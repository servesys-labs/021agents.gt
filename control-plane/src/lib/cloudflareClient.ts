/**
 * CloudflareClient — calls worker /cf/* endpoints for CF-only resources.
 *
 * The control-plane uses this when it needs Cloudflare bindings (Vectorize, R2,
 * Dynamic Workers, Browser Rendering) that only the edge worker can access.
 *
 * Configuration (env vars):
 *   AGENTOS_WORKER_URL  — base URL of the Cloudflare worker
 *   EDGE_INGEST_TOKEN   — shared secret (same token the worker sends to backend)
 *
 * Usage:
 *   const client = getCloudflareClient();  // singleton, returns null if not configured
 *   if (client) {
 *     const result = await client.sandboxExec("console.log('hello')");
 *     const results = await client.ragQuery("how does X work?", "org_123");
 *   }
 */

/// <reference types="@cloudflare/workers-types" />

import type { Env } from "../env";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// Module-level singleton — avoids creating a new client per call
let _cfClientInstance: CloudflareClient | null = null;
let _cfClientChecked = false;

/**
 * Return the process-wide CloudflareClient singleton.
 * Returns null if AGENTOS_WORKER_URL is not set. Safe to call from
 * any async context — the underlying client is created lazily.
 */
export function getCloudflareClient(env: Env): CloudflareClient | null {
  if (_cfClientChecked) {
    return _cfClientInstance;
  }
  _cfClientChecked = true;
  _cfClientInstance = CloudflareClient.fromEnv(env);
  if (_cfClientInstance) {
    console.log("CloudflareClient configured:", _cfClientInstance.workerUrl);
  }
  return _cfClientInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetCloudflareClient(): void {
  _cfClientInstance = null;
  _cfClientChecked = false;
}

/**
 * Execute with retry logic and exponential backoff
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; retryDelayMs?: number } = {}
): Promise<T> {
  const { maxRetries = MAX_RETRIES, retryDelayMs = RETRY_DELAY_MS } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (e: any) {
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        throw e;
      }

      // Exponential backoff
      await new Promise((r) => setTimeout(r, retryDelayMs * Math.pow(2, attempt)));
    }
  }

  throw new Error("Max retries exceeded");
}

/**
 * HTTP client for Cloudflare worker /cf/* callback endpoints.
 */
export class CloudflareClient {
  workerUrl: string;
  private edgeToken: string;
  private defaultTimeoutMs: number;

  constructor(
    workerUrl: string,
    edgeToken: string,
    defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    this.workerUrl = workerUrl.replace(/\/$/, ""); // rstrip("/")
    this.edgeToken = edgeToken;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Create from env vars. Returns null if not configured.
   */
  static fromEnv(env: Env): CloudflareClient | null {
    // Try EDGE_INGEST_TOKEN first, then SERVICE_TOKEN as fallback
    const url = (env as any).AGENTOS_WORKER_URL || "";
    const token = (env as any).EDGE_INGEST_TOKEN || env.SERVICE_TOKEN || "";
    if (!url || !token) {
      return null;
    }
    return new CloudflareClient(url, token);
  }

  /**
   * Build request headers with authorization
   */
  private getHeaders(contentType = "application/json"): Record<string, string> {
    return {
      Authorization: `Bearer ${this.edgeToken}`,
      "X-Edge-Token": this.edgeToken,
      "Content-Type": contentType,
    };
  }

  /**
   * Make a POST request to the worker
   */
  private async post(
    path: string,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number; contentType?: string } = {}
  ): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
    const contentType = options.contentType || "application/json";

    return executeWithRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetch(`${this.workerUrl}${path}`, {
          method: "POST",
          headers: this.getHeaders(contentType),
          body: JSON.stringify(payload),
          // @ts-ignore - Cloudflare fetch supports signal
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
          const text = await resp.text().catch(() => resp.statusText);
          throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
        }

        return (await resp.json()) as Record<string, unknown>;
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    });
  }

  /**
   * Make a GET request to the worker
   */
  private async get(
    path: string,
    params?: Record<string, string>,
    options: { timeoutMs?: number } = {}
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;

    return executeWithRetry(async () => {
      const url = new URL(`${this.workerUrl}${path}`);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetch(url.toString(), {
          method: "GET",
          headers: this.getHeaders(),
          // @ts-ignore - Cloudflare fetch supports signal
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
          const text = await resp.text().catch(() => resp.statusText);
          throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
        }

        return resp;
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    });
  }

  // ── LLM Inference (Workers AI — edge, sub-second) ───────────────

  /**
   * Run LLM inference via Workers AI on the CF edge.
   *
   * For @cf/ models: Llama, GPT-OSS, Kimi, Nemotron, etc.
   * Sub-second latency for small models, no external API call.
   */
  async llmInfer(
    model: string,
    messages: Array<Record<string, unknown>>,
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: Array<Record<string, unknown>>;
    } = {}
  ): Promise<Record<string, unknown>> {
    const { maxTokens = 1024, temperature = 0.0, tools } = options;
    const payload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (tools) {
      payload.tools = tools;
    }
    return await this.post("/cf/llm/infer", payload);
  }

  // ── Sandbox ──────────────────────────────────────────────────────

  /**
   * Execute code in CF Dynamic Worker or Container sandbox.
   */
  async sandboxExec(
    code: string,
    options: { language?: string; timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>> {
    const { language = "javascript", timeoutMs = 30_000 } = options;
    return await this.post("/cf/sandbox/exec", {
      code,
      language,
      timeoutMs,
    });
  }

  // ── AI / Embeddings ──────────────────────────────────────────────

  /**
   * Embed texts via Workers AI (bge-base-en-v1.5).
   */
  async embed(texts: string[]): Promise<number[][]> {
    const data = await this.post("/cf/ai/embed", { texts });
    return (data.vectors as number[][]) || [];
  }

  // ── RAG ──────────────────────────────────────────────────────────

  /**
   * Semantic search via Cloudflare Vectorize.
   */
  async ragQuery(
    query: string,
    options: {
      topK?: number;
      orgId?: string;
      agentName?: string;
    } = {}
  ): Promise<Array<Record<string, unknown>>> {
    const { topK = 10, orgId = "", agentName = "" } = options;
    const data = await this.post("/cf/rag/query", {
      query,
      topK,
      org_id: orgId,
      agent_name: agentName,
    });
    return (data.results as Array<Record<string, unknown>>) || [];
  }

  /**
   * Chunk, embed, and store text in Vectorize + R2.
   */
  async ragIngest(
    text: string,
    options: {
      source?: string;
      orgId?: string;
      agentName?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    const { source = "api", orgId = "", agentName = "" } = options;
    return await this.post("/cf/rag/ingest", {
      text,
      source,
      org_id: orgId,
      agent_name: agentName,
    });
  }

  // ── Storage (R2) ─────────────────────────────────────────────────

  /**
   * Upload to R2 bucket.
   */
  async storagePut(
    key: string,
    data: Uint8Array | ArrayBuffer,
    options: { contentType?: string } = {}
  ): Promise<Record<string, unknown>> {
    const contentType = options.contentType || "application/octet-stream";

    return executeWithRetry(async () => {
      const url = new URL(`${this.workerUrl}/cf/storage/put`);
      url.searchParams.set("key", key);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

      try {
        const resp = await fetch(url.toString(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.edgeToken}`,
            "X-Edge-Token": this.edgeToken,
            "Content-Type": contentType,
          },
          body: data as unknown as BodyInit,
          // @ts-ignore - Cloudflare fetch supports signal
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
          const text = await resp.text().catch(() => resp.statusText);
          throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
        }

        return (await resp.json()) as Record<string, unknown>;
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    });
  }

  /**
   * Download from R2 bucket.
   */
  async storageGet(key: string): Promise<Uint8Array> {
    const resp = await this.get("/cf/storage/get", { key });
    return new Uint8Array(await resp.arrayBuffer());
  }

  // ── Browse (Cloudflare Browser Rendering REST API) ──────────────

  /**
   * Start/poll a crawl via Cloudflare Browser Rendering /crawl API.
   *
   * Params match the CF REST API: limit (max pages), depth (link depth),
   * formats (list of "markdown", "html", "links", etc.).
   */
  async browseCrawl(
    url: string,
    options: {
      limit?: number;
      depth?: number;
      formats?: string[];
    } = {}
  ): Promise<Record<string, unknown>> {
    const { limit = 10, depth = 2, formats = ["markdown"] } = options;
    return await this.post("/cf/browse/crawl", {
      url,
      limit,
      depth,
      formats,
    });
  }

  /**
   * Render a single page via Cloudflare Browser Rendering REST API.
   *
   * action maps to a CF endpoint:
   *   "markdown" → /markdown  (default, best for RAG)
   *   "html"     → /content
   *   "links"    → /links
   *   "text"     → /markdown  (alias)
   *   "screenshot" → /screenshot
   *
   * waitForSelector: CSS selector to wait for before extraction.
   */
  async browseRender(
    url: string,
    options: {
      action?: string;
      waitForSelector?: string;
      timeoutMs?: number;
    } = {}
  ): Promise<Record<string, unknown>> {
    const { action = "markdown", waitForSelector = "", timeoutMs = 30_000 } = options;
    return await this.post("/cf/browse/render", {
      url,
      action,
      waitForSelector,
      timeout: timeoutMs,
    });
  }

  // ── Tool Execution ─────────────────────────────────────────────

  /**
   * Execute a tool on the Cloudflare worker.
   *
   * The worker's /cf/tool/exec endpoint routes to the appropriate
   * CF binding (Sandbox, LOADER, fetch, Vectorize, etc.).
   *
   * Returns: {"tool": name, "result": "..."} or {"tool": name, "error": "..."}
   */
  async toolExec(
    toolName: string,
    args: Record<string, unknown>,
    options: {
      sessionId?: string;
      turn?: number;
    } = {}
  ): Promise<Record<string, unknown>> {
    const { sessionId = "", turn = 0 } = options;

    // Longer timeout for sandbox operations (container spin-up + execution)
    return await this.post(
      "/cf/tool/exec",
      {
        tool: toolName,
        args,
        session_id: sessionId,
        turn,
      },
      { timeoutMs: 120_000 }
    );
  }

  // ── Agent Teardown ─────────────────────────────────────────────

  /**
   * Clean up all CF-side resources for a deleted agent.
   *
   * Removes: Vectorize entries, R2 files under the agent's prefix.
   */
  async teardownAgent(
    agentName: string,
    options: { orgId?: string } = {}
  ): Promise<Record<string, unknown>> {
    const { orgId = "" } = options;
    return await this.post("/cf/agent/teardown", {
      agent_name: agentName,
      org_id: orgId,
    });
  }

  // ── Dispatch Namespace (Workers for Platforms) ─────────────────

  /**
   * Deterministic worker name: agentos-{org_slug}-{agent_name}.
   */
  private workerName(orgSlug: string, agentName: string): string {
    const slug = `${orgSlug}-${agentName}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const normalized = slug.replace(/-+/g, "-").replace(/^-|-$/g, "");
    return `agentos-${normalized}`.slice(0, 63); // CF worker name limit
  }

  /**
   * Deploy a customer agent worker into the dispatch namespace.
   *
   * The worker handles API requests, Telegram webhooks, and other channels.
   * Only the env var bindings differ per agent (AGENT_NAME, ORG_ID, etc.).
   */
  async deployCustomerWorker(
    env: Env,
    orgSlug: string,
    agentName: string,
    options: {
      orgId?: string;
      projectId?: string;
      telegramBotToken?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    const { orgId = "", projectId = "", telegramBotToken = "" } = options;

    const workerName = this.workerName(orgSlug, agentName);
    const accountId = (env as any).CLOUDFLARE_ACCOUNT_ID || "";
    const apiToken = (env as any).CLOUDFLARE_API_TOKEN || "";
    const namespace = (env as any).DISPATCH_NAMESPACE || "agentos-production";

    // Customer worker calls the MAIN CF WORKER (edge runtime), not Railway.
    // The main worker holds all API keys and CF bindings.
    let workerUrl = (env as any).AGENTOS_WORKER_URL || (env as any).WORKER_URL || "";
    if (!workerUrl) {
      // Fallback: derive from worker name in wrangler config
      workerUrl = "https://agentos.workers.dev";
    }
    const edgeToken = this.edgeToken;

    if (!accountId || !apiToken) {
      return { error: "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not set", deployed: false };
    }

    // Minimal proxy worker script (routes to main worker edge runtime)
    const templateCode =
      'export default{async fetch(r,e){const b=await r.json().catch(()=>({}));' +
      'const resp=await fetch(`${e.WORKER_URL}/api/v1/runtime-proxy/runnable/invoke`,' +
      '{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${e.SERVICE_TOKEN}`},' +
      'body:JSON.stringify({...b,agent_name:e.AGENT_NAME,org_id:e.ORG_ID,channel:"dispatch_worker"})});' +
      'return new Response(resp.body,{status:resp.status,headers:resp.headers})}}';

    // Build metadata
    const metadata: Record<string, unknown> = {
      main_module: "index.js",
      bindings: [
        { type: "plain_text", name: "AGENT_NAME", text: agentName },
        { type: "plain_text", name: "ORG_ID", text: orgId },
        { type: "plain_text", name: "PROJECT_ID", text: projectId },
        { type: "plain_text", name: "WORKER_URL", text: workerUrl },
        { type: "secret_text", name: "SERVICE_TOKEN", text: edgeToken },
        // Channel integrations — only added if configured
        ...(telegramBotToken
          ? [{ type: "secret_text", name: "TELEGRAM_BOT_TOKEN", text: telegramBotToken }]
          : []),
      ],
      tags: [`org:${orgSlug}`, `agent:${agentName}`],
      compatibility_date: "2026-03-01",
    };

    // Build multipart form
    const boundary = "----AgentOSWorkerUpload";
    const bodyParts: string[] = [];

    // Part 1: metadata JSON
    bodyParts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="metadata"; filename="metadata.json"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        JSON.stringify(metadata)
    );

    // Part 2: worker script
    bodyParts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n` +
        `Content-Type: application/javascript+module\r\n\r\n` +
        templateCode
    );

    bodyParts.push(`--${boundary}--`);
    const multipartBody = bodyParts.join("\r\n");

    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
      `/workers/dispatch/namespaces/${namespace}/scripts/${workerName}`;

    return executeWithRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

      try {
        const resp = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody,
          // @ts-ignore - Cloudflare fetch supports signal
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
        return {
          deployed: resp.ok,
          worker_name: workerName,
          namespace,
          status_code: resp.status,
          result: data.result || data.errors || [],
        };
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    });
  }

  /**
   * Remove a customer worker from the dispatch namespace.
   */
  async undeployCustomerWorker(
    env: Env,
    orgSlug: string,
    agentName: string
  ): Promise<Record<string, unknown>> {
    const workerName = this.workerName(orgSlug, agentName);
    const accountId = (env as any).CLOUDFLARE_ACCOUNT_ID || "";
    const apiToken = (env as any).CLOUDFLARE_API_TOKEN || "";
    const namespace = (env as any).DISPATCH_NAMESPACE || "agentos-production";

    if (!accountId || !apiToken) {
      return { error: "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not set", removed: false };
    }

    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
      `/workers/dispatch/namespaces/${namespace}/scripts/${workerName}`;

    return executeWithRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

      try {
        const resp = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
          // @ts-ignore - Cloudflare fetch supports signal
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        return {
          removed: resp.ok,
          worker_name: workerName,
          status_code: resp.status,
        };
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    });
  }

  /**
   * List customer workers in the dispatch namespace. Filter by org_slug prefix.
   */
  async listCustomerWorkers(
    env: Env,
    orgSlug = ""
  ): Promise<Array<Record<string, unknown>>> {
    const accountId = (env as any).CLOUDFLARE_ACCOUNT_ID || "";
    const apiToken = (env as any).CLOUDFLARE_API_TOKEN || "";
    const namespace = (env as any).DISPATCH_NAMESPACE || "agentos-production";

    if (!accountId || !apiToken) {
      return [];
    }

    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
      `/workers/dispatch/namespaces/${namespace}/scripts`;

    return executeWithRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

      try {
        const resp = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
          // @ts-ignore - Cloudflare fetch supports signal
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
          return [];
        }

        const data = (await resp.json()) as Record<string, unknown>;
        const scripts = (data.result as Array<Record<string, unknown>>) || [];

        // Filter by org prefix if specified
        const prefix = orgSlug ? `agentos-${orgSlug}-` : "agentos-";
        return scripts
          .filter((s) => {
            const name = String(s.script_name || s.id || "");
            return name.startsWith(prefix);
          })
          .map((s) => ({
            worker_name: s.script_name || s.id || "",
            created_on: s.created_on || "",
            modified_on: s.modified_on || "",
            tags: s.tags || [],
          }));
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    });
  }

  // ── Legacy alias methods for compatibility ─────────────────────────

  /**
   * Alias for storagePut - Upload to R2 bucket
   */
  async r2Upload(
    key: string,
    data: Uint8Array | ArrayBuffer,
    options: { contentType?: string } = {}
  ): Promise<Record<string, unknown>> {
    return this.storagePut(key, data, options);
  }

  /**
   * Alias for embed - Upsert vectors
   */
  async vectorizeUpsert(
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>,
    options: { orgId?: string } = {}
  ): Promise<Record<string, unknown>> {
    return await this.post("/cf/vectorize/upsert", {
      vectors,
      org_id: options.orgId || "",
    });
  }

  /**
   * Alias for deployCustomerWorker - Deploy dynamic worker
   */
  async dynamicWorkerDeploy(
    env: Env,
    config: {
      orgSlug: string;
      agentName: string;
      orgId?: string;
      projectId?: string;
      telegramBotToken?: string;
    }
  ): Promise<Record<string, unknown>> {
    return this.deployCustomerWorker(env, config.orgSlug, config.agentName, {
      orgId: config.orgId,
      projectId: config.projectId,
      telegramBotToken: config.telegramBotToken,
    });
  }
}
