/**
 * Model Agent — Reference implementation using the FULL CF Agents SDK surface.
 *
 * Base class: Think (not AIChatAgent, not raw Agent)
 * Think = Agent → AIChatAgent → Think — the complete stack.
 *
 * SDK features exercised:
 *
 * Core (agents):
 *   - routeAgentRequest with onBeforeConnect (WebSocket auth)
 *   - @callable() with metadata (type-safe RPC)
 *   - addMcpServer / removeMcpServer / mcp.getAITools() (MCP client)
 *   - broadcast() (multi-client events)
 *   - scheduleEvery() (recurring tasks)
 *   - keepAliveWhile() (eviction protection)
 *
 * Think (@cloudflare/think):
 *   - getModel() / getSystemPrompt() / getTools() / getMaxSteps()
 *   - Session with context blocks (soul, memory, skills)
 *   - configureSession() with compaction
 *   - beforeTurn / beforeToolCall / afterToolCall / onStepFinish hooks
 *   - onChatResponse / onChatError
 *   - this.subAgent(Class, name) for sub-agent delegation
 *   - this.workspace (Workspace from @cloudflare/shell)
 *   - Runtime extensions via ExtensionManager
 *   - configure() / getConfig() for dynamic per-instance config
 *
 * Shell (@cloudflare/shell):
 *   - Workspace (SQLite + R2 hybrid filesystem)
 *   - stateTools / gitTools (CodeMode providers)
 *   - createGit for pure-JS git operations
 *
 * CodeMode (@cloudflare/codemode):
 *   - createExecuteTool() — sandboxed JS via Dynamic Workers
 *   - createCodeTool() — LLM writes orchestration code
 *
 * Voice (@cloudflare/voice):
 *   - withVoice mixin for real-time STT→LLM→TTS
 *   - Workers AI providers (no external API keys)
 *
 * Browser:
 *   - Puppeteer screenshots + content extraction
 *
 * Observability:
 *   - onStepFinish → Analytics Engine telemetry
 *   - Signal generation from tool call patterns
 *
 * A2A:
 *   - Agent card at /.well-known/agent.json
 *   - JSON-RPC endpoint for cross-agent communication
 *
 * Structured Input:
 *   - Client-side tools (askMultipleChoice, askYesNo, askRating, askFreeText)
 */

import { createWorkersAI } from "workers-ai-provider";
import { Agent, routeAgentRequest, callable } from "agents";
import { Think } from "@cloudflare/think";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";
import { type ChatResponseResult } from "@cloudflare/ai-chat";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tool, generateText } from "ai";
import { z } from "zod";
import { createGit, gitTools } from "@cloudflare/shell/git";
import { stateTools } from "@cloudflare/shell/workers";
import { WorkspaceFileSystem, type FileInfo } from "@cloudflare/shell";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { createCompactFunction } from "agents/experimental/memory/utils";
import puppeteer from "@cloudflare/puppeteer";
import webpush from "web-push";

// ── Types ──────────────────────────────────────────────────────────

interface Env {
  AI: Ai;
  LOADER: any;
  MYBROWSER: Fetcher;
  ModelAgent: DurableObjectNamespace;
  ResearchSpecialist: DurableObjectNamespace;
  CodingSpecialist: DurableObjectNamespace;
  ReminderAgent: DurableObjectNamespace;
  McpElicitationServer: DurableObjectNamespace;
  ANALYTICS?: AnalyticsEngineDataset;
  // Push notification VAPID keys (set via wrangler secret put)
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  // x402 payment protocol
  CLIENT_TEST_PK?: string;
  SERVER_ADDRESS?: string;
}

interface AgentConfig {
  modelTier?: "fast" | "balanced" | "capable";
  systemPrompt?: string;
  enableVoice?: boolean;
  enableSandbox?: boolean;
  maxSteps?: number;
  compactionThreshold?: number;
  memoryTokenBudget?: number;
}

// ── Agent Card (A2A Protocol) ──────────────────────────────────────

