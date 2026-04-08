/**
 * Workspace routes — browse and preview files stored in R2.
 * Proxies to the RUNTIME service binding which has the R2 STORAGE binding.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { errorResponses } from "../schemas/openapi";
import { requireScope } from "../middleware/auth";

export const workspaceRoutes = createOpenAPIRouter();

// ── GET /files — list workspace files from R2 manifest ──────

const listFilesRoute = createRoute({
  method: "get",
  path: "/files",
  tags: ["Workspace"],
  summary: "List workspace files for an agent",
  middleware: [requireScope("agents:read")],
  request: {
    query: z.object({
      agent_name: z.string().min(1),
      user_id: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "File list", content: { "application/json": { schema: z.object({ files: z.array(z.record(z.unknown())) }) } } },
    ...errorResponses(500),
  },
});

workspaceRoutes.openapi(listFilesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, user_id } = c.req.valid("query");

  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/workspace/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org_id: user.org_id,
        agent_name,
        user_id: user_id || user.user_id,
      }),
    });
    const data = await resp.json();
    return c.json(data);
  } catch (err: any) {
    return c.json({ files: [], error: err.message }, 500);
  }
});

// ── GET /files/read — read a single file from R2 ───────────

const readFileRoute = createRoute({
  method: "get",
  path: "/files/read",
  tags: ["Workspace"],
  summary: "Read a file from the workspace",
  middleware: [requireScope("agents:read")],
  request: {
    query: z.object({
      agent_name: z.string().min(1),
      path: z.string().min(1),
      user_id: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "File content", content: { "application/json": { schema: z.object({ path: z.string(), content: z.string(), size: z.number(), mime_type: z.string().optional() }) } } },
    ...errorResponses(404, 500),
  },
});

workspaceRoutes.openapi(readFileRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, path: filePath, user_id } = c.req.valid("query");

  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/workspace/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org_id: user.org_id,
        agent_name,
        path: filePath,
        user_id: user_id || user.user_id,
      }),
    });
    if (!resp.ok) return c.json({ error: "File not found" }, 404);
    const data = await resp.json();
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /projects — list workspace projects from R2 ─────────

const listProjectsRoute = createRoute({
  method: "get",
  path: "/projects",
  tags: ["Workspace"],
  summary: "List workspace projects for an agent",
  middleware: [requireScope("agents:read")],
  request: {
    query: z.object({
      agent_name: z.string().min(1),
    }),
  },
  responses: {
    200: { description: "Project list", content: { "application/json": { schema: z.object({ projects: z.array(z.record(z.unknown())) }) } } },
    ...errorResponses(500),
  },
});

workspaceRoutes.openapi(listProjectsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name } = c.req.valid("query");

  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/workspace/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_id: user.org_id, agent_name }),
    });
    const data = await resp.json();
    return c.json(data);
  } catch (err: any) {
    return c.json({ projects: [], error: err.message }, 500);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Phase 8.2: Workspace Write Endpoints
// ══════════════════════════════════════════════════════════════════════

const createFileRoute = createRoute({
  method: "post",
  path: "/files/create",
  tags: ["Workspace"],
  summary: "Create a file in the workspace",
  middleware: [requireScope("agents:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            path: z.string().min(1),
            content: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Create file result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 413, 500),
  },
});

workspaceRoutes.openapi(createFileRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Path traversal prevention
  if (body.path.includes("..") || body.path.startsWith("/")) {
    return c.json({ error: "Invalid path: must be relative, no '..' allowed" }, 400);
  }

  // Size limit: 10MB
  if (body.content.length > 10_000_000) {
    return c.json({ error: "File too large (max 10MB)" }, 413);
  }

  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/workspace/files/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org_id: user.org_id,
        agent_name: body.agent_name,
        user_id: user.user_id,
        path: body.path,
        content: body.content,
      }),
    });
    const data = await resp.json();
    return c.json(data, resp.ok ? 200 : 500);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * DELETE /files — Delete a file from the workspace
 */
const deleteFileRoute = createRoute({
  method: "delete",
  path: "/files",
  tags: ["Workspace"],
  summary: "Delete a file from the workspace",
  middleware: [requireScope("agents:write")],
  request: {
    query: z.object({
      agent_name: z.string().min(1),
      path: z.string().min(1),
    }),
  },
  responses: {
    200: { description: "Delete file result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
  },
});

workspaceRoutes.openapi(deleteFileRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, path } = c.req.valid("query");

  if (path.includes("..") || path.startsWith("/")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/workspace/files/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_id: user.org_id, agent_name: agentName, user_id: user.user_id, path }),
    });
    const data = await resp.json();
    return c.json(data, resp.ok ? 200 : 500);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
