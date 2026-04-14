/**
 * Compute Worker — sandbox container management, V8 isolate code execution,
 * and browser rendering for the AgentOS platform.
 *
 * Phase 1: Thin proxy exposing sandbox/code/browser operations via fetch API.
 * The Agent Core worker calls this via service binding.
 *
 * Owns:
 *   - SANDBOX  (Durable Object + Container) — Python/Bash execution
 *   - LOADER   (Dynamic Workers)            — V8 isolate execution
 *   - BROWSER  (Browser Rendering)          — Puppeteer headless Chrome
 */

import { Sandbox, getSandbox } from "@cloudflare/sandbox";

// ── Env typing ──────────────────────────────────────────────────────────────

export interface Env {
  SANDBOX: DurableObjectNamespace;
  LOADER: any;            // DynamicWorkerLoader binding
  BROWSER: any;           // Browser Rendering binding (Fetcher)
  STORAGE: R2Bucket;
  TELEMETRY_QUEUE: Queue;
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_SANDBOX_TIMEOUT_SECONDS = 300;
const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 30;

function clampTimeout(seconds?: number): number {
  if (!seconds || seconds <= 0) return DEFAULT_SANDBOX_TIMEOUT_SECONDS;
  return Math.min(seconds, MAX_SANDBOX_TIMEOUT_SECONDS);
}

// ── AgentSandbox Durable Object ─────────────────────────────────────────────
//
// Lifted from deploy/src/index.ts lines 184-257.  Manages org-scoped sandbox
// containers with persistence for org_id recovery after eviction.

const _sandboxOrgRegistry = new Map<string, string>();

export class AgentSandbox extends Sandbox<Env> {

  /** Persist org_id so outbound handlers can scope access. */
  static async registerOrg(
    sandboxNamespace: any,
    sandboxId: string,
    orgId: string,
  ): Promise<void> {
    const doIdObj = sandboxNamespace.idFromName(sandboxId);
    const doIdStr = doIdObj.toString();
    _sandboxOrgRegistry.set(doIdStr, orgId);
    _sandboxOrgRegistry.set(sandboxId, orgId);
    try {
      const stub = sandboxNamespace.get(doIdObj);
      await stub.fetch("http://internal/__set_org", {
        method: "POST",
        body: orgId,
      });
    } catch {
      // Best-effort — the in-memory registry is the primary path.
    }
  }

  async onStart() {
    console.log(`[sandbox] Started: ${this.ctx.id.toString().slice(0, 16)}`);
    const stored = await this.ctx.storage.get<string>("__org_id");
    if (stored) {
      _sandboxOrgRegistry.set(this.ctx.id.toString(), stored);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__set_org" && request.method === "POST") {
      const orgId = await request.text();
      if (orgId) {
        await this.ctx.storage.put("__org_id", orgId);
        _sandboxOrgRegistry.set(this.ctx.id.toString(), orgId);
      }
      return new Response("OK");
    }
    return super.fetch(request);
  }

  async onStop() {
    console.log(`[sandbox] Stopped: ${this.ctx.id.toString().slice(0, 16)}`);
    _sandboxOrgRegistry.delete(this.ctx.id.toString());
  }