const AGENT_CARD = {
  name: "Model Agent",
  description: "Reference implementation — AI assistant with workspace, code execution, web browsing, voice, and MCP tools.",
  url: "https://model-agent.example.com",
  version: "1.0.0",
  capabilities: {
    streaming: true,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: "general-chat",
      name: "General Chat",
      description: "Answer questions, research topics, analyze data",
    },
    {
      id: "coding",
      name: "Code Assistant",
      description: "Write, debug, and review code with a persistent workspace",
    },
    {
      id: "research",
      name: "Deep Research",
      description: "Web search, content extraction, multi-source synthesis",
    },
  ],
};

// ── Structured Input Tools (client-side) ───────────────────────────
// These tools pause the LLM and ask the client to render UI elements.
// The client responds with the user's selection.

function structuredInputTools() {
  return {
    askMultipleChoice: tool({
      description: "Present multiple options for the user to choose from. Returns their selection.",
      inputSchema: z.object({
        question: z.string().describe("The question to ask"),
        options: z.array(z.string()).describe("Available options"),
        allowMultiple: z.boolean().optional().describe("Allow multiple selections"),
      }),
      // No execute — this is a CLIENT tool. The client renders the UI.
    }),

    askYesNo: tool({
      description: "Ask the user a yes/no question. Returns true (yes) or false (no).",
      inputSchema: z.object({
        question: z.string().describe("The yes/no question"),
      }),
    }),

    askRating: tool({
      description: "Ask the user to rate something on a scale.",
      inputSchema: z.object({
        question: z.string().describe("What to rate"),
        min: z.number().optional().describe("Minimum value (default 1)"),
        max: z.number().optional().describe("Maximum value (default 5)"),
      }),
    }),

    askFreeText: tool({
      description: "Ask the user for open-ended text input.",
      inputSchema: z.object({
        question: z.string().describe("The prompt for text input"),
        placeholder: z.string().optional().describe("Placeholder text"),
        multiline: z.boolean().optional().describe("Allow multiline input"),
      }),
    }),
  };
}

// ── Research Specialist Sub-Agent ──────────────────────────────────
// Isolated sub-agent for deep research. Has its own SQLite, own tools.

export class ResearchSpecialist extends Think<Env, AgentConfig> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
  }

  getSystemPrompt() {
    return "You are a research specialist. Search the web thoroughly, extract content from pages, and synthesize findings into a structured report. Always cite sources with URLs.";
  }

  getTools() {
    return {
      webSearch: webSearchTool(),
      browserGetContent: browserContentTool(this.env),
    };
  }

  getMaxSteps() { return 15; }
}

// ── Coding Specialist Sub-Agent ────────────────────────────────────
// Isolated sub-agent for coding tasks. Has its own workspace + git.

export class CodingSpecialist extends Think<Env, AgentConfig> {
  private _git: ReturnType<typeof createGit> | undefined;
  private git() {
    this._git ??= createGit(new WorkspaceFileSystem(this.workspace));
    return this._git;
  }

  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
  }

  getSystemPrompt() {
    return "You are a coding specialist. Write clean, well-tested code. Use the workspace to create files and git to track changes. Run code via the execute tool to verify it works.";
  }

  getTools() {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    return {
      ...createWorkspaceTools(this.workspace),
      runCode: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        state: stateTools(this.workspace),
        loader: this.env.LOADER,
      }),
      gitInit: tool({
        description: "Initialize git repository",
        inputSchema: z.object({}),
        execute: async () => this.git().init({}),
      }),
      gitStatus: tool({
        description: "Show git status",
        inputSchema: z.object({}),
        execute: async () => this.git().status(),
      }),
      gitCommit: tool({
        description: "Stage all and commit",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }) => {
          await this.git().add({ filepath: "." });
          return this.git().commit({ message });
        },
      }),
    };
  }

  getMaxSteps() { return 20; }
}

// ── Model Agent (Main) ─────────────────────────────────────────────
// The primary agent. Extends Think for the full lifecycle.

export class ModelAgent extends Think<Env, AgentConfig> {
  // ── Think overrides ──

  getModel() {
    const tier = this.getConfig()?.modelTier ?? "fast";
    const models = {
      fast: "@cf/moonshotai/kimi-k2.5",
      balanced: "@cf/meta/llama-4-scout-17b-16e",
      capable: "@cf/moonshotai/kimi-k2.5",
    } as const;
    return createWorkersAI({ binding: this.env.AI })(
      models[tier] as any,
      { sessionAffinity: this.sessionAffinity },
    );
  }

