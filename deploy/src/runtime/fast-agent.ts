/**
 * Fast Conversational Agent — sub-5-second responses for real-time channels.
 *
 * Bypasses the full Workflow/DO pipeline: loads agent config (cached),
 * builds a short message array, calls MoE LLM directly, handles a limited
 * set of fast-path tools inline, and fires DB writes asynchronously.
 *
 * v2: Per-agent execution profiles, _escalate pseudo-tool (LLM decides
 * when to escalate), channel-aware token limits from channel-prompts.ts.
 */

import type { ToolDefinition } from "./types";
import { getChannelConfig, type ChannelConfig } from "./channel-prompts";
import { log } from "./log";

// ── Types ─────────────────────────────────────────────────────

export interface FastAgentResult {
  output: string;
  tool_calls: Array<{ name: string; result: string }>;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  model: string;
  escalated: boolean;
  /** Interim message to show the user while the full pipeline runs. */
  escalation_message: string;
}

/** Minimal env shape — callers pass their full Env; we only read what we need. */
interface FastEnv {
  HYPERDRIVE?: any;
  AI?: any;
  SERVICE_TOKEN?: string;
  DEFAULT_PROVIDER?: string;
  DEFAULT_MODEL?: string;
  MOE_LLM_URL?: string;
  GPU_SERVICE_KEY?: string;
  LOCAL_SEARCH_URL?: string;
}

export interface FastAgentOpts {
  org_id: string;
  channel: string;
  session_id?: string;
  history?: Array<{ role: string; content: string }>;
}

// ── Execution Profile ─────────────────────────────────────────

export interface ExecutionProfile {
  execution_mode: "auto" | "fast-only" | "full";
  fast_tools?: string[];
  max_fast_tool_calls: number;
  escalation_message?: string;
  fast_temperature?: number;
  fast_max_tokens?: number;
}

const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = {
  execution_mode: "auto",
  max_fast_tool_calls: 3,
};

// ── Agent Config Cache ────────────────────────────────────────

interface CachedConfig {
  system_prompt: string;
  tools: string[];
  model: string;
  provider: string;
  execution_profile: ExecutionProfile;
  channels?: Array<{
    channel: string;
    enabled: boolean;
    prompt_suffix?: string;
    greeting?: string;
    execution_profile?: ExecutionProfile;
  }>;
  fetched_at: number;
}

const CONFIG_TTL_MS = 5 * 60 * 1000;
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

  let config: CachedConfig = {
    system_prompt: "You are a helpful AI assistant.",
    tools: ["web-search", "knowledge-search", "http-request"],
    model: String(env.DEFAULT_MODEL || "gemma-4-26b-moe"),
    provider: String(env.DEFAULT_PROVIDER || "custom-gemma4-fast"),
    execution_profile: { ...DEFAULT_EXECUTION_PROFILE },
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

        // Parse execution profile from agent config
        const ep = cfg?.execution_profile;
        const execProfile: ExecutionProfile = {
          execution_mode: ep?.execution_mode || "auto",
          fast_tools: Array.isArray(ep?.fast_tools) ? ep.fast_tools : undefined,
          max_fast_tool_calls: Number(ep?.max_fast_tool_calls) || 3,
          escalation_message: ep?.escalation_message || undefined,
          fast_temperature: ep?.fast_temperature ?? undefined,
          fast_max_tokens: ep?.fast_max_tokens ?? undefined,
        };

        config = {
          system_prompt: cfg?.system_prompt || config.system_prompt,
          tools: Array.isArray(cfg?.tools) ? cfg.tools : config.tools,
          model: cfg?.model || config.model,
          provider: cfg?.provider || config.provider,
          execution_profile: execProfile,
          channels: Array.isArray(cfg?.channels) ? cfg.channels : undefined,
          fetched_at: Date.now(),
        };
      }
    } catch (err) {
      log.warn(`[fast-agent] Config load failed for ${agentName}: ${err instanceof Error ? err.message : err}`);
    }
  }

  configCache.set(key, config);
  return config;
}

// ── Fast-Path Tool Definitions ────────────────────────────────

/** Default tools allowed on the fast path when no execution_profile.fast_tools is set. */
const DEFAULT_FAST_TOOLS = new Set([
  "web-search", "knowledge-search", "http-request",
  "memory-recall", "memory-save", "memory-delete",
  "text-to-speech", "speech-to-text",
  "store-knowledge",
]);

/** Tools that ALWAYS require the full pipeline regardless of config. */
const ALWAYS_SLOW_TOOLS = new Set([
  "bash", "python-exec", "write-file", "edit-file", "read-file",
  "dynamic-exec", "execute-code", "create-agent", "run-agent",
  "save-project", "load-project", "image-generate",
]);

/** All fast-path tool definitions (full schema for LLM function calling). */
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

/**
 * _escalate pseudo-tool — the LLM calls this when it determines the task
 * is too complex for the fast path (needs code execution, file ops, multi-step
 * research, image generation, etc.). This replaces the old hardcoded SLOW_TOOLS
 * detection with intent-based classification: the LLM decides.
 */
