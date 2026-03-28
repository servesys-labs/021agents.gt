/**
 * Agents router — CRUD, versions, clone, import/export, create-from-description.
 * Ported from agentos/api/routers/agents.py.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { requireScope } from "../middleware/auth";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, AgentCreateBody, AgentTemplate, AgentSummary, errorResponses } from "../schemas/openapi";
import { getDb, getDbForOrg } from "../db/client";
import { lintGraphDesign, lintPayloadFromResult, summarizeGraphContracts } from "../logic/graph-lint";
import { lintAndAutofixGraph } from "../logic/graph-autofix";
import { latestEvalGate, rolloutRecommendation, lintSuggestionsFromErrors } from "../logic/gate-pack";
import { defaultNoCodeGraph, buildFromDescription, recommendTools } from "../logic/meta-agent";
import { AGENT_TEMPLATES, getTemplateById } from "../logic/agent-templates";
import { applyDeployPolicyToConfigJson } from "../logic/deploy-policy-contract";

export const agentRoutes = createOpenAPIRouter();

// ── GET /agents/templates — list pre-built agent templates ────────────

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/templates",
  tags: ["Agents"],
  summary: "List agent templates",
  responses: {
    200: { description: "Template list", content: { "application/json": { schema: z.object({ templates: z.array(AgentTemplate) }) } } },
  },
});
agentRoutes.openapi(listTemplatesRoute, (c) => {
  return c.json({
    templates: AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      tools: t.tools,
      reasoning_strategy: t.reasoning_strategy,
      tags: t.tags,
    })),
  });
});

const getTemplateRoute = createRoute({
  method: "get",
  path: "/templates/{id}",
  tags: ["Agents"],
  summary: "Get agent template by ID",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Template details", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404),
  },
});
agentRoutes.openapi(getTemplateRoute, (c): any => {
  const { id } = c.req.valid("param");
  const template = getTemplateById(id);
  if (!template) return c.json({ error: "Template not found" }, 404);
  return c.json(template as any);
});

// ── Helper: Notify runtime of config changes ─────────────────────────

/**
 * Notify the runtime worker that an agent's config has changed.
 * The runtime will invalidate its cache and reload from Postgres on next request.
 * Fire-and-forget: failures are logged but don't block the response.
 */
async function notifyRuntimeOfConfigChange(
  env: Env,
  agentName: string,
  version: string,
): Promise<void> {
  try {
    await env.RUNTIME.fetch("https://runtime/api/v1/internal/config-invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ agent_name: agentName, version, timestamp: Date.now() }),
    });
  } catch (e) {
    // Non-critical: runtime will reload on next request anyway
    console.warn(`[agents] Failed to notify runtime of config change for ${agentName}:`, e);
  }
}

async function listAgentsViaDataProxy(
  env: Env,
  user: CurrentUser,
): Promise<Array<Record<string, unknown>> | null> {
  const enabled = String(env.DB_PROXY_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return null;

  try {
    const resp = await env.RUNTIME.fetch("https://runtime/cf/db/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        query_id: "agents.list_active_by_org",
        context: {
          org_id: user.org_id,
          user_id: user.user_id,
          role: user.role,
        },
      }),
    });
    if (!resp.ok) return null;

    const payload = await resp.json() as { rows?: Array<Record<string, unknown>> };
    return Array.isArray(payload.rows) ? payload.rows : [];
  } catch {
    return null;
  }
}

// ── Zod schemas (local-only — shared schemas imported from schemas/openapi) ──

const CreateFromDescriptionSchema = z.object({
  description: z.string().min(1).max(5000),
  name: z.string().max(128).default(""),
  tools: z.string().default("auto"),
  draft_only: z.boolean().default(false),
  strict_graph_lint: z.boolean().default(true),
  auto_graph: z.boolean().default(true),
  graph_json: z.string().default(""),
  include_autofix: z.boolean().default(true),
  include_gate_pack: z.boolean().default(true),
  include_contracts_validate: z.boolean().default(true),
  min_eval_pass_rate: z.number().min(0).max(1).default(0.85),
  min_eval_trials: z.number().int().min(1).max(1000).default(3),
  target_channel: z.string().min(1).default("staging"),
  override_hold: z.boolean().default(false),
  override_reason: z.string().default(""),
});

const ImportAgentSchema = z.object({
  config: z.record(z.unknown()),
});

// ── Helpers ──────────────────────────────────────────────────────────

function runtimeMovedToEdge(detail_suffix = ""): Response {
  let detail =
    "Runtime execution is edge-only. Use worker runtime endpoints " +
    "(`/api/v1/runtime-proxy/runnable/*` or `/api/v1/runtime-proxy/agent/run`).";
  if (detail_suffix) detail = `${detail} ${detail_suffix}`;
  return Response.json({ error: detail }, { status: 410 });
}

function ensureDeclarativeGraph(
  configJson: Record<string, unknown>,
  autoGraph: boolean,
): Record<string, unknown> | null {
  let harness = configJson.harness as Record<string, unknown> | undefined;
  if (typeof harness !== "object" || harness === null) {
    harness = {};
    configJson.harness = harness;
  }
  for (const key of ["declarative_graph", "graph"]) {
    const graph = harness[key];
    if (typeof graph === "object" && graph !== null && !Array.isArray(graph)) {
      if (key !== "declarative_graph") {
        harness.declarative_graph = graph;
      }
      return graph as Record<string, unknown>;
    }
  }
  if (!autoGraph) return null;
  const graph = defaultNoCodeGraph();
  harness.declarative_graph = graph;
  return graph;
}

function lintGraphOrThrow(
  graph: Record<string, unknown> | null,
  opts: { strict: boolean; source: string },
): Record<string, unknown> | null {
  if (graph === null) return null;
  const result = lintGraphDesign(graph, { strict: opts.strict });
  if (result.valid) {
    return {
      valid: true,
      errors: [],
      warnings: result.warnings,
      summary: result.summary,
    };
  }
  const errors = result.errors;
  const warnings = result.warnings;
  throw {
    status: 422,
    body: {
      message: "No-code graph lint failed. Fix graph design before publish.",
      source: opts.source,
      strict: opts.strict,
      errors,
      warnings,
      suggestions: lintSuggestionsFromErrors(errors),
    },
  };
}