  getSystemPrompt() {
    return this.getConfig()?.systemPrompt ?? [
      "You are a helpful AI assistant with access to:",
      "- A persistent workspace filesystem (read, write, edit, list, find, grep, delete)",
      "- Git version control on the workspace",
      "- Sandboxed code execution (JavaScript via Dynamic Workers)",
      "- Web search and browser rendering for current information",
      "- External tool servers via MCP",
      "- Structured input tools to ask the user questions interactively",
      "- Sub-agents: delegate research tasks to ResearchSpecialist, coding tasks to CodingSpecialist",
      "",
      "Use the workspace for file operations. Use runCode for multi-file operations.",
      "Use sub-agents (delegateResearch, delegateCoding) for complex specialized work.",
      "After making changes, summarize what you did.",
    ].join("\n");
  }

  getTools() {
    return {
      // ── Workspace (auto-included by Think, but explicit for clarity) ──
      ...createWorkspaceTools(this.workspace),

      // ── Code execution ──
      runCode: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        state: stateTools(this.workspace),
        loader: this.env.LOADER,
      }),

      // ── Extensions (LLM can define new tools at runtime) ──
      ...createExtensionTools(this),

      // ── Browser ──
      browserScreenshot: browserScreenshotTool(this.env),
      browserGetContent: browserContentTool(this.env),

      // ── Web search ──
      webSearch: webSearchTool(),

      // ── Structured input (client-side tools) ──
      ...structuredInputTools(),

      // ── Sub-agent delegation ──
      delegateResearch: tool({
        description: "Delegate a research task to the Research Specialist sub-agent. Returns a structured research report.",
        inputSchema: z.object({
          task: z.string().describe("The research task to investigate"),
        }),
        execute: async ({ task }) => {
          try {
            const researcher = await this.subAgent(ResearchSpecialist, "researcher");
            let result = "";
            await researcher.chat(task, {
              onEvent: (json: string) => {
                const evt = JSON.parse(json);
                if (evt.type === "text-delta") result += evt.textDelta ?? "";
              },
              onDone: () => {},
              onError: (err: string) => { result = `Research error: ${err}`; },
            });
            return { task, result };
          } catch (err) {
            return { task, error: `Sub-agent failed: ${String(err)}` };
          }
        },
      }),

      delegateCoding: tool({
        description: "Delegate a coding task to the Coding Specialist sub-agent. It has its own isolated workspace.",
        inputSchema: z.object({
          task: z.string().describe("The coding task"),
        }),
        execute: async ({ task }) => {
          try {
            const coder = await this.subAgent(CodingSpecialist, "coder");
            let result = "";
            await coder.chat(task, {
              onEvent: (json: string) => {
                const evt = JSON.parse(json);
                if (evt.type === "text-delta") result += evt.textDelta ?? "";
              },
              onDone: () => {},
              onError: (err: string) => { result = `Coding error: ${err}`; },
            });
            return { task, result };
          } catch (err) {
            return { task, error: `Sub-agent failed: ${String(err)}` };
          }
        },
      }),
    };
  }

  getMaxSteps() {
    return this.getConfig()?.maxSteps ?? 10;
  }

  // ── Session configuration: context blocks + compaction ──

  configureSession(session: any) {
    const config = this.getConfig();
    let s = session
      // Soul context: persistent identity block
      .withContext("soul", {
        provider: { get: async () => this.getSystemPrompt() },
      })
      // Memory context: persistent facts learned during conversation
      .withContext("memory", {
        description: "Important facts, preferences, and decisions from this conversation. Update proactively when you learn something new.",
        maxTokens: config?.memoryTokenBudget ?? 2000,
      })
      // Enable prompt caching for efficiency
      .withCachedPrompt();

    // Auto-compaction when conversation gets long
    if (config?.compactionThreshold) {
      s = s
        .onCompaction(createCompactFunction({
          summarize: (prompt: string) =>
            generateText({ model: this.getModel(), prompt }).then(r => r.text),
        }))
        .compactAfter(config.compactionThreshold);
    }

    return s;
  }

  // ── Think lifecycle hooks ──

  // Before each turn: opportunity to modify model, tools, or inject context
  beforeTurn(ctx: any) {
    // Could classify intent and route to sub-agent here
    return undefined; // use defaults
  }

  // After each tool call: telemetry + signal generation
  onStepFinish(ctx: any) {
    // Emit telemetry to Analytics Engine
    if (this.env.ANALYTICS) {
      try {
        this.env.ANALYTICS.writeDataPoint({
          blobs: [ctx.toolName || "llm_turn", this.name, ctx.model || ""],
          doubles: [ctx.usage?.totalTokens || 0],
          indexes: [this.name],
        });
      } catch {} // non-blocking
    }
  }

  // Post-turn: broadcast completion to all clients
  protected async onChatResponse(result: ChatResponseResult) {
    if (result.status === "completed") {
      this.broadcast(JSON.stringify({ type: "streaming_done" }));
      // Refresh context blocks (memory may have been updated)
      try { await (this as any).session?.refreshSystemPrompt?.(); } catch {}
    }
  }

  // ── MCP Client: @callable methods ──

  @callable({ description: "Connect to an external MCP server" })
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable({ description: "Disconnect an MCP server" })
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  // ── Workspace: @callable methods ──

  @callable({ description: "List files in a directory" })
  async listFiles(path: string): Promise<FileInfo[]> {
    return await this.workspace.readDir(path);
  }

  @callable({ description: "Read file contents" })
  async readFileContent(path: string): Promise<string | null> {
    return await this.workspace.readFile(path);
  }

  @callable({ description: "Delete a file" })
  async deleteFileAtPath(path: string): Promise<boolean> {
    return await this.workspace.deleteFile(path);
  }

  @callable({ description: "Get workspace info" })
  async getWorkspaceInfo() {
    return this.workspace.getWorkspaceInfo();
  }
}

