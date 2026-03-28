/**
 * Components router — reusable graph components, prompts, tool sets.
 *
 * Org-scoped and public component library for sharing across projects.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import type { Env } from "../env";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const componentRoutes = createOpenAPIRouter();

// ── Helper: Notify runtime of cache invalidation ─────────────────────

/**
 * Notify the runtime worker that component caches should be invalidated.
 * Fire-and-forget: failures are logged but don't block the response.
 */
async function notifyRuntimeOfCacheInvalidation(
  env: Env,
  type: "graph" | "subgraph" | "all",
  id?: string,
): Promise<void> {
  try {
    await env.RUNTIME.fetch("https://runtime/api/v1/internal/cache-invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        type,
        graph_id: type === "graph" ? id : undefined,
        subgraph_id: type === "subgraph" ? id : undefined,
        timestamp: Date.now()
      }),
    });
  } catch (e) {
    // Non-critical: cache will be stale until TTL expires
    console.warn(`[components] Failed to notify runtime of cache invalidation:`, e);
  }
}

// ── Schemas ──────────────────────────────────────────────────────────

const ComponentCreateSchema = z.object({
  type: z.enum(["graph", "prompt", "tool_set", "node_template"]),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  content: z.record(z.unknown()),
  tags: z.array(z.string()).default([]),
  is_public: z.boolean().default(false),
});

const ComponentUpdateSchema = z.object({
  description: z.string().max(2000).optional(),
  content: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  is_public: z.boolean().optional(),
});

// ── CRUD Operations ──────────────────────────────────────────────────

// GET /components — list components
const listComponentsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Components"],
  summary: "List components",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
      offset: z.coerce.number().int().min(0).default(0).optional(),
      type: z.string().optional(),
      search: z.string().optional(),
      tags: z.string().optional(),
      include_public: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Component list",
      content: { "application/json": { schema: z.object({ components: z.array(z.record(z.unknown())), pagination: z.record(z.unknown()) }) } },
    },
  },
});
componentRoutes.openapi(listComponentsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const q = c.req.valid("query");
  const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
  const offset = Math.max(0, Number(q.offset || 0));

  let rows: any[];
  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const type = q.type;
    const search = q.search;
    const tags = q.tags?.split(",").filter(Boolean);
    const includePublic = q.include_public === "true";

    let query = sql`
      SELECT component_id, type, name, description, tags, is_public,
             created_by, created_at, updated_at, version
      FROM components
      WHERE (org_id = ${user.org_id}${includePublic ? sql` OR is_public = true` : sql``})
    `;

    if (type) {
      query = sql`${query} AND type = ${type}`;
    }

    if (tags && tags.length > 0) {
      query = sql`${query} AND tags && ${tags}`;
    }

    if (search) {
      query = sql`${query} AND (name ILIKE ${`%${search}%`} OR description ILIKE ${`%${search}%`})`;
    }

    query = sql`${query} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    rows = await query;
  } catch (err: any) {
    // Table may not exist yet — return empty
    if (err?.message?.includes("does not exist") || err?.message?.includes("relation")) {
      return c.json({ components: [], count: 0 });
    }
    throw err;
  }

  return c.json({
    components: rows.map((r: any) => ({
      id: r.component_id,
      type: r.type,
      name: r.name,
      description: r.description,
      tags: r.tags || [],
      is_public: r.is_public,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      version: r.version,
    })),
    pagination: { limit, offset },
  });
});

// GET /components/:id — get component detail
const getComponentRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Components"],
  summary: "Get a component by ID",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Component detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(403, 404),
  },
});
componentRoutes.openapi(getComponentRoute, async (c): Promise<any> => {
  const { id } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const [row] = await sql`
    SELECT component_id, type, name, description, content, tags, is_public,
           created_by, created_at, updated_at, version, org_id
    FROM components
    WHERE component_id = ${id}
  `;

  if (!row) {
    return c.json({ error: "Component not found" }, 404);
  }

  // Check access
  if (row.org_id !== user.org_id && !row.is_public) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({
    id: row.component_id,
    type: row.type,
    name: row.name,
    description: row.description,
    content: row.content,
    tags: row.tags || [],
    is_public: row.is_public,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
    can_edit: row.org_id === user.org_id,
  } as any);
});

// POST /components — create component
const createComponentRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Components"],
  summary: "Create a component",
  middleware: [requireScope("components:write")],
  request: {
    body: { content: { "application/json": { schema: ComponentCreateSchema } } },
  },
  responses: {
    201: {
      description: "Component created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 409),
  },
});
componentRoutes.openapi(createComponentRoute, async (c): Promise<any> => {
  const req = c.req.valid("json");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Check for duplicate name in org
  const [existing] = await sql`
    SELECT 1 FROM components
    WHERE org_id = ${user.org_id}
    AND type = ${req.type}
    AND name = ${req.name}
    LIMIT 1
  `;

  if (existing) {
    return c.json({ error: `Component '${req.name}' already exists in your org` }, 409);
  }

  const componentId = crypto.randomUUID();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO components (
      component_id, org_id, type, name, description, content, tags,
      is_public, created_by, created_at, updated_at, version
    ) VALUES (
      ${componentId}, ${user.org_id}, ${req.type}, ${req.name},
      ${req.description}, ${JSON.stringify(req.content)}, ${req.tags},
      ${req.is_public}, ${user.user_id}, ${now}, ${now}, '1.0.0'
    )
  `;

  return c.json({
    id: componentId,
    type: req.type,
    name: req.name,
    version: "1.0.0",
    created: true,
  }, 201);
});

