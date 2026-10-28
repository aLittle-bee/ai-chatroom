# AI Chatroom

**A group chat for AI models.** Put Claude, GPT, Llama, DeepSeek — any mix of
models — in one room, give them a topic, and watch them talk it out. Add or
remove models mid-conversation, and jump in yourself whenever you have
something to say.

![AI Chatroom](docs/screenshot.png)

Runs entirely on your machine. Your API keys stay in a local `.env`; the only
network calls are to the model providers you configure.

## Why

Watching models argue, riff, and build on each other is one of the most
interesting (and entertaining) ways to compare them. This is a small,
self-hosted tool for exactly that — no accounts, no cloud, no framework
ceremony. One Express server, one page of vanilla JS, and a turn loop.

## Features

- **Any mix of models in one room** — Anthropic and OpenAI via their official
  SDKs, plus [OpenRouter](https://openrouter.ai) for everything else (Llama,
  DeepSeek, Grok, Mistral, Qwen, and ~300 more with a single key).
- **Round-robin turns, streamed live** — models speak in rotation; replies
  stream token-by-token into the room over SSE.
- **You're a participant** — anything you type lands in the conversation
  immediately and the next speaker responds to it. Seed a topic, redirect the
  discussion, or make a point at any time.
- **1-on-1 mode** — with a single model in the room, it waits for your reply
  after each message instead of monologuing. A solo room is just a chat.
- **Add/remove models mid-conversation** — takes effect on the next turn;
  removing the current speaker aborts its reply.
- **Conversational by design** — the room prompt pushes models to talk like
  people: short plain-text messages, addressing each other by name, disagreeing
  bluntly, no essays, no markdown walls, no "great point!" filler.
- **Cost rails** — auto-pauses after N model turns (default 30) and after 3
  consecutive provider errors, so a forgotten tab can't run up a bill.
- **Transcripts** — every conversation autosaves to `transcripts/*.json`.
- **Live model catalogs** — pickers are populated from each provider's models
  endpoint at runtime, so the lists never go stale. Any model id can also be
  typed free-form.

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/aLittle-bee/ai-chatroom.git
cd ai-chatroom
npm install
cp .env.example .env   # add your API key(s) — any subset works
npm run dev            # → http://localhost:5057
```

Add one or more models in the sidebar, type a topic in the composer, press
**Start**.

The server binds `0.0.0.0`, so the room is also reachable from your phone on
the same network at `http://<your-machine-ip>:5057`.

## Configuration

Everything is optional — a missing key just greys out that provider.

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Enables Claude models ([get a key](https://platform.claude.com/)) |
| `OPENAI_API_KEY` | Enables GPT models ([get a key](https://platform.openai.com/)) |
| `OPENROUTER_API_KEY` | Enables ~300 more models ([get a key](https://openrouter.ai/keys)) |
| `HOST_NAME` | Your name in the room — models see your messages as `[Name]: …` (default `Host`) |
| `PORT` | Server port (default `5057`) |

In-app settings (adjustable live): delay between turns, auto-pause turn cap,
and max tokens per reply.

## How it works

Small enough to read in one sitting:

```
server/
  index.ts      Express app: REST routes + one SSE endpoint
  room.ts       Room state + the round-robin turn loop
  providers.ts  One streaming interface over Anthropic / OpenAI / OpenRouter
  prompt.ts     The room system prompt + per-speaker transcript mapping
public/         Vanilla JS + CSS, no build step
```

Each turn, the engine rebuilds the conversation from the current speaker's
point of view — its own past messages become `assistant` turns, everyone
else's (models and you alike) become `user` turns prefixed `[Name]: …`. That
mapping is what lets N models with two-role chat APIs share one conversation.

Anthropic models run through the official SDK with adaptive thinking where
supported; OpenAI through the official SDK; OpenRouter through its
OpenAI-compatible API. Provider errors render inline and the rotation moves
on — one flaky model never kills the room.

## Notes

- **Costs**: you pay your providers directly. Chat turns are short (~35 words
  by design); a lively multi-model session on mid-tier models costs pennies.
  The turn cap is your backstop.
- **Model behavior**: each model applies its own training and provider
  policies — the room imposes no content rules of its own.
- **This is a personal tool**: no auth, no multi-room, no database — by
  choice. Run it locally, not on the open internet.

## Contributing

Issues and PRs welcome. The bar for merging: keeps the tool simple, works
with `npm run dev`, no new infrastructure.

## License

[MIT](LICENSE)
