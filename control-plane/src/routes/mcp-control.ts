/**
 * MCP control plane router — register, monitor, and sync MCP servers.
 * Ported from agentos/api/routers/mcp_control.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const mcpControlRoutes = new Hono<R>();

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

mcpControlRoutes.get("/servers", requireScope("integrations:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT server_id, name, url, transport, status, last_health_at, created_at
    FROM mcp_servers WHERE org_id = ${user.org_id} ORDER BY name
  `;
  return c.json({ servers: rows });
});

mcpControlRoutes.post("/servers", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const url = String(body.url || "").trim();
  const transport = String(body.transport || "stdio");
  const authToken = String(body.auth_token || "");
  const metadata = body.metadata || {};

  if (!name) return c.json({ error: "name is required" }, 400);
  if (!url) return c.json({ error: "url is required" }, 400);

  const urlError = validateRemoteUrl(url);
  if (urlError) return c.json({ error: urlError }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const serverId = genId();
  const now = Date.now() / 1000;

  await sql`
    INSERT INTO mcp_servers (server_id, org_id, name, url, transport, auth_token, metadata_json, status, created_at)
    VALUES (${serverId}, ${user.org_id}, ${name}, ${url}, ${transport}, ${authToken}, ${JSON.stringify(metadata)}, 'registered', ${now})
  `;

  return c.json({ server_id: serverId, name, status: "registered" });
});

mcpControlRoutes.get("/servers/:server_id/status", requireScope("integrations:read"), async (c) => {
  const user = c.get("user");
  const serverId = c.req.param("server_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM mcp_servers WHERE server_id = ${serverId} AND org_id = ${user.org_id}
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
  const now = Date.now() / 1000;
  await sql`UPDATE mcp_servers SET status = ${status}, last_health_at = ${now} WHERE server_id = ${serverId}`;

  return c.json({
    server_id: serverId,
    name: server.name,
    status,
    healthy,
    error: error || null,
  });
});

mcpControlRoutes.post("/servers/:server_id/sync", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const serverId = c.req.param("server_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM mcp_servers WHERE server_id = ${serverId} AND org_id = ${user.org_id}
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

  const now = Date.now() / 1000;
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

mcpControlRoutes.delete("/servers/:server_id", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const serverId = c.req.param("server_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM mcp_servers WHERE server_id = ${serverId} AND org_id = ${user.org_id}
  `;
  if (result.count === 0) return c.json({ error: "MCP server not found" }, 404);
  return c.json({ deleted: serverId });
});