// PUT /components/:id — update component
const updateComponentRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Components"],
  summary: "Update a component",
  middleware: [requireScope("components:write")],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: ComponentUpdateSchema } } },
  },
  responses: {
    200: {
      description: "Component updated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(403, 404),
  },
});
componentRoutes.openapi(updateComponentRoute, async (c): Promise<any> => {
  const { id } = c.req.valid("param");
  const req = c.req.valid("json");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Check ownership
  const [existing] = await sql`
    SELECT org_id, version FROM components WHERE component_id = ${id}
  `;

  if (!existing) {
    return c.json({ error: "Component not found" }, 404);
  }

  if (existing.org_id !== user.org_id) {
    return c.json({ error: "Cannot modify component from another org" }, 403);
  }

  // Bump version
  const versionParts = String(existing.version).split(".").map(Number);
  versionParts[2] = (versionParts[2] || 0) + 1;
  const newVersion = versionParts.join(".");

  const now = new Date().toISOString();

  await sql`
    UPDATE components
    SET
      description = COALESCE(${req.description ?? null}, description),
      content = COALESCE(${req.content ? JSON.stringify(req.content) : null}, content),
      tags = COALESCE(${req.tags ?? null}, tags),
      is_public = COALESCE(${req.is_public ?? null}, is_public),
      version = ${newVersion},
      updated_at = ${now}
    WHERE component_id = ${id}
  `;

  // Notify runtime to invalidate caches (fire-and-forget)
  const componentType = existing?.type || "graph";
  const invalidationType = componentType === "graph" ? "graph" : componentType === "subgraph" ? "subgraph" : "all";
  notifyRuntimeOfCacheInvalidation(c.env, invalidationType, id).catch(() => {});

  return c.json({
    id,
    updated: true,
    new_version: newVersion,
  });
});

// DELETE /components/:id — delete component
const deleteComponentRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Components"],
  summary: "Delete a component",
  middleware: [requireScope("components:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Component deleted",
      content: { "application/json": { schema: z.object({ deleted: z.string() }) } },
    },
    ...errorResponses(403, 404),
  },
});
componentRoutes.openapi(deleteComponentRoute, async (c): Promise<any> => {
  const { id } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const [existing] = await sql`
    SELECT org_id FROM components WHERE component_id = ${id}
  `;

  if (!existing) {
    return c.json({ error: "Component not found" }, 404);
  }

  if (existing.org_id !== user.org_id) {
    return c.json({ error: "Cannot delete component from another org" }, 403);
  }

  await sql`DELETE FROM components WHERE component_id = ${id}`;

  // Notify runtime to invalidate caches (fire-and-forget)
  notifyRuntimeOfCacheInvalidation(c.env, "all").catch(() => {});

  return c.json({ deleted: id });
});

