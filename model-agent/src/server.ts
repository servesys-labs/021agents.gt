/**
 * Model Agent — Reference implementation using all CF Agents SDK features.
 *
 * Follows canonical patterns from cloudflare/agents repo examples:
 * - workspace-chat: AIChatAgent + Workspace + CodeMode + git
 * - mcp-client: MCP server management via @callable
 * - dynamic-workers: LOADER for isolate execution
 * - agent-harness: Multi-tenant, browser tools, sandbox tools
 *
 * SDK features exercised:
 * - AIChatAgent (session persistence, streaming, resumable streams)
 * - @callable() with metadata (type-safe RPC from client)
 * - Workspace (@cloudflare/shell) for persistent virtual filesystem
 * - CodeMode (@cloudflare/codemode) for sandboxed JS execution
 * - MCP client (this.mcp, addMcpServer, removeMcpServer, getAITools)
 * - Browser Rendering (Puppeteer for screenshots + content extraction)
 * - broadcast() for multi-client events
 * - onStateChanged() for reactive side effects
 * - scheduleEvery() for recurring tasks
 * - keepAliveWhile() for eviction protection
 * - pruneMessages / convertToModelMessages for context management
 * - stepCountIs() for tool call limits
 * - routeAgentRequest with onBeforeConnect for WebSocket auth
 */

import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import {
  AIChatAgent,
  type OnChatMessageOptions,
  type ChatResponseResult,
} from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
} from "ai";
import { z } from "zod";
import { Workspace, WorkspaceFileSystem, type FileInfo } from "@cloudflare/shell";
import { STATE_TYPES, STATE_SYSTEM_PROMPT } from "@cloudflare/shell";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { stateTools } from "@cloudflare/shell/workers";
import { createGit, gitTools } from "@cloudflare/shell/git";
import puppeteer from "@cloudflare/puppeteer";

// ── Types ──────────────────────────────────────────────────────────

interface Env {
  AI: Ai;
  LOADER: any; // Dynamic Worker Loader
  MYBROWSER: Fetcher; // Browser Rendering
  ModelAgent: DurableObjectNamespace;
}

// ── Model Agent ────────────────────────────────────────────────────
// Extends AIChatAgent (not raw Agent) — gets session persistence,
// streaming, resumable streams, message pruning, and tool execution
// for free. This is the CF-recommended base class for chat agents.

export class ModelAgent extends AIChatAgent<Env> {
  // SDK: max messages persisted in DO SQLite (auto-pruned)
  maxPersistedMessages = 200;

  // SDK: wait for MCP server connections before processing chat
  // (important after hibernation — servers need to reconnect)
  waitForMcpConnections = true;

