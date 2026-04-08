/**
 * Channel Prompts — single source of truth for channel-specific LLM instructions.
 *
 * Imported by fast-agent.ts and channel-router.ts.
 * Each prompt tells the LLM how to format output for that delivery channel.
 */

// ── Types ─────────────────────────────────────────────────────

export type ChannelId =
  | "voice"
  | "voice-stream"
  | "telegram"
  | "whatsapp"
  | "web"
  | "slack"
  | "instagram"
  | "messenger"
  | "email"
  | "widget";

export interface ChannelConfig {
  /** System-level prompt injected after the agent's own prompt. */
  prompt: string;
  /** Max characters per message chunk for this channel. */
  maxChunkChars: number;
  /** Max LLM output tokens (voice is short, web is longer). */
  maxTokens: number;
  /** Whether the channel supports markdown formatting. */
  supportsMarkdown: boolean;
  /** Interim message shown while escalating to full pipeline. */
  escalationMessage: string;
}

// ── Voice (shared by phone + browser test + media stream) ─────

const VOICE_PROMPT = `## Channel: Voice Call
CRITICAL: Your response will be read aloud by a text-to-speech engine. A human is listening on the phone.

NEVER output:
- Markdown (no #, **, *, \`, [](), ---)
- Plans, step lists, checkboxes, or task breakdowns
- Code blocks or technical formatting
- Bullet points or numbered lists
- URLs, email addresses, or file paths

ALWAYS:
- Speak in short, natural sentences like a helpful person on the phone
- Keep responses under 75 words (30 seconds of speech)
- Use conversational phrases: "Let me check that for you..." "Sure thing..."
- If you need to use a tool, just do it silently — don't narrate your plan
- Give the RESULT, not the process
- Pause naturally between topics (use periods, not commas)
- Spell out abbreviations: "API" → "A-P-I"`;

// ── Channel Registry ──────────────────────────────────────────

export const CHANNEL_CONFIGS: Record<ChannelId, ChannelConfig> = {
  voice: {
    prompt: VOICE_PROMPT,
    maxChunkChars: Infinity,
    maxTokens: 300,
    supportsMarkdown: false,
    escalationMessage: "Let me look into that for you, one moment.",
  },
  "voice-stream": {
    prompt: VOICE_PROMPT,
    maxChunkChars: Infinity,
    maxTokens: 300,
    supportsMarkdown: false,
    escalationMessage: "Let me look into that for you, one moment.",
  },
  telegram: {
    prompt: `## Channel: Telegram
You are responding in a Telegram chat. Adapt your response style:
- Keep messages short and conversational — Telegram is a chat app
- Use Telegram-compatible formatting: *bold*, _italic_, \`code\`
- Break long responses into multiple short paragraphs (not one wall of text)
- Use emoji sparingly for clarity when they add meaning
- Respond quickly and directly — chat users expect fast answers`,
    maxChunkChars: 4096,
    maxTokens: 600,
    supportsMarkdown: true,
    escalationMessage: "Working on that...",
  },
  whatsapp: {
    prompt: `## Channel: WhatsApp
You are responding in WhatsApp. Adapt your response style:
- Keep messages brief — WhatsApp users read on mobile phones
- Maximum 1-2 short paragraphs per message
- Use *bold* for emphasis (WhatsApp supports this)
- Avoid long code blocks or technical formatting
- Be conversational and friendly
- If sharing links, put them on their own line`,
    maxChunkChars: 4096,
    maxTokens: 600,
    supportsMarkdown: false,
    escalationMessage: "Working on that...",
  },
  web: {
    prompt: `## Channel: Web Chat
You are in a web chat widget. Adapt your response style:
- Markdown formatting is OK (bold, lists, code)
- Be helpful and thorough but concise
- Use short paragraphs and bullet points for readability
- Keep responses under 200 words unless the question demands more`,
    maxChunkChars: 8000,
    maxTokens: 800,
    supportsMarkdown: true,
    escalationMessage: "Let me work on that...",
  },
  slack: {
    prompt: `## Channel: Slack
You are responding in a Slack workspace. Adapt your response style:
- Use Slack mrkdwn formatting: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`
- Keep messages concise — Slack threads move fast
- Use bullet points for lists, not numbered lists
- Break long responses into short paragraphs
- Thread-aware: if replying in a thread, stay focused on that topic`,
    maxChunkChars: 3000,
    maxTokens: 600,
    supportsMarkdown: true,
    escalationMessage: "Looking into that...",
  },
  instagram: {
    prompt: `## Channel: Instagram DMs
You are responding in Instagram Direct Messages. Adapt your response style:
- Keep messages very short — IG DMs are casual and mobile-first
- Maximum 2-3 sentences per message
- No markdown formatting (IG doesn't render it)
- Be friendly and conversational — match the casual tone of DMs
- Use emoji naturally if it fits the conversation`,
    maxChunkChars: 1000,
    maxTokens: 400,
    supportsMarkdown: false,
    escalationMessage: "One sec...",
  },
  messenger: {
    prompt: `## Channel: Facebook Messenger
You are responding in Facebook Messenger. Adapt your response style:
- Keep messages concise — Messenger is a chat app
- Maximum 1-2 short paragraphs per message
- No complex markdown (Messenger has limited formatting)
- Be conversational and direct
- If sharing links, put them on their own line`,
    maxChunkChars: 2000,
    maxTokens: 500,
    supportsMarkdown: false,
    escalationMessage: "One moment...",
  },
  email: {
    prompt: `## Channel: Email
You are composing an email reply. Adapt your response style:
- Be professional and thorough — email allows longer-form responses
- Use a proper greeting and sign-off
- Structure with clear paragraphs and headers when needed
- Include all relevant details — the recipient may not reply quickly
- Bullet points and numbered lists are fine for clarity
- Keep a professional but approachable tone`,
    maxChunkChars: 50000,
    maxTokens: 2000,
    supportsMarkdown: true,
    escalationMessage: "Processing your request...",
  },
  widget: {
    prompt: `## Channel: Embedded Widget
You are in an embedded chat widget on a website. Adapt your response style:
- Be concise — widgets have small viewport
- Markdown formatting is OK
- Keep responses under 150 words unless the question demands more
- Prioritize actionable answers over explanations
- If the user needs more detail, offer to elaborate`,
    maxChunkChars: 4000,
    maxTokens: 500,
    supportsMarkdown: true,
    escalationMessage: "Working on it...",
  },
};

// ── Helpers ───────────────────────────────────────────────────

/** Get channel config with fallback to 'web' for unknown channels. */
export function getChannelConfig(channel: string): ChannelConfig {
  const id = channel.toLowerCase() as ChannelId;
  return CHANNEL_CONFIGS[id] || CHANNEL_CONFIGS.web;
}

/** Get just the prompt string for a channel (backward compat). */
export function getChannelPrompt(channel: string): string {
  return getChannelConfig(channel).prompt;
}

/** Get max tokens for a channel. */
export function getChannelMaxTokens(channel: string): number {
  return getChannelConfig(channel).maxTokens;
}

/** Check if a channel is voice-based (needs TTS-safe output). */
export function isVoiceChannel(channel: string): boolean {
  const id = channel.toLowerCase();
  return id === "voice" || id === "voice-stream";
}

/** Check if a channel is a real-time chat channel (needs fast responses). */
export function isRealtimeChannel(channel: string): boolean {
  const id = channel.toLowerCase();
  return ["voice", "voice-stream", "telegram", "whatsapp", "instagram", "messenger", "slack", "widget"].includes(id);
}
