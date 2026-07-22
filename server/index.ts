import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableProviders, listModels } from "./providers";
import type { ProviderName } from "./prompt";
import { Room } from "./room";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS: ProviderName[] = ["anthropic", "openai", "openrouter"];

const app = express();
app.use(express.json());

const room = new Room();

// ---- SSE ----
const sseClients = new Set<express.Response>();

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  // Full state on connect, so reconnects self-heal.
  res.write(`data: ${JSON.stringify({ type: "state", state: room.snapshot() })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

room.on("event", (event) => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(data);
});

// ---- REST ----
app.get("/api/state", (_req, res) => res.json(room.snapshot()));
app.get("/api/providers", (_req, res) => res.json(availableProviders()));

app.get("/api/models", async (req, res) => {
  const provider = String(req.query.provider) as ProviderName;
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: "unknown provider" });
  }
  if (!availableProviders()[provider]) {
    return res.status(400).json({ error: `${provider} API key not configured` });
  }
  try {
    res.json(await listModels(provider));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.post("/api/participants", (req, res) => {
  const { provider, modelId } = (req.body ?? {}) as {
    provider?: ProviderName;
    modelId?: string;
  };
  if (!provider || !PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: "unknown provider" });
  }
  if (!availableProviders()[provider]) {
    return res.status(400).json({ error: `${provider} API key not configured` });
  }
  if (typeof modelId !== "string" || !modelId.trim()) {
    return res.status(400).json({ error: "modelId is required" });
  }
  res.json(room.addParticipant(provider, modelId.trim()));
});

app.delete("/api/participants/:id", (req, res) => {
  if (!room.removeParticipant(req.params.id)) {
    return res.status(404).json({ error: "no such participant" });
  }
  res.json({ ok: true });
});

app.post("/api/message", (req, res) => {
  const { text } = (req.body ?? {}) as { text?: string };
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  res.json(room.sendUserMessage(text.trim()));
});

app.post("/api/control", (req, res) => {
  const { action } = (req.body ?? {}) as { action?: string };
  try {
    if (action === "start") room.start();
    else if (action === "pause") room.pause();
    else if (action === "reset") room.reset();
    else return res.status(400).json({ error: "action must be start | pause | reset" });
    res.json({ ok: true, running: room.running });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.patch("/api/settings", (req, res) => {
  const patch = (req.body ?? {}) as Record<string, unknown>;
  const clean: Record<string, number> = {};
  for (const key of ["turnDelayMs", "maxTokens", "turnCap"] as const) {
    if (typeof patch[key] === "number" && Number.isFinite(patch[key])) {
      clean[key] = patch[key] as number;
    }
  }
  res.json(room.updateSettings(clean));
});

// ---- static ----
const markedCandidates = [
  path.join(__dirname, "..", "node_modules", "marked", "marked.min.js"),
  path.join(__dirname, "..", "node_modules", "marked", "lib", "marked.umd.js"),
];
const markedFile = markedCandidates.find((f) => fs.existsSync(f));
app.get("/vendor/marked.js", (_req, res) => {
  if (!markedFile) return res.status(404).end();
  res.sendFile(markedFile);
});

app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = Number(process.env.PORT) || 5057;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Chatroom → http://localhost:${PORT}`);
});
