/**
 * Codemode routes -- CRUD for snippets, execution, templates, scoped type definitions.
 *
 * Snippets are stored in `codemode_snippets` table.
 * Execution is proxied to the runtime worker via service binding.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const codemodeRoutes = new Hono<R>();

// -- Helper: Notify runtime of snippet cache invalidation --

/**
 * Notify the runtime worker that a codemode snippet cache entry should be invalidated.
 * Fire-and-forget: failures are logged but don't block the response.
 */
async function notifyRuntimeOfSnippetInvalidation(
  env: Env,
  snippetId: string,
  orgId: string,
): Promise<void> {
  try {
    await env.RUNTIME.fetch("https://runtime/api/v1/internal/snippet-cache-invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ snippet_id: snippetId, org_id: orgId, timestamp: Date.now() }),
    });
  } catch (e) {
    console.warn("[codemode] Failed to notify runtime of snippet cache invalidation:", e);
  }
}

// -- Zod Schemas --

const CodemodeScopes = z.enum([
  "agent", "graph_node", "transform", "validator",
  "webhook", "middleware", "orchestrator", "observability",
  "test", "mcp_generator",
]);

const ScopeConfigSchema = z.object({
  allowedTools: z.union([z.literal("*"), z.array(z.string())]).optional(),
  blockedTools: z.array(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  maxToolCalls: z.number().int().min(1).max(500).optional(),
  allowNestedCodemode: z.boolean().optional(),
  maxNestingDepth: z.number().int().min(0).max(5).optional(),
}).optional();

const CreateSnippetSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1024).default(""),
  code: z.string().min(1).max(65536),
  scope: CodemodeScopes,
  input_schema: z.record(z.unknown()).optional(),
  output_schema: z.record(z.unknown()).optional(),
  scope_config: ScopeConfigSchema,
  tags: z.array(z.string()).default([]),
});

const UpdateSnippetSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(1024).optional(),
  code: z.string().min(1).max(65536).optional(),
  scope: CodemodeScopes.optional(),
  input_schema: z.record(z.unknown()).optional().nullable(),
  output_schema: z.record(z.unknown()).optional().nullable(),
  scope_config: ScopeConfigSchema.nullable(),
  tags: z.array(z.string()).optional(),
});

const ExecuteSnippetSchema = z.object({
  snippet_id: z.string().optional(),
  code: z.string().max(65536).optional(),
  scope: CodemodeScopes.default("agent"),
  input: z.unknown().optional(),
  globals: z.record(z.unknown()).optional(),
  scope_config: ScopeConfigSchema,
}).refine((d) => d.snippet_id || d.code, { message: "Either snippet_id or code is required" });

// -- POST /codemode/snippets -- Create snippet --

codemodeRoutes.post("/snippets", requireScope("codemode:write"), async (c) => {
  const body = await c.req.json();
  const parsed = CreateSnippetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);

  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const req = parsed.data;
  const id = crypto.randomUUID().slice(0, 12);
  const now = Date.now() / 1000;

  await sql`
    INSERT INTO codemode_snippets (
      id, org_id, name, description, code, scope,
      input_schema, output_schema, scope_config,
      tags, version, is_template, created_at, updated_at
    ) VALUES (
      ${id}, ${user.org_id}, ${req.name}, ${req.description}, ${req.code}, ${req.scope},
      ${JSON.stringify(req.input_schema || null)}, ${JSON.stringify(req.output_schema || null)},
      ${JSON.stringify(req.scope_config || null)},
      ${JSON.stringify(req.tags)}, ${1}, ${false}, ${now}, ${now}
    )
  `;

  return c.json({
    id, org_id: user.org_id, name: req.name, description: req.description,
    scope: req.scope, tags: req.tags, version: 1, created_at: now,
  }, 201);
});

// -- GET /codemode/snippets -- List snippets --