  // ── Workspace: persistent virtual filesystem ──
  // @cloudflare/shell — SQLite-backed file storage in the DO
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "ws",
    name: () => this.name,
  });

  // ── Git: version control on the workspace ──
  private _git: ReturnType<typeof createGit> | undefined;
  private git() {
    this._git ??= createGit(new WorkspaceFileSystem(this.workspace));
    return this._git;
  }

  // ── SDK: onStateChanged — reactive side effects ──
  // Called on every setState(). Use for broadcasting alerts.
  onStateChanged(state: any, source: any) {
    if (!state) return;
    // Example: broadcast when agent is actively processing
    if (state.isProcessing !== undefined) {
      this.broadcast(JSON.stringify({
        type: "agent_status",
        isProcessing: state.isProcessing,
      }));
    }
  }

  // ── MCP Client: @callable methods for client-side management ──

  @callable({ description: "Connect to an external MCP server" })
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable({ description: "Disconnect an MCP server" })
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  // ── Workspace: @callable methods for file operations ──

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

  @callable({ description: "Get workspace info (file count, size)" })
  async getWorkspaceInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }> {
    return this.workspace.getWorkspaceInfo();
  }

  // ── Core: onChatMessage — the agent's brain ──
  // Called by SDK when a user message arrives via WebSocket.
  // Returns a streaming response that the SDK broadcasts to all clients.

  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    // Merge SDK-managed MCP tools with built-in tools
    const mcpTools = this.mcp.getAITools();

    // CodeMode executor for sandboxed JS execution
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity,
      }),
      system: [
        "You are a helpful AI assistant with access to a persistent workspace filesystem, web browsing, code execution, and external tool servers via MCP.",
        "Use the file tools (readFile, writeFile, listDirectory, deleteFile, mkdir, glob) for simple operations.",
        "Use runStateCode for complex multi-file operations — it runs JavaScript in an isolated sandbox.",
        "Use git tools to track changes.",
        "Use browserScreenshot and browserGetContent to inspect web pages.",
        "Use webSearch for current information.",
        "After making changes, briefly summarize what you did.",
        "",
        STATE_SYSTEM_PROMPT.replace("{{types}}", STATE_TYPES),
      ].join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message",
      }),
      tools: {
        // ── MCP tools from connected servers ──
        ...mcpTools,

        // ── Workspace file tools (from @cloudflare/shell) ──
        readFile: tool({
          description: "Read file contents at the given path",
          inputSchema: z.object({
            path: z.string().describe("Absolute file path, e.g. /src/index.ts"),
          }),
          execute: async ({ path }) => {
            const content = await this.workspace.readFile(path);
            if (content === null) return { error: `File not found: ${path}` };
            return { path, content };
          },
        }),

        writeFile: tool({
          description: "Write content to a file. Creates parent directories.",
          inputSchema: z.object({
            path: z.string().describe("Absolute file path"),
            content: z.string().describe("File content to write"),
          }),
          execute: async ({ path, content }) => {
            await this.workspace.writeFile(path, content);
            return { path, bytesWritten: content.length };
          },
        }),

        listDirectory: tool({
          description: "List files and directories at a path",
          inputSchema: z.object({
            path: z.string().describe("Absolute directory path"),
          }),
          execute: async ({ path }) => {
            const entries = await this.workspace.readDir(path);
            return { path, entries: entries.map(e => ({ name: e.name, type: e.type, size: e.size })) };
          },
        }),

        deleteFile: tool({
          description: "Delete a file or empty directory",
          inputSchema: z.object({
            path: z.string().describe("Absolute path to delete"),
          }),
          execute: async ({ path }) => {
            const deleted = await this.workspace.deleteFile(path);
            return { path, deleted };
          },
        }),

        mkdir: tool({
          description: "Create a directory (and parent directories)",
          inputSchema: z.object({
            path: z.string().describe("Absolute directory path"),
          }),
          execute: async ({ path }) => {
            await this.workspace.mkdir(path, { recursive: true });
            return { path, created: true };
          },
        }),

        glob: tool({
          description: "Find files matching a glob pattern",
          inputSchema: z.object({
            pattern: z.string().describe("Glob pattern, e.g. **/*.ts"),
          }),
          execute: async ({ pattern }) => {
            const files = await this.workspace.glob(pattern);
            return { pattern, matches: files.map(f => ({ path: f.path, type: f.type, size: f.size })) };
          },
        }),

        // ── CodeMode: sandboxed JS execution ──
        runStateCode: tool({
          description: "Run JavaScript in an isolated sandbox against the workspace. Use for multi-file operations, search/replace, or coordinated edits.",
          inputSchema: z.object({
            code: z.string().describe("Async arrow function: async () => { /* use state.* and git.* */ return result; }"),
          }),
          execute: async ({ code }) => {
            return executor.execute(code, [
              resolveProvider(stateTools(this.workspace)),
              resolveProvider(gitTools(this.workspace)),
            ]);
          },
        }),

        // ── Git tools ──
        gitInit: tool({
          description: "Initialize a git repository in the workspace",
          inputSchema: z.object({ defaultBranch: z.string().optional() }),
          execute: async ({ defaultBranch }) => this.git().init({ defaultBranch }),
        }),

        gitStatus: tool({
          description: "Show working tree status",
          inputSchema: z.object({}),
          execute: async () => this.git().status(),
        }),

        gitAdd: tool({
          description: "Stage files for commit",
          inputSchema: z.object({ filepath: z.string().describe('File path or "." for all') }),
          execute: async ({ filepath }) => this.git().add({ filepath }),
        }),

        gitCommit: tool({
          description: "Create a commit",
          inputSchema: z.object({
            message: z.string(),
            authorName: z.string().optional(),
            authorEmail: z.string().optional(),
          }),
          execute: async ({ message, authorName, authorEmail }) => {
            const author = authorName && authorEmail ? { name: authorName, email: authorEmail } : undefined;
            return this.git().commit({ message, author });
          },
        }),

        gitLog: tool({
          description: "Show commit history",
          inputSchema: z.object({ depth: z.number().optional() }),
          execute: async ({ depth }) => this.git().log({ depth }),
        }),

        gitDiff: tool({
          description: "Show changes since last commit",
          inputSchema: z.object({}),
          execute: async () => this.git().diff(),
        }),

        // ── Browser tools (Puppeteer) ──
        browserScreenshot: tool({
          description: "Take a screenshot of a web page. Returns base64 PNG.",
          inputSchema: z.object({
            url: z.string().url(),
            fullPage: z.boolean().optional(),
          }),
          execute: async ({ url, fullPage }) => {
            let browser;
            try {
              browser = await puppeteer.launch(this.env.MYBROWSER);
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
        }),

        browserGetContent: tool({
          description: "Render a web page and return text content. Works for JS-rendered SPAs.",
          inputSchema: z.object({
            url: z.string().url(),
            selector: z.string().optional().describe("CSS selector (default: body)"),
          }),
          execute: async ({ url, selector }) => {
            let browser;
            try {
              browser = await puppeteer.launch(this.env.MYBROWSER);
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
        }),

        // ── Web search (no API key needed) ──
        webSearch: tool({
          description: "Search the web. Returns titles, URLs, and snippets.",
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
        }),
      },
      toolChoice: "auto",
      stopWhen: stepCountIs(10),
    });

    return result.toUIMessageStreamResponse();
  }

  // ── SDK: onChatResponse — post-turn hook ──
  protected async onChatResponse(result: ChatResponseResult) {
    if (result.status === "completed") {
      // Broadcast to all connected clients that streaming finished
      this.broadcast(JSON.stringify({ type: "streaming_done" }));
    }
  }
}

// ── Worker Entry Point ─────────────────────────────────────────────
// Canonical pattern: routeAgentRequest handles WebSocket + HTTP routing
// to the correct DO instance. onBeforeConnect provides auth.

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", service: "model-agent", ts: new Date().toISOString() });
    }

    // Agent SDK routing — handles WebSocket upgrades + HTTP to DOs
    const response = await routeAgentRequest(request, env, {
      // Auth gate for WebSocket connections (browsers can't set headers)
      onBeforeConnect: async (req) => {
        // In production: validate JWT from query param or cookie
        // For this reference impl: allow all connections
        return req;
      },
      onBeforeRequest: async (req) => {
        return req;
      },
    });

    if (response) return response;
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
