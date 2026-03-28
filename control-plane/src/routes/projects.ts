/**
 * Projects router — org > project > agents hierarchy, canvas layout, meta-agent bootstrap.
 * Ported from agentos/api/routers/projects.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses, ProjectSummary } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { ORCHESTRATOR_SYSTEM_PROMPT, ORCHESTRATOR_TOOLS } from "../templates/orchestrator";

export const projectRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireProjectOrg(sql: any, projectId: string, orgId: string): Promise<any> {
  const rows = await sql`
    SELECT * FROM projects WHERE project_id = ${projectId} AND org_id = ${orgId}
  `;
  if (rows.length === 0) throw { status: 404, message: "Project not found" };
  return rows[0];
}

// ── GET / — list projects ───────────────────────────────────────────────

const listProjectsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Projects"],
  summary: "List projects for the current org",
  middleware: [requireScope("projects:read")],
  responses: {
    200: {
      description: "Project list",
      content: { "application/json": { schema: z.object({ projects: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(401, 500),
  },
});
projectRoutes.openapi(listProjectsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM projects WHERE org_id = ${user.org_id} ORDER BY created_at DESC
  `;
  return c.json({ projects: rows });
});

// ── POST / — create a project ───────────────────────────────────────────

const createProjectRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Projects"],
  summary: "Create a new project with environments and meta-agent",
  middleware: [requireScope("projects:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().default(""),
            plan: z.string().default("standard"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Created project",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 500),
  },
});
projectRoutes.openapi(createProjectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const name = String(body.name || "").trim();
  const description = String(body.description || "");
  const plan = String(body.plan || "standard");

  if (!name) return c.json({ error: "name is required" }, 400);
  const allowedPlans = new Set(["starter", "standard", "pro", "enterprise"]);
  if (!allowedPlans.has(plan)) return c.json({ error: "Invalid plan" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const projectId = genId();
  const slug = name.toLowerCase().replace(/\s+/g, "-");

  await sql`
    INSERT INTO projects (project_id, org_id, name, slug, description, default_plan)
    VALUES (${projectId}, ${user.org_id}, ${name}, ${slug}, ${description}, ${plan})
  `;

  // Create default environments
  for (const envName of ["development", "staging", "production"]) {
    const envId = genId();
    await sql`
      INSERT INTO environments (env_id, project_id, name) VALUES (${envId}, ${projectId}, ${envName})
    `;
  }

  // Bootstrap meta-agent with full orchestrator prompt and tools
  let metaAgent: any = { name: "", created: false };
  try {
    const agentName = `${slug}-meta-agent` || `project-${projectId.slice(0, 8)}-meta-agent`;
    // Check if already exists
    const existing = await sql`SELECT name FROM agents WHERE name = ${agentName}`;
    if (existing.length === 0) {
      // Inject project context into the orchestrator system prompt
      const projectContext = `\n\n## Project Context\n- Project: ${name}\n- Project ID: ${projectId}\n- Plan: ${plan}\n- Description: ${description || "N/A"}\n`;
      const systemPrompt = ORCHESTRATOR_SYSTEM_PROMPT + projectContext;

      const configJson = JSON.stringify({
        name: agentName,
        system_prompt: systemPrompt,
        model: "anthropic/claude-sonnet-4-6",
        tools: ORCHESTRATOR_TOOLS,
        max_turns: 20,
        governance: {
          budget_limit_usd: 20.0,
          require_confirmation_for_destructive: true,
          blocked_tools: [],
          allowed_domains: [],
        },
        memory: {
          working: { max_items: 200 },
          episodic: { max_episodes: 500, ttl_days: 30 },
          procedural: { max_procedures: 100 },
        },
        tags: ["meta-agent", `project:${projectId}`],
        plan: "standard",
      });

      const agentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const now = new Date().toISOString();
      await sql`
        INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, version, is_active, created_by, created_at, updated_at)
        VALUES (
          ${agentId}, ${agentName}, ${user.org_id}, ${projectId}, ${configJson},
          ${`Orchestrator meta-agent for ${name} — builds, tests, and continuously improves all agents`},
          ${"0.1.0"}, 1, ${user.user_id}, ${now}, ${now}
        )
      `;
      metaAgent = { name: agentName, created: true, tools_count: ORCHESTRATOR_TOOLS.length };
    } else {
      metaAgent = { name: agentName, created: false };
    }
  } catch (err: any) {
    console.error("[projects] Meta-agent bootstrap failed:", err?.message || err);
    metaAgent = { name: "", created: false, error: String(err?.message || "bootstrap_failed").slice(0, 200) };
  }

  // Audit
  try {
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'project.create', 'project', ${projectId}, ${JSON.stringify({ name })}, ${new Date().toISOString()})
    `;
  } catch {}

  return c.json({
    project_id: projectId,
    name,
    slug,
    envs: ["development", "staging", "production"],
    meta_agent: metaAgent,
  });
});

// ── GET /:project_id — get project details ──────────────────────────────

const getProjectRoute = createRoute({
  method: "get",
  path: "/{project_id}",
  tags: ["Projects"],
  summary: "Get project details with environments",
  middleware: [requireScope("projects:read")],
  request: {
    params: z.object({ project_id: z.string() }),
  },
  responses: {
    200: {
      description: "Project details",
      content: { "application/json": { schema: z.object({ project: z.record(z.unknown()), environments: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(400, 401, 404, 500),
  },
});
projectRoutes.openapi(getProjectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { project_id: projectId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let project: any;
  try {
    project = await requireProjectOrg(sql, projectId, user.org_id);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  const envs = await sql`SELECT * FROM environments WHERE project_id = ${projectId}`;
  return c.json({ project, environments: envs });
});

// ── GET /:project_id/envs — list environments ──────────────────────────

const listEnvsRoute = createRoute({
  method: "get",
  path: "/{project_id}/envs",
  tags: ["Projects"],
  summary: "List environments for a project",
  middleware: [requireScope("projects:read")],
  request: {
    params: z.object({ project_id: z.string() }),
  },
  responses: {
    200: {
      description: "Environment list",
      content: { "application/json": { schema: z.object({ environments: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(400, 401, 404, 500),
  },
});
projectRoutes.openapi(listEnvsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { project_id: projectId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    await requireProjectOrg(sql, projectId, user.org_id);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  const rows = await sql`SELECT * FROM environments WHERE project_id = ${projectId}`;
  return c.json({ environments: rows });
});

// ── PUT /:project_id/envs/:env_name — update environment ───────────────

const updateEnvRoute = createRoute({
  method: "put",
  path: "/{project_id}/envs/{env_name}",
  tags: ["Projects"],
  summary: "Update an environment's plan or provider config",
  middleware: [requireScope("projects:write")],
  request: {
    params: z.object({ project_id: z.string(), env_name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            plan: z.string().optional(),
            provider_config: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Environment updated",
      content: { "application/json": { schema: z.object({ updated: z.string() }) } },
    },
    ...errorResponses(400, 401, 404, 500),
  },
});
projectRoutes.openapi(updateEnvRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { project_id: projectId, env_name: envName } = c.req.valid("param");
  const body = c.req.valid("json");
  const plan = String(body.plan || "");
  const providerConfig = body.provider_config;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await requireProjectOrg(sql, projectId, user.org_id);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  if (!plan && providerConfig === undefined) return c.json({ error: "Nothing to update" }, 400);

  if (plan && providerConfig !== undefined) {
    const configJson = JSON.stringify(providerConfig);
    await sql`
      UPDATE environments SET plan = ${plan}, provider_config_json = ${configJson}
      WHERE project_id = ${projectId} AND name = ${envName}
    `;
  } else if (plan) {
    await sql`UPDATE environments SET plan = ${plan} WHERE project_id = ${projectId} AND name = ${envName}`;
  } else {
    const configJson = JSON.stringify(providerConfig);
    await sql`
      UPDATE environments SET provider_config_json = ${configJson}
      WHERE project_id = ${projectId} AND name = ${envName}
    `;
  }

  return c.json({ updated: envName });
});

// ── GET /:project_id/canvas-layout — get canvas layout ─────────────────

const getCanvasLayoutRoute = createRoute({
  method: "get",
  path: "/{project_id}/canvas-layout",
  tags: ["Projects"],
  summary: "Get project canvas layout",
  middleware: [requireScope("projects:read")],
  request: {
    params: z.object({ project_id: z.string() }),
  },
  responses: {
    200: {
      description: "Canvas layout",
      content: {
        "application/json": {
          schema: z.object({
            nodes: z.array(z.record(z.unknown())),
            edges: z.array(z.record(z.unknown())),
            assignments: z.array(z.record(z.unknown())),
            updated_at: z.union([z.string(), z.number()]),
          }),
        },
      },
    },
    ...errorResponses(400, 401, 404, 500),
  },
});
projectRoutes.openapi(getCanvasLayoutRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { project_id: projectId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    await requireProjectOrg(sql, projectId, user.org_id);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  const rows = await sql`
    SELECT layout_json, assignments_json FROM project_canvas_layouts
    WHERE project_id = ${projectId} AND org_id = ${user.org_id}
  `;

  if (rows.length === 0) {
    return c.json({ nodes: [], edges: [], assignments: [], updated_at: 0 });
  }

  let layout: any = {};
  let assignments: any[] = [];
  try {
    layout = JSON.parse(rows[0].layout_json || "{}");
  } catch {}
  try {
    assignments = JSON.parse(rows[0].assignments_json || "[]");
  } catch {}

  return c.json({
    nodes: layout.nodes || [],
    edges: layout.edges || [],
    assignments: Array.isArray(assignments) ? assignments : [],
    updated_at: layout.updated_at || 0,
  });
});

// ── PUT /:project_id/canvas-layout — save canvas layout ────────────────

const saveCanvasLayoutRoute = createRoute({
  method: "put",
  path: "/{project_id}/canvas-layout",
  tags: ["Projects"],
  summary: "Save project canvas layout",
  middleware: [requireScope("projects:write")],
  request: {
    params: z.object({ project_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            nodes: z.array(z.record(z.unknown())).optional(),
            edges: z.array(z.record(z.unknown())).optional(),
            assignments: z.array(z.record(z.unknown())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Layout saved",
      content: {
        "application/json": {
          schema: z.object({ saved: z.boolean(), project_id: z.string(), assignments: z.number() }),
        },
      },
    },
    ...errorResponses(400, 401, 404, 500),
  },
});
projectRoutes.openapi(saveCanvasLayoutRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { project_id: projectId } = c.req.valid("param");
  const body = c.req.valid("json");
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  let assignments = body.assignments;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await requireProjectOrg(sql, projectId, user.org_id);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  const now = new Date().toISOString();
  const layout = { nodes, edges, updated_at: now };

  if (assignments === undefined || assignments === null) {
    // Derive from edges
    assignments = edges
      .filter((e: any) => typeof e === "object" && e?.source && e?.target)
      .map((e: any) => ({
        source_node_id: String(e.source),
        target_node_id: String(e.target),
        relationship: "attached",
      }));
  }
  if (!Array.isArray(assignments)) assignments = [];

  const layoutJson = JSON.stringify(layout);
  const assignmentsJson = JSON.stringify(assignments);

  await sql`
    INSERT INTO project_canvas_layouts (project_id, org_id, layout_json, assignments_json, updated_by, updated_at)
    VALUES (${projectId}, ${user.org_id}, ${layoutJson}, ${assignmentsJson}, ${user.user_id}, ${now})
    ON CONFLICT (project_id) DO UPDATE SET
      layout_json = EXCLUDED.layout_json,
      assignments_json = EXCLUDED.assignments_json,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at
  `;

  return c.json({ saved: true, project_id: projectId, assignments: assignments.length });
});