/**
 * Snapshot agent config to agent_versions table.
 * This is the PRIMARY versioning system. R2 VCS (in evolve.ts) is audit-only.
 * Called on: create, update, create-from-description, version restore.
 */
async function snapshotVersion(
  sql: Awaited<ReturnType<typeof getDbForOrg>>,
  agentName: string,
  version: string,
  configJson: Record<string, unknown>,
  createdBy: string,
): Promise<void> {
  try {
    await sql`
      INSERT INTO agent_versions (agent_name, version_number, config_json, created_by, created_at)
      VALUES (${agentName}, ${version}, ${JSON.stringify(configJson)}, ${createdBy}, now())
      ON CONFLICT (agent_name, version_number) DO UPDATE
      SET config_json = ${JSON.stringify(configJson)}, created_by = ${createdBy}
    `;
  } catch {
    // Non-critical
  }
}

function agentResponse(row: Record<string, unknown>): Record<string, unknown> {
  const config = parseConfig(row.config_json);
  return {
    name: row.name ?? config.name ?? "",
    description: row.description ?? config.description ?? "",
    model: config.model ?? "",
    tools: Array.isArray(config.tools) ? config.tools : [],
    tags: Array.isArray(config.tags) ? config.tags : [],
    version: config.version ?? "0.1.0",
  };
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  return {};
}

// ── Routes ───────────────────────────────────────────────────────────

// GET /agents — list all agents for the org
const listAgentsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Agents"],
  summary: "List all agents for the org",
  responses: {
    200: { description: "Agent list", content: { "application/json": { schema: z.array(AgentSummary) } } },
  },
});
agentRoutes.openapi(listAgentsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const proxied = await listAgentsViaDataProxy(c.env, user);
  if (proxied) {
    return c.json(proxied.map((r) => agentResponse(r as Record<string, unknown>)) as any);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT name, description, config_json, is_active, created_at, updated_at
    FROM agents
    WHERE org_id = ${user.org_id} AND is_active = 1
    ORDER BY created_at DESC
  `;

  return c.json(rows.map((r) => agentResponse(r as Record<string, unknown>)) as any);
});

// GET /agents/:name — get single agent
const getAgentRoute = createRoute({
  method: "get",
  path: "/{name}",
  tags: ["Agents"],
  summary: "Get a single agent by name",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Agent details", content: { "application/json": { schema: AgentSummary } } },
    ...errorResponses(404),
  },
});
agentRoutes.openapi(getAgentRoute, async (c): Promise<any> => {
  const { name } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT name, description, config_json, is_active, created_at, updated_at
    FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: `Agent '${name}' not found` }, 404);
  }

  return c.json(agentResponse(rows[0] as Record<string, unknown>) as any);
});

// POST /agents — create agent
const createAgentRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Agents"],
  summary: "Create a new agent",
  middleware: [requireScope("agents:write")],
  request: {
    body: { content: { "application/json": { schema: AgentCreateBody } } },
  },
  responses: {
    201: { description: "Agent created", content: { "application/json": { schema: AgentSummary } } },
    ...errorResponses(400, 500),
    409: { description: "Agent already exists", content: { "application/json": { schema: ErrorSchema } } },
  },
});
agentRoutes.openapi(createAgentRoute, async (c): Promise<any> => {
    const req = c.req.valid("json");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    // Check for existing agent with same name in org
    const existing = await sql`
      SELECT name FROM agents WHERE name = ${req.name} AND org_id = ${user.org_id} LIMIT 1
    `;
    if (existing.length > 0) {
      return c.json({ error: `Agent '${req.name}' already exists` }, 409);
    }

    // Build config JSON
    const configJson: Record<string, unknown> = {
      name: req.name,
      description: req.description,
      system_prompt: req.system_prompt,
      personality: req.personality,
      model: req.model || "anthropic/claude-sonnet-4-6",
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      tools: req.tools,
      max_turns: req.max_turns,
      timeout_seconds: req.timeout_seconds,
      tags: req.tags,
      version: "0.1.0",
      governance: req.governance ?? { budget_limit_usd: req.budget_limit_usd },
      harness: {},
    };

    // Reasoning strategy
    if (req.reasoning_strategy) {
      configJson.reasoning_strategy = req.reasoning_strategy;
    }

    // Eval config
    if (req.eval_config) {
      configJson.eval_config = req.eval_config;
    }
    if (req.deploy_policy) {
      configJson.deploy_policy = req.deploy_policy;
    }

    // Attach graph if provided
    if (req.graph && typeof req.graph === "object") {
      (configJson.harness as Record<string, unknown>).declarative_graph = req.graph;
    }

    // Ensure / auto-generate graph
    let graph = ensureDeclarativeGraph(configJson, req.auto_graph);

    // Lint graph — fall back to safe default if it fails
    try {
      lintGraphOrThrow(graph, { strict: req.strict_graph_lint, source: "agents.create" });
    } catch {
      // LLM-generated or user-provided graph failed lint — fall back to safe default
      console.warn("[agents/create] Graph lint failed, falling back to default graph");
      const safeGraph = defaultNoCodeGraph();
      if (configJson.harness && typeof configJson.harness === "object") {
        (configJson.harness as Record<string, unknown>).declarative_graph = safeGraph;
      } else {
        configJson.harness = { declarative_graph: safeGraph };
      }
      graph = safeGraph;
    }

    const deployPolicyApply = applyDeployPolicyToConfigJson(configJson);
    if (!deployPolicyApply.ok) {
      return c.json(
        {
          error: "Deploy policy validation failed",
          details: deployPolicyApply.errors,
          warnings: deployPolicyApply.warnings,
        },
        400,
      );
    }

    // Insert into DB
    await sql`
      INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
      VALUES (
        ${crypto.randomUUID().replace(/-/g, "").slice(0, 16)},
        ${req.name},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(configJson)},
        ${req.description},
        1,
        now(),
        now()
      )
    `;

    // Snapshot version
    await snapshotVersion(sql, req.name, "0.1.0", configJson, user.user_id);

    // Persist full package if provided
    let packageErrors: string[] = [];
    const hasPackage = req.sub_agents || req.skills || req.codemode_snippets || req.guardrails || req.release_strategy;
    if (hasPackage) {
      packageErrors = await persistAgentPackage(sql, req.name, user.org_id, user.project_id || "", user.user_id, {
        sub_agents: req.sub_agents,
        skills: req.skills,
        codemode_snippets: req.codemode_snippets,
        guardrails: req.guardrails,
        release_strategy: req.release_strategy,
      });
    }

    const response: Record<string, unknown> = {
      name: req.name,
      description: req.description,
      model: configJson.model,
      tools: req.tools,
      tags: req.tags,
      version: "0.1.0",
    };
    if (req.reasoning_strategy) response.reasoning_strategy = req.reasoning_strategy;
    if (packageErrors.length > 0) response.package_errors = packageErrors;
    return c.json(response as any, 201);
});

// PUT /agents/:name — update agent
const updateAgentRoute = createRoute({
  method: "put",
  path: "/{name}",
  tags: ["Agents"],
  summary: "Update an existing agent",
  middleware: [requireScope("agents:write")],
  request: {
    params: z.object({ name: z.string() }),
    body: { content: { "application/json": { schema: AgentCreateBody } } },
  },
  responses: {
    200: { description: "Agent updated", content: { "application/json": { schema: AgentSummary } } },
    ...errorResponses(400, 404, 500),
  },
});
agentRoutes.openapi(updateAgentRoute, async (c): Promise<any> => {
    const { name } = c.req.valid("param");
    const req = c.req.valid("json");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    // Fetch existing
    const rows = await sql`
      SELECT config_json FROM agents
      WHERE name = ${name} AND org_id = ${user.org_id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return c.json({ error: `Agent '${name}' not found` }, 404);
    }

    const existingConfig = parseConfig((rows[0] as Record<string, unknown>).config_json);

    // Merge updates
    if (req.description) existingConfig.description = req.description;
    if (req.system_prompt) existingConfig.system_prompt = req.system_prompt;
    if (req.personality) existingConfig.personality = req.personality;
    if (req.model) existingConfig.model = req.model;
    if (req.max_tokens != null) existingConfig.max_tokens = req.max_tokens;
    if (req.temperature != null) existingConfig.temperature = req.temperature;
    if (req.tools.length > 0) existingConfig.tools = req.tools;
    if (req.tags.length > 0) existingConfig.tags = req.tags;
    existingConfig.max_turns = req.max_turns;
    if (req.timeout_seconds != null) existingConfig.timeout_seconds = req.timeout_seconds;
    if (req.deploy_policy) {
      existingConfig.deploy_policy = req.deploy_policy;
    }

    // Governance
    const gov = (existingConfig.governance ?? {}) as Record<string, unknown>;
    gov.budget_limit_usd = req.budget_limit_usd;
    existingConfig.governance = gov;

    // Graph
    if (req.graph && typeof req.graph === "object") {
      let harness = existingConfig.harness as Record<string, unknown> | undefined;
      if (typeof harness !== "object" || harness === null) {
        harness = {};
        existingConfig.harness = harness;
      }
      harness.declarative_graph = req.graph;
    }

    let graph = ensureDeclarativeGraph(existingConfig, req.auto_graph);

    try {
      lintGraphOrThrow(graph, { strict: req.strict_graph_lint, source: "agents.update" });
    } catch {
      // Fall back to safe default graph on lint failure
      console.warn("[agents/update] Graph lint failed, falling back to default graph");
      const safeGraph = defaultNoCodeGraph();
      let harness = existingConfig.harness as Record<string, unknown> | undefined;
      if (typeof harness !== "object" || harness === null) { harness = {}; existingConfig.harness = harness; }
      harness.declarative_graph = safeGraph;
      graph = safeGraph;
    }

    const deployPolicyUpdate = applyDeployPolicyToConfigJson(existingConfig);
    if (!deployPolicyUpdate.ok) {
      return c.json(
        {
          error: "Deploy policy validation failed",
          details: deployPolicyUpdate.errors,
          warnings: deployPolicyUpdate.warnings,
        },
        400,
      );
    }

    // Bump version
    const oldVersion = String(existingConfig.version ?? "0.1.0");
    const parts = oldVersion.split(".").map(Number);
    parts[2] = (parts[2] ?? 0) + 1;
    const newVersion = parts.join(".");
    existingConfig.version = newVersion;

    await sql`
      UPDATE agents
      SET config_json = ${JSON.stringify(existingConfig)},
          description = ${req.description || (existingConfig.description as string) || ""},
          updated_at = now()
      WHERE name = ${name} AND org_id = ${user.org_id}
    `;

    await snapshotVersion(sql, name, newVersion, existingConfig, user.user_id);

    // Notify runtime of config change (fire-and-forget)
    // This triggers the DO to reload config on next request
    notifyRuntimeOfConfigChange(c.env, name, newVersion).catch(() => {});

    return c.json({
      name,
      description: existingConfig.description ?? "",
      model: existingConfig.model ?? "",
      tools: Array.isArray(existingConfig.tools) ? existingConfig.tools : [],
      tags: Array.isArray(existingConfig.tags) ? existingConfig.tags : [],
      version: newVersion,
    } as any);
});

