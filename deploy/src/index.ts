/**
 * AgentOS — Cloudflare Agents Deployment (Modernized)
 *
 * Uses Cloudflare Agents SDK patterns:
 *   - @callable() methods for type-safe RPC
 *   - Dedicated MCP server agent for MCP protocol support
 *   - this.schedule() / this.queue() for job orchestration
 *   - this.sql`` for persistent state
 *   - routeAgentRequest for URL-based agent dispatch
 */

import {
  Agent,
  AgentNamespace,
  Connection,
  callable,
  routeAgentRequest,
  type StreamingResponse,
} from "agents";
import { McpAgent } from "agents/mcp";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  AGENTOS_AGENT: AgentNamespace<AgentOSAgent>;
  AGENTOS_MCP: AgentNamespace<AgentOSMcpServer>;
  AI: Ai;
  ASSETS: Fetcher;
  VECTORIZE: VectorizeIndex;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GMI_API_KEY?: string;
  E2B_API_KEY?: string;
  AUTH_JWT_SECRET?: string;
  DEFAULT_PROVIDER: string;
  DEFAULT_MODEL: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentState {
  config: AgentConfig;
  working: Record<string, unknown>;
  turnCount: number;
  sessionActive: boolean;
  totalCostUsd: number;
}

interface AgentConfig {
  provider: string;
  model: string;
  maxTurns: number;
  budgetLimitUsd: number;
  blockedTools: string[];
  systemPrompt: string;
  agentName: string;
  agentDescription: string;
}

interface TurnResult {
  turn: number;
  content: string;
  toolResults: any[];
  done: boolean;
  error?: string;
  costUsd: number;
  model: string;
}

// ---------------------------------------------------------------------------
// AgentOS Agent — main agent with @callable methods
// ---------------------------------------------------------------------------

