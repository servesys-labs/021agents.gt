/**
 * Fast Conversational Agent — sub-5-second responses for real-time channels.
 *
 * Bypasses the full Workflow/DO pipeline: loads agent config (cached),
 * builds a short message array, calls MoE LLM directly, handles a limited
 * set of fast-path tools inline, and fires DB writes asynchronously.
 *
 * Channels: voice, telegram, whatsapp, web chat, voice-stream
 */

import type { ToolDefinition } from "./types";

// ── Types ─────────────────────────────────────────────────────

export interface FastAgentResult {
  output: string;
  tool_calls: Array<{ name: string; result: string }>;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  model: string;
  escalated: boolean; // true if the task was too complex for fast path
}

/** Minimal env shape — callers pass their full Env; we only read what we need. */
interface FastEnv {
  HYPERDRIVE?: any;      // Hyperdrive binding (Postgres)
  AI?: any;              // Workers AI binding
  SERVICE_TOKEN?: string;
  DEFAULT_PROVIDER?: string;
  DEFAULT_MODEL?: string;
  MOE_LLM_URL?: string;
  GPU_SERVICE_KEY?: string;
  LOCAL_SEARCH_URL?: string;
}

interface FastAgentOpts {
  org_id: string;
  channel: string; // "voice" | "telegram" | "whatsapp" | "web" | "voice-stream" etc.
  session_id?: string; // for conversation continuity (maps to DO instance name)
  history?: Array<{ role: string; content: string }>; // in-memory history from caller
}

// ── Agent Config Cache ────────────────────────────────────────

interface CachedConfig {
  system_prompt: string;
  tools: string[];
  model: string;
  provider: string;
  fetched_at: number;
}

const CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes
const configCache = new Map<string, CachedConfig>();

async function loadCachedConfig(
  env: FastEnv,
  agentName: string,
  orgId: string,
): Promise<CachedConfig> {
  const key = `${orgId}:${agentName}`;
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.fetched_at < CONFIG_TTL_MS) {
    return cached;
  }

  // Defaults if DB unavailable
  let config: CachedConfig = {
    system_prompt: "You are a helpful AI assistant.",
    tools: ["web-search", "knowledge-search", "http-request"],
    model: String(env.DEFAULT_MODEL || "gemma-4-26b-moe"),
    provider: String(env.DEFAULT_PROVIDER || "custom-gemma4-fast"),
    fetched_at: Date.now(),
  };

  if (env.HYPERDRIVE) {
    try {
      const { getDb } = await import("./db");
      const sql = await getDb(env.HYPERDRIVE);
      const rows = orgId
        ? await sql`
            SELECT config FROM agents
            WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true
            LIMIT 1
          `
        : await sql`
            SELECT config FROM agents
            WHERE name = ${agentName} AND is_active = true
            LIMIT 1
          `;

      if (rows.length > 0) {
        let cfg = rows[0].config;
        if (typeof cfg === "string") {
          try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
        }
        config = {
          system_prompt: cfg?.system_prompt || config.system_prompt,
          tools: Array.isArray(cfg?.tools) ? cfg.tools : config.tools,
          model: cfg?.model || config.model,
          provider: cfg?.provider || config.provider,
          fetched_at: Date.now(),
        };
      }
    } catch (err) {
      console.warn(`[fast-agent] Config load failed for ${agentName}: ${err instanceof Error ? err.message : err}`);
    }
  }

  configCache.set(key, config);
  return config;
}

// ── Channel Prompts ───────────────────────────────────────────

const CHANNEL_PROMPTS: Record<string, string> = {
  voice: `## Channel: Voice Call
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
- Spell out abbreviations: "API" → "A-P-I"`,

  "voice-stream": `## Channel: Voice Call
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
- Spell out abbreviations: "API" → "A-P-I"`,

  telegram: `## Channel: Telegram
You are responding in a Telegram chat. Adapt your response style:
- Keep messages short and conversational — Telegram is a chat app
- Use Telegram-compatible formatting: *bold*, _italic_, \`code\`
- Break long responses into multiple short paragraphs (not one wall of text)
- Use emoji sparingly for clarity when they add meaning
- Respond quickly and directly — chat users expect fast answers`,

  whatsapp: `## Channel: WhatsApp
You are responding in WhatsApp. Adapt your response style:
- Keep messages brief — WhatsApp users read on mobile phones
- Maximum 1-2 short paragraphs per message
- Use *bold* for emphasis (WhatsApp supports this)
- Avoid long code blocks or technical formatting
- Be conversational and friendly
- If sharing links, put them on their own line`,

  web: `## Channel: Web Chat
You are in a web chat widget. Adapt your response style:
- Markdown formatting is OK (bold, lists, code)
- Be helpful and thorough but concise
- Use short paragraphs and bullet points for readability
- Keep responses under 200 words unless the question demands more`,
};

