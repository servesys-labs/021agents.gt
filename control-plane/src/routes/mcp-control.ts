/**
 * MCP control plane router — register, monitor, and sync MCP servers.
 * Ported from agentos/api/routers/mcp_control.py
 *
 * RLS: mcp_servers is org-scoped under withOrgDb. Redundant
 * `WHERE org_id = ${user.org_id}` clauses removed.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const mcpControlRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validateRemoteUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Invalid server URL";
    const host = parsed.hostname;
    if (!host) return "Invalid server URL";
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
      return "Server URL host is not allowed";
    }
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(host)) {
      return "Server URL host is not allowed";
    }
    return null;
  } catch {
    return "Invalid server URL";
  }
}

// ── GET /mcp/servers ───────────────────────────────────────────────────

const listServersRoute = createRoute({
  method: "get",
  path: "/servers",
  tags: ["MCP"],
  summary: "List registered MCP servers",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: {
      description: "Server list",
      content: { "application/json": { schema: z.object({ servers: z.array(z.record(z.unknown())) }) } },
    },
  },
});
mcpControlRoutes.openapi(listServersRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT server_id, name, url, transport, status, last_health_at, created_at
      FROM mcp_servers ORDER BY name
    `;
    return c.json({ servers: rows });
  });
});

// ── POST /mcp/servers ──────────────────────────────────────────────────

const createServerRoute = createRoute({
  method: "post",
  path: "/servers",
  tags: ["MCP"],
  summary: "Register a new MCP server",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            url: z.string().min(1),
            transport: z.string().default("stdio"),
            auth_token: z.string().default(""),
            metadata: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Server registered",
      content: { "application/json": { schema: z.object({ server_id: z.string(), name: z.string(), status: z.string() }) } },
    },
    ...errorResponses(400),
  },
});
mcpControlRoutes.openapi(createServerRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const name = body.name.trim();
  const url = body.url.trim();
  const transport = body.transport;
  const authToken = body.auth_token;
  const metadata = body.metadata;

  if (!name) return c.json({ error: "name is required" }, 400);
  if (!url) return c.json({ error: "url is required" }, 400);

  const urlError = validateRemoteUrl(url);
  if (urlError) return c.json({ error: urlError }, 400);

  const serverId = genId();
  const now = new Date().toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO mcp_servers (server_id, org_id, name, url, transport, auth_token, metadata, status, created_at)
      VALUES (${serverId}, ${user.org_id}, ${name}, ${url}, ${transport}, ${authToken}, ${JSON.stringify(metadata)}, 'registered', ${now})
    `;

    return c.json({ server_id: serverId, name, status: "registered" });
  });
});

// ── GET /mcp/servers/{server_id}/status ────────────────────────────────

const getServerStatusRoute = createRoute({
  method: "get",
  path: "/servers/{server_id}/status",
  tags: ["MCP"],
  summary: "Get MCP server health status",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ server_id: z.string() }),
  },
  responses: {
    200: {
      description: "Server status",
      content: {
        "application/json": {
          schema: z.object({
            server_id: z.string(),
            name: z.string(),
            status: z.string(),
            healthy: z.boolean(),
            error: z.string().nullable(),
          }),
        },
      },
    },
    ...errorResponses(404),
  },
});
mcpControlRoutes.openapi(getServerStatusRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { server_id: serverId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM mcp_servers WHERE server_id = ${serverId}
    `;
    if (rows.length === 0) return c.json({ error: "MCP server not found" }, 404);
    const server = rows[0] as any;

    // Lightweight health check
    let healthy = false;
    let error = "";
    try {
      const resp = await fetch(server.url.replace(/\/+$/, "") + "/health", {
        signal: AbortSignal.timeout(5000),
      });
      healthy = resp.status < 400;
    } catch (e: any) {
      error = e.message || "Health check failed";
    }

    const status = healthy ? "healthy" : "unhealthy";
    const now = new Date().toISOString();
    await sql`UPDATE mcp_servers SET status = ${status}, last_health_at = ${now} WHERE server_id = ${serverId}`;

    return c.json({
      server_id: serverId,
      name: server.name,
      status,
      healthy,
      error: error || null,
    });
  });
});

// ── POST /mcp/servers/{server_id}/sync ─────────────────────────────────

const syncServerRoute = createRoute({
  method: "post",
  path: "/servers/{server_id}/sync",
  tags: ["MCP"],
  summary: "Sync tools from an MCP server",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ server_id: z.string() }),
  },
  responses: {
    200: {
      description: "Sync result",
      content: {
        "application/json": {
          schema: z.object({
            server_id: z.string(),
            synced_tools: z.number(),
            tools: z.array(z.record(z.unknown())),
            error: z.string().nullable(),
            synced_at: z.string(),
          }),
        },
      },
    },
    ...errorResponses(404),
  },
});
mcpControlRoutes.openapi(syncServerRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { server_id: serverId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM mcp_servers WHERE server_id = ${serverId}
    `;
    if (rows.length === 0) return c.json({ error: "MCP server not found" }, 404);
    const server = rows[0] as any;

    let tools: any[] = [];
    let error = "";
    try {
      const resp = await fetch(server.url.replace(/\/+$/, "") + "/tools", {
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status < 400) {
        const data = await resp.json() as any;
        tools = data.tools || (Array.isArray(data) ? data : []);
      }
    } catch (e: any) {
      error = e.message || "Sync failed";
    }

    const now = new Date().toISOString();
    const newStatus = error ? "sync_failed" : "synced";
    await sql`UPDATE mcp_servers SET last_health_at = ${now}, status = ${newStatus} WHERE server_id = ${serverId}`;

    return c.json({
      server_id: serverId,
      synced_tools: tools.length,
      tools,
      error: error || null,
      synced_at: now,
    });
  });
});

// ── DELETE /mcp/servers/{server_id} ────────────────────────────────────

const deleteServerRoute = createRoute({
  method: "delete",
  path: "/servers/{server_id}",
  tags: ["MCP"],
  summary: "Delete an MCP server",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ server_id: z.string() }),
  },
  responses: {
    200: {
      description: "Server deleted",
      content: { "application/json": { schema: z.object({ deleted: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
mcpControlRoutes.openapi(deleteServerRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { server_id: serverId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await sql`
      DELETE FROM mcp_servers WHERE server_id = ${serverId}
    `;
    if (result.count === 0) return c.json({ error: "MCP server not found" }, 404);
    return c.json({ deleted: serverId });
  });
});