  onError(error: unknown) {
    console.error("[sandbox] Container error:", error);
    if (this.env.TELEMETRY_QUEUE) {
      this.env.TELEMETRY_QUEUE.send({
        type: "event",
        payload: {
          event_type: "sandbox.error",
          error: String(error).slice(0, 500),
          instance_id: this.ctx.id.toString().slice(0, 16),
          created_at: new Date().toISOString(),
        },
      }).catch(() => {});
    }
  }
}

// ── Helper: get a timed sandbox proxy ───────────────────────────────────────

function getTimedSandbox(namespace: DurableObjectNamespace, sandboxId: string) {
  return getSandbox(namespace, sandboxId, {
    sleepAfter: "30m",
    enableInternet: true,
  } as any);
}

// ── Request / Response helpers ──────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ── Route handler type ──────────────────────────────────────────────────────

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

// ── Endpoint implementations ────────────────────────────────────────────────

/**
 * POST /sandbox/exec — execute a command in the sandbox container.
 *
 * Body: { sandbox_id, command, timeout_seconds?, org_id? }
 *
 * TODO: Move execution logic from deploy/src/runtime/tools.ts
 *   - See tool case "bash" (~line 370+): getSandbox(), sandbox.exec()
 *   - See deploy/src/index.ts (~line 7160+): sandbox_exec tool handler
 *   - Port sandbox pool/lease logic from deploy/src/index.ts (~line 6280+)
 */
const handleSandboxExec: RouteHandler = async (request, env) => {
  const body = await readJsonBody(request);
  const sandboxId = body.sandbox_id || "default";
  const command = body.command || "";
  const timeout = clampTimeout(body.timeout_seconds);
  const orgId = body.org_id;

  if (!command) {
    return jsonResponse({ error: "Missing required field: command" }, 400);
  }

  try {
    if (orgId) {
      await AgentSandbox.registerOrg(env.SANDBOX, sandboxId, orgId);
    }
    const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
    const result = await sandbox.exec(command, { timeout });
    return jsonResponse({
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exit_code: result.exitCode ?? 0,
    });
  } catch (err) {
    return jsonResponse({
      error: String(err),
      stdout: "",
      stderr: String(err),
      exit_code: 1,
    }, 500);
  }
};

/**
 * POST /sandbox/write — write a file to the sandbox container filesystem.
 *
 * Body: { sandbox_id, path, content, org_id? }
 *
 * TODO: Move file-write logic from deploy/src/runtime/tools.ts
 *   - See tool case "file_write" / "sandbox_file_write" in deploy/src/index.ts (~line 7248+, 7316+)
 *   - sandbox.writeFile(path, content)
 */
const handleSandboxWrite: RouteHandler = async (request, env) => {
  const body = await readJsonBody(request);
  const sandboxId = body.sandbox_id || "default";
  const path = body.path || "";
  const content = body.content || "";
  const orgId = body.org_id;

  if (!path) {
    return jsonResponse({ error: "Missing required field: path" }, 400);
  }

  try {
    if (orgId) {
      await AgentSandbox.registerOrg(env.SANDBOX, sandboxId, orgId);
    }
    const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
    await sandbox.writeFile(path, content);
    return jsonResponse({
      status: "ok",
      bytes_written: content.length,
      path,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
};

/**
 * POST /sandbox/read — read a file from the sandbox container filesystem.
 *
 * Body: { sandbox_id, path, org_id? }
 *
 * TODO: Move file-read logic from deploy/src/runtime/tools.ts
 *   - See tool case "file_read" / "sandbox_file_read" in deploy/src/index.ts (~line 7238+, 7324+)
 *   - sandbox.exec(`cat -n "${path}" | head -2000`)
 */
const handleSandboxRead: RouteHandler = async (request, env) => {
  const body = await readJsonBody(request);
  const sandboxId = body.sandbox_id || "default";
  const path = body.path || "";
  const orgId = body.org_id;

  if (!path) {
    return jsonResponse({ error: "Missing required field: path" }, 400);
  }

  try {
    if (orgId) {
      await AgentSandbox.registerOrg(env.SANDBOX, sandboxId, orgId);
    }
    const sandbox = getTimedSandbox(env.SANDBOX, sandboxId);
    const result = await sandbox.exec(`cat -n "${path}" 2>&1 | head -2000`, { timeout: 10 });
    return jsonResponse({
      content: result.stdout || "",
      stderr: result.stderr || "",
      exit_code: result.exitCode ?? 0,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
};

/**
 * POST /code/execute — run code in a V8 isolate via Dynamic Workers.
 *
 * Body: { code, language?, timeout_ms? }
 *
 * TODO: Move V8 isolate execution from deploy/src/runtime/codemode.ts
 *   - See DynamicWorkerExecutor usage (~line 369-373): env.LOADER.load() with
 *     zero network access and zero bindings for sandboxed execution
 *   - See deploy/src/index.ts (~line 6260+): inline JS execution via env.LOADER.load()
 *   - See deploy/src/runtime/tools.ts (~line 605+): dynamic worker cache and
 *     env.LOADER.load({ compatibilityDate, mainModule, modules })
 *   - Port the full codemode scope system (agent, graph_node, transform, etc.)
 *     from deploy/src/runtime/codemode.ts for capability-based tool permissions
 */
const handleCodeExecute: RouteHandler = async (request, env) => {
  const body = await readJsonBody(request);
  const code = body.code || "";
  const language = body.language || "javascript";
  const timeoutMs = body.timeout_ms || 20_000;

  if (!code) {
    return jsonResponse({ error: "Missing required field: code" }, 400);
  }

  try {
    if (language === "javascript" || language === "js" || language === "typescript" || language === "ts") {
      // V8 isolate execution via Dynamic Workers
      const workerCode = [
        `const __o=[],__e=[];`,
        `console.log=(...a)=>__o.push(a.map(String).join(" "));`,
        `console.error=(...a)=>__e.push(a.map(String).join(" "));`,
        `export default{async fetch(){try{${code};`,
        `return Response.json({stdout:__o.join("\\n"),stderr:__e.join("\\n"),exit_code:0})`,
        `}catch(e){return Response.json({stdout:__o.join("\\n"),stderr:e.message||String(e),exit_code:1})}}}`,
      ].join("");

      const loaded = await env.LOADER.load({
        compatibilityDate: "2026-03-01",
        mainModule: "main.js",
        modules: [{ name: "main.js", esModule: workerCode }],
        env: {},
        globalOutbound: null,
      });

      const resp = await loaded.fetch("http://localhost/", { signal: AbortSignal.timeout(timeoutMs) });
      const result = await resp.json() as { stdout: string; stderr: string; exit_code: number };
      return jsonResponse(result);
    }

    // For non-JS languages, delegate to sandbox container
    if (language === "python" || language === "bash" || language === "shell") {
      const sandbox = getTimedSandbox(env.SANDBOX, "code-exec-default");
      let execResult;
      if (language === "python") {
        const tmpFile = `/tmp/exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`;
        await sandbox.writeFile(tmpFile, code);
        execResult = await sandbox.exec(`python3 ${tmpFile}`, { timeout: Math.ceil(timeoutMs / 1000) });
      } else {
        execResult = await sandbox.exec(code, { timeout: Math.ceil(timeoutMs / 1000) });
      }
      return jsonResponse({
        stdout: execResult.stdout || "",
        stderr: execResult.stderr || "",
        exit_code: execResult.exitCode ?? 0,
      });
    }

    return jsonResponse({ error: `Unsupported language: ${language}` }, 400);
  } catch (err) {
    return jsonResponse({
      error: String(err),
      stdout: "",
      stderr: String(err),
      exit_code: 1,
    }, 500);
  }
};

/**
 * POST /browser/render — render a URL via Puppeteer headless Chrome.
 *
 * Body: { url, format?, viewport?, wait_for? }
 *
 * TODO: Move browser rendering from deploy/src/runtime/tools.ts
 *   - See puppeteer.default.launch(env.BROWSER) at ~line 99
 *   - See browser pool management with pruneBrowserPoolIfNeeded() at ~line 97
 *   - Port the full browsing tool: page.goto(), page.content(), page.screenshot()
 *   - Handle viewport configuration, wait strategies, and screenshot formats
 */
const handleBrowserRender: RouteHandler = async (request, env) => {
  const body = await readJsonBody(request);
  const url = body.url || "";
  const format = body.format || "html";        // "html" | "screenshot" | "pdf"
  const viewport = body.viewport || { width: 1280, height: 720 };
  const waitFor = body.wait_for || "networkidle0";

  if (!url) {
    return jsonResponse({ error: "Missing required field: url" }, 400);
  }

  try {
    const puppeteer = await import("@cloudflare/puppeteer");
    const browser = await puppeteer.default.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.goto(url, { waitUntil: waitFor, timeout: 30_000 });

    let result: any;
    if (format === "screenshot") {
      const screenshotBuf = await page.screenshot({ type: "png", fullPage: true });
      const base64 = Buffer.from(screenshotBuf).toString("base64");
      result = { format: "screenshot", data: base64, mime: "image/png" };
    } else if (format === "pdf") {
      const pdfBuf = await page.pdf({ format: "A4" });
      const base64 = Buffer.from(pdfBuf).toString("base64");
      result = { format: "pdf", data: base64, mime: "application/pdf" };
    } else {
      const html = await page.content();
      result = { format: "html", data: html, mime: "text/html" };
    }

    await browser.close();
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
};

/**
 * GET /health — simple health check.
 */
const handleHealth: RouteHandler = async (_request, _env) => {
  return jsonResponse({
    status: "ok",
    service: "agentos-compute",
    timestamp: new Date().toISOString(),
  });
};

// ── Router ──────────────────────────────────────────────────────────────────

const routes: Record<string, Record<string, RouteHandler>> = {
  "/sandbox/exec":   { POST: handleSandboxExec },
  "/sandbox/write":  { POST: handleSandboxWrite },
  "/sandbox/read":   { POST: handleSandboxRead },
  "/code/execute":   { POST: handleCodeExecute },
  "/browser/render": { POST: handleBrowserRender },
  "/health":         { GET: handleHealth },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = routes[url.pathname];

    if (!route) {
      return jsonResponse({ error: "Not found", path: url.pathname }, 404);
    }

    const handler = route[request.method];
    if (!handler) {
      return jsonResponse(
        { error: "Method not allowed", allowed: Object.keys(route) },
        405,
      );
    }

    return handler(request, env);
  },
};
