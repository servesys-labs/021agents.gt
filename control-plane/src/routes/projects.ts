/**
 * Projects router — org > project > agents hierarchy, canvas layout, meta-agent bootstrap.
 * Ported from agentos/api/routers/projects.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { ORCHESTRATOR_SYSTEM_PROMPT, ORCHESTRATOR_TOOLS } from "../templates/orchestrator";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const projectRoutes = new Hono<R>();

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

projectRoutes.get("/", requireScope("projects:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM projects WHERE org_id = ${user.org_id} ORDER BY created_at DESC
  `;
  return c.json({ projects: rows });
});

projectRoutes.post("/", requireScope("projects:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
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
      const toolsJson = JSON.stringify(ORCHESTRATOR_TOOLS);
      const governanceJson = JSON.stringify({
        budget_limit_usd: 20.0,
        require_confirmation_for_destructive: true,
        blocked_tools: [],
        allowed_domains: [],
      });

      await sql`
        INSERT INTO agents (
          name, org_id, project_id, description, system_prompt, model,
          tools_json, governance_json, max_turns,
          is_active, created_by, created_at
        )
        VALUES (
          ${agentName}, ${user.org_id}, ${projectId},
          ${`Orchestrator meta-agent for ${name} — builds, tests, and continuously improves all agents`},
          ${systemPrompt}, 'anthropic/claude-sonnet-4.6',
          ${toolsJson}, ${governanceJson}, ${20},
          true, ${user.user_id}, ${Date.now() / 1000}
        )
      `;
      metaAgent = { name: agentName, created: true, tools_count: ORCHESTRATOR_TOOLS.length };
    } else {
      metaAgent = { name: agentName, created: false };
    }
  } catch {
    metaAgent = { name: "", created: false, error: "bootstrap_failed" };
  }

  // Audit
  try {
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'project.create', 'project', ${projectId}, ${JSON.stringify({ name })}, ${Date.now() / 1000})
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

projectRoutes.get("/:project_id", requireScope("projects:read"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("project_id");
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

projectRoutes.get("/:project_id/envs", requireScope("projects:read"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("project_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    await requireProjectOrg(sql, projectId, user.org_id);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  const rows = await sql`SELECT * FROM environments WHERE project_id = ${projectId}`;
  return c.json({ environments: rows });
});

projectRoutes.put("/:project_id/envs/:env_name", requireScope("projects:write"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("project_id");
  const envName = c.req.param("env_name");
  const body = await c.req.json();
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

projectRoutes.get("/:project_id/canvas-layout", requireScope("projects:read"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("project_id");
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

projectRoutes.put("/:project_id/canvas-layout", requireScope("projects:write"), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("project_id");
  const body = await c.req.json();
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  let assignments = body.assignments;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await requireProjectOrg(sql, projectId, user.org_id);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 400);
  }

  const now = Date.now() / 1000;
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
