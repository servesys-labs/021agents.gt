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
import { latestEvalGate, rolloutRecommendation } from "../logic/gate-pack";
import { buildFromDescription, recommendTools, expandEvalConfig, generateEvolutionSuggestions, type EvalTestCase, type EvalRubric } from "../logic/meta-agent";
import { runMetaChat, type MetaChatMessage } from "../logic/meta-agent-chat";
import { AGENT_TEMPLATES, getTemplateById } from "../logic/agent-templates";
import { applyDeployPolicyToConfigJson } from "../logic/deploy-policy-contract";
import { parseJsonColumn } from "../lib/parse-json-column";

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
  plan: z.enum(["free", "basic", "standard", "premium"]).default("standard"),
  draft_only: z.boolean().default(false),
  include_gate_pack: z.boolean().default(true),
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
      INSERT INTO agent_versions (agent_name, version, config_json, created_by, created_at)
      VALUES (${agentName}, ${version}, ${JSON.stringify(configJson)}, ${createdBy}, now())
      ON CONFLICT (agent_name, version) DO UPDATE
      SET config_json = ${JSON.stringify(configJson)}, created_by = ${createdBy}
    `;
  } catch {
    // Non-critical
  }
}

function agentResponse(row: Record<string, unknown>): Record<string, unknown> {
  const config = parseConfig(row.config_json);
  return {
    agent_id: row.agent_id ?? "",
    name: row.name ?? config.name ?? "",
    description: row.description ?? config.description ?? "",
    system_prompt: config.system_prompt ?? config.systemPrompt ?? "",
    model: config.model ?? "",
    plan: config.plan ?? "standard",
    tools: Array.isArray(config.tools) ? config.tools : [],
    tags: Array.isArray(config.tags) ? config.tags : [],
    version: config.version ?? "0.1.0",
    is_active: row.is_active ?? true,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    max_turns: config.max_turns,
    timeout_seconds: config.timeout_seconds,
    reasoning_strategy: config.reasoning_strategy,
    budget_limit_usd: (config.governance as Record<string, unknown>)?.budget_limit_usd ?? config.budget_limit_usd,
    model_override: config.model_override,
    handoff_config: config.handoff_config,
  };
}

/**
 * Resolve an agent identifier (either agent_id or name) to the agent's name.
 * This allows frontend URLs to use agent_id while backend routes still key on name.
 */
async function resolveAgentName(
  sql: Awaited<ReturnType<typeof getDbForOrg>>,
  identifier: string,
  orgId: string,
): Promise<string | null> {
  // First try as agent_id (hex string with optional agt_ prefix)
  const cleanId = identifier.replace(/^agt_/, "");
  if (/^[a-f0-9]{8,32}$/i.test(cleanId) || identifier.startsWith("agt_")) {
    const rows = await sql`
      SELECT name FROM agents WHERE (agent_id = ${identifier} OR agent_id = ${cleanId}) AND org_id = ${orgId} AND is_active = true LIMIT 1
    `;
    if (rows.length > 0) return String(rows[0].name);
  }
  // Fall back to treating it as a name (case-insensitive)
  const rows = await sql`
    SELECT name FROM agents WHERE LOWER(name) = LOWER(${identifier}) AND org_id = ${orgId} LIMIT 1
  `;
  return rows.length > 0 ? String(rows[0].name) : null;
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
    SELECT agent_id, name, description, config_json, is_active, created_at, updated_at
    FROM agents
    WHERE org_id = ${user.org_id} AND is_active = true
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
  const { name: identifier } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentName = await resolveAgentName(sql, identifier, user.org_id);
  if (!agentName) {
    return c.json({ error: `Agent '${identifier}' not found` }, 404);
  }

  const rows = await sql`
    SELECT agent_id, name, description, config_json, is_active, created_at, updated_at
    FROM agents
    WHERE name = ${agentName} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: `Agent '${identifier}' not found` }, 404);
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

    // Normalize agent name to lowercase — prevents case-variant duplicates
    req.name = req.name.toLowerCase().replace(/\s+/g, "-");

    // Check for existing agent with same name in org (case-insensitive)
    const existing = await sql`
      SELECT name, is_active FROM agents WHERE LOWER(name) = LOWER(${req.name}) AND org_id = ${user.org_id} LIMIT 1
    `;
    if (existing.length > 0) {
      if (existing[0].is_active) {
        return c.json({ error: `Agent '${existing[0].name}' already exists (names are case-insensitive)` }, 409);
      }
      // Reactivate soft-deleted agent with new config
      const configJson: Record<string, unknown> = {
        name: req.name, description: req.description, system_prompt: req.system_prompt,
        model: req.model || "", plan: req.plan || "free",
        tools: req.tools, max_turns: req.max_turns, temperature: req.temperature,
        tags: req.tags, version: "0.1.0",
        governance: req.governance ?? { budget_limit_usd: req.budget_limit_usd },
      };
      await sql`
        UPDATE agents SET is_active = true, config_json = ${JSON.stringify(configJson)}::jsonb,
          description = ${req.description}, updated_at = now()
        WHERE LOWER(name) = LOWER(${req.name}) AND org_id = ${user.org_id}
      `;
      return c.json(agentResponse({ ...existing[0], is_active: true, config_json: configJson } as any), 201);
    }

    // Agent creation is unlimited — agents are just config rows with zero cost.
    // Billing is purely usage-based (LLM tokens + tool execution).

    // Build config JSON
    const configJson: Record<string, unknown> = {
      name: req.name,
      description: req.description,
      system_prompt: req.system_prompt,
      personality: req.personality,
      model: req.model || "anthropic/claude-sonnet-4-6",
      plan: req.plan || "standard",
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

    // Insert agent + snapshot version + package in a single transaction
    const newAgentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    let packageErrors: string[] = [];

    await sql.begin(async (tx: any) => {
      await tx`
        INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
        VALUES (
          ${newAgentId},
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
      await snapshotVersion(tx, req.name, "0.1.0", configJson, user.user_id);

      // Persist full package if provided
      const hasPackage = req.sub_agents || req.skills || req.codemode_snippets || req.guardrails || req.release_strategy;
      if (hasPackage) {
        packageErrors = await persistAgentPackage(tx, req.name, user.org_id, user.project_id || "", user.user_id, {
          sub_agents: req.sub_agents,
          skills: req.skills,
          codemode_snippets: req.codemode_snippets,
          guardrails: req.guardrails,
          release_strategy: req.release_strategy,
        });
      }
    });

    const response: Record<string, unknown> = {
      agent_id: newAgentId,
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
    const { name: identifier } = c.req.valid("param");
    const req = c.req.valid("json");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const name = await resolveAgentName(sql, identifier, user.org_id);
    if (!name) {
      return c.json({ error: `Agent '${identifier}' not found` }, 404);
    }

    // Fetch existing
    const rows = await sql`
      SELECT config_json FROM agents
      WHERE name = ${name} AND org_id = ${user.org_id}
      LIMIT 1
    `;

    const existingConfig = parseConfig((rows[0] as Record<string, unknown>).config_json);

    // Merge updates
    if (req.description) existingConfig.description = req.description;
    if (req.system_prompt) existingConfig.system_prompt = req.system_prompt;
    if (req.personality) existingConfig.personality = req.personality;
    if (req.model) existingConfig.model = req.model;
    if (req.plan) existingConfig.plan = req.plan;
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

    // MVP dashboard flow UI (visual only)
    if (req.mvp_flow_canvas && typeof req.mvp_flow_canvas === "object") {
      let harness = existingConfig.harness as Record<string, unknown> | undefined;
      if (typeof harness !== "object" || harness === null) {
        harness = {};
        existingConfig.harness = harness;
      }
      harness.mvp_flow_canvas = req.mvp_flow_canvas;
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

    // Phase 10.4: Deploy policy audit trail
    // Log policy-relevant field changes for compliance
    const policyFields = ["deploy_policy", "tools", "model", "governance", "system_prompt"];
    for (const field of policyFields) {
      const oldVal = rows[0] ? JSON.stringify((parseConfig((rows[0] as any).config_json) as any)[field]) : null;
      const newVal = JSON.stringify((existingConfig as any)[field]);
      if (oldVal !== newVal) {
        sql`
          INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
          VALUES (${user.org_id}, ${user.user_id}, 'config_change', 'agent', ${name},
            ${JSON.stringify({ field, old_hash: oldVal?.slice(0, 50), new_hash: newVal?.slice(0, 50), version: newVersion })},
            NOW())
        `.catch(() => {}); // fire-and-forget
      }
    }

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
    const { name: identifier } = c.req.valid("param");
    const hardDelete = c.req.query("hard_delete") === "true";
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const name = await resolveAgentName(sql, identifier, user.org_id);
    if (!name) {
      return c.json({ error: `Agent '${identifier}' not found` }, 404);
    }

    // Block deletion of personal agents (my-assistant) — they're permanent per account
    try {
      const configRows = await sql`SELECT config_json FROM agents WHERE name = ${name} AND org_id = ${user.org_id} LIMIT 1`;
      const cfg = parseConfig(configRows[0]?.config_json);
      if (cfg.is_personal) {
        return c.json({ error: "Cannot delete the personal assistant. This agent is permanent for your account." }, 403);
      }
    } catch {}

    const counts: Record<string, number> = {};

    if (hardDelete) {
      // Hard delete — cascading removal of all associated records in a transaction
      // Explicit per-table parameterized DELETEs (no dynamic table names)
      await sql.begin(async (tx: any) => {
        const r1 = await tx`DELETE FROM turns WHERE session_id IN (SELECT session_id FROM sessions WHERE agent_name = ${name} AND org_id = ${user.org_id})`;
        counts.turns = r1.count ?? 0;

        const r2 = await tx`DELETE FROM sessions WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.sessions = r2.count ?? 0;

        const r3 = await tx`DELETE FROM billing_records WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.billing_records = r3.count ?? 0;

        const r4 = await tx`DELETE FROM eval_runs WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.eval_runs = r4.count ?? 0;

        const r5 = await tx`DELETE FROM eval_results WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.eval_results = r5.count ?? 0;

        const r6 = await tx`DELETE FROM issues WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.issues = r6.count ?? 0;

        const r7 = await tx`DELETE FROM compliance_checks WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.compliance_checks = r7.count ?? 0;

        const r8 = await tx`DELETE FROM schedules WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.schedules = r8.count ?? 0;

        const r9 = await tx`DELETE FROM webhooks WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.webhooks = r9.count ?? 0;

        const r10 = await tx`DELETE FROM agent_versions WHERE agent_name = ${name} AND org_id = ${user.org_id}`;
        counts.agent_versions = r10.count ?? 0;

        await tx`DELETE FROM agents WHERE name = ${name} AND org_id = ${user.org_id}`;
        counts.agent = 1;
      });
    } else {
      // Soft delete
      await sql`
        UPDATE agents SET is_active = false, updated_at = now()
        WHERE name = ${name} AND org_id = ${user.org_id}
      `;
      counts.agent = 1;
    }

    // Audit log (fire-and-forget)
    sql`
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'delete', 'agent', ${name}, ${JSON.stringify({
        hard_delete: hardDelete,
      })}::jsonb, now())
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
    const { name: identifier } = c.req.valid("param");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const agentName = await resolveAgentName(sql, identifier, user.org_id) || identifier;

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
  const { name: identifier } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const name = await resolveAgentName(sql, identifier, user.org_id);
  if (!name) return c.json({ error: `Agent '${identifier}' not found` }, 404);

  const rows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;

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
  const { name: identifier } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const name = await resolveAgentName(sql, identifier, user.org_id);
  if (!name) return c.json({ error: `Agent '${identifier}' not found` }, 404);

  const rows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;

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
  const { name: identifier } = c.req.valid("param");
  const { new_name: newNameValue } = c.req.valid("json");

  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const name = await resolveAgentName(sql, identifier, user.org_id);
  if (!name) return c.json({ error: `Agent '${identifier}' not found` }, 404);

  // Fetch source agent
  const rows = await sql`
    SELECT name, description, config_json FROM agents
    WHERE name = ${name} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  // Check target name doesn't exist (case-insensitive)
  const existCheck = await sql`
    SELECT name FROM agents WHERE LOWER(name) = LOWER(${newNameValue}) AND org_id = ${user.org_id} LIMIT 1
  `;
  if (existCheck.length > 0) {
    return c.json({ error: `Agent '${existCheck[0].name}' already exists (names are case-insensitive)` }, 409);
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
    422: { description: "Validation failed", content: { "application/json": { schema: z.record(z.unknown()) } } },
  },
});
agentRoutes.openapi(importAgentRoute, async (c): Promise<any> => {
    const { config } = c.req.valid("json");
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

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
  const { name: identifier } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const name = await resolveAgentName(sql, identifier, user.org_id);
  if (!name) return c.json({ error: `Agent '${identifier}' not found` }, 404);

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
        INSERT INTO skills (name, description, category, prompt, prompt_template, agent_name, org_id, enabled, created_at)
        VALUES (${String(s.name)}, ${String(s.description || "")}, ${String(s.category || "general")},
                ${String(s.content || "")}, ${String(s.content || "")}, ${agentName}, ${orgId}, true, now())
        ON CONFLICT (org_id, name) DO NOTHING
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
        orgProfile = parseJsonColumn(settingsRows[0].settings_json);
      }
    } catch { /* ignore — preferences are optional */ }

    // Generate config via Claude Sonnet 4.6 (plan + org-profile aware)
    const config = await buildFromDescription(c.env.AI, req.description, {
      name: req.name || undefined,
      hyperdrive: c.env.HYPERDRIVE,
      orgId: user.org_id,
      openrouterApiKey: c.env.OPENROUTER_API_KEY || "",
      cloudflareAccountId: c.env.CLOUDFLARE_ACCOUNT_ID,
      aiGatewayId: c.env.AI_GATEWAY_ID,
      cloudflareApiToken: c.env.CLOUDFLARE_API_TOKEN,
      pipedream: c.env.PIPEDREAM_CLIENT_ID ? {
        clientId: c.env.PIPEDREAM_CLIENT_ID,
        clientSecret: c.env.PIPEDREAM_CLIENT_SECRET ?? "",
        projectId: c.env.PIPEDREAM_PROJECT_ID ?? "",
      } : undefined,
      orgProfile: orgProfile as any,
    });

    if (req.name) config.name = req.name;

    // Apply LLM plan
    config.plan = req.plan;

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

    // Store eval config in agent config if provided
    if (pkg?.eval_config) {
      (config as Record<string, unknown>).eval_config = pkg.eval_config;
    }

    // Eval gate
    const evalGate = await latestEvalGate(sql, String(config.name), {
      minEvalPassRate: req.min_eval_pass_rate,
      minEvalTrials: req.min_eval_trials,
      orgId: user.org_id,
    });

    const gatePack = {
      eval_gate: evalGate,
      rollout: rolloutRecommendation({
        agentName: String(config.name),
        evalGate,
        targetChannel: req.target_channel,
      }),
    };

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

      if (req.include_gate_pack) payload.gate_pack = gatePack;
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

    // Save agent + snapshot version + package in a single transaction
    const generatedAgentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    let agentId = generatedAgentId;
    let packageErrors: string[] = [];

    await sql.begin(async (tx: any) => {
      await tx`
        INSERT INTO agents (agent_id, name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
        VALUES (
          ${generatedAgentId},
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

      // Retrieve the actual agent_id (may differ on conflict/update)
      try {
        const idRows = await tx`SELECT agent_id FROM agents WHERE name = ${String(config.name)} AND org_id = ${user.org_id} LIMIT 1`;
        if (idRows.length > 0) agentId = String(idRows[0].agent_id);
      } catch {}

      await snapshotVersion(tx, String(config.name), String(config.version), cfgRecord, user.user_id);

      // Persist the full agent package (sub-agents, skills, codemode, guardrails, releases)
      if (pkg) {
        // Clean _package from config before using it
        delete (config as Record<string, unknown>)._package;
        packageErrors = await persistAgentPackage(
          tx, String(config.name), user.org_id, user.project_id || "", user.user_id, pkg,
        );
      }
    });

    // Notify runtime of new agent (fire-and-forget)
    notifyRuntimeOfConfigChange(c.env, String(config.name), String(config.version)).catch(() => {});

    // ── Auto-Eval: expand eval_config into executable test cases ──────
    // This runs after agent creation so the agent exists before we test it.
    let autoEvalTasks: EvalTestCase[] = [];
    let autoEvalRubric: EvalRubric | null = null;
    const evalCfg = (pkg?.eval_config ?? (config as Record<string, unknown>).eval_config) as Record<string, unknown> | null;

    if (evalCfg) {
      try {
        const expanded = await expandEvalConfig(
          evalCfg,
          String(config.description || req.description),
          String(config.name),
          { openrouterApiKey: c.env.OPENROUTER_API_KEY },
        );
        autoEvalTasks = expanded.tasks;
        autoEvalRubric = expanded.rubric;

        // Persist auto-generated eval tasks for later re-runs
        if (autoEvalTasks.length > 0) {
          const evalConfigWithTasks = {
            ...evalCfg,
            test_cases: autoEvalTasks,
            rubric: autoEvalRubric,
            auto_generated: true,
            generated_at: new Date().toISOString(),
          };
          // Update agent config with expanded eval_config
          await sql`
            UPDATE agents SET config_json = jsonb_set(
              config_json::jsonb,
              '{eval_config}',
              ${JSON.stringify(evalConfigWithTasks)}::jsonb
            )
            WHERE name = ${String(config.name)} AND org_id = ${user.org_id}
          `.catch(() => {
            // Fallback: re-write the whole config if jsonb_set isn't available
            const updatedConfig = { ...cfgRecord, eval_config: evalConfigWithTasks };
            return sql`
              UPDATE agents SET config_json = ${JSON.stringify(updatedConfig)}
              WHERE name = ${String(config.name)} AND org_id = ${user.org_id}
            `;
          });
        }
      } catch (err) {
        console.error("[auto-eval] Failed to expand eval config:", err);
        // Non-fatal — agent is already created
      }
    }

    const payload: Record<string, unknown> = {
      created: true,
      agent_id: agentId,
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
    if (autoEvalTasks.length > 0) {
      payload.auto_eval = {
        test_cases_generated: autoEvalTasks.length,
        rubric: autoEvalRubric,
        tasks: autoEvalTasks,
      };
    }
    if (packageErrors.length > 0) payload.package_errors = packageErrors;
    if (req.include_gate_pack) payload.gate_pack = gatePack;
    payload.hold_override_applied = holdOverrideApplied;

    return c.json(payload as any, 201);
});

// ── Evolution: analyze eval results and suggest improvements ──────────

const evolveRoute = createRoute({
  method: "post",
  path: "/{name}/evolve",
  tags: ["Agents"],
  summary: "Analyze eval results and suggest agent improvements",
  middleware: [requireScope("agents:write")],
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            eval_run_id: z.string().optional().openapi({ description: "Specific eval run to analyze (defaults to latest)" }),
            auto_apply: z.boolean().default(false).openapi({ description: "Auto-apply low-risk suggestions" }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Evolution suggestions", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404, 500),
  },
});

agentRoutes.openapi(evolveRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name: identifier } = c.req.valid("param");
  const req = c.req.valid("json");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentName = await resolveAgentName(sql, identifier, user.org_id);
  if (!agentName) return c.json({ error: "Agent not found" }, 404);

  // Load agent config
  const agentRows = await sql`SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id} LIMIT 1`;
  if (agentRows.length === 0) return c.json({ error: "Agent not found" }, 404);
  const agentConfig = parseJsonColumn(agentRows[0].config_json);

  // Load eval results (latest run or specific run)
  let evalRows: any[];
  if (req.eval_run_id) {
    evalRows = await sql`SELECT * FROM eval_runs WHERE id = ${req.eval_run_id} AND org_id = ${user.org_id} LIMIT 1`;
  } else {
    evalRows = await sql`SELECT * FROM eval_runs WHERE agent_name = ${agentName} AND org_id = ${user.org_id} ORDER BY created_at DESC LIMIT 1`;
  }

  if (evalRows.length === 0) {
    return c.json({
      suggestions: [{
        area: "test_cases",
        severity: "high",
        suggestion: "No eval runs found. Run the auto-generated tests first to get improvement suggestions.",
        auto_applicable: false,
      }],
      eval_run: null,
    });
  }

  const evalRun = evalRows[0];
  // Load trial failures
  let failures: any[] = [];
  try {
    const trials = await sql`SELECT * FROM eval_trials WHERE run_id = ${evalRun.id} AND pass = false ORDER BY trial_number`;
    failures = trials.map((t: any) => ({
      input: String(t.input || ""),
      expected: String(t.expected || ""),
      actual: String(t.actual || ""),
      reasoning: String(t.reasoning || ""),
    }));
  } catch {}

  const suggestions = await generateEvolutionSuggestions(
    agentName,
    agentConfig,
    {
      pass_rate: Number(evalRun.pass_rate) || 0,
      failures,
      avg_latency_ms: Number(evalRun.avg_latency_ms) || undefined,
      total_cost_usd: Number(evalRun.total_cost_usd) || undefined,
    },
    { openrouterApiKey: c.env.OPENROUTER_API_KEY },
  );

  // Auto-apply safe suggestions if requested
  let appliedCount = 0;
  if (req.auto_apply) {
    for (const sug of suggestions) {
      if (!sug.auto_applicable || !sug.patch) continue;
      try {
        if (sug.area === "prompt" && sug.patch.system_prompt_append) {
          const currentPrompt = String(agentConfig.system_prompt || "");
          const appendText = String(sug.patch.system_prompt_append);
          agentConfig.system_prompt = currentPrompt + "\n\n" + appendText;
          appliedCount++;
        }
        if (sug.area === "tools" && Array.isArray(sug.patch.add_tools)) {
          const currentTools = new Set(Array.isArray(agentConfig.tools) ? agentConfig.tools : []);
          for (const t of sug.patch.add_tools) currentTools.add(String(t));
          agentConfig.tools = [...currentTools];
          appliedCount++;
        }
      } catch {}
    }

    if (appliedCount > 0) {
      await sql`
        UPDATE agents SET config_json = ${JSON.stringify(agentConfig)}, updated_at = now()
        WHERE name = ${agentName} AND org_id = ${user.org_id}
      `;
      notifyRuntimeOfConfigChange(c.env, agentName, String(agentConfig.version || "")).catch(() => {});
    }
  }

  return c.json({
    suggestions,
    auto_applied: appliedCount,
    eval_run: {
      id: evalRun.id,
      pass_rate: evalRun.pass_rate,
      total_tasks: evalRun.total_tasks,
      failures_analyzed: failures.length,
    },
  });
});

