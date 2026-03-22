/**
 * AgentOS — Cloudflare Workers Deployment
 *
 * Maps the AgentOS composable architecture onto Cloudflare's edge platform:
 *   - Agent Harness      → CF Agents SDK (Durable Object with SQLite)
 *   - LLM Routing         → Workers AI / OpenAI / Anthropic SDKs
 *   - Hierarchical Memory → setState (working), this.sql (episodic/procedural), Vectorize (semantic)
 *   - RAG Pipeline        → Vectorize embeddings + Workers AI
 *   - Tool Execution      → MCP-style handlers registered on the Agent
 *   - Voice               → WebSocket Hibernation API
 *   - Eval Gym            → Scheduled tasks via this.schedule
 *   - API                 → Worker fetch + routeAgentRequest
 */

import {
  Agent,
  AgentNamespace,
  Connection,
  routeAgentRequest,
} from "agents";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  AGENTOS: AgentNamespace<AgentOSWorker>;
  AI: Ai;
  ASSETS: Fetcher;
  VECTORIZE: VectorizeIndex;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AGENTOS_API_KEY?: string; // Legacy API key auth (simple Bearer token)
  AUTH_JWT_SECRET?: string; // JWT signing secret for user auth
  GITHUB_CLIENT_ID?: string; // OAuth: GitHub device flow
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string; // OAuth: Google device flow
  GOOGLE_CLIENT_SECRET?: string;
  E2B_API_KEY?: string; // E2B sandbox API key
  DEFAULT_PROVIDER: string; // "workers-ai" | "openai" | "anthropic"
  DEFAULT_MODEL: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Hierarchical agent state persisted via this.setState */
interface AgentState {
  working: Record<string, unknown>;
  config: AgentConfig;
  turnCount: number;
  sessionActive: boolean;
}

interface AgentConfig {
  provider: string;
  model: string;
  maxTurns: number;
  budgetLimitUsd: number;
  spentUsd: number;
  blockedTools: string[];
  requireConfirmationForDestructive: boolean;
  systemPrompt: string;
  agentName: string;
  agentDescription: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface LLMResponse {
  content: string;
  model: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

interface TurnResult {
  turn: number;
  content: string;
  toolResults: Record<string, unknown>[];
  done: boolean;
  error?: string;
}

interface Episode {
  id: string;
  input: string;
  output: string;
  timestamp: number;
  outcome: string;
}

interface Procedure {
  name: string;
  steps: string; // JSON-serialized
  description: string;
  successCount: number;
  failureCount: number;
  lastUsed: number;
}

interface EvalTask {
  name: string;
  input: string;
  expected: string;
  graderType: "exact" | "contains" | "llm";
}

interface EvalTrialResult {
  taskName: string;
  trial: number;
  passed: boolean;
  score: number;
  latencyMs: number;
  output: string;
}

// ---------------------------------------------------------------------------
// Tool registry — MCP-style tool definitions
// ---------------------------------------------------------------------------

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, env: Env) => Promise<unknown>;
}

/** Built-in tools — extensible by registering more */
function getBuiltinTools(env: Env): MCPTool[] {
  return [
    {
      name: "web_search",
      description: "Search the web for information",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      handler: async (args) => {
        const resp = await fetch(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(String(args.query))}&format=json`
        );
        return resp.json();
      },
    },
    {
      name: "vectorize_query",
      description: "Search the knowledge base using semantic similarity",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, topK: { type: "number" } },
        required: ["query"],
      },
      handler: async (args) => {
        const embedding = await generateEmbedding(env, String(args.query));
        const results = await env.VECTORIZE.query(embedding, {
          topK: Number(args.topK) || 5,
          returnMetadata: "all",
        });
        return results.matches;
      },
    },
    {
      name: "store_knowledge",
      description: "Store a fact in the semantic knowledge base",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["id", "text"],
      },
      handler: async (args) => {
        const embedding = await generateEmbedding(env, String(args.text));
        await env.VECTORIZE.upsert([
          {
            id: String(args.id),
            values: embedding,
            metadata: {
              text: String(args.text),
              ...(args.metadata as Record<string, string> || {}),
            },
          },
        ]);
        return { stored: true, id: args.id };
      },
    },
    // ── E2B Sandbox tools ──────────────────────────────────────────────
    {
      name: "sandbox_exec",
      description: "Execute a shell command in a secure E2B sandbox. Returns stdout, stderr, and exit code.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          sandbox_id: { type: "string", description: "Existing sandbox ID (optional — creates new if omitted)" },
          timeout_ms: { type: "number", description: "Timeout in ms (default: 30000)" },
        },
        required: ["command"],
      },
      handler: async (args, env) => {
        return sandboxExec(env, String(args.command), args.sandbox_id as string | undefined, Number(args.timeout_ms) || 30000);
      },
    },
    {
      name: "sandbox_file_write",
      description: "Write a file inside the E2B sandbox filesystem",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path inside sandbox" },
          content: { type: "string", description: "File content" },
          sandbox_id: { type: "string", description: "Existing sandbox ID" },
        },
        required: ["path", "content"],
      },
      handler: async (args, env) => {
        return sandboxFileWrite(env, String(args.path), String(args.content), args.sandbox_id as string | undefined);
      },
    },
    {
      name: "sandbox_file_read",
      description: "Read a file from the E2B sandbox filesystem",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path inside sandbox" },
          sandbox_id: { type: "string", description: "Existing sandbox ID" },
        },
        required: ["path"],
      },
      handler: async (args, env) => {
        return sandboxFileRead(env, String(args.path), args.sandbox_id as string | undefined);
      },
    },
    {
      name: "sandbox_list",
      description: "List all active E2B sandboxes",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, env) => {
        return sandboxList(env);
      },
    },
    {
      name: "sandbox_kill",
      description: "Kill an E2B sandbox to free resources",
      inputSchema: {
        type: "object",
        properties: {
          sandbox_id: { type: "string", description: "Sandbox ID to kill" },
        },
        required: ["sandbox_id"],
      },
      handler: async (args, env) => {
        return sandboxKill(env, String(args.sandbox_id));
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// LLM provider abstraction
// ---------------------------------------------------------------------------

async function generateEmbedding(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  });
  return (result as { data: number[][] }).data[0];
}

// ---------------------------------------------------------------------------
// E2B Sandbox Functions
// ---------------------------------------------------------------------------

/** Cache of active sandbox instances (sandbox_id -> Sandbox) */
const activeSandboxes = new Map<string, unknown>();

/**
 * Get or create an E2B sandbox.
 * Uses the E2B REST API directly (no Node.js SDK import needed in Workers).
 */
async function getOrCreateSandbox(
  env: Env,
  sandboxId?: string,
  template = "base"
): Promise<{ sandboxId: string; isNew: boolean }> {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error("E2B_API_KEY secret is not configured. Set it with: wrangler secret put E2B_API_KEY");
  }

  // Reuse existing sandbox if provided
  if (sandboxId) {
    // Verify it's still alive
    const resp = await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}`, {
      headers: { "X-API-Key": apiKey },
    });
    if (resp.ok) {
      return { sandboxId, isNew: false };
    }
    // Sandbox died — fall through to create new one
  }

  // Create new sandbox
  const resp = await fetch("https://api.e2b.dev/sandboxes", {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      templateID: template,
      timeout: 300, // 5 min default timeout
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`E2B sandbox creation failed: ${resp.status} ${err}`);
  }

  const data = (await resp.json()) as { sandboxID: string };
  return { sandboxId: data.sandboxID, isNew: true };
}

/** Execute a shell command in an E2B sandbox */
async function sandboxExec(
  env: Env,
  command: string,
  sandboxId?: string,
  timeoutMs = 30000
): Promise<SandboxExecResult> {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY not configured");

  const { sandboxId: sid } = await getOrCreateSandbox(env, sandboxId);
  const start = Date.now();

  const resp = await fetch(`https://api.e2b.dev/sandboxes/${sid}/commands`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cmd: command,
      timeout: Math.ceil(timeoutMs / 1000),
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { sandboxId: sid, stdout: "", stderr: `E2B error: ${err}`, exitCode: -1, durationMs: Date.now() - start };
  }

  const result = (await resp.json()) as {
    stdout: string;
    stderr: string;
    exitCode: number;
  };

  return {
    sandboxId: sid,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.exitCode ?? 0,
    durationMs: Date.now() - start,
  };
}

/** Write a file in an E2B sandbox */
async function sandboxFileWrite(
  env: Env,
  path: string,
  content: string,
  sandboxId?: string
): Promise<SandboxFileResult> {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY not configured");

  const { sandboxId: sid } = await getOrCreateSandbox(env, sandboxId);

  const resp = await fetch(`https://api.e2b.dev/sandboxes/${sid}/files`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, content }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { sandboxId: sid, path, success: false, error: `Write failed: ${err}` };
  }

  return { sandboxId: sid, path, success: true };
}

