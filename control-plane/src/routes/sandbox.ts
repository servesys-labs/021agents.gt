/**
 * Sandbox router — code execution via Cloudflare containers or E2B fallback.
 * Ported from agentos/api/routers/sandbox.py
 *
 * All sandbox operations are proxied to the RUNTIME service binding.
 * Agent code NEVER runs on the control-plane worker.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const sandboxRoutes = new Hono<R>();

// ── Helpers ──────────────────────────────────────────────────────────

async function proxyToRuntime(
  runtime: Fetcher,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return runtime.fetch(`https://runtime/api/v1/sandbox${path}`, init);
}

async function forwardResponse(c: any, resp: Response) {
  if (resp.status >= 400) {
    const text = await resp.text();
    return c.json({ error: text.slice(0, 500) }, resp.status as any);
  }
  return c.json(await resp.json());
}

// ── Create sandbox ───────────────────────────────────────────────────

sandboxRoutes.post("/create", requireScope("sandbox:write"), async (c) => {
  const body = await c.req.json();
  const template = String(body.template || "base");
  const timeoutSec = Math.max(10, Math.min(3600, Number(body.timeout_sec) || 300));

  try {
    const resp = await proxyToRuntime(c.env.RUNTIME, "/create", "POST", {
      template,
      timeout_sec: timeoutSec,
    });
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox create failed: ${e.message}` }, 502);
  }
});

// ── Execute command ──────────────────────────────────────────────────

sandboxRoutes.post("/exec", requireScope("sandbox:write"), async (c) => {
  const body = await c.req.json();
  const command = String(body.command || "");
  const sandboxId = String(body.sandbox_id || "");
  const timeoutMs = Math.max(1000, Math.min(120000, Number(body.timeout_ms) || 30000));

  if (!command) {
    return c.json({ error: "command is required" }, 400);
  }

  try {
    const resp = await proxyToRuntime(c.env.RUNTIME, "/exec", "POST", {
      command,
      sandbox_id: sandboxId,
      timeout_ms: timeoutMs,
    });
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox exec failed: ${e.message}` }, 502);
  }
});

// ── List sandboxes ───────────────────────────────────────────────────

sandboxRoutes.get("/list", requireScope("sandbox:read"), async (c) => {
  try {
    const resp = await proxyToRuntime(c.env.RUNTIME, "/list", "GET");
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox list failed: ${e.message}` }, 502);
  }
});

// ── Kill sandbox ─────────────────────────────────────────────────────

sandboxRoutes.post("/kill", requireScope("sandbox:write"), async (c) => {
  const body = await c.req.json();
  const sandboxId = String(body.sandbox_id || "");

  if (!sandboxId) {
    return c.json({ error: "sandbox_id is required" }, 400);
  }

  try {
    const resp = await proxyToRuntime(c.env.RUNTIME, "/kill", "POST", {
      sandbox_id: sandboxId,
    });
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox kill failed: ${e.message}` }, 502);
  }
});

// ── List files in sandbox ────────────────────────────────────────────

sandboxRoutes.get("/:sandbox_id/files", requireScope("sandbox:read"), async (c) => {
  const sandboxId = c.req.param("sandbox_id");
  const path = c.req.query("path") || "/";

  try {
    const url = `/${sandboxId}/files?path=${encodeURIComponent(path)}`;
    const resp = await proxyToRuntime(c.env.RUNTIME, url, "GET");
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox files failed: ${e.message}` }, 502);
  }
});

// ── Upload file to sandbox ───────────────────────────────────────────

sandboxRoutes.post("/:sandbox_id/files/upload", requireScope("sandbox:write"), async (c) => {
  const sandboxId = c.req.param("sandbox_id");
  const body = await c.req.json();
  const destPath = String(body.dest_path || "");
  const content = String(body.content || "");

  if (!destPath) {
    return c.json({ error: "dest_path is required" }, 400);
  }

  try {
    const resp = await proxyToRuntime(c.env.RUNTIME, `/${sandboxId}/files/upload`, "POST", {
      dest_path: destPath,
      content,
    });
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox upload failed: ${e.message}` }, 502);
  }
});

// ── Sandbox logs ─────────────────────────────────────────────────────

sandboxRoutes.get("/:sandbox_id/logs", requireScope("sandbox:read"), async (c) => {
  const sandboxId = c.req.param("sandbox_id");
  const lines = Math.max(1, Math.min(1000, Number(c.req.query("lines")) || 100));

  try {
    const url = `/${sandboxId}/logs?lines=${lines}`;
    const resp = await proxyToRuntime(c.env.RUNTIME, url, "GET");
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox logs failed: ${e.message}` }, 502);
  }
});