codemodeRoutes.get("/snippets", requireScope("codemode:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const scope = c.req.query("scope");
  const tag = c.req.query("tag");
  const search = c.req.query("q");
  const limit = Math.min(Number(c.req.query("limit") || 50), 100);
  const offset = Number(c.req.query("offset") || 0);

  let rows;
  if (scope) {
    rows = await sql`
      SELECT id, name, description, scope, tags, version, is_template, created_at, updated_at
      FROM codemode_snippets
      WHERE org_id = ${user.org_id} AND scope = ${scope}
      ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (tag) {
    rows = await sql`
      SELECT id, name, description, scope, tags, version, is_template, created_at, updated_at
      FROM codemode_snippets
      WHERE org_id = ${user.org_id} AND tags::jsonb ? ${tag}
      ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (search) {
    const pattern = `%${search}%`;
    rows = await sql`
      SELECT id, name, description, scope, tags, version, is_template, created_at, updated_at
      FROM codemode_snippets
      WHERE org_id = ${user.org_id} AND (name ILIKE ${pattern} OR description ILIKE ${pattern})
      ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT id, name, description, scope, tags, version, is_template, created_at, updated_at
      FROM codemode_snippets
      WHERE org_id = ${user.org_id}
      ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return c.json(rows);
});

// -- GET /codemode/snippets/:id -- Get snippet with code --

codemodeRoutes.get("/snippets/:id", requireScope("codemode:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const id = c.req.param("id");

  const rows = await sql`
    SELECT * FROM codemode_snippets
    WHERE id = ${id} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) return c.json({ error: "Snippet not found" }, 404);
  return c.json(rows[0]);
});

// -- PUT /codemode/snippets/:id -- Update snippet --

codemodeRoutes.put("/snippets/:id", requireScope("codemode:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = UpdateSnippetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const id = c.req.param("id");
  const req = parsed.data;
  const now = Date.now() / 1000;

  // Check ownership
  const existing = await sql`
    SELECT id, version FROM codemode_snippets WHERE id = ${id} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (existing.length === 0) return c.json({ error: "Snippet not found" }, 404);

  // Atomic version increment: bump version when code changes, otherwise keep current
  const bumpVersion = Boolean(req.code);

  await sql`
    UPDATE codemode_snippets SET
      name = COALESCE(${req.name ?? null}, name),
      description = COALESCE(${req.description ?? null}, description),
      code = COALESCE(${req.code ?? null}, code),
      scope = COALESCE(${req.scope ?? null}, scope),
      input_schema = COALESCE(${req.input_schema ? JSON.stringify(req.input_schema) : null}, input_schema),
      output_schema = COALESCE(${req.output_schema ? JSON.stringify(req.output_schema) : null}, output_schema),
      scope_config = COALESCE(${req.scope_config ? JSON.stringify(req.scope_config) : null}, scope_config),
      tags = COALESCE(${req.tags ? JSON.stringify(req.tags) : null}, tags),
      version = CASE WHEN ${bumpVersion} THEN version + 1 ELSE version END,
      updated_at = ${now}
    WHERE id = ${id} AND org_id = ${user.org_id}
  `;

  const updated = await sql`SELECT * FROM codemode_snippets WHERE id = ${id} LIMIT 1`;

  // Invalidate runtime snippet cache
  await notifyRuntimeOfSnippetInvalidation(c.env, id, user.org_id);

  return c.json(updated[0] || { id });
});

// -- DELETE /codemode/snippets/:id -- Delete snippet --

codemodeRoutes.delete("/snippets/:id", requireScope("codemode:write"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const id = c.req.param("id");

  const rows = await sql`
    DELETE FROM codemode_snippets WHERE id = ${id} AND org_id = ${user.org_id} RETURNING id
  `;
  if (rows.length === 0) return c.json({ error: "Snippet not found" }, 404);

  // Invalidate runtime snippet cache
  await notifyRuntimeOfSnippetInvalidation(c.env, id, user.org_id);

  return c.json({ deleted: true, id });
});

// -- POST /codemode/execute -- Execute code or snippet --

codemodeRoutes.post("/execute", requireScope("codemode:write"), async (c) => {
  const body = await c.req.json();
  const parsed = ExecuteSnippetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);

  const user = c.get("user");
  const req = parsed.data;

  // If snippet_id, load the code
  let code = req.code;
  let scope = req.scope;
  let scopeConfig = req.scope_config;

  if (req.snippet_id && !code) {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    const rows = await sql`
      SELECT code, scope, scope_config FROM codemode_snippets
      WHERE id = ${req.snippet_id} AND org_id = ${user.org_id}
      LIMIT 1
    `;
    if (rows.length === 0) return c.json({ error: "Snippet not found" }, 404);
    const row = rows[0] as Record<string, unknown>;
    code = String(row.code || "");
    scope = (row.scope as typeof scope) || scope;
    if (row.scope_config && !scopeConfig) {
      try { scopeConfig = JSON.parse(String(row.scope_config)); } catch {}
    }
  }

  if (!code) return c.json({ error: "No code to execute" }, 400);

  // Forward to runtime worker
  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/codemode/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          code,
          scope,
          scope_config: scopeConfig,
          input: req.input,
          globals: req.globals,
          org_id: user.org_id,
          snippet_id: req.snippet_id,
        }),
      }),
    );

    const result = await resp.json();
    return c.json(result as Record<string, unknown>, resp.status as 200);
  } catch (err) {
    console.error("[codemode] execution proxy failed:", err);
    return c.json({ error: "Codemode execution failed" }, 502);
  }
});

// -- GET /codemode/templates -- List built-in templates --

codemodeRoutes.get("/templates", async (c) => {
  // Forward to runtime for templates (they live in codemode.ts CODEMODE_TEMPLATES)
  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/codemode/templates", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
      }),
    );
    const result = await resp.json();
    return c.json(result as Record<string, unknown>);
  } catch {
    // Fallback: return minimal template list
    return c.json([
      { name: "sentiment-router", scope: "graph_node", tags: ["sentiment", "routing"] },
      { name: "data-enrichment", scope: "transform", tags: ["enrichment", "pipeline"] },
      { name: "approval-validator", scope: "validator", tags: ["validation", "business-rules"] },
      { name: "webhook-normalize", scope: "webhook", tags: ["webhook", "normalization"] },
      { name: "loop-detector", scope: "middleware", tags: ["middleware", "safety"] },
      { name: "intent-router", scope: "orchestrator", tags: ["routing", "multi-agent"] },
      { name: "latency-monitor", scope: "observability", tags: ["observability", "alerting"] },
      { name: "multi-tool-orchestrator", scope: "agent", tags: ["agent", "orchestration"] },
    ]);
  }
});

// -- GET /codemode/scopes -- List available scopes with their default configs --

codemodeRoutes.get("/scopes", async (c) => {
  return c.json([
    { scope: "agent", description: "LLM-generated code during agent turn", defaultTimeout: 30000, defaultMaxTools: 50 },
    { scope: "graph_node", description: "Custom graph node logic", defaultTimeout: 60000, defaultMaxTools: 100 },
    { scope: "transform", description: "Data transformation pipeline step", defaultTimeout: 30000, defaultMaxTools: 20 },
    { scope: "validator", description: "Schema/business-rule validation", defaultTimeout: 10000, defaultMaxTools: 5 },
    { scope: "webhook", description: "Webhook payload processing", defaultTimeout: 15000, defaultMaxTools: 10 },
    { scope: "middleware", description: "Pre/post hooks on LLM/tool calls", defaultTimeout: 5000, defaultMaxTools: 3 },
    { scope: "orchestrator", description: "Multi-agent routing/dispatch", defaultTimeout: 60000, defaultMaxTools: 100 },
    { scope: "observability", description: "Telemetry processing/alerting", defaultTimeout: 10000, defaultMaxTools: 10 },
    { scope: "test", description: "Self-test / eval execution", defaultTimeout: 120000, defaultMaxTools: 200 },
    { scope: "mcp_generator", description: "Dynamic MCP server generation", defaultTimeout: 15000, defaultMaxTools: 5 },
  ]);
});

// -- GET /codemode/types/:scope -- Get TypeScript type defs for a scope --

codemodeRoutes.get("/types/:scope", requireScope("codemode:read"), async (c) => {
  const scope = c.req.param("scope");

  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request(`https://runtime/api/v1/codemode/types/${scope}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
      }),
    );
    const result = await resp.json();
    return c.json(result as Record<string, unknown>);
  } catch (err) {
    console.error("[codemode] types proxy failed:", err);
    return c.json({ error: "Failed to get type definitions" }, 502);
  }
});

