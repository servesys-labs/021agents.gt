/**
 * Connectors router — Pipedream hub abstraction, OAuth status, tool calls.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { failSafe } from "../lib/error-response";
import type { AuditAction } from "../telemetry/events";

export const connectorRoutes = createOpenAPIRouter();

// ── GET /connectors/providers ──────────────────────────────────────────

const listProvidersRoute = createRoute({
  method: "get",
  path: "/providers",
  tags: ["Connectors"],
  summary: "List supported connector providers",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: {
      description: "Provider list",
      content: {
        "application/json": {
          schema: z.object({
            providers: z.array(z.object({
              name: z.string(),
              apps: z.string(),
              status: z.string(),
            })),
            active: z.string(),
          }),
        },
      },
    },
  },
});
connectorRoutes.openapi(listProvidersRoute, async (c): Promise<any> => {
  return c.json({
    providers: [
      { name: "pipedream", apps: "3,000+", status: "supported" },
      { name: "nango", apps: "250+", status: "planned" },
      { name: "merge", apps: "200+ (CRM/HR/Ticketing)", status: "planned" },
    ],
    active: "pipedream",
  });
});

// ── GET /connectors/tools ──────────────────────────────────────────────

const listToolsRoute = createRoute({
  method: "get",
  path: "/tools",
  tags: ["Connectors"],
  summary: "List connector tools",
  middleware: [requireScope("integrations:read")],
  request: {
    query: z.object({
      app: z.string().optional().openapi({ description: "Filter by app name" }),
    }),
  },
  responses: {
    200: {
      description: "Tool list",
      content: { "application/json": { schema: z.object({ tools: z.array(z.record(z.unknown())), total: z.number(), note: z.string().optional() }) } },
    },
  },
});
connectorRoutes.openapi(listToolsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { app } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
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
});

// ── POST /connectors/tools/call ────────────────────────────────────────

const callToolRoute = createRoute({
  method: "post",
  path: "/tools/call",
  tags: ["Connectors"],
  summary: "Call a connector tool",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tool_name: z.string().min(1),
            arguments: z.record(z.unknown()).default({}),
            app: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tool call result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
    502: { description: "Bad gateway", content: { "application/json": { schema: ErrorSchema } } },
  },
});
connectorRoutes.openapi(callToolRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const toolName = body.tool_name.trim();
  const args = body.arguments;
  const app = body.app;

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
    const now = new Date().toISOString();
    try {
      await withOrgDb(c.env, user.org_id, async (sql) => {
        await sql`
          INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
          VALUES (${user.org_id}, ${user.user_id}, ${"connector.tool_call" satisfies AuditAction}, 'connector', ${toolName},
                  ${JSON.stringify({ provider: "pipedream", app, duration_ms: durationMs })}, ${now})
        `;
      });
    } catch {}

    return c.json({ success: true, data: result.data, duration_ms: Math.round(durationMs * 10) / 10 });
  } catch (e: any) {
    return c.json({ error: `Connector tool call failed: ${e.message}` }, 502);
  }
});

// ── GET /connectors/usage ──────────────────────────────────────────────

const getUsageRoute = createRoute({
  method: "get",
  path: "/usage",
  tags: ["Connectors"],
  summary: "Get connector usage stats",
  middleware: [requireScope("integrations:read")],
  request: {
    query: z.object({
      since_days: z.coerce.number().int().min(1).max(365).default(30).openapi({ description: "Lookback window in days" }),
    }),
  },
  responses: {
    200: {
      description: "Usage summary",
      content: { "application/json": { schema: z.object({ total_calls: z.number(), total_cost_usd: z.number(), by_tool: z.array(z.record(z.unknown())), since_days: z.number() }) } },
    },
  },
});
connectorRoutes.openapi(getUsageRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { since_days: sinceDays } = c.req.valid("query");
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT model as tool_name, COUNT(*) as calls, COALESCE(SUM(total_cost_usd), 0) as cost
      FROM billing_records
      WHERE cost_type = 'connector' AND created_at >= ${since}
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
});

// ── POST /connectors/tokens ────────────────────────────────────────────

const storeTokenRoute = createRoute({
  method: "post",
  path: "/tokens",
  tags: ["Connectors"],
  summary: "Store OAuth token after OAuth flow",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1),
            app: z.string().default(""),
            access_token_enc: z.string().min(1),
            refresh_token_enc: z.string().default(""),
            expires_at: z.string().optional(),
            scopes: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Token stored",
      content: { "application/json": { schema: z.object({ provider: z.string(), stored: z.boolean() }) } },
    },
    ...errorResponses(400, 500),
  },
});
connectorRoutes.openapi(storeTokenRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const provider = body.provider.trim();
  const app = body.app.trim();
  const accessTokenEnc = body.access_token_enc.trim();
  const refreshTokenEnc = body.refresh_token_enc;
  const expiresAt = body.expires_at ? new Date(body.expires_at).toISOString() : null;
  const scopes = body.scopes;

  if (!provider) return c.json({ error: "provider is required" }, 400);
  if (!accessTokenEnc) return c.json({ error: "access_token_enc is required" }, 400);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();

    try {
      await sql`
        INSERT INTO connector_tokens (
          org_id, provider, app, access_token_enc, refresh_token_enc,
          expires_at, scopes, created_at, updated_at
        ) VALUES (
          ${user.org_id}, ${provider}, ${app}, ${accessTokenEnc}, ${refreshTokenEnc},
          ${expiresAt}, ${scopes}, ${now}, ${now}
        )
        ON CONFLICT (org_id, provider, app) DO UPDATE SET
          access_token_enc = EXCLUDED.access_token_enc,
          refresh_token_enc = EXCLUDED.refresh_token_enc,
          expires_at = EXCLUDED.expires_at,
          scopes = EXCLUDED.scopes,
          updated_at = EXCLUDED.updated_at
      `;
    } catch (err) {
      return c.json(failSafe(err, "connectors/store-token", { userMessage: "We couldn't save the connector token. Please try reconnecting the integration." }), 500);
    }

    // Audit
    try {
      const nowEpoch = new Date().toISOString();
      await sql`
        INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
        VALUES (${user.org_id}, ${user.user_id}, ${"connector.token_stored" satisfies AuditAction}, 'connector', ${provider},
                ${JSON.stringify({ scopes })}, ${nowEpoch})
      `;
    } catch {}

    return c.json({ provider, stored: true });
  });
});

// ── DELETE /connectors/tokens/{connector} ──────────────────────────────

const revokeTokenRoute = createRoute({
  method: "delete",
  path: "/tokens/{connector}",
  tags: ["Connectors"],
  summary: "Revoke a connector token",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ connector: z.string() }),
  },
  responses: {
    200: {
      description: "Token revoked",
      content: { "application/json": { schema: z.object({ provider: z.string(), revoked: z.boolean() }) } },
    },
  },
});
connectorRoutes.openapi(revokeTokenRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { connector: connectorProvider } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      DELETE FROM connector_tokens
      WHERE provider = ${connectorProvider}
    `;

    return c.json({ provider: connectorProvider, revoked: true });
  });
});

// ── POST /connectors/tools (register) ──────────────────────────────────

const registerToolsRoute = createRoute({
  method: "post",
  path: "/tools",
  tags: ["Connectors"],
  summary: "Register tools for a connector",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tools: z.array(z.object({
              name: z.string().min(1),
              description: z.string().default(""),
              app: z.string().default(""),
              provider: z.string().default("pipedream"),
            })),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Registration result",
      content: { "application/json": { schema: z.object({ registered: z.number(), total: z.number() }) } },
    },
    ...errorResponses(400),
  },
});
connectorRoutes.openapi(registerToolsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const tools = body.tools;

  if (tools.length === 0) return c.json({ error: "tools array is required" }, 400);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let inserted = 0;

    for (const tool of tools) {
      const name = tool.name.trim();
      const description = tool.description;
      const app = tool.app;
      const provider = tool.provider;

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
});

// ── GET /connectors/auth/{app} ─────────────────────────────────────────

const getAuthRoute = createRoute({
  method: "get",
  path: "/auth/{app}",
  tags: ["Connectors"],
  summary: "Get OAuth URL for a connector app",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ app: z.string() }),
  },
  responses: {
    200: {
      description: "Auth URL",
      content: { "application/json": { schema: z.object({ app: z.string(), auth_url: z.string(), error: z.string().optional() }) } },
    },
  },
});
connectorRoutes.openapi(getAuthRoute, async (c): Promise<any> => {
  const { app } = c.req.valid("param");
  const user = c.get("user");
  const projectId = String(c.env.PIPEDREAM_PROJECT_ID || "").trim();
  if (!projectId) {
    return c.json({ app, auth_url: "", error: "OAuth not configured for this app" });
  }

  // Keep parity with the prior connector-hub behavior:
  // https://pipedream.com/_static/connect.html?app=...&connectLink=true&...
  const params = new URLSearchParams({
    app,
    connectLink: "true",
    external_user_id: user.user_id || "default-user",
    project_id: projectId,
    environment: String((c.env as any).PIPEDREAM_ENV || "production"),
  });
  const authUrl = `https://pipedream.com/_static/connect.html?${params.toString()}`;
  return c.json({ app, auth_url: authUrl });
});
