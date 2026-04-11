/**
 * Sandbox router — code execution via Cloudflare containers or E2B fallback.
 *
 * All sandbox operations are proxied to the RUNTIME service binding.
 * Agent code NEVER runs on the control-plane worker.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { requireScope } from "../middleware/auth";

export const sandboxRoutes = createOpenAPIRouter();

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

const createSandboxRoute = createRoute({
  method: "post",
  path: "/create",
  tags: ["Sandbox"],
  summary: "Create a new sandbox",
  middleware: [requireScope("sandbox:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            template: z.string().default("base").openapi({ example: "base" }),
            timeout_sec: z.coerce.number().int().min(10).max(3600).default(300).openapi({ example: 300 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Sandbox created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

sandboxRoutes.openapi(createSandboxRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
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

const execSandboxRoute = createRoute({
  method: "post",
  path: "/exec",
  tags: ["Sandbox"],
  summary: "Execute a command in a sandbox",
  middleware: [requireScope("sandbox:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            command: z.string().min(1).openapi({ example: "echo hello" }),
            sandbox_id: z.string().default("").openapi({ example: "sb-abc123" }),
            timeout_ms: z.coerce.number().int().min(1000).max(120000).default(30000).openapi({ example: 30000 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Command execution result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

sandboxRoutes.openapi(execSandboxRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
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

const listSandboxesRoute = createRoute({
  method: "get",
  path: "/list",
  tags: ["Sandbox"],
  summary: "List all sandboxes",
  middleware: [requireScope("sandbox:read")],
  responses: {
    200: {
      description: "List of sandboxes",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

sandboxRoutes.openapi(listSandboxesRoute, async (c): Promise<any> => {
  try {
    const resp = await proxyToRuntime(c.env.RUNTIME, "/list", "GET");
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox list failed: ${e.message}` }, 502);
  }
});

// ── Kill sandbox ─────────────────────────────────────────────────────

const killSandboxRoute = createRoute({
  method: "post",
  path: "/kill",
  tags: ["Sandbox"],
  summary: "Kill a running sandbox",
  middleware: [requireScope("sandbox:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            sandbox_id: z.string().min(1).openapi({ example: "sb-abc123" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Sandbox killed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

sandboxRoutes.openapi(killSandboxRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
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

const listFilesRoute = createRoute({
  method: "get",
  path: "/{sandbox_id}/files",
  tags: ["Sandbox"],
  summary: "List files in a sandbox",
  middleware: [requireScope("sandbox:read")],
  request: {
    params: z.object({ sandbox_id: z.string().openapi({ example: "sb-abc123" }) }),
    query: z.object({ path: z.string().default("/").openapi({ example: "/" }) }),
  },
  responses: {
    200: {
      description: "File listing",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

sandboxRoutes.openapi(listFilesRoute, async (c): Promise<any> => {
  const { sandbox_id: sandboxId } = c.req.valid("param");
  const { path } = c.req.valid("query");

  try {
    const url = `/${sandboxId}/files?path=${encodeURIComponent(path || "/")}`;
    const resp = await proxyToRuntime(c.env.RUNTIME, url, "GET");
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox files failed: ${e.message}` }, 502);
  }
});

// ── Upload file to sandbox ───────────────────────────────────────────

const uploadFileRoute = createRoute({
  method: "post",
  path: "/{sandbox_id}/files/upload",
  tags: ["Sandbox"],
  summary: "Upload a file to a sandbox",
  middleware: [requireScope("sandbox:write")],
  request: {
    params: z.object({ sandbox_id: z.string().openapi({ example: "sb-abc123" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            dest_path: z.string().min(1).openapi({ example: "/app/main.py" }),
            content: z.string().default("").openapi({ example: "print('hello')" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "File uploaded",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

sandboxRoutes.openapi(uploadFileRoute, async (c): Promise<any> => {
  const { sandbox_id: sandboxId } = c.req.valid("param");
  const body = c.req.valid("json");
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

const sandboxLogsRoute = createRoute({
  method: "get",
  path: "/{sandbox_id}/logs",
  tags: ["Sandbox"],
  summary: "Get sandbox logs",
  middleware: [requireScope("sandbox:read")],
  request: {
    params: z.object({ sandbox_id: z.string().openapi({ example: "sb-abc123" }) }),
    query: z.object({ lines: z.coerce.number().int().min(1).max(1000).default(100).openapi({ example: 100 }) }),
  },
  responses: {
    200: {
      description: "Sandbox log output",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

sandboxRoutes.openapi(sandboxLogsRoute, async (c): Promise<any> => {
  const { sandbox_id: sandboxId } = c.req.valid("param");
  const { lines } = c.req.valid("query");
  const lineCount = Math.max(1, Math.min(1000, Number(lines) || 100));

  try {
    const url = `/${sandboxId}/logs?lines=${lineCount}`;
    const resp = await proxyToRuntime(c.env.RUNTIME, url, "GET");
    return forwardResponse(c, resp);
  } catch (e: any) {
    return c.json({ error: `Runtime sandbox logs failed: ${e.message}` }, 502);
  }
});