// POST /components/:id/fork — fork a public component into your org
const forkComponentRoute = createRoute({
  method: "post",
  path: "/{id}/fork",
  tags: ["Components"],
  summary: "Fork a public component into your org",
  middleware: [requireScope("components:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    201: {
      description: "Component forked",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(403, 404),
  },
});
componentRoutes.openapi(forkComponentRoute, async (c): Promise<any> => {
  const { id } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const [source] = await sql`
    SELECT type, name, description, content, tags, org_id, is_public
    FROM components WHERE component_id = ${id}
  `;

  if (!source) {
    return c.json({ error: "Component not found" }, 404);
  }

  if (!source.is_public && source.org_id !== user.org_id) {
    return c.json({ error: "Component is not public" }, 403);
  }

  // Generate new name if conflict
  let newName = source.name;
  const [conflict] = await sql`
    SELECT 1 FROM components
    WHERE org_id = ${user.org_id}
    AND type = ${source.type}
    AND name = ${newName}
    LIMIT 1
  `;

  if (conflict) {
    newName = `${source.name} (forked)`;
  }

  const componentId = crypto.randomUUID();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO components (
      component_id, org_id, type, name, description, content, tags,
      is_public, created_by, created_at, updated_at, version
    ) VALUES (
      ${componentId}, ${user.org_id}, ${source.type}, ${newName},
      ${source.description}, ${JSON.stringify(source.content)}, ${source.tags},
      false, ${user.user_id}, ${now}, ${now}, '1.0.0'
    )
  `;

  return c.json({
    id: componentId,
    name: newName,
    forked_from: id,
    created: true,
  }, 201);
});

// ── POST /components/subgraphs — create a reusable subgraph definition ──
const createSubgraphRoute = createRoute({
  method: "post",
  path: "/subgraphs",
  tags: ["Components"],
  summary: "Create a reusable subgraph definition",
  middleware: [requireScope("components:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().default(""),
            version: z.string().default("1.0.0"),
            graph: z.record(z.unknown()),
            input_schema: z.record(z.unknown()).optional(),
            input_mapping: z.record(z.unknown()).optional(),
            output_schema: z.record(z.unknown()).optional(),
            output_mapping: z.record(z.unknown()).optional(),
            is_public: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Subgraph created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 409, 500),
  },
});
componentRoutes.openapi(createSubgraphRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const name = String(body.name || "").trim();
  const description = String(body.description || "");
  const version = String(body.version || "1.0.0");
  const graph = body.graph;
  const inputSchema = body.input_schema || body.input_mapping || {};
  const outputSchema = body.output_schema || body.output_mapping || {};
  const isPublic = Boolean(body.is_public);

  if (!name) return c.json({ error: "name is required" }, 400);
  if (!graph || typeof graph !== "object") return c.json({ error: "graph object is required" }, 400);

  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const subgraphId = crypto.randomUUID();

  try {
    await sql`
      INSERT INTO subgraph_definitions (
        subgraph_id, name, version, description, graph_json,
        input_schema, output_schema, org_id, is_public, created_at
      ) VALUES (
        ${subgraphId}, ${name}, ${version}, ${description},
        ${JSON.stringify(graph)}, ${JSON.stringify(inputSchema)},
        ${JSON.stringify(outputSchema)}, ${user.org_id}, ${isPublic},
        ${new Date().toISOString()}
      )
    `;
  } catch (err: any) {
    if (err?.message?.includes("unique") || err?.message?.includes("duplicate")) {
      return c.json({ error: `Subgraph '${name}' v${version} already exists` }, 409);
    }
    return c.json({ error: `Failed to create subgraph: ${err.message}` }, 500);
  }

  // Notify runtime to invalidate subgraph caches
  notifyRuntimeOfCacheInvalidation(c.env, "subgraph", subgraphId).catch(() => {});

  return c.json({
    subgraph_id: subgraphId,
    name,
    version,
    created: true,
  }, 201);
});

// ── PUT /components/subgraphs/:id — update a subgraph definition ──
const updateSubgraphRoute = createRoute({
  method: "put",
  path: "/subgraphs/{id}",
  tags: ["Components"],
  summary: "Update a subgraph definition",
  middleware: [requireScope("components:write")],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            description: z.string().optional(),
            version: z.string().optional(),
            graph: z.record(z.unknown()).optional(),
            input_schema: z.record(z.unknown()).optional(),
            output_schema: z.record(z.unknown()).optional(),
            is_public: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Subgraph updated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(403, 404),
  },
});
componentRoutes.openapi(updateSubgraphRoute, async (c): Promise<any> => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const [existing] = await sql`
    SELECT org_id, version FROM subgraph_definitions WHERE subgraph_id = ${id}
  `;
  if (!existing) return c.json({ error: "Subgraph not found" }, 404);
  if (existing.org_id !== user.org_id) return c.json({ error: "Access denied" }, 403);

  // Bump patch version
  const versionParts = String(existing.version).split(".").map(Number);
  versionParts[2] = (versionParts[2] || 0) + 1;
  const newVersion = body.version || versionParts.join(".");

  await sql`
    UPDATE subgraph_definitions SET
      description = COALESCE(${body.description ?? null}, description),
      graph_json = COALESCE(${body.graph ? JSON.stringify(body.graph) : null}, graph_json),
      input_schema = COALESCE(${body.input_schema ? JSON.stringify(body.input_schema) : null}, input_schema),
      output_schema = COALESCE(${body.output_schema ? JSON.stringify(body.output_schema) : null}, output_schema),
      is_public = COALESCE(${body.is_public ?? null}, is_public),
      version = ${newVersion}
    WHERE subgraph_id = ${id}
  `;

  notifyRuntimeOfCacheInvalidation(c.env, "subgraph", id).catch(() => {});

  return c.json({ subgraph_id: id, updated: true, new_version: newVersion });
});

// GET /components/catalog — list built-in and popular components
const catalogRoute = createRoute({
  method: "get",
  path: "/catalog/list",
  tags: ["Components"],
  summary: "List built-in and popular components",
  responses: {
    200: {
      description: "Component catalog",
      content: { "application/json": { schema: z.object({ builtin: z.array(z.record(z.unknown())), popular: z.array(z.record(z.unknown())) }) } },
    },
  },
});
componentRoutes.openapi(catalogRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Built-in components (system org)
  const builtin = await sql`
    SELECT component_id, type, name, description, tags, version
    FROM components
    WHERE org_id = 'system'
    ORDER BY name
  `;

  // Popular public components (most used)
  const popular = await sql`
    SELECT c.component_id, c.type, c.name, c.description, c.tags, c.version,
           COUNT(u.component_id) as usage_count
    FROM components c
    LEFT JOIN component_usage u ON c.component_id = u.component_id
    WHERE c.is_public = true
    AND c.org_id != 'system'
    GROUP BY c.component_id
    ORDER BY usage_count DESC
    LIMIT 20
  `;

  return c.json({
    builtin: builtin.map((r: any) => ({...r, source: "builtin"})),
    popular: popular.map((r: any) => ({...r, source: "community"})),
  });
});

// POST /components/:id/use — track component usage
const trackUsageRoute = createRoute({
  method: "post",
  path: "/{id}/use",
  tags: ["Components"],
  summary: "Track component usage",
  middleware: [requireScope("components:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Usage tracked",
      content: { "application/json": { schema: z.object({ tracked: z.boolean() }) } },
    },
  },
});
componentRoutes.openapi(trackUsageRoute, async (c): Promise<any> => {
  const { id } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = new Date().toISOString();

  // Fire-and-forget usage tracking
  sql`
    INSERT INTO component_usage (component_id, org_id, used_by, used_at)
    VALUES (${id}, ${user.org_id}, ${user.user_id}, ${now})
  `.catch(() => {});

  return c.json({ tracked: true });
});