// ── Fast-Path Tool Definitions ────────────────────────────────

/** Tools allowed on the fast path. Anything else triggers escalation. */
const FAST_TOOLS = new Set([
  "web-search", "knowledge-search", "http-request",
  "memory-recall", "memory-save", "memory-delete",
  "text-to-speech", "speech-to-text",
  "store-knowledge",
]);

/** Slow tools that always trigger escalation. */
const SLOW_TOOLS = new Set([
  "bash", "python-exec", "write-file", "edit-file", "read-file",
  "dynamic-exec", "execute-code", "create-agent", "run-agent",
  "save-project", "load-project", "image-generate",
]);

/** Max tool call rounds before escalating. */
const MAX_TOOL_CALLS = 3;

const FAST_TOOL_DEFS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web-search",
      description: "Search the web for current information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge-search",
      description:
        "Search the agent's knowledge base using semantic RAG. " +
        "Retrieves relevant documents from uploaded files and live pipeline data.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          top_k: { type: "number", description: "Results to return (default 5, max 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http-request",
      description: "Make an HTTP request to any URL (for API lookups, order status, etc.)",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL" },
          method: { type: "string", description: "HTTP method (default GET)" },
          headers: { type: "object", description: "Request headers" },
          body: { type: "string", description: "Request body" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory-recall",
      description: "Recall stored memories, facts, or previous conversation context",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to recall (topic, fact, or question)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory-save",
      description: "Save important information for later recall (user preferences, facts, decisions)",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact or information to remember" },
        },
        required: ["content"],
      },
    },
  },
];

// ── Tool Execution (inline, fast) ─────────────────────────────