// -- GET /codemode/stats -- Codemode execution stats --

codemodeRoutes.get("/stats", requireScope("codemode:read"), async (c) => {
  const user = c.get("user");

  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    const countRows = await sql`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN scope = 'graph_node' THEN 1 END) as graph_nodes,
             COUNT(CASE WHEN scope = 'transform' THEN 1 END) as transforms,
             COUNT(CASE WHEN scope = 'validator' THEN 1 END) as validators,
             COUNT(CASE WHEN scope = 'webhook' THEN 1 END) as webhooks,
             COUNT(CASE WHEN scope = 'middleware' THEN 1 END) as middleware,
             COUNT(CASE WHEN scope = 'orchestrator' THEN 1 END) as orchestrators
      FROM codemode_snippets
      WHERE org_id = ${user.org_id}
    `;

    // Also get runtime stats
    let runtimeStats = {};
    try {
      const resp = await c.env.RUNTIME.fetch(
        new Request("https://runtime/api/v1/codemode/stats", {
          method: "GET",
          headers: c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {},
        }),
      );
      runtimeStats = await resp.json() as Record<string, unknown>;
    } catch {}

    return c.json({
      snippets: countRows[0] || {},
      runtime: runtimeStats,
    });
  } catch {
    return c.json({ snippets: {}, runtime: {} });
  }
});

// -- POST /codemode/snippets/:id/clone -- Clone a snippet --

codemodeRoutes.post("/snippets/:id/clone", requireScope("codemode:write"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const sourceId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const source = await sql`
    SELECT * FROM codemode_snippets WHERE id = ${sourceId} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (source.length === 0) return c.json({ error: "Snippet not found" }, 404);

  const src = source[0] as Record<string, unknown>;
  const newId = crypto.randomUUID().slice(0, 12);
  const now = Date.now() / 1000;
  const newName = String(body.name || `${src.name}-copy`);

  await sql`
    INSERT INTO codemode_snippets (
      id, org_id, name, description, code, scope,
      input_schema, output_schema, scope_config,
      tags, version, is_template, created_at, updated_at
    ) VALUES (
      ${newId}, ${user.org_id}, ${newName}, ${String(src.description || "")},
      ${String(src.code || "")}, ${String(src.scope || "agent")},
      ${String(src.input_schema || "null")}, ${String(src.output_schema || "null")},
      ${String(src.scope_config || "null")},
      ${String(src.tags || "[]")}, ${1}, ${false}, ${now}, ${now}
    )
  `;

  return c.json({ id: newId, name: newName, cloned_from: sourceId }, 201);
});