// DELETE /agents/:name — delete agent with cascading cleanup
const deleteAgentRoute = createRoute({
  method: "delete",
  path: "/{name}",
  tags: ["Agents"],
  summary: "Delete an agent with cascading cleanup",
  middleware: [requireScope("agents:write")],
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: { description: "Agent deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404),
  },
});
agentRoutes.openapi(deleteAgentRoute, async (c): Promise<any> => {
    const { name } = c.req.valid("param");
    const hardDelete = c.req.query("hard_delete") === "true";
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    // Check existence
    const rows = await sql`
      SELECT name FROM agents WHERE name = ${name} AND org_id = ${user.org_id} LIMIT 1
    `;
    if (rows.length === 0) {
      return c.json({ error: `Agent '${name}' not found` }, 404);
    }

    const counts: Record<string, number> = {};

    if (hardDelete) {
      // Hard delete — cascading removal of all associated records
      // Explicit per-table parameterized DELETEs (no dynamic table names)
      try {
        const r = await sql`DELETE FROM turns WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.turns = r.count ?? 0;
      } catch { counts.turns = 0; }

      try {
        const r = await sql`DELETE FROM sessions WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.sessions = r.count ?? 0;
      } catch { counts.sessions = 0; }

      try {
        const r = await sql`DELETE FROM billing_records WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.billing_records = r.count ?? 0;
      } catch { counts.billing_records = 0; }

      try {
        const r = await sql`DELETE FROM eval_runs WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.eval_runs = r.count ?? 0;
      } catch { counts.eval_runs = 0; }

      try {
        const r = await sql`DELETE FROM eval_results WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.eval_results = r.count ?? 0;
      } catch { counts.eval_results = 0; }

      try {
        const r = await sql`DELETE FROM issues WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.issues = r.count ?? 0;
      } catch { counts.issues = 0; }

      try {
        const r = await sql`DELETE FROM compliance_checks WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.compliance_checks = r.count ?? 0;
      } catch { counts.compliance_checks = 0; }

      try {
        const r = await sql`DELETE FROM schedules WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.schedules = r.count ?? 0;
      } catch { counts.schedules = 0; }

      try {
        const r = await sql`DELETE FROM webhooks WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.webhooks = r.count ?? 0;
      } catch { counts.webhooks = 0; }

      try {
        const r = await sql`DELETE FROM agent_versions WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.agent_versions = r.count ?? 0;
      } catch { counts.agent_versions = 0; }

      await sql`DELETE FROM agents WHERE name = ${name} AND org_id = ${user.org_id}`;
      counts.agent = 1;
    } else {
      // Soft delete
      await sql`
        UPDATE agents SET is_active = 0, updated_at = now()
        WHERE name = ${name} AND org_id = ${user.org_id}
      `;
      counts.agent = 1;
    }

    // Audit log (fire-and-forget)
    sql`
      INSERT INTO config_audit (agent_name, action, details_json, created_at)
      VALUES (${name}, 'delete', ${JSON.stringify({
        user: user.user_id,
        org: user.org_id,
        hard_delete: hardDelete,
      })}, now())
    `.catch(() => {});

    const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

    return c.json({
      deleted: name,
      hard_delete: hardDelete,
      db_cleanup: counts,
      total_records_affected: totalRecords,
    } as any);
});