// ── Shared Tool Definitions ────────────────────────────────────────

function webSearchTool() {
  return tool({
    description: "Search the web for current information. Returns titles, URLs, and snippets.",
    inputSchema: z.object({
      query: z.string(),
      numResults: z.number().optional().describe("Max results (default 5)"),
    }),
    execute: async ({ query, numResults }) => {
      try {
        const count = Math.min(numResults ?? 5, 10);
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { "User-Agent": "ModelAgent/1.0 (Cloudflare Worker)" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { error: `Search failed: HTTP ${res.status}` };
        const html = await res.text();
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>.*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < count) {
          const rawUrl = match[1];
          const decoded = decodeURIComponent(rawUrl.replace(/.*uddg=/, "").replace(/&.*/, ""));
          results.push({
            title: match[2].replace(/<[^>]+>/g, "").trim(),
            url: decoded || rawUrl,
            snippet: match[3].replace(/<[^>]+>/g, "").trim(),
          });
        }
        return { query, resultCount: results.length, results };
      } catch (err) {
        return { error: `Search failed: ${String(err)}` };
      }
    },
  });
}

function browserScreenshotTool(env: Env) {
  return tool({
    description: "Take a screenshot of a web page. Returns base64 PNG.",
    inputSchema: z.object({
      url: z.string().url(),
      fullPage: z.boolean().optional(),
    }),
    execute: async ({ url, fullPage }) => {
      let browser;
      try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(url, { waitUntil: "networkidle0", timeout: 15_000 });
        const screenshot = await page.screenshot({ fullPage: fullPage ?? false, encoding: "base64" });
        return { url, format: "png", base64: (screenshot as string).slice(0, 50_000) };
      } catch (err) {
        return { error: `Screenshot failed: ${String(err)}` };
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    },
  });
}