// ── Meta-agent conversational chat ──────────────────────────────────

const metaChatRoute = createRoute({
  method: "post",
  path: "/{name}/meta-chat",
  tags: ["Agents"],
  summary: "Chat with the meta-agent about this agent's configuration, performance, and improvements",
  middleware: [requireScope("agents:write")],
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            messages: z.array(
              z.object({
                role: z.enum(["user", "assistant", "system", "tool"]),
                content: z.string(),
                tool_call_id: z.string().optional(),
                tool_calls: z.array(z.record(z.unknown())).optional(),
              }),
            ),
            mode: z.enum(["demo", "live"]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Meta-agent response",
      content: {
        "application/json": {
          schema: z.object({
            response: z.string(),
            messages: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
    ...errorResponses(400, 404, 500),
  },
});
agentRoutes.openapi(metaChatRoute, async (c): Promise<any> => {
  const { name: identifier } = c.req.valid("param");
  const { messages, mode } = c.req.valid("json");
  const user = c.get("user");

  // Resolve agent identifier (supports both agent_id and name)
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const agentName = await resolveAgentName(sql, identifier, user.org_id);
  if (!agentName) {
    return c.json({ error: `Agent '${identifier}' not found` }, 404);
  }

  try {
    const result = await runMetaChat(messages as MetaChatMessage[], {
      agentName,
      orgId: user.org_id,
      userId: user.user_id,
      hyperdrive: c.env.HYPERDRIVE,
      openrouterApiKey: c.env.OPENROUTER_API_KEY || "",
      cloudflareAccountId: c.env.CLOUDFLARE_ACCOUNT_ID,
      aiGatewayId: c.env.AI_GATEWAY_ID,
      cloudflareApiToken: c.env.CLOUDFLARE_API_TOKEN,
      aiGatewayToken: c.env.AI_GATEWAY_TOKEN,
      mode: mode || "live",
      env: {
        RUNTIME: c.env.RUNTIME,
        SERVICE_TOKEN: c.env.SERVICE_TOKEN,
        JOB_QUEUE: c.env.JOB_QUEUE,
      },
    });

    return c.json({
      response: result.response,
      messages: result.messages,
      cost_usd: result.cost_usd || 0,
      turns: result.turns || 0,
    });
  } catch (err: any) {
    console.error(`[meta-chat] Error for agent ${agentName}:`, err);
    return c.json(
      { error: err.message || "Meta-agent chat failed" },
      500,
    );
  }
});

// ── Runtime endpoints — moved to edge ────────────────────────────────

agentRoutes.post("/:name/run", (c) => {
  return runtimeMovedToEdge();
});

agentRoutes.post("/:name/run/stream", (c) => {
  return runtimeMovedToEdge(
    "Use `POST /api/v1/runtime-proxy/runnable/stream` (SSE) with the same auth.",
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
    const { name: identifier, commitId } = c.req.valid("param");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const agentName = await resolveAgentName(sql, identifier, user.org_id) || identifier;

    const rows = await sql`
      SELECT config_json, version FROM agent_versions
      WHERE id = ${commitId} AND agent_name = ${agentName}
      LIMIT 1
    `;
    if (rows.length === 0) return c.json({ error: "Version not found" }, 404);

    let configJson: string;
    try {
      const restoredCfg = parseJsonColumn<Record<string, unknown>>(rows[0].config_json);
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
        parseJsonColumn(current[0].config_json), user.user_id);
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
    const { name: identifier } = c.req.valid("param");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    const agentName = await resolveAgentName(sql, identifier, user.org_id) || identifier;

    const rows = await sql`
      SELECT agent_id, name, config_json, updated_at, created_by
      FROM agents
      WHERE name LIKE ${agentName + '-deleted-%'} AND org_id = ${user.org_id} AND is_active = false
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
    const { name: identifier, trashId } = c.req.valid("param");
    const sql2 = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
    const agentName = await resolveAgentName(sql2, identifier, user.org_id) || identifier;
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    await sql`
      UPDATE agents SET is_active = true, name = ${agentName}, updated_at = now()
      WHERE agent_id = ${trashId} AND org_id = ${user.org_id} AND is_active = false
    `;

    return c.json({ restored: true } as any);
});
