// The room engine: participants, transcript, and the round-robin turn loop.
// All state lives in memory; the transcript autosaves to transcripts/*.json.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSystemPrompt,
  buildTranscript,
  type ChatMessage,
  type Participant,
  type ProviderName,
} from "./prompt";
import { streamReply } from "./providers";

const HOST_NAME = process.env.HOST_NAME || "Host";
const HOST_COLOR = "oklch(0.82 0.02 255)";
// Voice hues at uniform perceived lightness (OKLCH) so no speaker shouts.
const COLORS = [
  "oklch(0.72 0.11 250)", // blue
  "oklch(0.74 0.11 60)", // amber
  "oklch(0.73 0.11 155)", // green
  "oklch(0.70 0.12 20)", // red
  "oklch(0.72 0.10 300)", // violet
  "oklch(0.76 0.10 100)", // citron
  "oklch(0.73 0.10 200)", // cyan
  "oklch(0.72 0.10 340)", // pink
];

export interface Settings {
  turnDelayMs: number;
  maxTokens: number;
  turnCap: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, "..", "transcripts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Room extends EventEmitter {
  participants: Participant[] = [];
  messages: ChatMessage[] = [];
  running = false;
  pausedReason: string | null = null;
  activeSpeakerId: string | null = null;
  waitingForHost = false;
  settings: Settings = { turnDelayMs: 2000, maxTokens: 2048, turnCap: 30 };

  private cursor = 0;
  private turnsThisRun = 0;
  private consecutiveErrors = 0;
  private colorIndex = 0;
  private loopActive = false;
  private currentAbort: AbortController | null = null;
  private transcriptFile: string;
  private startedAt: number;

  constructor() {
    super();
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    this.startedAt = Date.now();
    this.transcriptFile = this.newTranscriptFile();
  }

  snapshot() {
    return {
      hostName: HOST_NAME,
      participants: this.participants,
      messages: this.messages,
      running: this.running,
      pausedReason: this.pausedReason,
      activeSpeakerId: this.activeSpeakerId,
      waitingForHost: this.waitingForHost,
      settings: this.settings,
      turnsThisRun: this.turnsThisRun,
    };
  }

  private broadcast(event: Record<string, unknown>) {
    this.emit("event", event);
  }

  addParticipant(provider: ProviderName, modelId: string): Participant {
    const participant: Participant = {
      id: randomUUID().slice(0, 8),
      provider,
      modelId,
      displayName: this.uniqueName(prettyName(modelId)),
      color: COLORS[this.colorIndex++ % COLORS.length],
    };
    this.participants.push(participant);
    this.broadcast({ type: "participants", participants: this.participants });
    this.wake();
    return participant;
  }

  removeParticipant(id: string): boolean {
    const idx = this.participants.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    if (this.activeSpeakerId === id) this.currentAbort?.abort();
    if (idx < this.cursor) this.cursor--;
    this.participants.splice(idx, 1);
    this.broadcast({ type: "participants", participants: this.participants });
    this.wake();
    return true;
  }

  sendUserMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: randomUUID().slice(0, 8),
      speakerId: null,
      speakerName: HOST_NAME,
      color: HOST_COLOR,
      text,
      ts: Date.now(),
    };
    this.messages.push(msg);
    this.broadcast({ type: "message", message: msg });
    this.save();
    this.wake();
    return msg;
  }

  start() {
    if (this.running) return;
    if (this.participants.length === 0) {
      throw new Error("Add at least one model before starting");
    }
    this.running = true;
    this.pausedReason = null;
    this.turnsThisRun = 0;
    this.consecutiveErrors = 0;
    this.broadcast({ type: "status", running: true, reason: null });
    void this.runLoop();
  }

  pause(reason = "paused") {
    if (!this.running) return;
    this.running = false;
    this.pausedReason = reason;
    this.currentAbort?.abort();
    this.broadcast({ type: "status", running: false, reason });
    this.wake();
  }

  reset() {
    this.pause("reset");
    this.messages = [];
    this.cursor = 0;
    this.turnsThisRun = 0;
    this.pausedReason = null;
    this.startedAt = Date.now();
    this.transcriptFile = this.newTranscriptFile();
    this.broadcast({ type: "reset", state: this.snapshot() });
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.turnDelayMs !== undefined) {
      this.settings.turnDelayMs = clamp(patch.turnDelayMs, 0, 60_000);
    }
    if (patch.maxTokens !== undefined) {
      this.settings.maxTokens = clamp(patch.maxTokens, 256, 16_000);
    }
    if (patch.turnCap !== undefined) {
      this.settings.turnCap = clamp(patch.turnCap, 1, 1_000_000_000_000);
    }
    this.broadcast({ type: "settings", settings: this.settings });
    return this.settings;
  }

  private async runLoop() {
    if (this.loopActive) return;
    this.loopActive = true;
    try {
      while (this.running) {
        if (this.participants.length === 0) {
          this.pause("no participants left");
          break;
        }
        if (this.turnsThisRun >= this.settings.turnCap) {
          this.pause(`auto-paused after ${this.settings.turnCap} turns`);
          break;
        }
        // Solo room = 1-on-1 chat: after the model speaks, wait for the host
        // instead of monologuing. A host message, roster change, or pause wakes
        // the loop.
        if (this.shouldWaitForHost()) {
          this.waitingForHost = true;
          this.broadcast({ type: "waiting", waiting: true });
          await new Promise<void>((resolve) => this.once("wake", resolve));
          this.waitingForHost = false;
          this.broadcast({ type: "waiting", waiting: false });
          continue;
        }
        this.cursor = this.cursor % this.participants.length;
        const participant = this.participants[this.cursor];
        this.cursor++;
        await this.takeTurn(participant);
        if (!this.running) break;
        await sleep(this.settings.turnDelayMs);
      }
    } finally {
      this.loopActive = false;
      this.activeSpeakerId = null;
    }
  }

  private async takeTurn(p: Participant) {
    // Build the participant's view of the transcript before adding their bubble.
    const system = buildSystemPrompt(p, this.participants, HOST_NAME);
    const transcript = buildTranscript(p, this.messages);

    const msg: ChatMessage = {
      id: randomUUID().slice(0, 8),
      speakerId: p.id,
      speakerName: p.displayName,
      color: p.color,
      text: "",
      ts: Date.now(),
    };
    this.messages.push(msg);
    this.activeSpeakerId = p.id;
    this.currentAbort = new AbortController();
    this.broadcast({ type: "message_start", message: msg });

    let outcome: "ok" | "error" | "cancelled" = "ok";
    try {
      const stream = streamReply(
        p,
        system,
        transcript,
        this.settings.maxTokens,
        this.currentAbort.signal,
      );
      for await (const delta of stream) {
        msg.text += delta;
        this.broadcast({ type: "message_delta", id: msg.id, delta });
      }
    } catch (err) {
      if (this.currentAbort.signal.aborted) {
        outcome = msg.text ? "ok" : "cancelled";
      } else {
        outcome = "error";
        msg.error = true;
        msg.text = msg.text || `${p.displayName} failed: ${(err as Error).message}`;
      }
    }

    this.activeSpeakerId = null;
    this.currentAbort = null;

    if (outcome === "cancelled") {
      const i = this.messages.indexOf(msg);
      if (i !== -1) this.messages.splice(i, 1);
      this.broadcast({ type: "message_cancelled", id: msg.id });
      return;
    }

    this.consecutiveErrors = outcome === "error" ? this.consecutiveErrors + 1 : 0;
    this.turnsThisRun++;
    this.broadcast({ type: "message_end", message: msg });
    this.save();

    if (this.consecutiveErrors >= 3) {
      this.pause("auto-paused after 3 consecutive errors");
    }
  }

  private wake() {
    this.emit("wake");
  }

  // True when the sole participant spoke most recently (solo rooms only).
  private shouldWaitForHost(): boolean {
    if (this.participants.length !== 1) return false;
    const solo = this.participants[0];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.error) continue;
      return m.speakerId === solo.id;
    }
    return false; // empty transcript — the model may open
  }

  private uniqueName(base: string): string {
    let name = base;
    let n = 2;
    while (this.participants.some((p) => p.displayName === name)) {
      name = `${base} (${n++})`;
    }
    return name;
  }

  private newTranscriptFile(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(TRANSCRIPTS_DIR, `${stamp}.json`);
  }

  private save() {
    const data = {
      startedAt: new Date(this.startedAt).toISOString(),
      savedAt: new Date().toISOString(),
      settings: this.settings,
      participants: this.participants,
      messages: this.messages,
    };
    try {
      fs.writeFileSync(this.transcriptFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("transcript save failed:", err);
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function prettyName(modelId: string): string {
  let base = modelId.split("/").pop() ?? modelId;
  base = base
    .replace(/:(free|beta|extended|nitro)$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(latest|preview)$/, "")
    // join hyphenated versions (haiku-4-5 → 4.5) without touching ids that
    // already use dots (llama-3.3-70b)
    .replace(/-(\d+)-(\d+)(?=-|$)/g, "-$1.$2");
  return base
    .split("-")
    .filter(Boolean)
    .map((tok) => {
      if (/^(gpt|o\d*)$/i.test(tok)) return tok.toUpperCase();
      return tok[0].toUpperCase() + tok.slice(1);
    })
    .join(" ");
}