// GET /agents/:name/versions — list versions
const listVersionsRoute = createRoute({
  method: "get",
  path: "/{name}/versions",
  tags: ["Agents"],
  summary: "List agent versions",
  middleware: [requireScope("agents:read")],
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Version list", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
agentRoutes.openapi(listVersionsRoute, async (c): Promise<any> => {
    const { name: agentName } = c.req.valid("param");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const rows = await sql`
      SELECT id, agent_name, version, config_json, created_by, created_at
      FROM agent_versions
      WHERE agent_name = ${agentName}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const versions = rows.map((row, i) => ({
      id: String(row.id),
      tree_id: String(row.id),
      parent_id: i < rows.length - 1 ? String(rows[i + 1].id) : null,
      message: `Version ${row.version || "0.1.0"}`,
      author: String(row.created_by || "system"),
      timestamp: new Date(row.created_at as string).getTime() / 1000,
      metadata: { version: row.version, source: "agent_versions" },
    }));

    return c.json({ versions, total: versions.length } as any);
});

// GET /agents/:name/tools — list tools for agent
const listToolsRoute = createRoute({
  method: "get",
  path: "/{name}/tools",
  tags: ["Agents"],
  summary: "List tools for an agent",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Tool list", content: { "application/json": { schema: z.object({ tools: z.array(z.string()) }) } } },
    ...errorResponses(404),
  },
});
agentRoutes.openapi(listToolsRoute, async (c): Promise<any> => {
  const { name } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: `Agent '${name}' not found` }, 404);
  }

  const config = parseConfig((rows[0] as Record<string, unknown>).config_json);
  return c.json({ tools: Array.isArray(config.tools) ? config.tools : [] });
});

// GET /agents/:name/config — get raw config
const getConfigRoute = createRoute({
  method: "get",
  path: "/{name}/config",
  tags: ["Agents"],
  summary: "Get raw agent config",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Agent config", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404),
  },
});
agentRoutes.openapi(getConfigRoute, async (c): Promise<any> => {
  const { name } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: `Agent '${name}' not found` }, 404);
  }

  return c.json(parseConfig((rows[0] as Record<string, unknown>).config_json) as any);
});

// POST /agents/:name/clone — clone agent with new name
const cloneAgentRoute = createRoute({
  method: "post",
  path: "/{name}/clone",
  tags: ["Agents"],
  summary: "Clone an agent with a new name",
  middleware: [requireScope("agents:write")],
  request: {
    params: z.object({ name: z.string() }),
    body: { content: { "application/json": { schema: z.object({ new_name: z.string().min(1).max(128) }) } } },
  },
  responses: {
    201: { description: "Agent cloned", content: { "application/json": { schema: AgentSummary } } },
    ...errorResponses(400, 404),
    409: { description: "Agent already exists", content: { "application/json": { schema: ErrorSchema } } },
  },
});
agentRoutes.openapi(cloneAgentRoute, async (c): Promise<any> => {
  const { name } = c.req.valid("param");
  const { new_name: newNameValue } = c.req.valid("json");

  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Fetch source agent
  const rows = await sql`
    SELECT name, description, config_json FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: `Agent '${name}' not found` }, 404);
  }

  // Check target name doesn't exist
  const existCheck = await sql`
    SELECT name FROM agents WHERE name = ${newNameValue} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (existCheck.length > 0) {
    return c.json({ error: `Agent '${newNameValue}' already exists` }, 409);
  }

  const config = parseConfig((rows[0] as Record<string, unknown>).config_json);
  config.name = newNameValue;
  config.version = "0.1.0";

  const clonePolicy = applyDeployPolicyToConfigJson(config);
  if (!clonePolicy.ok) {
    return c.json(
      {
        error: "Deploy policy validation failed",
        details: clonePolicy.errors,
        warnings: clonePolicy.warnings,
      },
      400,
    );
  }

  await sql`
    INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
    VALUES (
      ${crypto.randomUUID().replace(/-/g, "").slice(0, 16)},
      ${newNameValue},
      ${user.org_id},
      ${user.project_id || ""},
      ${JSON.stringify(config)},
      ${(config.description as string) || ""},
      true,
      now(),
      now()
    )
  `;

  return c.json({
    name: newNameValue,
    description: config.description ?? "",
    model: config.model ?? "",
    tools: Array.isArray(config.tools) ? config.tools : [],
    tags: Array.isArray(config.tags) ? config.tags : [],
    version: "0.1.0",
  } as any, 201);
});

// POST /agents/import — import agent from JSON config
const importAgentRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["Agents"],
  summary: "Import agent from JSON config",
  middleware: [requireScope("agents:write")],
  request: {
    body: { content: { "application/json": { schema: ImportAgentSchema } } },
  },
  responses: {
    200: { description: "Agent imported", content: { "application/json": { schema: AgentSummary } } },
    ...errorResponses(400, 500),
    422: { description: "Graph lint failed", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
agentRoutes.openapi(importAgentRoute, async (c): Promise<any> => {
    const { config } = c.req.valid("json");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    // Extract graph for linting
    let graph: Record<string, unknown> | null = null;
    const harness = config.harness;
    if (typeof harness === "object" && harness !== null && !Array.isArray(harness)) {
      const h = harness as Record<string, unknown>;
      const g = h.declarative_graph ?? h.graph;
      if (typeof g === "object" && g !== null && !Array.isArray(g)) {
        graph = g as Record<string, unknown>;
      }
    }
    if (typeof config.graph === "object" && config.graph !== null && graph === null) {
      graph = config.graph as Record<string, unknown>;
    }

    try {
      lintGraphOrThrow(graph, { strict: true, source: "agents.import" });
    } catch (err: unknown) {
      const e = err as { status: number; body: unknown };
      return c.json(e.body, 422);
    }

    const agentName = String(config.name || "imported_agent");

    const importCfg = config as Record<string, unknown>;
    const importPolicy = applyDeployPolicyToConfigJson(importCfg);
    if (!importPolicy.ok) {
      return c.json(
        {
          error: "Deploy policy validation failed",
          details: importPolicy.errors,
          warnings: importPolicy.warnings,
        },
        400,
      );
    }

    await sql`
      INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
      VALUES (
        ${crypto.randomUUID().replace(/-/g, "").slice(0, 16)},
        ${agentName},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(importCfg)},
        ${String(config.description || "")},
        1,
        now(),
        now()
      )
      ON CONFLICT (name, org_id) DO UPDATE
      SET config_json = ${JSON.stringify(importCfg)}, updated_at = now()
    `;

    return c.json({
      name: agentName,
      description: config.description ?? "",
      model: config.model ?? "",
      tools: Array.isArray(config.tools) ? config.tools : [],
      tags: Array.isArray(config.tags) ? config.tags : [],
      version: config.version ?? "0.1.0",
    } as any);
});

// GET /agents/:name/export — export agent config
const exportAgentRoute = createRoute({
  method: "get",
  path: "/{name}/export",
  tags: ["Agents"],
  summary: "Export agent config as JSON",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Agent config export", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404),
  },
});
agentRoutes.openapi(exportAgentRoute, async (c): Promise<any> => {
  const { name } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: `Agent '${name}' not found` }, 404);
  }

  return c.json({ agent: parseConfig((rows[0] as Record<string, unknown>).config_json) } as any);
});

/* ── persistAgentPackage ─────────────────────────────────────────── */
/*
 * After the main agent INSERT, persist all subsidiary resources
 * (sub-agents, skills, codemode, guardrails, release channels).
 * Fire-and-forget with error collection — parent agent is never rolled back.
 */

async function persistAgentPackage(
  sql: Awaited<ReturnType<typeof getDb>>,
  agentName: string,
  orgId: string,
  projectId: string,
  userId: string,
  pkg: Record<string, unknown>,
): Promise<string[]> {
  const errors: string[] = [];
  const now = new Date().toISOString();

  // Sub-agents (max 3)
  const subAgents = Array.isArray(pkg.sub_agents) ? pkg.sub_agents.slice(0, 3) : [];
  for (const sa of subAgents) {
    try {
      const subConfig = {
        ...(sa as Record<string, unknown>),
        parent_agent: agentName,
        governance: { budget_limit_usd: 10 },
        harness: {},
      } as Record<string, unknown>;
      const subPolicy = applyDeployPolicyToConfigJson(subConfig);
      if (!subPolicy.ok) {
        errors.push(`sub-agent ${(sa as Record<string, unknown>).name}: deploy policy: ${subPolicy.errors.join("; ")}`);
        continue;
      }
      const subName = String((sa as Record<string, unknown>).name || `${agentName}-sub`);
      const subId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await sql`
        INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
        VALUES (${subId}, ${subName}, ${orgId}, ${projectId}, ${JSON.stringify(subConfig)},
                ${String((sa as Record<string, unknown>).description || "")}, 1, now(), now())
        ON CONFLICT (name, org_id) DO UPDATE SET config_json = ${JSON.stringify(subConfig)}, updated_at = now()
      `;
    } catch (e) {
      errors.push(`sub-agent ${(sa as Record<string, unknown>).name}: ${(e as Error).message}`);
    }
  }

  // Skills (max 5)
  const skills = Array.isArray(pkg.skills) ? pkg.skills.slice(0, 5) : [];
  for (const sk of skills) {
    try {
      const s = sk as Record<string, unknown>;
      await sql`
        INSERT INTO skills (name, description, category, content, assigned_agents, org_id, enabled, created_at)
        VALUES (${String(s.name)}, ${String(s.description || "")}, ${String(s.category || "prompt")},
                ${String(s.content || "")}, ${JSON.stringify([agentName])}, ${orgId}, true, now())
        ON CONFLICT DO NOTHING
      `;
    } catch (e) {
      errors.push(`skill ${(sk as Record<string, unknown>).name}: ${(e as Error).message}`);
    }
  }

  // Codemode snippets (max 5)
  const snippets = Array.isArray(pkg.codemode_snippets) ? pkg.codemode_snippets.slice(0, 5) : [];
  for (const sn of snippets) {
    try {
      const s = sn as Record<string, unknown>;
      const snippetId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await sql`
        INSERT INTO codemode_snippets (id, org_id, name, description, code, scope, tags, version, is_template, created_at, updated_at)
        VALUES (${snippetId}, ${orgId}, ${String(s.name)}, ${String(s.description || "")},
                ${String(s.code || "")}, ${String(s.scope || "agent")},
                ${JSON.stringify([agentName])}, 1, false, ${now}, ${now})
        ON CONFLICT DO NOTHING
      `;
    } catch (e) {
      errors.push(`codemode ${(sn as Record<string, unknown>).name}: ${(e as Error).message}`);
    }
  }

  // Guardrails (max 5)
  const guardrails = Array.isArray(pkg.guardrails) ? pkg.guardrails.slice(0, 5) : [];
  for (const gr of guardrails) {
    try {
      const g = gr as Record<string, unknown>;
      const grId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const policyJson = JSON.stringify({ type: g.type, rule: g.rule, action: g.action });
      await sql`
        INSERT INTO guardrail_policies (id, org_id, name, agent_name, policy_json, created_at, updated_at)
        VALUES (${grId}, ${orgId}, ${String(g.name)}, ${agentName}, ${policyJson}, ${now}, ${now})
        ON CONFLICT DO NOTHING
      `;
    } catch (e) {
      errors.push(`guardrail ${(gr as Record<string, unknown>).name}: ${(e as Error).message}`);
    }
  }

  // Release channel (max 1)
  const release = pkg.release_strategy as Record<string, unknown> | null;
  if (release) {
    try {
      const channel = String(release.initial_channel || "staging");
      await sql`
        INSERT INTO release_channels (org_id, agent_name, channel, version, config_json, promoted_by, promoted_at)
        VALUES (${orgId}, ${agentName}, ${channel}, ${"0.1.0"}, ${JSON.stringify(release)}, ${userId}, ${now})
        ON CONFLICT DO NOTHING
      `;
    } catch (e) {
      errors.push(`release channel: ${(e as Error).message}`);
    }
  }

  return errors;
}

// POST /agents/create-from-description — LLM-powered agent creation
const createFromDescriptionRoute = createRoute({
  method: "post",
  path: "/create-from-description",
  tags: ["Agents"],
  summary: "Create agent from natural language description",
  middleware: [requireScope("agents:write")],
  request: {
    body: { content: { "application/json": { schema: CreateFromDescriptionSchema } } },
  },
  responses: {
    201: { description: "Agent created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    200: { description: "Draft returned", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
    409: { description: "Gate-pack hold", content: { "application/json": { schema: z.record(z.unknown()) } } },
    422: { description: "Graph lint or validation failed", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
agentRoutes.openapi(createFromDescriptionRoute, async (c): Promise<any> => {
    const req = c.req.valid("json");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    // Load org profile for the meta-agent prompt context
    let orgProfile: Record<string, unknown> | undefined;
    try {
      const settingsRows = await sql`
        SELECT settings_json FROM org_settings WHERE org_id = ${user.org_id} LIMIT 1
      `;
      if (settingsRows.length > 0) {
        orgProfile = JSON.parse(String(settingsRows[0].settings_json || "{}"));
      }
    } catch { /* ignore — preferences are optional */ }

    // Generate config via Claude Sonnet 4.6 (plan + org-profile aware)
    const config = await buildFromDescription(c.env.AI, req.description, {
      name: req.name || undefined,
      hyperdrive: c.env.HYPERDRIVE,
      orgId: user.org_id,
      openrouterApiKey: c.env.OPENROUTER_API_KEY,
      pipedream: c.env.PIPEDREAM_CLIENT_ID ? {
        clientId: c.env.PIPEDREAM_CLIENT_ID,
        clientSecret: c.env.PIPEDREAM_CLIENT_SECRET ?? "",
        projectId: c.env.PIPEDREAM_PROJECT_ID ?? "",
      } : undefined,
      orgProfile: orgProfile as any,
    });

    if (req.name) config.name = req.name;

    // Tool selection
    if (req.tools === "auto") {
      const recommended = new Set(recommendTools(req.description));
      const existing = new Set(
        (Array.isArray(config.tools) ? config.tools : []).filter(
          (t): t is string => typeof t === "string",
        ),
      );
      config.tools = [...new Set([...existing, ...recommended])].sort();
    } else if (req.tools === "none") {
      config.tools = [];
    } else if (req.tools) {
      config.tools = req.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }

    // Initialize harness + governance — use LLM-proposed governance if available
    const pkg = (config as Record<string, unknown>)._package as Record<string, unknown> | undefined;
    config.governance = (pkg?.governance as Record<string, unknown>) ?? config.governance ?? { budget_limit_usd: 10 };
    if (typeof config.harness !== "object" || config.harness === null) {
      config.harness = {};
    }

    // Use LLM-proposed graph instead of hardcoded 5-node template
    if (pkg?.graph && typeof pkg.graph === "object") {
      (config.harness as Record<string, unknown>).declarative_graph = pkg.graph;
    }

    // Store eval config in agent config if provided
    if (pkg?.eval_config) {
      (config as Record<string, unknown>).eval_config = pkg.eval_config;
    }

    // Parse explicit graph_json if provided
    if (req.graph_json.trim()) {
      let parsedGraph: unknown;
      try {
        parsedGraph = JSON.parse(req.graph_json);
      } catch (err) {
        return c.json({ error: `Invalid graph_json: ${err}` }, 400);
      }
      if (typeof parsedGraph !== "object" || parsedGraph === null || Array.isArray(parsedGraph)) {
        return c.json({ error: "graph_json must decode to a JSON object" }, 400);
      }
      (config.harness as Record<string, unknown>).declarative_graph = parsedGraph;
    }

    // Ensure graph
    let graph = ensureDeclarativeGraph(config, req.auto_graph);

    // Lint + autofix
    let lintReport: Record<string, unknown> | null = null;
    let graphAutofix: Record<string, unknown> | null = null;

    if (graph !== null) {
      graphAutofix = lintAndAutofixGraph(graph, {
        strict: req.strict_graph_lint,
        apply: req.include_autofix,
      });

      if (graphAutofix.autofix_applied) {
        const fixedGraph = graphAutofix.graph;
        if (typeof fixedGraph === "object" && fixedGraph !== null) {
          (config.harness as Record<string, unknown>).declarative_graph = fixedGraph;
          graph = fixedGraph as Record<string, unknown>;
        }
      }

      lintReport = (graphAutofix.lint_after ?? null) as Record<string, unknown> | null;
      const lintValid = Boolean(lintReport?.valid);

      // If lint fails after autofix, fall back to safe default graph instead of blocking
      if (!lintValid && !req.draft_only) {
        console.warn("[agents/create-from-description] LLM graph failed lint after autofix, falling back to default graph");
        const safeGraph = defaultNoCodeGraph();
        (config.harness as Record<string, unknown>).declarative_graph = safeGraph;
        graph = safeGraph;
        // Re-lint the safe graph (should always pass)
        const safeLint = lintAndAutofixGraph(safeGraph, { strict: false });
        lintReport = (safeLint.lint_after ?? safeLint.lint_before ?? null) as Record<string, unknown> | null;
        graphAutofix = safeLint;
      }

      // Only block on draft_only=false if even the safe graph fails (should never happen)
      if (!Boolean(lintReport?.valid) && !req.draft_only) {
        const errors = (Array.isArray(lintReport?.errors) ? lintReport!.errors : []) as Array<{ code?: string }>;
        return c.json(
          {
            message: "No-code graph lint failed. Fix graph design before publish.",
            source: "agents.create-from-description",
            strict: req.strict_graph_lint,
            errors: lintReport?.errors ?? [],
            warnings: lintReport?.warnings ?? [],
            suggestions: lintSuggestionsFromErrors(errors),
            graph_autofix: graphAutofix,
          },
          422,
        );
      }
    } else if (!req.draft_only) {
      try {
        lintReport = lintGraphOrThrow(graph, {
          strict: req.strict_graph_lint,
          source: "agents.create-from-description",
        });
      } catch (err: unknown) {
        const e = err as { status: number; body: unknown };
        return c.json(e.body, 422);
      }
    }

    // Eval gate
    const evalGate = await latestEvalGate(sql, String(config.name), {
      minEvalPassRate: req.min_eval_pass_rate,
      minEvalTrials: req.min_eval_trials,
      orgId: user.org_id,
    });

    const gatePack = {
      graph_lint: lintReport,
      eval_gate: evalGate,
      rollout: rolloutRecommendation({
        agentName: String(config.name),
        graphLint: lintReport,
        evalGate,
        targetChannel: req.target_channel,
      }),
    };

    // Contracts validate
    let contractsValidate: Record<string, unknown> | null = null;
    if (graph !== null) {
      const contractsResult = lintGraphDesign(graph, { strict: req.strict_graph_lint });
      const contractsSummary: Record<string, unknown> = { ...(contractsResult.summary ?? {}) };
      contractsSummary.contracts = summarizeGraphContracts(graph);
      contractsValidate = {
        valid: contractsResult.valid,
        errors: contractsResult.errors,
        warnings: contractsResult.warnings,
        summary: contractsSummary,
      };
    }

    const rolloutDecision = String(gatePack.rollout.decision ?? "").trim().toLowerCase();
    let holdOverrideApplied = false;

    // Draft-only response
    if (req.draft_only) {
      // Extract the full package metadata if present
      const pkg = (config as Record<string, unknown>)._package as Record<string, unknown> | undefined;
      delete (config as Record<string, unknown>)._package;

      const payload: Record<string, unknown> = {
        created: false,
        name: config.name,
        description: config.description,
        system_prompt: config.system_prompt,
        model: config.model,
        tools: config.tools,
        tags: config.tags,
        version: config.version,
        draft: config,
        graph_lint: lintReport,
      };

      // Include the full agent package from the meta-agent
      if (pkg) {
        payload.agent_graph = pkg.graph;
        payload.sub_agents = pkg.sub_agents;
        payload.skills = pkg.skills;
        payload.codemode_snippets = pkg.codemode_snippets;
        payload.governance = pkg.governance ?? config.governance;
        payload.guardrails = pkg.guardrails;
        payload.eval_config = pkg.eval_config;
        payload.release_strategy = pkg.release_strategy;
        payload.mcp_connectors = pkg.mcp_connectors;
      }

      if (req.include_autofix) payload.graph_autofix = graphAutofix;
      if (req.include_gate_pack) payload.gate_pack = gatePack;
      if (req.include_contracts_validate) payload.contracts_validate = contractsValidate;
      return c.json(payload as any);
    }

    // Gate-pack hold enforcement
    // Auto-override hold for first-time creation when the only reason is "no eval runs"
    // (a new agent can't have eval runs yet — requiring them before creation is a catch-22)
    const holdReason = String(gatePack.rollout.reason ?? "").toLowerCase();
    const isFirstTimeNoEval = holdReason.includes("no eval") || holdReason.includes("no eval run");
    const effectiveOverride = req.override_hold || isFirstTimeNoEval;

    if (rolloutDecision === "hold" && !effectiveOverride) {
      return c.json(
        {
          message: "Gate-pack rollout decision is HOLD. Explicit override required to create.",
          override_required: true,
          gate_pack: gatePack,
        },
        409,
      );
    }

    if (rolloutDecision === "hold" && effectiveOverride && !isFirstTimeNoEval && !req.override_reason.trim()) {
      return c.json({ error: "override_reason is required when overriding a hold decision" }, 422);
    }

    if (rolloutDecision === "hold" && effectiveOverride) {
      holdOverrideApplied = true;
      // Audit the override (fire-and-forget)
      sql`
        INSERT INTO config_audit (agent_name, action, details_json, created_at)
        VALUES (${String(config.name)}, 'hold_override', ${JSON.stringify({
          user: user.user_id,
          org: user.org_id,
          reason: req.override_reason.trim(),
          gate_pack: gatePack,
          source: "agents.create-from-description",
        })}, now())
      `.catch(() => {});
    }

    const cfgRecord = config as Record<string, unknown>;
    const fromDescPolicy = applyDeployPolicyToConfigJson(cfgRecord);
    if (!fromDescPolicy.ok) {
      return c.json(
        {
          error: "Deploy policy validation failed",
          details: fromDescPolicy.errors,
          warnings: fromDescPolicy.warnings,
        },
        400,
      );
    }

    // Save agent
    await sql`
      INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
      VALUES (
        ${crypto.randomUUID().replace(/-/g, "").slice(0, 16)},
        ${String(config.name)},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(cfgRecord)},
        ${String(config.description || "")},
        1,
        now(),
        now()
      )
      ON CONFLICT (name, org_id) DO UPDATE
      SET config_json = ${JSON.stringify(cfgRecord)}, updated_at = now()
    `;

    await snapshotVersion(sql, String(config.name), String(config.version), cfgRecord, user.user_id);

    // Persist the full agent package (sub-agents, skills, codemode, guardrails, releases)
    let packageErrors: string[] = [];
    if (pkg) {
      // Clean _package from config before using it
      delete (config as Record<string, unknown>)._package;
      packageErrors = await persistAgentPackage(
        sql, String(config.name), user.org_id, user.project_id || "", user.user_id, pkg,
      );
    }

    // Notify runtime of new agent (fire-and-forget)
    notifyRuntimeOfConfigChange(c.env, String(config.name), String(config.version)).catch(() => {});

    const payload: Record<string, unknown> = {
      created: true,
      name: config.name,
      description: config.description,
      model: config.model,
      tools: config.tools,
      tags: config.tags,
      version: config.version,
    };
    if (pkg) {
      payload.sub_agents_created = (Array.isArray(pkg.sub_agents) ? pkg.sub_agents : []).length;
      payload.skills_created = (Array.isArray(pkg.skills) ? pkg.skills : []).length;
      payload.codemode_snippets_created = (Array.isArray(pkg.codemode_snippets) ? pkg.codemode_snippets : []).length;
      payload.guardrails_created = (Array.isArray(pkg.guardrails) ? pkg.guardrails : []).length;
      payload.mcp_connectors = pkg.mcp_connectors;
    }
    if (packageErrors.length > 0) payload.package_errors = packageErrors;
    if (req.include_autofix) payload.graph_autofix = graphAutofix;
    if (req.include_gate_pack) payload.gate_pack = gatePack;
    if (req.include_contracts_validate) payload.contracts_validate = contractsValidate;
    payload.hold_override_applied = holdOverrideApplied;

    return c.json(payload as any, 201);
});

// ── Runtime endpoints — moved to edge ────────────────────────────────

agentRoutes.post("/:name/run", (c) => {
  return runtimeMovedToEdge();
});

agentRoutes.post("/:name/run/stream", (c) => {
  return runtimeMovedToEdge(
    "Use `/api/v1/runtime-proxy/runnable/stream-events` on worker.",
  );
});

agentRoutes.post("/:name/chat", (c) => {
  return runtimeMovedToEdge("Use runnable invoke on worker for chat turns.");
});

agentRoutes.post("/:name/run/checkpoints/:checkpoint_id/resume", (c) => {
  return runtimeMovedToEdge("Resume via edge checkpoint endpoint.");
});

agentRoutes.post("/:name/run/:session_id/cancel", (c) => {
  return runtimeMovedToEdge(
    "Cancellation is managed in edge runtime/session layer.",
  );
});

// ── Version Restore (auth-protected) ───────────────────────────────────────

const restoreVersionRoute = createRoute({
  method: "post",
  path: "/{name}/versions/{commitId}/restore",
  tags: ["Agents"],
  summary: "Restore agent to a previous version",
  middleware: [requireScope("agents:write")],
  request: { params: z.object({ name: z.string(), commitId: z.string() }) },
  responses: {
    200: { description: "Version restored", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 404),
    422: { description: "Deploy policy validation failed", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
agentRoutes.openapi(restoreVersionRoute, async (c): Promise<any> => {
    const user = c.get("user");
    const { name: agentName, commitId } = c.req.valid("param");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const rows = await sql`
      SELECT config_json, version FROM agent_versions
      WHERE id = ${commitId} AND agent_name = ${agentName}
      LIMIT 1
    `;
    if (rows.length === 0) return c.json({ error: "Version not found" }, 404);

    let configJson: string;
    try {
      const restoredCfg = JSON.parse(String(rows[0].config_json || "{}")) as Record<string, unknown>;
      const restoredPolicy = applyDeployPolicyToConfigJson(restoredCfg, { fallbackStripOverlay: true });
      if (!restoredPolicy.ok) {
        return c.json(
          {
            error: "Deploy policy validation failed for restored version",
            details: restoredPolicy.errors,
            warnings: restoredPolicy.warnings,
          },
          422,
        );
      }
      configJson = JSON.stringify(restoredCfg);
    } catch {
      return c.json({ error: "Invalid config_json on version snapshot" }, 400);
    }

    // Snapshot current config before overwriting (for undo)
    const current = await sql`
      SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id} LIMIT 1
    `;
    if (current.length > 0) {
      await snapshotVersion(sql, agentName, `pre-restore-${Date.now()}`,
        JSON.parse(String(current[0].config_json || "{}")), user.user_id);
    }

    await sql`UPDATE agents SET config_json = ${configJson}, updated_at = now() WHERE name = ${agentName} AND org_id = ${user.org_id}`;
    await snapshotVersion(
      sql,
      agentName,
      String(rows[0].version || "restored"),
      JSON.parse(configJson) as Record<string, unknown>,
      user.user_id,
    );

    return c.json({ restored: true, version: rows[0].version } as any);
});

// ── Trash / Soft Delete (auth-protected) ──────────────────────────────────

const listTrashRoute = createRoute({
  method: "get",
  path: "/{name}/trash",
  tags: ["Agents"],
  summary: "List soft-deleted versions of an agent",
  middleware: [requireScope("agents:read")],
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Trash list", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
agentRoutes.openapi(listTrashRoute, async (c): Promise<any> => {
    const user = c.get("user");
    const { name: agentName } = c.req.valid("param");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const rows = await sql`
      SELECT agent_id, name, config_json, updated_at, created_by
      FROM agents
      WHERE name LIKE ${agentName + '-deleted-%'} AND org_id = ${user.org_id} AND is_active = 0
      ORDER BY updated_at DESC LIMIT 20
    `;

    const trash = rows.map((row) => ({
      id: String(row.agent_id),
      path: String(row.name),
      deleted_at: new Date(row.updated_at as string).getTime() / 1000,
      deleted_by: String(row.created_by || "system"),
      expires_at: new Date(row.updated_at as string).getTime() / 1000 + 30 * 86400,
      reason: "Soft-deleted",
    }));

    return c.json({ trash } as any);
});

const restoreTrashRoute = createRoute({
  method: "post",
  path: "/{name}/trash/{trashId}/restore",
  tags: ["Agents"],
  summary: "Restore a soft-deleted agent from trash",
  middleware: [requireScope("agents:write")],
  request: { params: z.object({ name: z.string(), trashId: z.string() }) },
  responses: {
    200: { description: "Agent restored", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
agentRoutes.openapi(restoreTrashRoute, async (c): Promise<any> => {
    const user = c.get("user");
    const { name: agentName, trashId } = c.req.valid("param");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    await sql`
      UPDATE agents SET is_active = 1, name = ${agentName}, updated_at = now()
      WHERE agent_id = ${trashId} AND org_id = ${user.org_id} AND is_active = 0
    `;

    return c.json({ restored: true } as any);
});