/** Read a file from an E2B sandbox */
async function sandboxFileRead(
  env: Env,
  path: string,
  sandboxId?: string
): Promise<SandboxFileResult> {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY not configured");

  const { sandboxId: sid } = await getOrCreateSandbox(env, sandboxId);

  const resp = await fetch(
    `https://api.e2b.dev/sandboxes/${sid}/files?path=${encodeURIComponent(path)}`,
    { headers: { "X-API-Key": apiKey } }
  );

  if (!resp.ok) {
    const err = await resp.text();
    return { sandboxId: sid, path, success: false, error: `Read failed: ${err}` };
  }

  const data = (await resp.json()) as { content: string };
  return { sandboxId: sid, path, content: data.content, success: true };
}

/** List active sandboxes */
async function sandboxList(env: Env): Promise<{ sandboxes: { sandboxId: string; template: string; startedAt: string }[] }> {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY not configured");

  const resp = await fetch("https://api.e2b.dev/sandboxes", {
    headers: { "X-API-Key": apiKey },
  });

  if (!resp.ok) {
    return { sandboxes: [] };
  }

  const data = (await resp.json()) as { sandboxID: string; templateID: string; startedAt: string }[];
  return {
    sandboxes: data.map((s) => ({
      sandboxId: s.sandboxID,
      template: s.templateID,
      startedAt: s.startedAt,
    })),
  };
}

/** Kill a sandbox */
async function sandboxKill(env: Env, sandboxId: string): Promise<{ killed: boolean; sandboxId: string }> {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY not configured");

  const resp = await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}`, {
    method: "DELETE",
    headers: { "X-API-Key": apiKey },
  });

  return { killed: resp.ok, sandboxId };
}

/** Keep a sandbox alive for a given duration */
async function sandboxKeepAlive(env: Env, sandboxId: string, timeoutSec: number): Promise<boolean> {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY not configured");

  const resp = await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}/timeout`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ timeout: timeoutSec }),
  });

  return resp.ok;
}

// ---------------------------------------------------------------------------
// Complexity-based LLM routing (ported from Python LLMRouter)
// ---------------------------------------------------------------------------

type Complexity = "simple" | "moderate" | "complex";

const COMPLEXITY_MODELS: Record<string, Record<Complexity, string>> = {
  "workers-ai": {
    simple: "@cf/meta/llama-3.1-8b-instruct",
    moderate: "@cf/meta/llama-3.1-70b-instruct",
    complex: "@cf/meta/llama-3.1-70b-instruct",
  },
  openai: {
    simple: "gpt-4o-mini",
    moderate: "gpt-4o",
    complex: "gpt-4o",
  },
  anthropic: {
    simple: "claude-haiku-4-5-20251001",
    moderate: "claude-sonnet-4-6",
    complex: "claude-opus-4-6",
  },
};

function classifyComplexity(messages: ChatMessage[]): Complexity {
  const text = messages.map((m) => m.content).join(" ").toLowerCase();
  const wordCount = text.split(/\s+/).length;

  // Complex indicators
  const complexPatterns = [
    /multi[- ]?step/i, /compar(e|ison)/i, /analyz/i, /research/i,
    /implement/i, /architect/i, /design/i, /evaluat/i,
    /trade[- ]?off/i, /comprehensive/i, /in[- ]?depth/i,
  ];
  if (complexPatterns.some((p) => p.test(text)) || wordCount > 200) {
    return "complex";
  }

  // Simple indicators
  const simplePatterns = [
    /^(what|who|when|where|how much|yes|no|true|false)\b/i,
    /\b(define|translate|convert|list|name|spell)\b/i,
  ];
  if (simplePatterns.some((p) => p.test(text)) && wordCount < 30) {
    return "simple";
  }

  return "moderate";
}

function selectModel(provider: string, complexity: Complexity, configModel: string): string {
  const providerModels = COMPLEXITY_MODELS[provider];
  if (!providerModels) return configModel;
  return providerModels[complexity] || configModel;
}

async function callLLM(
  env: Env,
  messages: ChatMessage[],
  config: AgentConfig,
  tools?: MCPTool[]
): Promise<LLMResponse> {
  const start = Date.now();
  const provider = config.provider || env.DEFAULT_PROVIDER || "workers-ai";
  const complexity = classifyComplexity(messages);
  const model = selectModel(provider, complexity, config.model || env.DEFAULT_MODEL || "@cf/meta/llama-3.1-70b-instruct");

  if (provider === "workers-ai") {
    return callWorkersAI(env, messages, model, start, tools);
  } else if (provider === "openai") {
    return callOpenAI(env, messages, model, start, tools);
  } else if (provider === "anthropic") {
    return callAnthropic(env, messages, model, start, tools);
  }

  throw new Error(`Unknown provider: ${provider}`);
}

async function callWorkersAI(
  env: Env,
  messages: ChatMessage[],
  model: string,
  start: number,
  tools?: MCPTool[]
): Promise<LLMResponse> {
  const payload: Record<string, unknown> = { messages };
  if (tools?.length) {
    payload.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  const result = (await env.AI.run(model as BaseAiTextGenerationModels, payload)) as {
    response?: string;
    tool_calls?: { name: string; arguments: Record<string, unknown> }[];
  };

  return {
    content: result.response || "",
    model,
    toolCalls: (result.tool_calls || []).map((tc) => ({
      name: tc.name,
      arguments: tc.arguments,
    })),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0, // Workers AI is usage-based
    latencyMs: Date.now() - start,
  };
}

async function callOpenAI(
  env: Env,
  messages: ChatMessage[],
  model: string,
  start: number,
  tools?: MCPTool[]
): Promise<LLMResponse> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY secret is not configured. Set it with: wrangler secret put OPENAI_API_KEY");
  }
  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const params: Record<string, unknown> = { model, messages };
  if (tools?.length) {
    params.tools = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  const resp = await client.chat.completions.create(params as Parameters<typeof client.chat.completions.create>[0]);
  const choice = resp.choices[0];
  const toolCalls: ToolCall[] = (choice.message.tool_calls || []).map((tc) => ({
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments),
  }));

  return {
    content: choice.message.content || "",
    model: resp.model,
    toolCalls,
    inputTokens: resp.usage?.prompt_tokens || 0,
    outputTokens: resp.usage?.completion_tokens || 0,
    costUsd: 0,
    latencyMs: Date.now() - start,
  };
}

