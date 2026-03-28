/**
 * Codemode routes -- CRUD for snippets, execution, templates, scoped type definitions.
 *
 * Snippets are stored in `codemode_snippets` table.
 * Execution is proxied to the runtime worker via service binding.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { Env } from "../env";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const codemodeRoutes = createOpenAPIRouter();

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

const createSnippetRoute = createRoute({
  method: "post",
  path: "/snippets",
  tags: ["Codemode"],
  summary: "Create a codemode snippet",
  middleware: [requireScope("codemode:write")],
  request: {
    body: { content: { "application/json": { schema: CreateSnippetSchema } } },
  },
  responses: {
    201: {
      description: "Snippet created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
codemodeRoutes.openapi(createSnippetRoute, async (c): Promise<any> => {
  const req = c.req.valid("json");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const id = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();

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

const listSnippetsRoute = createRoute({
  method: "get",
  path: "/snippets",
  tags: ["Codemode"],
  summary: "List codemode snippets",
  middleware: [requireScope("codemode:read")],
  request: {
    query: z.object({
      scope: z.string().optional(),
      tag: z.string().optional(),
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
      offset: z.coerce.number().int().min(0).default(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Snippet list",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
  },
});
codemodeRoutes.openapi(listSnippetsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const q = c.req.valid("query");
  const scope = q.scope;
  const tag = q.tag;
  const search = q.q;
  const limit = Math.min(Number(q.limit || 50), 100);
  const offset = Number(q.offset || 0);

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

  return c.json(rows as any);
});

// -- GET /codemode/snippets/:id -- Get snippet with code --

const getSnippetRoute = createRoute({
  method: "get",
  path: "/snippets/{id}",
  tags: ["Codemode"],
  summary: "Get a codemode snippet by ID",
  middleware: [requireScope("codemode:read")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Snippet detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
codemodeRoutes.openapi(getSnippetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const { id } = c.req.valid("param");

  const rows = await sql`
    SELECT * FROM codemode_snippets
    WHERE id = ${id} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) return c.json({ error: "Snippet not found" }, 404);
  return c.json(rows[0] as any);
});

// -- PUT /codemode/snippets/:id -- Update snippet --

const updateSnippetRoute = createRoute({
  method: "put",
  path: "/snippets/{id}",
  tags: ["Codemode"],
  summary: "Update a codemode snippet",
  middleware: [requireScope("codemode:write")],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateSnippetSchema } } },
  },
  responses: {
    200: {
      description: "Snippet updated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404),
  },
});
codemodeRoutes.openapi(updateSnippetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const req = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const { id } = c.req.valid("param");
  const now = new Date().toISOString();

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

  return c.json(updated[0] as any || { id });
});

// -- DELETE /codemode/snippets/:id -- Delete snippet --

const deleteSnippetRoute = createRoute({
  method: "delete",
  path: "/snippets/{id}",
  tags: ["Codemode"],
  summary: "Delete a codemode snippet",
  middleware: [requireScope("codemode:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Snippet deleted",
      content: { "application/json": { schema: z.object({ deleted: z.boolean(), id: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
codemodeRoutes.openapi(deleteSnippetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const { id } = c.req.valid("param");

  const rows = await sql`
    DELETE FROM codemode_snippets WHERE id = ${id} AND org_id = ${user.org_id} RETURNING id
  `;
  if (rows.length === 0) return c.json({ error: "Snippet not found" }, 404);

  // Invalidate runtime snippet cache
  await notifyRuntimeOfSnippetInvalidation(c.env, id, user.org_id);

  return c.json({ deleted: true, id });
});

// -- POST /codemode/execute -- Execute code or snippet --

const executeRoute = createRoute({
  method: "post",
  path: "/execute",
  tags: ["Codemode"],
  summary: "Execute codemode snippet or inline code",
  middleware: [requireScope("codemode:write")],
  request: {
    body: { content: { "application/json": { schema: ExecuteSnippetSchema } } },
  },
  responses: {
    200: {
      description: "Execution result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404, 500),
  },
});
codemodeRoutes.openapi(executeRoute, async (c): Promise<any> => {
  const req = c.req.valid("json");
  const user = c.get("user");

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

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/templates",
  tags: ["Codemode"],
  summary: "List built-in codemode templates",
  responses: {
    200: {
      description: "Template list",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
  },
});
codemodeRoutes.openapi(listTemplatesRoute, async (c): Promise<any> => {
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
    return c.json(result as any);
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
    ] as any);
  }
});

// -- GET /codemode/scopes -- List available scopes with their default configs --

const listScopesRoute = createRoute({
  method: "get",
  path: "/scopes",
  tags: ["Codemode"],
  summary: "List available codemode scopes",
  responses: {
    200: {
      description: "Scope list",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
  },
});
codemodeRoutes.openapi(listScopesRoute, async (c): Promise<any> => {
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
  ] as any);
});

// -- GET /codemode/types/:scope -- Get TypeScript type defs for a scope --

const getTypesRoute = createRoute({
  method: "get",
  path: "/types/{scope}",
  tags: ["Codemode"],
  summary: "Get TypeScript type definitions for a codemode scope",
  middleware: [requireScope("codemode:read")],
  request: {
    params: z.object({ scope: z.string() }),
  },
  responses: {
    200: {
      description: "Type definitions",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});
codemodeRoutes.openapi(getTypesRoute, async (c): Promise<any> => {
  const { scope } = c.req.valid("param");

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

const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Codemode"],
  summary: "Get codemode execution stats",
  middleware: [requireScope("codemode:read")],
  responses: {
    200: {
      description: "Codemode stats",
      content: { "application/json": { schema: z.object({ snippets: z.record(z.unknown()), runtime: z.record(z.unknown()) }) } },
    },
  },
});
codemodeRoutes.openapi(statsRoute, async (c): Promise<any> => {
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

const cloneSnippetRoute = createRoute({
  method: "post",
  path: "/snippets/{id}/clone",
  tags: ["Codemode"],
  summary: "Clone a codemode snippet",
  middleware: [requireScope("codemode:write")],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
          }),
        },
      },
      required: false,
    },
  },
  responses: {
    201: {
      description: "Snippet cloned",
      content: { "application/json": { schema: z.object({ id: z.string(), name: z.string(), cloned_from: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
codemodeRoutes.openapi(cloneSnippetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const { id: sourceId } = c.req.valid("param");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const source = await sql`
    SELECT * FROM codemode_snippets WHERE id = ${sourceId} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (source.length === 0) return c.json({ error: "Snippet not found" }, 404);

  const src = source[0] as Record<string, unknown>;
  const newId = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();
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