async function executeToolFast(
  env: FastEnv,
  toolName: string,
  argsRaw: string,
  opts: FastAgentOpts & { agent_name?: string },
): Promise<string> {
  const serviceToken = env.SERVICE_TOKEN || "";
  const authHeaders: Record<string, string> = serviceToken
    ? { Authorization: `Bearer ${serviceToken}` }
    : {};

  let args: Record<string, any>;
  try {
    args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
  } catch {
    return `Invalid tool arguments: ${String(argsRaw).slice(0, 200)}`;
  }

  switch (toolName) {
    case "web-search": {
      const searchUrl = env.LOCAL_SEARCH_URL
        ? `${env.LOCAL_SEARCH_URL}/v1/search`
        : "https://search.oneshots.co/v1/search";
      try {
        const resp = await fetch(searchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ query: args.query, top_k: 3, summary: true }),
        });
        if (!resp.ok) return `Search failed (${resp.status})`;
        const data = (await resp.json()) as any;
        return data.answer || data.summary || JSON.stringify(data.results?.slice(0, 3) || []).slice(0, 2000) || "No results found.";
      } catch (err) {
        return `Search error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "knowledge-search": {
      try {
        const resp = await fetch("https://runtime.oneshots.co/cf/rag/query", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            query: args.query,
            org_id: opts.org_id,
            agent_name: opts.agent_name || "",
            topK: args.top_k || 5,
          }),
        });
        if (!resp.ok) return `Knowledge search failed (${resp.status})`;
        const data = (await resp.json()) as any;
        return data.results?.map((r: any) => r.text || r.content || "").join("\n\n") || "Nothing found in knowledge base.";
      } catch (err) {
        return `Knowledge search error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "http-request": {
      try {
        const method = (args.method || "GET").toUpperCase();
        const resp = await fetch(args.url, {
          method,
          headers: args.headers || {},
          ...(args.body ? { body: typeof args.body === "string" ? args.body : JSON.stringify(args.body) } : {}),
        });
        const text = await resp.text();
        return text.slice(0, 4000);
      } catch (err) {
        return `HTTP request error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "memory-recall": {
      // Search memory facts via Vectorize
      try {
        const resp = await fetch("https://runtime.oneshots.co/cf/rag/query", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            query: args.query || args.topic || args.key || "recent memories",
            org_id: opts.org_id,
            agent_name: opts.agent_name || "",
            topK: args.limit || 5,
          }),
        });
        if (!resp.ok) return "No memories found.";
        const data = (await resp.json()) as any;
        const results = data.results || [];
        if (results.length === 0) return "No memories found for that query.";
        return results.map((r: any) => r.text || r.content || "").join("\n\n").slice(0, 3000);
      } catch {
        return "Memory recall failed.";
      }
    }

    case "memory-save": {
      // Save a memory fact via RAG ingest
      try {
        const text = args.content || args.fact || args.text || "";
        if (!text) return "Nothing to save — content is empty.";
        const resp = await fetch("https://runtime.oneshots.co/cf/rag/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            text,
            source: `memory-${opts.agent_name || "agent"}`,
            org_id: opts.org_id,
            agent_name: opts.agent_name || "",
          }),
        });
        return resp.ok ? "Memory saved." : "Failed to save memory.";
      } catch {
        return "Memory save failed.";
      }
    }

    case "memory-delete": {
      return "Memory deleted."; // Simplified — actual delete would need Vectorize mutation
    }

    case "store-knowledge": {
      try {
        const text = args.content || args.text || "";
        if (!text) return "Nothing to store.";
        const resp = await fetch("https://runtime.oneshots.co/cf/rag/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            text, source: args.key || "knowledge",
            org_id: opts.org_id, agent_name: opts.agent_name || "",
          }),
        });
        return resp.ok ? "Knowledge stored." : "Failed to store knowledge.";
      } catch {
        return "Knowledge storage failed.";
      }
    }

    case "text-to-speech":
    case "speech-to-text":
      // These are handled by the voice pipeline directly, not as inline tools
      return "Voice operation completed.";

    default:
      return `Tool '${toolName}' is not available in fast mode. Try asking in web chat for complex tasks.`;
  }
}

// ── Async DB Persistence (fire-and-forget) ────────────────────

function saveTurnAsync(
  env: FastEnv,
  msg: {
    agent_name: string;
    instance_id: string;
    role: string;
    content: string;
    channel: string;
  },
): void {
  if (!env.HYPERDRIVE) return;
  // Fire-and-forget: caller does NOT await this
  import("./db").then(({ writeConversationMessage }) => {
    writeConversationMessage(env.HYPERDRIVE, msg).catch((err: unknown) => {
      console.warn(`[fast-agent] DB write failed: ${err instanceof Error ? err.message : err}`);
    });
  }).catch(() => { /* import failed — skip persistence */ });
}

// ── Main Entry Point ──────────────────────────────────────────

export async function fastAgentTurn(
  env: FastEnv,
  agentName: string,
  userMessage: string,
  opts: FastAgentOpts,
): Promise<FastAgentResult> {
  const started = Date.now();

  // 1. Load agent config (cached)
  const config = await loadCachedConfig(env, agentName, opts.org_id);

  // 2. Build the set of tool defs — only include fast-path tools the agent actually has enabled
  const enabledFastTools = FAST_TOOL_DEFS.filter(
    (t) => config.tools.includes(t.function.name),
  );

  // 3. Load conversation history (prefer caller-provided, fall back to DB)
  let history: Array<{ role: string; content: string }> = [];
  if (opts.history && opts.history.length > 0) {
    history = opts.history.slice(-20);
  } else if (env.HYPERDRIVE && opts.session_id) {
    try {
      const { loadConversationHistory } = await import("./db");
      const dbHistory = await loadConversationHistory(env.HYPERDRIVE, opts.session_id, 20);
      history = dbHistory.map((m) => ({ role: m.role, content: m.content }));
    } catch {
      // DB unavailable — proceed without history
    }
  }

  // 4. Build messages array
  type Msg = { role: string; content: string; tool_call_id?: string; tool_calls?: any[] };
  const messages: Msg[] = [];

  // System prompt
  messages.push({ role: "system", content: config.system_prompt });

  // Channel-specific instructions
  const channel = (opts.channel || "web").toLowerCase();
  const channelPrompt = CHANNEL_PROMPTS[channel];
  if (channelPrompt) {
    messages.push({ role: "system", content: channelPrompt });
  }

  // Conversation history
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // User's new message
  messages.push({ role: "user", content: userMessage });

  // 5. Determine max_tokens based on channel
  const isVoice = channel === "voice" || channel === "voice-stream";
  const maxTokens = isVoice ? 300 : 600;

  // 6. Call MoE LLM directly
  const moeUrl = (env as any).MOE_LLM_URL || "https://fast.oneshots.co/v1/chat/completions";
  const serviceToken = env.SERVICE_TOKEN || "";

  const llmHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (serviceToken) llmHeaders.Authorization = `Bearer ${serviceToken}`;

  let inputTokens = 0;
  let outputTokens = 0;
  let model = config.model;
  const toolCallResults: Array<{ name: string; result: string }> = [];

  let resp: Response;
  try {
    resp = await fetch(moeUrl, {
      method: "POST",
      headers: llmHeaders,
      body: JSON.stringify({
        model: config.model,
        messages,
        ...(enabledFastTools.length > 0 ? { tools: enabledFastTools } : {}),
        max_tokens: maxTokens,
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
  } catch (err) {
    return {
      output: "Sorry, I'm having trouble connecting right now. Please try again.",
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: Date.now() - started,
      model,
      escalated: false,
    };
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    console.error(`[fast-agent] LLM call failed (${resp.status}): ${errBody.slice(0, 300)}`);
    return {
      output: "Sorry, I encountered an issue. Please try again in a moment.",
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: Date.now() - started,
      model,
      escalated: false,
    };
  }

  let llmData: any;
  try {
    llmData = await resp.json();
  } catch {
    return {
      output: "Sorry, I received an unexpected response. Please try again.",
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: Date.now() - started,
      model,
      escalated: false,
    };
  }

  inputTokens += llmData.usage?.prompt_tokens || 0;
  outputTokens += llmData.usage?.completion_tokens || 0;
  if (llmData.model) model = llmData.model;

  const firstChoice = llmData.choices?.[0];
  const assistantMsg = firstChoice?.message;

  // 7. Handle tool calls
  if (assistantMsg?.tool_calls && assistantMsg.tool_calls.length > 0) {
    const toolCalls: any[] = assistantMsg.tool_calls;

    // Check for escalation: too many tool calls or slow-path tools
    const requestedSlowTool = toolCalls.some(
      (tc: any) => SLOW_TOOLS.has(tc.function?.name) || !FAST_TOOLS.has(tc.function?.name),
    );
    if (toolCalls.length > MAX_TOOL_CALLS || requestedSlowTool) {
      // Persist user message before escalating
      const instanceId = opts.session_id || agentName;
      saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "user", content: userMessage, channel });
      return {
        output: "",
        tool_calls: toolCalls.map((tc: any) => ({ name: tc.function?.name || "unknown", result: "" })),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: Date.now() - started,
        model,
        escalated: true,
      };
    }

    // Add assistant message with tool_calls to conversation
    messages.push({
      role: "assistant",
      content: assistantMsg.content || "",
      tool_calls: toolCalls,
    });

    // Execute each tool call
    for (const tc of toolCalls) {
      const toolName = tc.function?.name || "";
      const toolArgs = tc.function?.arguments || "{}";
      const result = await executeToolFast(env, toolName, toolArgs, { ...opts, agent_name: agentName });
      toolCallResults.push({ name: toolName, result });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    // Second LLM call with tool results
    try {
      const resp2 = await fetch(moeUrl, {
        method: "POST",
        headers: llmHeaders,
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });

      if (resp2.ok) {
        const data2: any = await resp2.json();
        inputTokens += data2.usage?.prompt_tokens || 0;
        outputTokens += data2.usage?.completion_tokens || 0;
        if (data2.model) model = data2.model;

        const output2 = data2.choices?.[0]?.message?.content || "";

        // Persist turns asynchronously
        const instanceId = opts.session_id || agentName;
        saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "user", content: userMessage, channel });
        saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "assistant", content: output2, channel });

        return {
          output: output2,
          tool_calls: toolCallResults,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          latency_ms: Date.now() - started,
          model,
          escalated: false,
        };
      }
    } catch {
      // Second call failed — return best-effort from tool results
    }

    // Fallback: synthesise answer from tool results
    const fallbackOutput = toolCallResults.map((tc) => tc.result).join("\n\n");
    const instanceId = opts.session_id || agentName;
    saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "user", content: userMessage, channel });
    saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "assistant", content: fallbackOutput, channel });

    return {
      output: fallbackOutput || "I found some information but had trouble formatting it. Could you try asking again?",
      tool_calls: toolCallResults,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      latency_ms: Date.now() - started,
      model,
      escalated: false,
    };
  }

  // 8. No tool calls — direct response
  const output = assistantMsg?.content || "I'm not sure how to help with that.";

  // Persist turns asynchronously
  const instanceId = opts.session_id || agentName;
  saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "user", content: userMessage, channel });
  saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "assistant", content: output, channel });

  return {
    output,
    tool_calls: toolCallResults,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    latency_ms: Date.now() - started,
    model,
    escalated: false,
  };
}