async function callAnthropic(
  env: Env,
  messages: ChatMessage[],
  model: string,
  start: number,
  tools?: MCPTool[]
): Promise<LLMResponse> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY secret is not configured. Set it with: wrangler secret put ANTHROPIC_API_KEY");
  }
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Separate system message
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system") as {
    role: "user" | "assistant";
    content: string;
  }[];

  const params: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: nonSystem,
  };
  if (systemMsg) params.system = systemMsg.content;
  if (tools?.length) {
    params.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  const resp = await client.messages.create(params as Parameters<typeof client.messages.create>[0]);
  const toolCalls: ToolCall[] = [];
  let content = "";

  for (const block of resp.content) {
    if (block.type === "text") content += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({ name: block.name, arguments: block.input as Record<string, unknown> });
    }
  }

  return {
    content,
    model: resp.model,
    toolCalls,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    costUsd: 0,
    latencyMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// AgentOS Worker — the Cloudflare Agent
// ---------------------------------------------------------------------------

export class AgentOSWorker extends Agent<Env, AgentState> {
  private tools: MCPTool[] = [];

  // ---- Lifecycle ----

  /** Called on first instantiation — initialize SQLite tables and state */
  async onStart(): Promise<void> {
    // Create memory tables (wrapped in try-catch for resilience)
    try {
      this.sql`CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        outcome TEXT DEFAULT ''
      )`;

      this.sql`CREATE TABLE IF NOT EXISTS procedures (
        name TEXT PRIMARY KEY,
        steps TEXT NOT NULL,
        description TEXT DEFAULT '',
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        last_used INTEGER NOT NULL
      )`;

      // Sessions — mirrors Python AgentDB.sessions (compliance & audit)
      this.sql`CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        agent_version TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unknown',
        stop_reason TEXT NOT NULL DEFAULT 'completed',
        stop_initiated_by TEXT NOT NULL DEFAULT '',
        is_finished INTEGER NOT NULL DEFAULT 0,
        finish_accepted INTEGER,
        error_attribution TEXT,
        step_count INTEGER NOT NULL DEFAULT 0,
        action_count INTEGER NOT NULL DEFAULT 0,
        time_to_first_action_ms REAL NOT NULL DEFAULT 0.0,
        wall_clock_seconds REAL NOT NULL DEFAULT 0.0,
        input_text TEXT NOT NULL DEFAULT '',
        output_text TEXT NOT NULL DEFAULT '',
        cost_llm_input_usd REAL NOT NULL DEFAULT 0.0,
        cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
        cost_tool_usd REAL NOT NULL DEFAULT 0.0,
        cost_total_usd REAL NOT NULL DEFAULT 0.0,
        benchmark_cost_llm_input_usd REAL NOT NULL DEFAULT 0.0,
        benchmark_cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
        benchmark_cost_tool_usd REAL NOT NULL DEFAULT 0.0,
        benchmark_cost_total_usd REAL NOT NULL DEFAULT 0.0,
        composition_json TEXT NOT NULL DEFAULT '{}',
        eval_score REAL,
        eval_passed INTEGER,
        eval_task_name TEXT NOT NULL DEFAULT '',
        eval_conditions_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )`;

      // Turns — per-turn detail within a session
      this.sql`CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        model_used TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0.0,
        llm_content TEXT NOT NULL DEFAULT '',
        cost_llm_input_usd REAL NOT NULL DEFAULT 0.0,
        cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
        cost_tool_usd REAL NOT NULL DEFAULT 0.0,
        cost_total_usd REAL NOT NULL DEFAULT 0.0,
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        tool_results_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]'
      )`;

      // Errors — structured error log
      this.sql`CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        tool_name TEXT,
        turn INTEGER NOT NULL DEFAULT 0,
        recoverable INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`;

      this.sql`CREATE TABLE IF NOT EXISTS eval_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name TEXT NOT NULL,
        trial INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        score REAL NOT NULL,
        latency_ms REAL NOT NULL,
        output TEXT DEFAULT '',
        created_at INTEGER NOT NULL
      )`;

      // Eval runs — aggregate eval reports (mirrors Python eval_runs table)
      this.sql`CREATE TABLE IF NOT EXISTS eval_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL DEFAULT '',
        agent_version TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        benchmark_name TEXT NOT NULL DEFAULT '',
        benchmark_version TEXT NOT NULL DEFAULT '',
        grader_type TEXT NOT NULL DEFAULT '',
        protocol TEXT NOT NULL DEFAULT 'agentos',
        total_tasks INTEGER NOT NULL DEFAULT 0,
        total_trials INTEGER NOT NULL DEFAULT 0,
        pass_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        pass_rate REAL NOT NULL DEFAULT 0.0,
        avg_score REAL NOT NULL DEFAULT 0.0,
        avg_latency_ms REAL NOT NULL DEFAULT 0.0,
        total_cost_usd REAL NOT NULL DEFAULT 0.0,
        benchmark_cost_usd REAL NOT NULL DEFAULT 0.0,
        avg_tool_calls REAL NOT NULL DEFAULT 0.0,
        tool_efficiency REAL NOT NULL DEFAULT 1.0,
        pass_at_1 REAL,
        pass_at_3 REAL,
        eval_conditions_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )`;

      // User accounts table
      this.sql`CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT DEFAULT '',
        password_hash TEXT DEFAULT '',
        provider TEXT DEFAULT 'email',
        created_at INTEGER NOT NULL
      )`;

      // E2B sandbox sessions table
      this.sql`CREATE TABLE IF NOT EXISTS sandbox_sessions (
        sandbox_id TEXT PRIMARY KEY,
        agent_name TEXT DEFAULT '',
        template TEXT DEFAULT 'base',
        status TEXT DEFAULT 'running',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        keep_alive_ms INTEGER DEFAULT 300000
      )`;

      // Evolution proposals — mirrors Python proposals table
      this.sql`CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        modification_json TEXT NOT NULL DEFAULT '{}',
        priority REAL NOT NULL DEFAULT 0.0,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        surfaced INTEGER NOT NULL DEFAULT 0,
        applied_version TEXT NOT NULL DEFAULT '',
        reviewer_note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER
      )`;

      // Evolution entries — mirrors Python evolution_entries table
      this.sql`CREATE TABLE IF NOT EXISTS evolution_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        previous_version TEXT NOT NULL,
        proposal_id TEXT NOT NULL DEFAULT '',
        proposal_title TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        modification_json TEXT NOT NULL DEFAULT '{}',
        previous_config_json TEXT NOT NULL DEFAULT '{}',
        new_config_json TEXT NOT NULL DEFAULT '{}',
        reviewer TEXT NOT NULL DEFAULT '',
        reviewer_note TEXT NOT NULL DEFAULT '',
        metrics_before_json TEXT NOT NULL DEFAULT '{}',
        metrics_after_json TEXT NOT NULL DEFAULT '{}',
        impact_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )`;

      // Cost ledger — persistent cost tracking
      this.sql`CREATE TABLE IF NOT EXISTS cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0,
        created_at INTEGER NOT NULL
      )`;

      // Facts — semantic memory
      this.sql`CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL DEFAULT '""',
        embedding_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`;
    } catch (err) {
      console.error("Failed to initialize SQL tables:", err);
    }

    // Initialize state if empty
    if (!this.state?.config) {
      this.setState({
        working: {},
        config: {
          provider: this.env.DEFAULT_PROVIDER || "workers-ai",
          model: this.env.DEFAULT_MODEL || "@cf/meta/llama-3.1-70b-instruct",
          maxTurns: 50,
          budgetLimitUsd: 10.0,
          spentUsd: 0,
          blockedTools: [],
          requireConfirmationForDestructive: true,
          systemPrompt: "",
          agentName: "",
          agentDescription: "",
        },
        turnCount: 0,
        sessionActive: false,
      });
    }

    this.tools = getBuiltinTools(this.env);
  }

  // ---- HTTP API ----

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1] || "";
    const lastTwoSegments = segments.slice(-2).join("/");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Auth: public routes skip auth checks
    const isPublicRoute = lastSegment === "health"
      || lastTwoSegments === "auth/signup"
      || lastTwoSegments === "auth/login"
      || lastTwoSegments === "auth/device";

    if (!isPublicRoute) {
      const authHeader = request.headers.get("Authorization") || "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

      if (bearerToken) {
        // Try JWT first, then legacy API key
        const jwtSecret = this.env.AUTH_JWT_SECRET;
        if (jwtSecret) {
          const claims = await verifyJWT(bearerToken, jwtSecret);
          if (!claims && bearerToken !== this.env.AGENTOS_API_KEY) {
            return jsonResponse({ error: "Invalid or expired token" }, 401);
          }
        } else if (this.env.AGENTOS_API_KEY && bearerToken !== this.env.AGENTOS_API_KEY) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
      } else if (this.env.AGENTOS_API_KEY || this.env.AUTH_JWT_SECRET) {
        return jsonResponse({ error: "Authentication required" }, 401);
      }
    }

    try {
      // POST /run — execute agent task
      if (request.method === "POST" && lastSegment === "run") {
        if (!isJsonRequest(request)) {
          return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        }
        const body = await parseJsonBody<{ input: string; config?: Partial<AgentConfig> }>(request);
        if (!body || typeof body.input !== "string" || !body.input.trim()) {
          return jsonResponse({ error: "Missing required field: input" }, 400);
        }
        if (body.config) {
          this.setState({
            ...this.state,
            config: { ...this.state.config, ...body.config },
          });
        }
        const results = await this.executeTask(body.input);
        return jsonResponse(results);
      }

      // GET /health
      if (lastSegment === "health") {
        return jsonResponse({ status: "ok", version: "0.1.0", provider: this.state.config.provider });
      }

      // GET /tools
      if (lastSegment === "tools") {
        return jsonResponse(
          this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
        );
      }

      // GET /memory
      if (lastSegment === "memory") {
        const episodes = this.querySql<Episode>`SELECT * FROM episodes ORDER BY timestamp DESC LIMIT 20`;
        const procedures = this.querySql<Procedure>`SELECT * FROM procedures ORDER BY last_used DESC LIMIT 20`;
        return jsonResponse({
          working: this.state.working,
          episodes,
          procedures,
        });
      }

      // POST /memory/working — set working memory
      if (request.method === "POST" && lastTwoSegments === "memory/working") {
        if (!isJsonRequest(request)) {
          return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        }
        const data = await parseJsonBody<Record<string, unknown>>(request);
        if (!data) return jsonResponse({ error: "Invalid JSON body" }, 400);
        this.setState({ ...this.state, working: { ...this.state.working, ...data } });
        return jsonResponse({ stored: true });
      }

      // POST /ingest — RAG document ingestion
      if (request.method === "POST" && lastSegment === "ingest") {
        if (!isJsonRequest(request)) {
          return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        }
        const body = await parseJsonBody<{ documents: { id: string; text: string; metadata?: Record<string, string> }[] }>(request);
        if (!body?.documents || !Array.isArray(body.documents) || body.documents.length === 0) {
          return jsonResponse({ error: "Missing required field: documents (non-empty array)" }, 400);
        }
        if (body.documents.length > 100) {
          return jsonResponse({ error: "Too many documents (max 100 per request)" }, 400);
        }
        const vectors = await Promise.all(
          body.documents.map(async (doc) => ({
            id: doc.id,
            values: await generateEmbedding(this.env, doc.text),
            metadata: { text: doc.text, ...(doc.metadata || {}) },
          }))
        );
        await this.env.VECTORIZE.upsert(vectors);
        return jsonResponse({ ingested: vectors.length });
      }

      // POST /eval — run evaluation
      if (request.method === "POST" && lastSegment === "eval") {
        if (!isJsonRequest(request)) {
          return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        }
        const body = await parseJsonBody<{ tasks: EvalTask[]; trialsPerTask?: number }>(request);
        if (!body?.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
          return jsonResponse({ error: "Missing required field: tasks (non-empty array)" }, 400);
        }
        const report = await this.runEval(body.tasks, body.trialsPerTask || 3);
        return jsonResponse(report);
      }

      // GET /eval/report
      if (lastTwoSegments === "eval/report") {
        const results = this.querySql<EvalTrialResult>`SELECT * FROM eval_results ORDER BY created_at DESC LIMIT 100`;
        return jsonResponse(results);
      }

      // GET /config
      if (lastSegment === "config" && request.method === "GET") {
        return jsonResponse(this.state.config);
      }

      // PUT /config
      if (request.method === "PUT" && lastSegment === "config") {
        if (!isJsonRequest(request)) {
          return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        }
        const updates = await parseJsonBody<Partial<AgentConfig>>(request);
        if (!updates) return jsonResponse({ error: "Invalid JSON body" }, 400);
        this.setState({
          ...this.state,
          config: { ...this.state.config, ...updates },
        });
        return jsonResponse(this.state.config);
      }

      // ── Auth endpoints ────────────────────────────────────────

      // POST /auth/signup — create account
      if (request.method === "POST" && lastTwoSegments === "auth/signup") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ email: string; password: string; name?: string }>(request);
        if (!body?.email || !body?.password) return jsonResponse({ error: "email and password required" }, 400);
        if (body.password.length < 8) return jsonResponse({ error: "Password must be at least 8 characters" }, 400);

        const existing = this.querySql<{ user_id: string }>`SELECT user_id FROM users WHERE email = ${body.email}`;
        if (existing.length > 0) return jsonResponse({ error: "Email already registered" }, 409);

        const userId = `email:${body.email.split("@")[0]}_${Date.now().toString(36)}`;
        const passwordHash = await hashPassword(body.password);
        const name = body.name || body.email.split("@")[0];

        this.execSql`INSERT INTO users (user_id, email, name, password_hash, provider, created_at)
                     VALUES (${userId}, ${body.email}, ${name}, ${passwordHash}, 'email', ${Date.now()})`;

        const secret = this.env.AUTH_JWT_SECRET || "dev-secret";
        const token = await createJWT(
          { sub: userId, email: body.email, name, provider: "email", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86400 },
          secret
        );

        return jsonResponse({ token, user_id: userId, email: body.email, name, provider: "email" });
      }

      // POST /auth/login — email/password login
      if (request.method === "POST" && lastTwoSegments === "auth/login") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ email: string; password: string }>(request);
        if (!body?.email || !body?.password) return jsonResponse({ error: "email and password required" }, 400);

        const users = this.querySql<{ user_id: string; email: string; name: string; password_hash: string; provider: string }>`
          SELECT user_id, email, name, password_hash, provider FROM users WHERE email = ${body.email}`;
        if (users.length === 0) return jsonResponse({ error: "Invalid email or password" }, 401);

        const user = users[0];
        if (!(await verifyPassword(body.password, user.password_hash))) {
          return jsonResponse({ error: "Invalid email or password" }, 401);
        }

        const secret = this.env.AUTH_JWT_SECRET || "dev-secret";
        const token = await createJWT(
          { sub: user.user_id, email: user.email, name: user.name, provider: user.provider, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86400 },
          secret
        );

        return jsonResponse({ token, user_id: user.user_id, email: user.email, name: user.name, provider: user.provider });
      }

      // POST /auth/device — OAuth device code exchange (GitHub/Google)
      if (request.method === "POST" && lastTwoSegments === "auth/device") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ provider: string; access_token: string }>(request);
        if (!body?.provider || !body?.access_token) return jsonResponse({ error: "provider and access_token required" }, 400);

        let userId = "", email = "", name = "";

        if (body.provider === "github") {
          const resp = await fetch("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/json", "User-Agent": "AgentOS" },
          });
          const ghUser = await resp.json() as { id: number; login: string; name?: string; email?: string };
          userId = `github:${ghUser.id}`;
          name = ghUser.name || ghUser.login;
          email = ghUser.email || "";

          if (!email) {
            try {
              const emailResp = await fetch("https://api.github.com/user/emails", {
                headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/json", "User-Agent": "AgentOS" },
              });
              const emails = await emailResp.json() as { email: string; primary: boolean }[];
              const primary = emails.find((e) => e.primary);
              if (primary) email = primary.email;
            } catch {}
          }
        } else if (body.provider === "google") {
          const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${body.access_token}` },
          });
          const gUser = await resp.json() as { id: string; email: string; name: string };
          userId = `google:${gUser.id}`;
          email = gUser.email;
          name = gUser.name;
        } else {
          return jsonResponse({ error: "Unsupported provider" }, 400);
        }

        // Upsert user
        const existing = this.querySql<{ user_id: string }>`SELECT user_id FROM users WHERE user_id = ${userId}`;
        if (existing.length === 0) {
          this.execSql`INSERT INTO users (user_id, email, name, password_hash, provider, created_at)
                       VALUES (${userId}, ${email}, ${name}, '', ${body.provider}, ${Date.now()})`;
        }

        const secret = this.env.AUTH_JWT_SECRET || "dev-secret";
        const token = await createJWT(
          { sub: userId, email, name, provider: body.provider, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86400 },
          secret
        );

        return jsonResponse({ token, user_id: userId, email, name, provider: body.provider });
      }

      // GET /auth/me — current user
      if (lastTwoSegments === "auth/me") {
        const authHeader = request.headers.get("Authorization") || "";
        const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        const secret = this.env.AUTH_JWT_SECRET || "dev-secret";
        const claims = await verifyJWT(bearerToken, secret);
        if (!claims) return jsonResponse({ error: "Invalid token" }, 401);
        return jsonResponse({ user_id: claims.sub, email: claims.email, name: claims.name, provider: claims.provider });
      }

      // ── Evolution endpoints ─────────────────────────────────────

      // GET /evolution/status — current evolution state
      if (lastTwoSegments === "evolution/status" || lastSegment === "evolution") {
        const episodes = this.querySql<{ id: string }>`SELECT id FROM episodes`;
        const proposals = this.querySql<EvolutionProposal>`SELECT * FROM evolution_proposals ORDER BY priority DESC`;
        return jsonResponse({
          totalSessions: episodes.length,
          proposals: proposals,
          lastAnalyzedAt: 0,
        });
      }

      // POST /evolution/analyze — run analysis on accumulated sessions
      if (request.method === "POST" && lastTwoSegments === "evolution/analyze") {
        const report = await this.runEvolutionAnalysis();
        return jsonResponse(report);
      }

      // POST /evolution/proposals/:id/approve
      if (request.method === "POST" && segments.includes("proposals")) {
        const proposalId = segments[segments.length - 2] === "proposals" ? lastSegment : "";
        if (proposalId && lastSegment === "approve") {
          const pid = segments[segments.length - 2];
          this.execSql`UPDATE evolution_proposals SET status = 'approved' WHERE id = ${pid}`;
          return jsonResponse({ status: "approved", id: pid });
        }
        if (proposalId && lastSegment === "reject") {
          const pid = segments[segments.length - 2];
          this.execSql`UPDATE evolution_proposals SET status = 'rejected' WHERE id = ${pid}`;
          return jsonResponse({ status: "rejected", id: pid });
        }
      }

      // POST /evolution/apply — apply all approved proposals
      if (request.method === "POST" && lastTwoSegments === "evolution/apply") {
        const approved = this.querySql<EvolutionProposal>`SELECT * FROM evolution_proposals WHERE status = 'approved'`;
        if (approved.length === 0) return jsonResponse({ message: "No approved proposals to apply" });

        let config = { ...this.state.config };
        for (const proposal of approved) {
          const mod = JSON.parse(typeof proposal.modification === 'string' ? proposal.modification : JSON.stringify(proposal.modification));
          config = { ...config, ...mod };
          this.execSql`UPDATE evolution_proposals SET status = 'applied' WHERE id = ${proposal.id}`;
        }

        this.setState({ ...this.state, config });
        return jsonResponse({ applied: approved.length, config });
      }

      // ── Sandbox endpoints ──────────────────────────────────────────

      // POST /sandbox/create — create a new E2B sandbox
      if (request.method === "POST" && lastTwoSegments === "sandbox/create") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ template?: string; timeout_sec?: number }>(request);
        const template = body?.template || "base";
        const { sandboxId } = await getOrCreateSandbox(this.env, undefined, template);

        // Track in SQLite
        this.execSql`INSERT INTO sandbox_sessions (sandbox_id, template, status, created_at, last_activity_at)
                     VALUES (${sandboxId}, ${template}, 'running', ${Date.now()}, ${Date.now()})`;

        // Keep alive if requested
        if (body?.timeout_sec) {
          await sandboxKeepAlive(this.env, sandboxId, body.timeout_sec);
          this.execSql`UPDATE sandbox_sessions SET keep_alive_ms = ${body.timeout_sec * 1000} WHERE sandbox_id = ${sandboxId}`;
        }

        return jsonResponse({ sandbox_id: sandboxId, template, status: "running" });
      }

      // POST /sandbox/exec — execute command in sandbox
      if (request.method === "POST" && lastTwoSegments === "sandbox/exec") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ command: string; sandbox_id?: string; timeout_ms?: number }>(request);
        if (!body?.command) return jsonResponse({ error: "command required" }, 400);

        const result = await sandboxExec(this.env, body.command, body.sandbox_id, body.timeout_ms || 30000);

        // Track sandbox in DB if new
        if (result.sandboxId) {
          const existing = this.querySql<{ sandbox_id: string }>`SELECT sandbox_id FROM sandbox_sessions WHERE sandbox_id = ${result.sandboxId}`;
          if (existing.length === 0) {
            this.execSql`INSERT INTO sandbox_sessions (sandbox_id, template, status, created_at, last_activity_at)
                         VALUES (${result.sandboxId}, 'base', 'running', ${Date.now()}, ${Date.now()})`;
          } else {
            this.execSql`UPDATE sandbox_sessions SET last_activity_at = ${Date.now()} WHERE sandbox_id = ${result.sandboxId}`;
          }
        }

        return jsonResponse(result);
      }

      // POST /sandbox/file/write — write file in sandbox
      if (request.method === "POST" && segments.includes("sandbox") && segments.includes("file") && lastSegment === "write") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ path: string; content: string; sandbox_id?: string }>(request);
        if (!body?.path || body.content === undefined) return jsonResponse({ error: "path and content required" }, 400);
        const result = await sandboxFileWrite(this.env, body.path, body.content, body.sandbox_id);
        return jsonResponse(result);
      }

      // POST /sandbox/file/read — read file from sandbox
      if (request.method === "POST" && segments.includes("sandbox") && segments.includes("file") && lastSegment === "read") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ path: string; sandbox_id?: string }>(request);
        if (!body?.path) return jsonResponse({ error: "path required" }, 400);
        const result = await sandboxFileRead(this.env, body.path, body.sandbox_id);
        return jsonResponse(result);
      }

      // GET /sandbox/list — list all tracked sandboxes
      if (lastTwoSegments === "sandbox/list" || (lastSegment === "sandboxes" && request.method === "GET")) {
        // Merge E2B API list with local tracking
        let liveSandboxes: { sandboxId: string; template: string; startedAt: string }[] = [];
        try {
          const e2bList = await sandboxList(this.env);
          liveSandboxes = e2bList.sandboxes;
        } catch {}

        const tracked = this.querySql<SandboxSession>`SELECT * FROM sandbox_sessions ORDER BY last_activity_at DESC LIMIT 50`;

        // Mark dead sandboxes
        const liveIds = new Set(liveSandboxes.map((s) => s.sandboxId));
        for (const t of tracked) {
          if (t.status === "running" && !liveIds.has(t.sandboxId)) {
            this.execSql`UPDATE sandbox_sessions SET status = 'timeout' WHERE sandbox_id = ${t.sandboxId}`;
          }
        }

        return jsonResponse({
          live: liveSandboxes,
          tracked: tracked.map((t) => ({
            sandbox_id: t.sandboxId,
            agent_name: t.agentName,
            template: t.template,
            status: liveIds.has(t.sandboxId) ? "running" : t.status,
            created_at: t.createdAt,
            last_activity_at: t.lastActivityAt,
          })),
        });
      }

      // POST /sandbox/kill — kill a sandbox
      if (request.method === "POST" && lastTwoSegments === "sandbox/kill") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ sandbox_id: string }>(request);
        if (!body?.sandbox_id) return jsonResponse({ error: "sandbox_id required" }, 400);

        const result = await sandboxKill(this.env, body.sandbox_id);
        this.execSql`UPDATE sandbox_sessions SET status = 'killed' WHERE sandbox_id = ${body.sandbox_id}`;
        return jsonResponse(result);
      }

      // POST /sandbox/keepalive — extend sandbox timeout
      if (request.method === "POST" && lastTwoSegments === "sandbox/keepalive") {
        if (!isJsonRequest(request)) return jsonResponse({ error: "Content-Type must be application/json" }, 415);
        const body = await parseJsonBody<{ sandbox_id: string; timeout_sec?: number }>(request);
        if (!body?.sandbox_id) return jsonResponse({ error: "sandbox_id required" }, 400);

        const ok = await sandboxKeepAlive(this.env, body.sandbox_id, body.timeout_sec || 300);
        if (ok) {
          this.execSql`UPDATE sandbox_sessions SET last_activity_at = ${Date.now()} WHERE sandbox_id = ${body.sandbox_id}`;
        }
        return jsonResponse({ kept_alive: ok, sandbox_id: body.sandbox_id });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Agent error:", err);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  }

  // ---- WebSocket (Voice / Real-time) ----

  async onConnect(connection: Connection): Promise<void> {
    console.log("Client connected:", connection.id);
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsed: { type: string; payload?: unknown };

    try {
      parsed = JSON.parse(text);
    } catch {
      connection.send(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (parsed.type === "run") {
      // Stream turn results over WebSocket
      const input = String((parsed.payload as { input?: string })?.input || "");
      const results = await this.executeTask(input);
      for (const result of results) {
        connection.send(JSON.stringify({ type: "turn", data: result }));
      }
      connection.send(JSON.stringify({ type: "done" }));
    } else if (parsed.type === "set_working_memory") {
      const data = parsed.payload as Record<string, unknown>;
      this.setState({ ...this.state, working: { ...this.state.working, ...data } });
      connection.send(JSON.stringify({ type: "ack", action: "working_memory_set" }));
    }
  }

  // ---- Core Agent Loop ----

  /**
   * Execute a multi-turn agent task.
   * Follows the AgentOS initialization sequence:
   * 1. Analyze request
   * 2. Select LLM (via config)
   * 3. Load context from all memory tiers
   * 4. Discover tools
   * 5. Plan & Execute
   */
  private async executeTask(userInput: string): Promise<TurnResult[]> {
    this.setState({ ...this.state, sessionActive: true, turnCount: 0 });
    const results: TurnResult[] = [];

    // Step 3: Load context from memory tiers
    const memoryContext = await this.buildMemoryContext(userInput);

    // Step 4: Ensure tools are loaded
    if (this.tools.length === 0) {
      this.tools = getBuiltinTools(this.env);
    }

    // Step 5: Build messages and execute
    const messages: ChatMessage[] = [];
    if (memoryContext) {
      messages.push({ role: "system", content: memoryContext });
    }
    messages.push({
      role: "system",
      content: this.state.config.systemPrompt || SYSTEM_PROMPT,
    });
    messages.push({ role: "user", content: userInput });

    const toolSequence: Record<string, unknown>[] = [];

    for (let turn = 1; turn <= this.state.config.maxTurns; turn++) {
      this.setState({ ...this.state, turnCount: turn });

      // Governance: budget check
      if (this.state.config.spentUsd >= this.state.config.budgetLimitUsd) {
        results.push({ turn, content: "", toolResults: [], done: true, error: "Budget exhausted" });
        break;
      }

      // Call LLM
      const llmResp = await callLLM(this.env, messages, this.state.config, this.tools);

      // Record cost
      this.setState({
        ...this.state,
        config: {
          ...this.state.config,
          spentUsd: this.state.config.spentUsd + llmResp.costUsd,
        },
      });

      if (llmResp.toolCalls.length > 0) {
        // Execute tools
        const toolResults = await this.executeTools(llmResp.toolCalls);
        toolSequence.push(...toolResults);

        messages.push({ role: "assistant", content: llmResp.content });
        for (const tr of toolResults) {
          messages.push({ role: "tool", content: JSON.stringify(tr) });
        }

        // Check for failures — inject alternative-approach guidance
        const failed = toolResults.filter((tr) => "error" in tr);
        if (failed.length > 0) {
          const summary = failed.map((f) => `${f.tool}: ${f.error}`).join("; ");
          messages.push({
            role: "system",
            content: `Tool failures: ${summary}. Try an alternative approach. Do not repeat the same failed action.`,
          });
        }

        results.push({
          turn,
          content: llmResp.content,
          toolResults,
          done: false,
        });
      } else {
        // No tool calls — done
        results.push({ turn, content: llmResp.content, toolResults: [], done: true });

        // Store in episodic memory
        await this.storeEpisode(userInput, llmResp.content);

        // Store successful tool sequence as procedure
        if (toolSequence.length > 0) {
          await this.storeProcedure(userInput, toolSequence);
        }

        break;
      }
    }

    this.setState({ ...this.state, sessionActive: false });
    return results;
  }

  // ---- Tool Execution ----

  private async executeTools(toolCalls: ToolCall[]): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];

    for (const call of toolCalls) {
      // Governance: check blocked
      if (this.state.config.blockedTools.includes(call.name)) {
        results.push({ tool: call.name, error: "Blocked by governance policy" });
        continue;
      }

      // Governance: destructive check
      if (this.state.config.requireConfirmationForDestructive) {
        const text = JSON.stringify(call).toLowerCase();
        if (["delete", "drop", "destroy", "remove"].some((kw) => text.includes(kw))) {
          results.push({ tool: call.name, error: "Requires user confirmation (destructive action)" });
          continue;
        }
      }

      const tool = this.tools.find((t) => t.name === call.name);
      if (!tool) {
        results.push({ tool: call.name, error: `Unknown tool: ${call.name}` });
        continue;
      }

      // Schema validation
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, { type: string }> };
      if (schema.required) {
        const missing = schema.required.filter((r) => !(r in call.arguments));
        if (missing.length > 0) {
          results.push({ tool: call.name, error: `Missing required: ${missing.join(", ")}` });
          continue;
        }
      }

      // Execute with retry
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await tool.handler(call.arguments, this.env);
          results.push({ tool: call.name, result });
          lastError = "";
          break;
        } catch (err) {
          lastError = String(err);
        }
      }
      if (lastError) {
        results.push({ tool: call.name, error: lastError, attempts: 3 });
      }
    }

    return results;
  }

  // ---- SQL Helper (error-safe) ----

  private querySql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    try {
      return [...this.sql<T>(strings, ...values)];
    } catch (err) {
      console.error("SQL error:", err);
      return [];
    }
  }

  private execSql(strings: TemplateStringsArray, ...values: unknown[]): void {
    try {
      this.sql(strings, ...values);
    } catch (err) {
      console.error("SQL error:", err);
    }
  }

  // ---- Memory ----

  private async buildMemoryContext(query: string): Promise<string> {
    const sections: string[] = [];

    // Working memory
    const wm = this.state.working;
    if (Object.keys(wm).length > 0) {
      const items = Object.entries(wm)
        .slice(0, 10)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("; ");
      sections.push(`[Working Memory] ${items}`);
    }

    // Episodic memory — keyword search
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      const like = `%${words[0]}%`;
      const episodes = this.querySql<Episode>`SELECT * FROM episodes WHERE input LIKE ${like} OR output LIKE ${like} ORDER BY timestamp DESC LIMIT 3`;
      if (episodes.length > 0) {
        const lines = episodes.map((e) => `- Q: ${e.input.slice(0, 80)} A: ${e.output.slice(0, 80)}`);
        sections.push(`[Episodic Memory]\n${lines.join("\n")}`);
      }
    }

    // Procedural memory — find matching procedures
    const procedures = this.querySql<Procedure>`SELECT * FROM procedures ORDER BY success_count DESC LIMIT 3`;
    if (procedures.length > 0) {
      const matching = procedures.filter((p) => {
        const pWords = `${p.name} ${p.description}`.toLowerCase();
        return words.some((w) => pWords.includes(w));
      });
      if (matching.length > 0) {
        const lines = matching.map(
          (p) =>
            `- ${p.name} (success=${p.successCount}/${p.successCount + p.failureCount}): ${p.description.slice(0, 60)}`
        );
        sections.push(`[Procedural Memory]\n${lines.join("\n")}`);
      }
    }

    // Semantic memory — RAG via Vectorize
    try {
      const embedding = await generateEmbedding(this.env, query);
      const results = await this.env.VECTORIZE.query(embedding, {
        topK: 3,
        returnMetadata: "all",
      });
      if (results.matches.length > 0) {
        const lines = results.matches.map(
          (m) => `- [${(m.score * 100).toFixed(0)}%] ${(m.metadata as { text?: string })?.text?.slice(0, 100) || m.id}`
        );
        sections.push(`[Semantic Memory / RAG]\n${lines.join("\n")}`);
      }
    } catch {
      // Vectorize may not be configured; skip gracefully
    }

    return sections.join("\n\n");
  }

  private async storeEpisode(input: string, output: string): Promise<void> {
    const id = crypto.randomUUID();
    this.execSql`INSERT INTO episodes (id, input, output, timestamp, outcome)
             VALUES (${id}, ${input}, ${output}, ${Date.now()}, 'success')`;
  }

  private async storeProcedure(
    taskDescription: string,
    toolSequence: Record<string, unknown>[]
  ): Promise<void> {
    const name = taskDescription
      .split(/\s+/)
      .slice(0, 5)
      .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(Boolean)
      .join("_");
    if (!name) return;

    const steps = JSON.stringify(toolSequence.map((tr) => ({ tool: tr.tool, keys: Object.keys(tr) })));
    const success = toolSequence.every((tr) => !("error" in tr));

    const existing = this.querySql<Procedure>`SELECT * FROM procedures WHERE name = ${name}`;
    if (existing.length > 0) {
      if (success) {
        this.execSql`UPDATE procedures SET success_count = success_count + 1, last_used = ${Date.now()} WHERE name = ${name}`;
      } else {
        this.execSql`UPDATE procedures SET failure_count = failure_count + 1, last_used = ${Date.now()} WHERE name = ${name}`;
      }
    } else {
      this.execSql`INSERT INTO procedures (name, steps, description, success_count, failure_count, last_used)
               VALUES (${name}, ${steps}, ${taskDescription.slice(0, 120)}, ${success ? 1 : 0}, ${success ? 0 : 1}, ${Date.now()})`;
    }
  }

  // ---- Evolution Analysis (ported from Python FailureAnalyzer) ----

  private async runEvolutionAnalysis(): Promise<AnalysisReport> {
    const episodes = this.querySql<Episode>`SELECT * FROM episodes ORDER BY timestamp DESC LIMIT 100`;
    const report: AnalysisReport = {
      totalSessions: episodes.length,
      successRate: 0,
      failureClusters: [],
      toolFailureRates: {},
      unusedTools: [],
      costAnomalies: [],
      recommendations: [],
    };

    if (episodes.length < 3) {
      report.recommendations.push(`Need at least 3 sessions for analysis. Currently have ${episodes.length}.`);
      return report;
    }

    // Success rate
    const successes = episodes.filter((e) => e.outcome === "success").length;
    report.successRate = successes / episodes.length;

    // Analyze procedures for tool failure patterns
    const procedures = this.querySql<Procedure>`SELECT * FROM procedures`;
    const totalCalls: Record<string, number> = {};
    const failedCalls: Record<string, number> = {};

    for (const proc of procedures) {
      totalCalls[proc.name] = (totalCalls[proc.name] || 0) + proc.successCount + proc.failureCount;
      failedCalls[proc.name] = (failedCalls[proc.name] || 0) + proc.failureCount;
    }

    for (const [tool, total] of Object.entries(totalCalls)) {
      if (total > 0) {
        const rate = (failedCalls[tool] || 0) / total;
        report.toolFailureRates[tool] = rate;
      }
    }

    // Generate recommendations
    if (report.successRate < 0.7) {
      report.recommendations.push(
        `Success rate is ${(report.successRate * 100).toFixed(0)}% — below 70% threshold.`
      );
    }

    for (const [tool, rate] of Object.entries(report.toolFailureRates)) {
      if (rate > 0.3) {
        report.recommendations.push(
          `Tool '${tool}' fails ${(rate * 100).toFixed(0)}% of the time. Consider fixing or adding fallback.`
        );
      }
    }

    // Generate proposals from findings
    const proposals: EvolutionProposal[] = [];

    if (report.successRate < 0.5) {
      const proposal: EvolutionProposal = {
        id: crypto.randomUUID(),
        title: "Review system prompt (success rate below 50%)",
        rationale: `Success rate is ${(report.successRate * 100).toFixed(0)}%. The system prompt may need improvement.`,
        category: "prompt",
        priority: 0.9,
        status: "pending",
        modification: {},
        evidence: { successRate: report.successRate },
        createdAt: Date.now(),
      };
      proposals.push(proposal);
    }

    for (const [tool, rate] of Object.entries(report.toolFailureRates)) {
      if (rate > 0.3) {
        proposals.push({
          id: crypto.randomUUID(),
          title: `Add failure guidance for tool '${tool}'`,
          rationale: `Tool '${tool}' fails ${(rate * 100).toFixed(0)}% of calls.`,
          category: "prompt",
          priority: Math.min(0.9, rate + 0.3),
          status: "pending",
          modification: {},
          evidence: { tool, failureRate: rate },
          createdAt: Date.now(),
        });
      }
    }

    // Store proposals in SQLite
    for (const p of proposals) {
      this.execSql`INSERT OR IGNORE INTO evolution_proposals (id, title, rationale, category, priority, status, modification, evidence, created_at)
                   VALUES (${p.id}, ${p.title}, ${p.rationale}, ${p.category}, ${p.priority}, ${p.status}, ${JSON.stringify(p.modification)}, ${JSON.stringify(p.evidence)}, ${p.createdAt})`;
    }

    return report;
  }

  // ---- Eval Gym ----

  private async runEval(
    tasks: EvalTask[],
    trialsPerTask: number
  ): Promise<{
    totalTasks: number;
    totalTrials: number;
    passRate: number;
    avgLatencyMs: number;
    results: EvalTrialResult[];
  }> {
    const results: EvalTrialResult[] = [];

    for (const task of tasks) {
      for (let trial = 1; trial <= trialsPerTask; trial++) {
        const start = Date.now();
        const turnResults = await this.executeTask(task.input);
        const latencyMs = Date.now() - start;

        const output = turnResults
          .filter((r) => r.done)
          .map((r) => r.content)
          .join("");

        const { passed, score } = this.grade(task, output);

        const trialResult: EvalTrialResult = {
          taskName: task.name,
          trial,
          passed,
          score,
          latencyMs,
          output: output.slice(0, 500),
        };
        results.push(trialResult);

        // Persist
        this.execSql`INSERT INTO eval_results (task_name, trial, passed, score, latency_ms, output, created_at)
                 VALUES (${task.name}, ${trial}, ${passed ? 1 : 0}, ${score}, ${latencyMs}, ${output.slice(0, 500)}, ${Date.now()})`;
      }
    }

    const passCount = results.filter((r) => r.passed).length;
    const avgLatency = results.reduce((sum, r) => sum + r.latencyMs, 0) / (results.length || 1);

    return {
      totalTasks: tasks.length,
      totalTrials: results.length,
      passRate: results.length > 0 ? passCount / results.length : 0,
      avgLatencyMs: avgLatency,
      results,
    };
  }

  private grade(task: EvalTask, output: string): { passed: boolean; score: number } {
    const actual = output.toLowerCase().trim();
    const expected = task.expected.toLowerCase().trim();

    if (task.graderType === "exact") {
      const match = actual === expected;
      return { passed: match, score: match ? 1 : 0 };
    }
    if (task.graderType === "contains") {
      const found = actual.includes(expected);
      return { passed: found, score: found ? 1 : 0 };
    }
    // LLM grader fallback — word overlap heuristic
    const expWords = new Set(expected.split(/\s+/));
    const actWords = new Set(actual.split(/\s+/));
    let overlap = 0;
    for (const w of expWords) {
      if (actWords.has(w)) overlap++;
    }
    const score = expWords.size > 0 ? overlap / expWords.size : 0;
    return { passed: score >= 0.5, score };
  }
}

// ---------------------------------------------------------------------------
// JWT Auth (matches Python agentos/auth/jwt.py)
// ---------------------------------------------------------------------------

interface JWTClaims {
  sub: string;
  email: string;
  name: string;
  provider: string; // "github" | "google" | "email"
  iat: number;
  exp: number;
}

function b64urlEncode(data: Uint8Array): string {
  let b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function createJWT(claims: JWTClaims, secret: string): Promise<string> {
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await hmacSign(secret, `${header}.${payload}`);
  return `${header}.${payload}.${b64urlEncode(sig)}`;
}

async function verifyJWT(token: string, secret: string): Promise<JWTClaims | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return null;

    const expected = await hmacSign(secret, `${headerB64}.${payloadB64}`);
    const actual = b64urlDecode(sigB64);

    if (expected.length !== actual.length) return null;
    let match = true;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) match = false;
    }
    if (!match) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as JWTClaims;
    if (claims.exp && Date.now() / 1000 > claims.exp) return null;

    return claims;
  } catch {
    return null;
  }
}

async function hashPassword(password: string, salt?: string): Promise<string> {
  salt = salt || crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  const hash = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${salt}:${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt] = stored.split(":");
  const rehash = await hashPassword(password, salt);
  return rehash === stored;
}

// ---------------------------------------------------------------------------
// Evolution types (ported from Python agentos/evolution/)
// ---------------------------------------------------------------------------

interface EvolutionState {
  enabled: boolean;
  analyzeIntervalMs: number; // Default: 1 hour
  minSessionsForAnalysis: number;
  lastAnalyzedAt: number;
  surfaceRatio: number;
  proposals: EvolutionProposal[];
}

interface EvolutionProposal {
  id: string;
  title: string;
  rationale: string;
  category: string; // "prompt" | "tools" | "governance" | "model" | "memory"
  priority: number;
  status: string; // "pending" | "approved" | "rejected" | "applied" | "rolled_back"
  modification: Record<string, unknown>;
  evidence: Record<string, unknown>;
  createdAt: number;
}

interface AnalysisReport {
  totalSessions: number;
  successRate: number;
  failureClusters: { pattern: string; count: number; severity: number }[];
  toolFailureRates: Record<string, number>;
  unusedTools: string[];
  costAnomalies: { sessionId: string; cost: number; factor: number }[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// E2B Sandbox types
// ---------------------------------------------------------------------------

interface SandboxSession {
  sandboxId: string;
  agentName: string;
  template: string;
  status: "running" | "idle" | "killed" | "timeout";
  createdAt: number;
  lastActivityAt: number;
  keepAliveMs: number;
}

interface SandboxExecResult {
  sandboxId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface SandboxFileResult {
  sandboxId: string;
  path: string;
  content?: string;
  success: boolean;
  error?: string;
}

interface SandboxBrowserResult {
  sandboxId: string;
  url: string;
  title?: string;
  screenshot?: string; // base64
  content?: string;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Core Orchestrator of AgentOS, a production-grade, composable autonomous agent framework deployed on Cloudflare's global edge network.

You have access to tools for searching the web, querying a vector knowledge base, and storing knowledge. Use them when needed to ground your responses in facts.

Operating guidelines:
1. Safety first: never execute destructive actions without confirmation.
2. Fail gracefully: if a tool fails, try an alternative approach.
3. Transparency: explain steps taken and sources consulted.
4. Grounding: prefer retrieved knowledge over speculation.
5. Continuous learning: store useful discoveries for future use.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function isJsonRequest(request: Request): boolean {
  const ct = request.headers.get("Content-Type") || "";
  return ct.includes("application/json");
}

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Route agent requests (handles /agents/:agent/:name pattern)
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Serve static assets for non-API routes
    if (url.pathname === "/" || url.pathname.startsWith("/assets")) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ error: "Not found", hint: "Use /agents/agentos/:name/run" }, 404);
  },
} satisfies ExportedHandler<Env>;
