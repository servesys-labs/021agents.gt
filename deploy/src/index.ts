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
  AGENTOS_API_KEY?: string; // Optional API key for auth
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

    // API key auth — if AGENTOS_API_KEY is set, require Bearer token
    if (this.env.AGENTOS_API_KEY) {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      // Allow health check without auth
      if (lastSegment !== "health" && token !== this.env.AGENTOS_API_KEY) {
        return jsonResponse({ error: "Unauthorized" }, 401);
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