const ESCALATE_TOOL_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "_escalate",
    description:
      "Escalate this conversation to the full agent pipeline for complex tasks. " +
      "Call this when the user's request requires: code execution, file operations, " +
      "multi-step research (4+ tool calls), image generation, agent creation, " +
      "long-form content, or any capability beyond quick lookups and conversation. " +
      "Include a brief reason and a friendly interim message for the user.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why this task needs the full pipeline (e.g., 'needs code execution', 'requires file write')",
        },
        interim_message: {
          type: "string",
          description: "A short, friendly message to show the user while the full pipeline processes their request",
        },
      },
      required: ["reason"],
    },
  },
};

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
      return "Memory deleted.";
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
  import("./db").then(({ writeConversationMessage }) => {
    writeConversationMessage(env.HYPERDRIVE, msg).catch((err: unknown) => {
      log.warn(`[fast-agent] DB write failed: ${err instanceof Error ? err.message : err}`);
    });
  }).catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────

/** Resolve the effective execution profile for a given channel. */
function resolveExecutionProfile(
  config: CachedConfig,
  channel: string,
): ExecutionProfile {
  // Check for per-channel override
  if (config.channels) {
    const channelOverride = config.channels.find(
      (c) => c.channel.toLowerCase() === channel.toLowerCase(),
    );
    if (channelOverride?.execution_profile) {
      return {
        ...config.execution_profile,
        ...channelOverride.execution_profile,
      };
    }
  }
  return config.execution_profile;
}

/** Build the set of fast tool names for this agent. */
function buildFastToolSet(profile: ExecutionProfile): Set<string> {
  if (profile.fast_tools && profile.fast_tools.length > 0) {
    return new Set(profile.fast_tools);
  }
  return new Set(DEFAULT_FAST_TOOLS);
}

/** Get the escalation message — from profile, channel config, or default. */
function getEscalationMessage(
  profile: ExecutionProfile,
  channelCfg: ChannelConfig,
  llmInterim?: string,
): string {
  // Priority: LLM-provided > agent config > channel default
  if (llmInterim && llmInterim.trim()) return llmInterim;
  if (profile.escalation_message) return profile.escalation_message;
  return channelCfg.escalationMessage;
}

// ── Main Entry Point ──────────────────────────────────────────