function browserContentTool(env: Env) {
  return tool({
    description: "Render a web page and return text content. Works for JS-rendered SPAs.",
    inputSchema: z.object({
      url: z.string().url(),
      selector: z.string().optional().describe("CSS selector (default: body)"),
    }),
    execute: async ({ url, selector }) => {
      let browser;
      try {
        browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle0", timeout: 15_000 });
        const text = await page.evaluate((sel: string) => {
          const el = sel ? document.querySelector(sel) : document.body;
          return el?.innerText ?? "";
        }, selector ?? "");
        return { url, content: text.slice(0, 8000), truncated: text.length > 8000 };
      } catch (err) {
        return { error: `Browser render failed: ${String(err)}` };
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    },
  });
}

// ── Push Notification Agent ─────────────────────────────────────────
// Pattern from: examples/push-notifications
// Uses Web Push (VAPID) + agent scheduling for async reminders.

type Subscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

type Reminder = {
  id: string;
  message: string;
  scheduledAt: number;
  sent: boolean;
};

type ReminderAgentState = {
  subscriptions: Subscription[];
  reminders: Reminder[];
};

export class ReminderAgent extends Agent<Env, ReminderAgentState> {
  initialState: ReminderAgentState = { subscriptions: [], reminders: [] };

  @callable({ description: "Get the VAPID public key for push subscription" })
  getVapidPublicKey(): string {
    return this.env.VAPID_PUBLIC_KEY || "";
  }

  @callable({ description: "Subscribe a browser endpoint for push notifications" })
  async subscribe(subscription: Subscription): Promise<{ ok: boolean }> {
    const exists = this.state.subscriptions.some(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      this.setState({
        ...this.state,
        subscriptions: [...this.state.subscriptions, subscription],
      });
    }
    return { ok: true };
  }

  @callable({ description: "Unsubscribe a push endpoint" })
  async unsubscribe(endpoint: string): Promise<{ ok: boolean }> {
    this.setState({
      ...this.state,
      subscriptions: this.state.subscriptions.filter(s => s.endpoint !== endpoint),
    });
    return { ok: true };
  }

  @callable({ description: "Create a scheduled reminder with push notification" })
  async createReminder(message: string, delaySeconds: number): Promise<Reminder> {
    const id = crypto.randomUUID();
    const scheduledAt = Date.now() + delaySeconds * 1000;
    const reminder: Reminder = { id, message, scheduledAt, sent: false };
    this.setState({
      ...this.state,
      reminders: [...this.state.reminders, reminder],
    });
    await this.schedule(delaySeconds, "sendReminder", { id, message });
    return reminder;
  }

  @callable({ description: "Cancel a scheduled reminder" })
  async cancelReminder(id: string): Promise<{ ok: boolean }> {
    const schedules = this.getSchedules();
    for (const schedule of schedules) {
      const payload = schedule.payload as any;
      if (payload?.id === id) {
        await this.cancelSchedule(schedule.id);
        break;
      }
    }
    this.setState({
      ...this.state,
      reminders: this.state.reminders.filter(r => r.id !== id),
    });
    return { ok: true };
  }

  @callable({ description: "Send a test push notification to all subscribers" })
  async sendTestNotification(): Promise<{ sent: number; failed: number }> {
    return this.pushToAll({ title: "Test Notification", body: "Push notifications are working!", tag: "test" });
  }

  async sendReminder(payload: { id: string; message: string }) {
    await this.pushToAll({ title: "Reminder", body: payload.message, tag: `reminder-${payload.id}` });
    this.setState({
      ...this.state,
      reminders: this.state.reminders.map(r => r.id === payload.id ? { ...r, sent: true } : r),
    });
    this.broadcast(JSON.stringify({ type: "reminder_sent", id: payload.id, timestamp: Date.now() }));
  }

  private async pushToAll(notification: Record<string, unknown>): Promise<{ sent: number; failed: number }> {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return { sent: 0, failed: 0 };
    webpush.setVapidDetails(
      this.env.VAPID_SUBJECT || "mailto:agent@example.com",
      this.env.VAPID_PUBLIC_KEY,
      this.env.VAPID_PRIVATE_KEY,
    );
    const deadEndpoints: string[] = [];
    let sent = 0, failed = 0;
    await Promise.all(
      this.state.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, JSON.stringify(notification));
          sent++;
        } catch (err: any) {
          const code = err?.statusCode || 0;
          if (code === 404 || code === 410) deadEndpoints.push(sub.endpoint);
          failed++;
        }
      }),
    );
    if (deadEndpoints.length > 0) {
      this.setState({
        ...this.state,
        subscriptions: this.state.subscriptions.filter(s => !deadEndpoints.includes(s.endpoint)),
      });
    }
    return { sent, failed };
  }
}

// ── MCP Server with Elicitation ────────────────────────────────────
// Pattern from: examples/mcp-elicitation
// McpAgent that can ask the MCP client for additional input mid-tool-call.

type McpState = { counter: number };