export class AgentOSAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    config: {
      provider: "workers-ai",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      maxTurns: 50,
      budgetLimitUsd: 10.0,
      blockedTools: [],
      systemPrompt: "You are a helpful AI assistant.",
      agentName: "agentos",
      agentDescription: "AgentOS Agent",
    },
    working: {},
    turnCount: 0,
    sessionActive: false,
    totalCostUsd: 0,
  };

  async onStart() {
    // Initialize SQL tables for persistent state
    this.sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      turns INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      model TEXT DEFAULT '',
      status TEXT DEFAULT 'completed',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments TEXT DEFAULT '{}',
      result TEXT DEFAULT '',
      error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      task_input TEXT NOT NULL,
      cron_or_delay TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      task_input TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT (datetime('now'))
    )`;
  }

  // ── Callable Methods (RPC from client) ──────────────────────────

  @callable()
  async run(input: string): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    const config = this.state.config;
    const messages: any[] = [
      { role: "system", content: config.systemPrompt },
      { role: "user", content: input },
    ];

    // Load episodic memory context
    const episodes = this.sql<{ input: string; output: string }>`
      SELECT input, output FROM episodes ORDER BY rowid DESC LIMIT 5
    `;
    if (episodes.length > 0) {
      const context = episodes.map(e => `Q: ${e.input}\nA: ${e.output}`).join("\n");
      messages[0].content += `\n\n[Memory]\n${context}`;
    }

    this.setState({ ...this.state, sessionActive: true, turnCount: 0 });

    for (let turn = 1; turn <= config.maxTurns; turn++) {
      if (this.state.totalCostUsd >= config.budgetLimitUsd) {
        results.push({ turn, content: "", toolResults: [], done: true, error: "Budget exhausted", costUsd: 0, model: config.model });
        break;
      }

      const response = await this._callLLM(messages);

      this.setState({ ...this.state, turnCount: turn, totalCostUsd: this.state.totalCostUsd + response.costUsd });

      if (response.toolCalls.length > 0) {
        const toolResults = await this._executeTools(response.toolCalls);
        results.push({ turn, content: response.content, toolResults, done: false, costUsd: response.costUsd, model: response.model });

        // Add tool results to conversation
        messages.push({ role: "assistant", content: response.content });
        for (const tr of toolResults) {
          messages.push({ role: "tool", content: JSON.stringify(tr) });
        }
      } else {
        results.push({ turn, content: response.content, toolResults: [], done: true, costUsd: response.costUsd, model: response.model });

        // Store in episodic memory
        const sessionId = crypto.randomUUID().slice(0, 16);
        this.sql`INSERT INTO episodes (id, input, output) VALUES (${sessionId}, ${input}, ${response.content})`;
        this.sql`INSERT INTO sessions (id, input, output, turns, cost_usd, model) VALUES (${sessionId}, ${input}, ${response.content}, ${turn}, ${this.state.totalCostUsd}, ${response.model})`;
        break;
      }
    }

    this.setState({ ...this.state, sessionActive: false });
    return results;
  }

  @callable()
  getConfig(): AgentConfig {
    return this.state.config;
  }

  @callable()
  setConfig(config: Partial<AgentConfig>): AgentConfig {
    const updated = { ...this.state.config, ...config };
    this.setState({ ...this.state, config: updated });
    return updated;
  }

  @callable()
  getWorkingMemory(): Record<string, unknown> {
    return this.state.working;
  }

  @callable()
  setWorkingMemory(key: string, value: unknown): void {
    const working = { ...this.state.working, [key]: value };
    this.setState({ ...this.state, working });
  }

  @callable()
  getSessions(limit: number = 20): any[] {
    return this.sql`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  getEpisodes(limit: number = 20): any[] {
    return this.sql`SELECT * FROM episodes ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable()
  getStats(): any {
    const sessions = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM sessions`;
    const totalCost = this.sql<{ total: number }>`SELECT COALESCE(SUM(cost_usd), 0) as total FROM sessions`;
    return {
      totalSessions: sessions[0]?.cnt ?? 0,
      totalCostUsd: totalCost[0]?.total ?? 0,
      turnCount: this.state.turnCount,
      sessionActive: this.state.sessionActive,
      config: this.state.config,
    };
  }

  // ── Scheduling (cron jobs) ──────────────────────────────────────

  @callable()
  scheduleTask(taskInput: string, cronOrDelay: string | number): string {
    const id = crypto.randomUUID().slice(0, 12);
    this.sql`INSERT INTO schedules (id, task_input, cron_or_delay) VALUES (${id}, ${taskInput}, ${String(cronOrDelay)})`;
    if (typeof cronOrDelay === "string") {
      this.schedule(cronOrDelay, "runScheduledTask", { id, taskInput });
    } else {
      this.schedule(cronOrDelay, "runScheduledTask", { id, taskInput });
    }
    return id;
  }

  async runScheduledTask(payload: { id: string; taskInput: string }) {
    await this.run(payload.taskInput);
  }

  @callable()
  getSchedules(): any[] {
    return this.sql`SELECT * FROM schedules ORDER BY created_at DESC LIMIT 100`;
  }

  // ── Queueing (async jobs) ──────────────────────────────────────

  @callable()
  enqueueJob(taskInput: string, priority: number = 0): string {
    const jobId = crypto.randomUUID().slice(0, 16);
    this.sql`INSERT INTO jobs (id, task_input, priority, status) VALUES (${jobId}, ${taskInput}, ${priority}, 'queued')`;
    this.queue("processJob", { jobId, taskInput, priority });
    return jobId;
  }

  async processJob(payload: { jobId: string; taskInput: string; priority?: number }) {
    this.sql`UPDATE jobs SET status = 'running' WHERE id = ${payload.jobId}`;
    try {
      const results = await this.run(payload.taskInput);
      this.sql`UPDATE jobs SET status = 'completed' WHERE id = ${payload.jobId}`;
      return results;
    } catch (err) {
      this.sql`UPDATE jobs SET status = 'failed' WHERE id = ${payload.jobId}`;
      throw err;
    }
  }

  // ── HTTP Handler ────────────────────────────────────────────────

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").pop() || "";

    if (path !== "health") {
      const authorized = await this._isAuthorized(request);
      if (!authorized) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Health
    if (path === "health") {
      return Response.json({ status: "ok", agent: this.state.config.agentName });
    }

    // Run
    if (path === "run" && request.method === "POST") {
      const { input } = await request.json() as { input: string };
      const results = await this.run(input);
      const last = results[results.length - 1];
      return Response.json({
        success: !last?.error,
        output: last?.content ?? "",
        turns: results.length,
        costUsd: this.state.totalCostUsd,
        turnResults: results,
      });
    }

    // Config
    if (path === "config" && request.method === "GET") {
      return Response.json(this.getConfig());
    }
    if (path === "config" && request.method === "PUT") {
      const config = await request.json();
      return Response.json(this.setConfig(config));
    }

    // Stats
    if (path === "stats") {
      return Response.json(this.getStats());
    }

    // Sessions
    if (path === "sessions") {
      return Response.json(this.getSessions());
    }

    // Memory
    if (path === "memory") {
      return Response.json({
        working: this.getWorkingMemory(),
        episodes: this.getEpisodes(),
        procedures: [],
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private async _isAuthorized(request: Request): Promise<boolean> {
    const secret = this.env.AUTH_JWT_SECRET;
    if (!secret) return true;
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return false;
    const token = auth.slice(7).trim();
    return verifyHs256Jwt(token, secret);
  }

  // ── WebSocket (real-time streaming) ─────────────────────────────

  async onConnect(connection: Connection) {
    connection.send(JSON.stringify({ type: "connected", agent: this.state.config.agentName }));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

    if (data.type === "run") {
      const results = await this.run(data.input);
      for (const result of results) {
        connection.send(JSON.stringify({ type: "turn", ...result }));
      }
      connection.send(JSON.stringify({ type: "done" }));
    }
  }

  // ── LLM Routing (Workers AI / GMI / Anthropic / OpenAI) ────────

  private async _callLLM(messages: any[]): Promise<{
    content: string; model: string; toolCalls: any[];
    inputTokens: number; outputTokens: number; costUsd: number;
  }> {
    const config = this.state.config;
    const provider = config.provider || this.env.DEFAULT_PROVIDER;
    const model = config.model || this.env.DEFAULT_MODEL;
    const start = Date.now();

    try {
      if (provider === "workers-ai") {
        const result = await this.env.AI.run(model as any, { messages }) as any;
        return {
          content: result.response || "",
          model,
          toolCalls: [],
          inputTokens: 0, outputTokens: 0,
          costUsd: 0, // Workers AI pricing handled by Cloudflare
        };
      }

      // GMI / OpenAI-compatible
      if (provider === "gmi" || provider === "openai") {
        const apiBase = provider === "gmi"
          ? "https://api.gmi-serving.com/v1"
          : "https://api.openai.com/v1";
        const apiKey = provider === "gmi"
          ? this.env.GMI_API_KEY
          : this.env.OPENAI_API_KEY;
        if (!apiKey) {
          return {
            content: `${provider.toUpperCase()} API key not configured`,
            model,
            toolCalls: [],
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          };
        }

        const resp = await fetch(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages, max_tokens: 4096 }),
        });
        const data = await resp.json() as any;
        const choice = data.choices?.[0] || {};
        return {
          content: choice.message?.content || "",
          model: data.model || model,
          toolCalls: choice.message?.tool_calls || [],
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          costUsd: 0, // Tracked by billing system
        };
      }

      // Anthropic
      if (provider === "anthropic") {
        const systemMsg = messages.find((m: any) => m.role === "system")?.content || "";
        const chatMsgs = messages.filter((m: any) => m.role !== "system");
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model, messages: chatMsgs, system: systemMsg, max_tokens: 4096 }),
        });
        const data = await resp.json() as any;
        const content = data.content?.map((b: any) => b.text).join("") || "";
        return {
          content,
          model: data.model || model,
          toolCalls: data.content?.filter((b: any) => b.type === "tool_use") || [],
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          costUsd: 0,
        };
      }

      return { content: "Unknown provider", model, toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
    } catch (err: any) {
      return { content: `Error: ${err.message}`, model, toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
    }
  }

  // ── Tool Execution ──────────────────────────────────────────────

  private async _executeTools(toolCalls: any[]): Promise<any[]> {
    const results: any[] = [];
    for (const tc of toolCalls) {
      const name = tc.name || tc.function?.name || "";
      const args = tc.arguments || tc.input || tc.function?.arguments || {};
      const parsedArgs = typeof args === "string" ? JSON.parse(args) : args;

      try {
        const result = await this._runTool(name, parsedArgs);
        results.push({ tool: name, result });
      } catch (err: any) {
        results.push({ tool: name, error: err.message });
      }
    }
    return results;
  }

  private async _runTool(name: string, args: any): Promise<string> {
    switch (name) {
      case "web_search":
      case "web-search":
        return `Search results for: ${args.query} (implement with actual search API)`;

      case "vectorize_query":
      case "knowledge-search": {
        const embedding = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [args.query] }) as any;
        const results = await this.env.VECTORIZE.query(embedding.data[0], { topK: args.top_k || 5 });
        return JSON.stringify(results.matches);
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyHs256Jwt(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToBytes(signatureB64);
    const valid = await crypto.subtle.verify("HMAC", key, signature, signingInput);
    if (!valid) return false;
    const payloadRaw = new TextDecoder().decode(base64UrlToBytes(payloadB64));
    const payload = JSON.parse(payloadRaw) as { exp?: number };
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MCP Server Agent — exposes tools via Model Context Protocol
// ---------------------------------------------------------------------------

export class AgentOSMcpServer extends McpAgent<Env> {
  async onStart() {
    // MCP tools are registered here
  }

  async onRequest(request: Request): Promise<Response> {
    // MCP JSON-RPC handler
    if (request.method === "POST") {
      const body = await request.json() as any;
      const method = body.method;

      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agentos-mcp", version: "0.2.0" },
          },
        });
      }

      if (method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            tools: [
              {
                name: "run-agent",
                description: "Run an AgentOS agent on a task",
                inputSchema: {
                  type: "object",
                  properties: {
                    agent_name: { type: "string", description: "Agent name" },
                    task: { type: "string", description: "Task to execute" },
                  },
                  required: ["task"],
                },
              },
              {
                name: "search-knowledge",
                description: "Search the agent's knowledge base",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Search query" },
                  },
                  required: ["query"],
                },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        const toolName = body.params?.name;
        const args = body.params?.arguments || {};

        if (toolName === "run-agent") {
          // Delegate to the main agent
          const agentId = this.env.AGENTOS_AGENT.idFromName(args.agent_name || "default");
          const agent = this.env.AGENTOS_AGENT.get(agentId);
          const resp = await agent.fetch(new Request("http://internal/run", {
            method: "POST",
            body: JSON.stringify({ input: args.task }),
          }));
          const result = await resp.json();
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }] },
          });
        }

        if (toolName === "search-knowledge") {
          const query = String(args.query || "");
          if (!query.trim()) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: { content: [{ type: "text", text: "query is required" }], isError: true },
            });
          }
          try {
            const agentId = this.env.AGENTOS_AGENT.idFromName("default");
            const agent = this.env.AGENTOS_AGENT.get(agentId);
            const resp = await agent.fetch(new Request("http://internal/run", {
              method: "POST",
              body: JSON.stringify({ input: `Use knowledge search for: ${query}` }),
            }));
            const result = await resp.json();
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            });
          } catch (err: any) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text", text: `search-knowledge failed: ${err?.message || err}` }],
                isError: true,
              },
            });
          }
        }

        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] },
        });
      }

      return Response.json({
        jsonrpc: "2.0", id: body.id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }

    return new Response("MCP Server — POST JSON-RPC requests here", { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// Worker entry point — routes to agents
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route agent requests: /agents/:agent-name/:instance-name
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: "0.2.0" });
    }

    // Serve static assets (portal SPA)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
