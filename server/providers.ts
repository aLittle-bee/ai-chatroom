// Provider adapters. One streaming interface for all three providers:
// Anthropic through the official SDK; OpenAI through the official SDK;
// OpenRouter through the OpenAI SDK with a baseURL override (it speaks the
// OpenAI wire format for every model it hosts).

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Participant, ProviderName, TranscriptMessage } from "./prompt";

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;
let openrouterClient: OpenAI | null = null;

function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  return (anthropicClient ??= new Anthropic());
}

function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  return (openaiClient ??= new OpenAI());
}

function getOpenRouter(): OpenAI {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  return (openrouterClient ??= new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  }));
}

export function availableProviders(): Record<ProviderName, boolean> {
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
  };
}

// Adaptive thinking is only valid on these tiers. Fable/Mythos have thinking
// always on (any explicit config is a 400 — omit the param), and older models
// (Haiku 4.5, Sonnet 4.5, …) still use budget_tokens, so they run without.
const ADAPTIVE_THINKING = /opus-4-[678]|sonnet-4-6|sonnet-5/;

export async function* streamReply(
  participant: Participant,
  system: string,
  messages: TranscriptMessage[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (participant.provider === "anthropic") {
    const stream = getAnthropic().messages.stream(
      {
        model: participant.modelId,
        max_tokens: maxTokens,
        system,
        messages,
        ...(ADAPTIVE_THINKING.test(participant.modelId)
          ? { thinking: { type: "adaptive" as const } }
          : {}),
      },
      { signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new Error("declined to respond (safety refusal)");
    }
    return;
  }

  const client = participant.provider === "openai" ? getOpenAI() : getOpenRouter();
  const stream = await client.chat.completions.create(
    {
      model: participant.modelId,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
      // OpenAI's newer models only accept max_completion_tokens; OpenRouter
      // normalizes max_tokens across every model it hosts.
      ...(participant.provider === "openai"
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
    },
    { signal },
  );
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export interface ModelInfo {
  id: string;
  name: string;
}

const modelCache = new Map<ProviderName, { at: number; models: ModelInfo[] }>();
const MODEL_CACHE_MS = 10 * 60 * 1000;

export async function listModels(provider: ProviderName): Promise<ModelInfo[]> {
  const cached = modelCache.get(provider);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;

  let models: ModelInfo[];
  if (provider === "anthropic") {
    models = [];
    for await (const m of getAnthropic().models.list()) {
      models.push({ id: m.id, name: m.display_name });
    }
  } else if (provider === "openai") {
    const CHAT = /^(gpt|o\d|chatgpt)/;
    const EXCLUDE = /audio|realtime|tts|whisper|embed|image|dall|moderation|transcribe|search/;
    models = [];
    for await (const m of await getOpenAI().models.list()) {
      if (CHAT.test(m.id) && !EXCLUDE.test(m.id)) models.push({ id: m.id, name: m.id });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
  } else {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    if (!res.ok) throw new Error(`OpenRouter models request failed (${res.status})`);
    const body = (await res.json()) as { data: { id: string; name?: string }[] };
    models = body.data
      .map((m) => ({ id: m.id, name: m.name ?? m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  modelCache.set(provider, { at: Date.now(), models });
  return models;
}
