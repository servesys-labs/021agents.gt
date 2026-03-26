/**
 * Components router — reusable graph components, prompts, tool sets.
 * 
 * Org-scoped and public component library for sharing across projects.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const componentRoutes = new Hono<R>();

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
componentRoutes.get("/", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  
  const type = c.req.query("type");
  const search = c.req.query("search");
  const tags = c.req.query("tags")?.split(",").filter(Boolean);
  const includePublic = c.req.query("include_public") === "true";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 20)));
  const offset = Math.max(0, Number(c.req.query("offset") || 0));
  
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
    // Array overlap check
    query = sql`${query} AND tags && ${tags}`;
  }
  
  if (search) {
    query = sql`${query} AND (name ILIKE ${`%${search}%`} OR description ILIKE ${`%${search}%`})`;
  }
  
  query = sql`${query} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  
  const rows = await query;
  
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
componentRoutes.get("/:id", async (c) => {
  const { id } = c.req.param();
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
  });
});

// POST /components — create component
componentRoutes.post(
  "/",
  requireScope("components:write"),
  async (c) => {
    const body = await c.req.json();
    const parsed = ComponentCreateSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    
    const req = parsed.data;
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
    const now = Date.now() / 1000;
    
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
  }
);

// PUT /components/:id — update component
componentRoutes.put(
  "/:id",
  requireScope("components:write"),
  async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = ComponentUpdateSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    
    const req = parsed.data;
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
    
    const now = Date.now() / 1000;
    
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
  }
);

// DELETE /components/:id — delete component
componentRoutes.delete(
  "/:id",
  requireScope("components:write"),
  async (c) => {
    const { id } = c.req.param();
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
  }
);

// POST /components/:id/fork — fork a public component into your org
componentRoutes.post("/:id/fork", requireScope("components:write"), async (c) => {
  const { id } = c.req.param();
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
  const now = Date.now() / 1000;
  
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

// GET /components/catalog — list built-in and popular components
componentRoutes.get("/catalog/list", async (c) => {
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
componentRoutes.post("/:id/use", requireScope("components:write"), async (c) => {
  const { id } = c.req.param();
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = Date.now() / 1000;
  
  // Fire-and-forget usage tracking
  sql`
    INSERT INTO component_usage (component_id, org_id, used_by, used_at)
    VALUES (${id}, ${user.org_id}, ${user.user_id}, ${now})
  `.catch(() => {});
  
  return c.json({ tracked: true });
});