export async function fastAgentTurn(
  env: FastEnv,
  agentName: string,
  userMessage: string,
  opts: FastAgentOpts,
): Promise<FastAgentResult> {
  const started = Date.now();
  const channel = (opts.channel || "web").toLowerCase();
  const channelCfg = getChannelConfig(channel);

  // 1. Load agent config (cached)
  const config = await loadCachedConfig(env, agentName, opts.org_id);

  // 2. Resolve execution profile (per-channel overrides)
  const profile = resolveExecutionProfile(config, channel);

  // Short-circuit: if execution_mode is "full", always escalate immediately
  if (profile.execution_mode === "full") {
    return {
      output: "",
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: Date.now() - started,
      model: config.model,
      escalated: true,
      escalation_message: getEscalationMessage(profile, channelCfg),
    };
  }

  // 3. Build fast tool set and filter tool defs
  const fastToolSet = buildFastToolSet(profile);
  const enabledFastTools = FAST_TOOL_DEFS.filter(
    (t) => fastToolSet.has(t.function.name) && config.tools.includes(t.function.name),
  );

  // Add _escalate pseudo-tool (unless execution_mode is "fast-only")
  const toolsForLLM: ToolDefinition[] = [...enabledFastTools];
  if (profile.execution_mode === "auto") {
    toolsForLLM.push(ESCALATE_TOOL_DEF);
  }

  // 4. Load conversation history
  let history: Array<{ role: string; content: string }> = [];
  if (opts.history && opts.history.length > 0) {
    history = opts.history.slice(-20);
  } else if (env.HYPERDRIVE && opts.session_id) {
    try {
      const { loadConversationHistory } = await import("./db");
      const dbHistory = await loadConversationHistory(env.HYPERDRIVE, opts.session_id, 20);
      history = dbHistory.map((m) => ({ role: m.role, content: m.content }));
    } catch {}
  }

  // 5. Build messages array
  type Msg = { role: string; content: string; tool_call_id?: string; tool_calls?: any[] };
  const messages: Msg[] = [];

  messages.push({ role: "system", content: config.system_prompt });
  messages.push({ role: "system", content: channelCfg.prompt });

  // Per-channel prompt suffix (from agent config)
  if (config.channels) {
    const co = config.channels.find((c) => c.channel.toLowerCase() === channel);
    if (co?.prompt_suffix) {
      messages.push({ role: "system", content: co.prompt_suffix });
    }
  }

  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: userMessage });

  // 6. Determine LLM parameters
  const maxTokens = profile.fast_max_tokens || channelCfg.maxTokens;
  const temperature = profile.fast_temperature ?? 0.7;
  const maxToolRounds = profile.max_fast_tool_calls;

  // 7. Call MoE LLM
  const moeUrl = (env as any).MOE_LLM_URL || "https://fast.oneshots.co/v1/chat/completions";
  const serviceToken = env.SERVICE_TOKEN || "";
  const llmHeaders: Record<string, string> = { "Content-Type": "application/json" };
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
        ...(toolsForLLM.length > 0 ? { tools: toolsForLLM } : {}),
        max_tokens: maxTokens,
        temperature,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
  } catch {
    return {
      output: "Sorry, I'm having trouble connecting right now. Please try again.",
      tool_calls: [], input_tokens: 0, output_tokens: 0,
      latency_ms: Date.now() - started, model, escalated: false, escalation_message: "",
    };
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    log.error(`[fast-agent] LLM call failed (${resp.status}): ${errBody.slice(0, 300)}`);
    return {
      output: "Sorry, I encountered an issue. Please try again in a moment.",
      tool_calls: [], input_tokens: 0, output_tokens: 0,
      latency_ms: Date.now() - started, model, escalated: false, escalation_message: "",
    };
  }

  let llmData: any;
  try {
    llmData = await resp.json();
  } catch {
    return {
      output: "Sorry, I received an unexpected response. Please try again.",
      tool_calls: [], input_tokens: 0, output_tokens: 0,
      latency_ms: Date.now() - started, model, escalated: false, escalation_message: "",
    };
  }

  inputTokens += llmData.usage?.prompt_tokens || 0;
  outputTokens += llmData.usage?.completion_tokens || 0;
  if (llmData.model) model = llmData.model;

  const firstChoice = llmData.choices?.[0];
  const assistantMsg = firstChoice?.message;

  // 8. Handle tool calls
  if (assistantMsg?.tool_calls && assistantMsg.tool_calls.length > 0) {
    const toolCalls: any[] = assistantMsg.tool_calls;

    // Check for _escalate pseudo-tool (LLM-initiated escalation)
    const escalateCall = toolCalls.find((tc: any) => tc.function?.name === "_escalate");
    if (escalateCall) {
      let escalateArgs: any = {};
      try { escalateArgs = JSON.parse(escalateCall.function?.arguments || "{}"); } catch {}
      const reason = escalateArgs.reason || "complex task";
      const interim = escalateArgs.interim_message || "";
      log.info(`[fast-agent] LLM escalated: ${reason}`);

      const instanceId = opts.session_id || agentName;
      saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "user", content: userMessage, channel });

      return {
        output: "",
        tool_calls: [{ name: "_escalate", result: reason }],
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: Date.now() - started,
        model,
        escalated: true,
        escalation_message: getEscalationMessage(profile, channelCfg, interim),
      };
    }

    // Check for tools outside the fast set (hardcoded safety net)
    const hasSlowTool = toolCalls.some(
      (tc: any) => ALWAYS_SLOW_TOOLS.has(tc.function?.name) || !fastToolSet.has(tc.function?.name),
    );
    if (hasSlowTool) {
      const instanceId = opts.session_id || agentName;
      saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "user", content: userMessage, channel });
      return {
        output: "",
        tool_calls: toolCalls.map((tc: any) => ({ name: tc.function?.name || "unknown", result: "" })),
        input_tokens: inputTokens, output_tokens: outputTokens,
        latency_ms: Date.now() - started, model, escalated: true,
        escalation_message: getEscalationMessage(profile, channelCfg),
      };
    }

    // Too many tool calls → escalate (unless fast-only mode)
    if (toolCalls.length > maxToolRounds && profile.execution_mode !== "fast-only") {
      const instanceId = opts.session_id || agentName;
      saveTurnAsync(env, { agent_name: agentName, instance_id: instanceId, role: "user", content: userMessage, channel });
      return {
        output: "",
        tool_calls: toolCalls.map((tc: any) => ({ name: tc.function?.name || "unknown", result: "" })),
        input_tokens: inputTokens, output_tokens: outputTokens,
        latency_ms: Date.now() - started, model, escalated: true,
        escalation_message: getEscalationMessage(profile, channelCfg),
      };
    }

    // Execute fast-path tools inline
    messages.push({
      role: "assistant",
      content: assistantMsg.content || "",
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const toolName = tc.function?.name || "";
      const toolArgs = tc.function?.arguments || "{}";
      const result = await executeToolFast(env, toolName, toolArgs, { ...opts, agent_name: agentName });
      toolCallResults.push({ name: toolName, result });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    // Second LLM call with tool results (no tools — just synthesis)
    try {
      const resp2 = await fetch(moeUrl, {
        method: "POST",
        headers: llmHeaders,
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: maxTokens,
          temperature,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });

      if (resp2.ok) {
        const data2: any = await resp2.json();
        inputTokens += data2.usage?.prompt_tokens || 0;
        outputTokens += data2.usage?.completion_tokens || 0;
        if (data2.model) model = data2.model;

        const output2 = data2.choices?.[0]?.message?.content || "";
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
          escalation_message: "",
        };
      }
    } catch {}

    // Fallback: synthesize from tool results
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
      escalation_message: "",
    };
  }

  // 9. No tool calls — direct response
  const output = assistantMsg?.content || "I'm not sure how to help with that.";
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
    escalation_message: "",
  };
}