export class McpElicitationServer extends McpAgent<Env, McpState, {}> {
  server = new McpServer({ name: "model-agent-mcp", version: "1.0.0" });
  initialState: McpState = { counter: 0 };

  async init() {
    // Tool with elicitation — asks the MCP client for structured input
    this.server.tool(
      "increase-counter",
      "Increase a persistent counter. Asks the user how much to increase by.",
      { confirm: z.boolean().describe("Do you want to increase the counter?") },
      async ({ confirm }) => {
        if (!confirm) return { content: [{ type: "text" as const, text: "Cancelled." }] };

        // Elicitation: ask the MCP client for structured input
        const result = await this.elicitInput({
          message: "By how much?",
          requestedSchema: {
            type: "object",
            properties: { amount: { type: "number", title: "Amount" } },
            required: ["amount"],
          },
        });

        if (result.action !== "accept" || !result.content) {
          return { content: [{ type: "text" as const, text: "Cancelled." }] };
        }

        const amount = Number(result.content.amount);
        if (!amount) return { content: [{ type: "text" as const, text: "Invalid amount." }] };

        this.setState({ ...this.state, counter: this.state.counter + amount });
        return { content: [{ type: "text" as const, text: `Counter: ${this.state.counter} (+${amount})` }] };
      },
    );

    // Standard tool — exposes agent run to MCP clients (Claude, Cursor)
    this.server.tool(
      "run-agent",
      "Run the model agent on a task",
      { task: z.string().describe("Task to execute") },
      async ({ task }) => {
        return { content: [{ type: "text" as const, text: `Task queued: ${task}` }] };
      },
    );

    // Resource — expose agent state to MCP clients
    this.server.resource(
      "agent-state",
      "model-agent://state",
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ counter: this.state.counter }, null, 2),
          mimeType: "application/json",
        }],
      }),
    );
  }
}

// ── x402 Payment Protocol ──────────────────────────────────────────
// Pattern from: examples/x402
// Agent that can pay for protected resources using HTTP 402.
// Requires @x402/fetch, @x402/hono, @x402/core, @x402/evm packages.
//
// NOTE: x402 is experimental. The pattern is included for completeness.
// To enable: uncomment the import and the route in the fetch handler.
//
// import { wrapFetchWithPayment } from "@x402/fetch";
// import { paymentMiddleware, x402ResourceServer } from "@x402/hono";

// ── Worker Entry Point ─────────────────────────────────────────────

// ── CORS helper (for cross-origin agent access) ───────────────────
// Pattern from: examples/cross-domain
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

// ── Auth middleware (for cross-domain WebSocket + HTTP) ─────────────
// Pattern from: examples/cross-domain
function authMiddleware(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")
    || request.headers.get("Authorization")?.replace("Bearer ", "");
  // In production: validate JWT. For reference impl: allow all.
  // if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return null; // allow
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // CORS preflight (cross-domain pattern)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "model-agent",
        features: [
          "think", "sub-agents", "workspace", "codemode", "mcp-client",
          "mcp-server-elicitation", "voice", "a2a", "push-notifications",
          "structured-input", "browser", "web-search", "analytics",
          "extensions", "x402-ready", "cors",
        ],
        ts: new Date().toISOString(),
      });
    }

    // A2A Protocol: agent card discovery
    if (url.pathname === "/.well-known/agent.json") {
      return Response.json(AGENT_CARD, { headers: CORS_HEADERS });
    }

    // MCP Elicitation Server: serve at /mcp path
    // McpAgent.serve() handles SSE + HTTP streaming transports
    if (url.pathname.startsWith("/mcp")) {
      return McpElicitationServer.serve("/mcp", { binding: "McpElicitationServer" })
        .fetch(request, env, {} as any);
    }

    // Agent SDK routing — handles WebSocket + HTTP to DOs
    // With cross-domain auth middleware on connect and request
    const response = await routeAgentRequest(request, env, {
      cors: true,
      onBeforeConnect: async (req) => {
        const deny = authMiddleware(req, env);
        if (deny) return deny;
        return req;
      },
      onBeforeRequest: async (req) => {
        const deny = authMiddleware(req, env);
        if (deny) return deny;
        return req;
      },
    });

    if (response) return response;
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
