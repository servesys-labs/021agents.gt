/**
 * Connectors router — Pipedream hub abstraction, OAuth status, tool calls.
 * Ported from agentos/api/routers/connectors.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const connectorRoutes = new Hono<R>();

connectorRoutes.get("/providers", requireScope("integrations:read"), async (c) => {
  return c.json({
    providers: [
      { name: "pipedream", apps: "3,000+", status: "supported" },
      { name: "nango", apps: "250+", status: "planned" },
      { name: "merge", apps: "200+ (CRM/HR/Ticketing)", status: "planned" },
    ],
    active: "pipedream",
  });
});

connectorRoutes.get("/tools", requireScope("integrations:read"), async (c) => {
  const user = c.get("user");
  const app = c.req.query("app") || "";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // List tools from connector_tools table if available, otherwise return placeholder
  try {
    let rows;
    if (app) {
      rows = await sql`
        SELECT name, description, app, provider FROM connector_tools WHERE app = ${app} ORDER BY name
      `;
    } else {
      rows = await sql`SELECT name, description, app, provider FROM connector_tools ORDER BY name LIMIT 200`;
    }
    return c.json({ tools: rows, total: rows.length });
  } catch {
    return c.json({
      tools: [],
      total: 0,
      note: "Connector tools registry not yet populated. Configure Pipedream integration.",
    });
  }
});

connectorRoutes.post("/tools/call", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const toolName = String(body.tool_name || "").trim();
  const args = body.arguments || {};
  const app = String(body.app || "");

  if (!toolName) return c.json({ error: "tool_name is required" }, 400);

  // In edge architecture, tool calls go through RUNTIME service binding
  try {
    const start = performance.now();
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/connectors/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: toolName, arguments: args, app, user_id: user.user_id, org_id: user.org_id }),
    });
    const durationMs = performance.now() - start;

    if (resp.status >= 400) {
      const text = await resp.text();
      return c.json({ error: text.slice(0, 500) }, resp.status as any);
    }

    const result = await resp.json() as any;

    if (result.auth_required) {
      return c.json({
        success: false,
        auth_required: true,
        auth_url: result.auth_url || "",
        message: result.error || "Authentication required",
      });
    }

    // Audit
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    const now = Date.now() / 1000;
    try {
      await sql`
        INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
        VALUES (${user.org_id}, ${user.user_id}, 'connector.tool_call', 'connector', ${toolName},
                ${JSON.stringify({ provider: "pipedream", app, duration_ms: durationMs })}, ${now})
      `;
    } catch {}

    return c.json({ success: true, data: result.data, duration_ms: Math.round(durationMs * 10) / 10 });
  } catch (e: any) {
    return c.json({ error: `Connector tool call failed: ${e.message}` }, 502);
  }
});

connectorRoutes.get("/usage", requireScope("integrations:read"), async (c) => {
  const user = c.get("user");
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const since = Date.now() / 1000 - sinceDays * 86400;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT model as tool_name, COUNT(*) as calls, COALESCE(SUM(total_cost_usd), 0) as cost
    FROM billing_records
    WHERE cost_type = 'connector' AND org_id = ${user.org_id} AND created_at >= ${since}
    GROUP BY model ORDER BY calls DESC
  `;

  const totalCalls = rows.reduce((sum: number, r: any) => sum + Number(r.calls), 0);
  const totalCost = rows.reduce((sum: number, r: any) => sum + Number(r.cost), 0);

  return c.json({
    total_calls: totalCalls,
    total_cost_usd: totalCost,
    by_tool: rows,
    since_days: sinceDays,
  });
});

// ── POST /connectors/tokens — store OAuth token after OAuth flow ──────
connectorRoutes.post("/tokens", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const connectorName = String(body.connector_name || "").trim();
  const accessToken = String(body.access_token || "").trim();
  const refreshToken = String(body.refresh_token || "");
  const tokenType = String(body.token_type || "Bearer");
  const expiresAt = body.expires_at ? new Date(body.expires_at).toISOString() : null;
  const scopes = String(body.scopes || "");
  const metadataJson = JSON.stringify(body.metadata || {});

  if (!connectorName) return c.json({ error: "connector_name is required" }, 400);
  if (!accessToken) return c.json({ error: "access_token is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = new Date().toISOString();

  try {
    await sql`
      INSERT INTO connector_tokens (
        org_id, connector_name, access_token, refresh_token,
        token_type, expires_at, scopes, metadata_json, created_at, updated_at
      ) VALUES (
        ${user.org_id}, ${connectorName}, ${accessToken}, ${refreshToken},
        ${tokenType}, ${expiresAt}, ${scopes}, ${metadataJson}, ${now}, ${now}
      )
      ON CONFLICT (org_id, connector_name) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_type = EXCLUDED.token_type,
        expires_at = EXCLUDED.expires_at,
        scopes = EXCLUDED.scopes,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at
    `;
  } catch (err: any) {
    return c.json({ error: `Failed to store token: ${err.message}` }, 500);
  }

  // Audit
  try {
    const nowEpoch = Date.now() / 1000;
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'connector.token_stored', 'connector', ${connectorName},
              ${JSON.stringify({ scopes, token_type: tokenType })}, ${nowEpoch})
    `;
  } catch {}

  return c.json({ connector_name: connectorName, stored: true });
});

// ── DELETE /connectors/tokens/:connector — revoke a connector token ──
connectorRoutes.delete("/tokens/:connector", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const connectorName = c.req.param("connector");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  await sql`
    DELETE FROM connector_tokens
    WHERE org_id = ${user.org_id} AND connector_name = ${connectorName}
  `;

  return c.json({ connector_name: connectorName, revoked: true });
});

// ── POST /connectors/tools — register tools for a connector ──────────
connectorRoutes.post("/tools", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const tools = Array.isArray(body.tools) ? body.tools : [];

  if (tools.length === 0) return c.json({ error: "tools array is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  let inserted = 0;

  for (const tool of tools) {
    const name = String(tool.name || "").trim();
    const description = String(tool.description || "");
    const app = String(tool.app || "");
    const provider = String(tool.provider || "pipedream");

    if (!name) continue;

    try {
      await sql`
        INSERT INTO connector_tools (name, description, app, provider)
        VALUES (${name}, ${description}, ${app}, ${provider})
        ON CONFLICT (name) DO UPDATE SET
          description = EXCLUDED.description,
          app = EXCLUDED.app,
          provider = EXCLUDED.provider
      `;
      inserted++;
    } catch {}
  }

  return c.json({ registered: inserted, total: tools.length });
});

connectorRoutes.get("/auth/:app", requireScope("integrations:read"), async (c) => {
  const app = c.req.param("app");
  const user = c.get("user");

  // Proxy to runtime for OAuth URL generation
  try {
    const resp = await c.env.RUNTIME.fetch(
      `https://runtime/api/v1/connectors/auth/${app}?user_id=${user.user_id}`,
      { method: "GET" },
    );
    if (resp.status >= 400) {
      return c.json({ app, auth_url: "", error: "OAuth not configured for this app" });
    }
    const data = await resp.json() as any;
    return c.json({ app, auth_url: data.auth_url || "" });
  } catch {
    return c.json({ app, auth_url: "", error: "Runtime service unavailable" });
  }
});
