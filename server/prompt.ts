// Shared types + the transcript→per-speaker mapping.
//
// Every participant sees the same conversation, but each provider API wants a
// two-role (user/assistant) message list. The standard multi-agent mapping:
// a participant's own past messages become `assistant` turns; everything else
// (other models + the human host) becomes `user` turns prefixed "[Name]: ".

export type ProviderName = "anthropic" | "openai" | "openrouter";

export interface Participant {
  id: string;
  provider: ProviderName;
  modelId: string;
  displayName: string;
  color: string;
}

export interface ChatMessage {
  id: string;
  speakerId: string | null; // null = the human host
  speakerName: string;
  color: string;
  text: string;
  ts: number;
  error?: boolean;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export function buildSystemPrompt(
  self: Participant,
  participants: Participant[],
  hostName: string,
): string {
  const others = participants
    .filter((p) => p.id !== self.id)
    .map((p) => p.displayName);
  const othersLine = others.length ? others.join(", ") : "no one else yet";
  return [
    `You are ${self.displayName}, one of a few AI models hanging out in a group chat.`,
    `Also in the room: ${othersLine}. ${hostName}, the human host, drops in whenever he wants — when he does, engage with what he said directly.`,
    ``,
    `How to talk — this matters more than what you say:`,
    `- Write like you're speaking, not writing. Contractions, fragments, plain text. No markdown at all: no bullets, no bold, no headings, no numbered lists.`,
    `- Keep it short. One or two sentences is a great message. Three or four is the usual ceiling. Go longer only when a point truly needs it, and never past ~120 words.`,
    `- React to the last thing said instead of restating the discussion. Address people by name when picking up their point ("Haiku, that cuts both ways —").`,
    `- Have a take. Disagree bluntly when you disagree. Concede specific points, not everything. Dry humor is welcome.`,
    `- Vary your rhythm like a real chat: sometimes a quick jab or a question, sometimes a fuller thought. Not every message needs a complete argument.`,
    `- Never summarize the conversation, never declare it finished or "leave it there". If a thread is dying, open a new angle or push on a weak spot instead.`,
    `- No assistant-speak: no "Great point!", no "I'd be happy to", don't end every message with a question.`,
    `- Messages from others appear as "[Name]: message"; your own have no prefix. Never prefix your reply with your own name, and never write anyone else's lines.`,
  ].join("\n");
}

export function buildTranscript(
  self: Participant,
  messages: ChatMessage[],
): TranscriptMessage[] {
  const mapped: TranscriptMessage[] = [];
  for (const msg of messages) {
    if (msg.error || !msg.text.trim()) continue;
    const own = msg.speakerId === self.id;
    const role = own ? "assistant" : "user";
    const content = own ? msg.text : `[${msg.speakerName}]: ${msg.text}`;
    const prev = mapped[mapped.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${content}`;
    else mapped.push({ role, content });
  }

  if (mapped.length === 0) {
    mapped.push({
      role: "user",
      content:
        "(The room is quiet — no one has spoken yet. Open the conversation with a topic you find genuinely interesting.)",
    });
  }
  // Anthropic requires the first message to be `user`, and an assistant-final
  // message counts as a prefill (400 on current models) — pad both ends.
  if (mapped[0].role === "assistant") {
    mapped.unshift({ role: "user", content: "(Conversation start.)" });
  }
  if (mapped[mapped.length - 1].role === "assistant") {
    mapped.push({
      role: "user",
      content: "(No one has replied yet — continue or expand on your last message.)",
    });
  }
  return mapped;
}
