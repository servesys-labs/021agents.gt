/**
 * Agents router — CRUD, versions, clone, import/export, create-from-description.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { requireScope } from "../middleware/auth";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, AgentCreateBody, AgentTemplate, AgentSummary, errorResponses } from "../schemas/openapi";
import { withOrgDb, type OrgSql } from "../db/client";
import { failSafe } from "../lib/error-response";
import type { AuditAction } from "../telemetry/events";
import { latestEvalGate, rolloutRecommendation } from "../logic/gate-pack";
import {
  buildAgentIdentity,
  decorateAgentConfigIdentity,
  isHiddenAgentConfig,
  isReservedPlatformAgentHandle,
} from "../logic/agent-identity";
import { buildFromDescription, recommendTools, expandEvalConfig, generateEvolutionSuggestions, type EvalTestCase, type EvalRubric } from "../logic/meta-agent";
import { normalizeEnabledSkills } from "../logic/meta-agent-chat";
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
  agentHandle: string,
  version: string,
): Promise<void> {
  try {
    await env.RUNTIME.fetch("https://runtime/api/v1/internal/config-invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ agent_handle: agentHandle, agent_name: agentHandle, version, timestamp: Date.now() }),
    });
  } catch (e) {
    // Non-critical: runtime will reload on next request anyway
    console.warn(`[agents] Failed to notify runtime of config change for ${agentHandle}:`, e);
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
  handle: z.string().max(128).default(""),
  display_name: z.string().max(160).default(""),
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
  sql: OrgSql,
  agent: { agentId: string; handle: string; displayName: string },
  version: string,
  configJson: Record<string, unknown>,
  createdBy: string,
): Promise<void> {
  try {
    await sql`
      INSERT INTO agent_versions (agent_id, agent_handle, display_name, agent_name, org_id, version, config, created_by, created_at)
      VALUES (
        ${agent.agentId},
        ${agent.handle},
        ${agent.displayName},
        ${agent.handle},
        current_org_id(),
        ${version},
        ${JSON.stringify(configJson)},
        ${createdBy},
        now()
      )
      ON CONFLICT (org_id, agent_id, version) DO UPDATE
      SET
        agent_handle = EXCLUDED.agent_handle,
        display_name = EXCLUDED.display_name,
        agent_name = EXCLUDED.agent_name,
        config = EXCLUDED.config,
        created_by = EXCLUDED.created_by
    `;
  } catch {
    // Non-critical
  }
}

function agentResponse(row: Record<string, unknown>): Record<string, unknown> {
  const config = parseConfig(row.config);
  const handle = String(row.handle ?? config.handle ?? row.name ?? config.name ?? "");
  const displayName = String(row.display_name ?? config.display_name ?? handle);
  return {
    agent_id: row.agent_id ?? "",
    handle,
    display_name: displayName,
    name: handle,
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
 * Resolve a user-facing agent identifier (agent_id or handle) to the
 * canonical routing identity. Hidden/internal agents are excluded unless the
 * caller explicitly opts in.
 */
async function resolveAgentRecord(
  sql: OrgSql,
  identifier: string,
  options: { includeHidden?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const cleanId = identifier.replace(/^agt_/, "");
  const rows = await sql`
    SELECT agent_id, handle, display_name, name, description, config, is_active, created_at, updated_at
    FROM agents
    WHERE is_active = true
      AND (
        agent_id = ${identifier}
        OR agent_id = ${cleanId}
        OR LOWER(handle) = LOWER(${identifier})
        OR LOWER(name) = LOWER(${identifier})
      )
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  const config = parseConfig(row.config);
  if (!options.includeHidden && isHiddenAgentConfig(config)) {
    return null;
  }
  return row;
}

async function assertHandleAvailable(
  sql: OrgSql,
  handle: string,
  excludeAgentId?: string,
): Promise<string | null> {
  if (isReservedPlatformAgentHandle(handle)) {
    return `Agent handle '${handle}' is reserved for a platform-owned ambient agent`;
  }
  const rows = await sql`
    SELECT agent_id, handle, is_active
    FROM agents
    WHERE LOWER(handle) = LOWER(${handle})
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  if (row.is_active === false) return null;
  if (excludeAgentId && String(row.agent_id || "") === excludeAgentId) return null;
  return `Agent handle '${row.handle}' already exists (handles are case-insensitive)`;
}

async function resolveAgentName(
  sql: OrgSql,
  identifier: string,
  _orgId: string,
): Promise<string | null> {
  const row = await resolveAgentRecord(sql, identifier);
  return row ? String(row.handle ?? row.name ?? "") : null;
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
    return c.json(
      proxied
        .filter((r) => !isHiddenAgentConfig(parseConfig((r as Record<string, unknown>).config)))
        .map((r) => agentResponse(r as Record<string, unknown>)) as any,
    );
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT agent_id, handle, display_name, name, description, config, is_active, created_at, updated_at
      FROM agents
      WHERE is_active = true
      ORDER BY created_at DESC
    `;

    return c.json(
      rows
        .filter((r) => !isHiddenAgentConfig(parseConfig((r as Record<string, unknown>).config)))
        .map((r) => agentResponse(r as Record<string, unknown>)) as any,
    );
  });
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const row = await resolveAgentRecord(sql, identifier);
    if (!row) {
      return c.json({ error: `Agent '${identifier}' not found` }, 404);
    }
    return c.json(agentResponse(row) as any);
  });
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    const identity = buildAgentIdentity({
      handle: req.handle || req.name,
      displayName: req.display_name,
      fallbackHandle: "agent",
    });
    const handleConflict = await assertHandleAvailable(sql, identity.handle);
    if (handleConflict) {
      return c.json({ error: handleConflict }, 409);
    }

    // Check for existing soft-deleted agent with same handle (case-insensitive)
    const existing = await sql`
      SELECT agent_id, handle, display_name, name, description, config, is_active
      FROM agents
      WHERE LOWER(handle) = LOWER(${identity.handle})
      LIMIT 1
    `;
    if (existing.length > 0) {
      if (existing[0].is_active) {
        return c.json({ error: `Agent handle '${existing[0].handle}' already exists (handles are case-insensitive)` }, 409);
      }
      // Reactivate soft-deleted agent with new config
      const existingAgentId = String(existing[0].agent_id || "");
      const configJson = decorateAgentConfigIdentity({
        description: req.description,
        system_prompt: req.system_prompt,
        model: req.model || "", plan: req.plan || "free",
        tools: req.tools, max_turns: req.max_turns, temperature: req.temperature,
        tags: req.tags, version: "0.1.0",
        governance: req.governance ?? { budget_limit_usd: req.budget_limit_usd },
      }, {
        agentId: existingAgentId,
        handle: identity.handle,
        displayName: identity.displayName,
      });
      await sql`
        UPDATE agents
        SET
          is_active = true,
          handle = ${identity.handle},
          display_name = ${identity.displayName},
          name = ${identity.handle},
          config = ${JSON.stringify(configJson)}::jsonb,
          description = ${req.description},
          updated_at = now()
        WHERE agent_id = ${existingAgentId}
      `;
      return c.json(agentResponse({
        ...existing[0],
        agent_id: existingAgentId,
        handle: identity.handle,
        display_name: identity.displayName,
        name: identity.handle,
        is_active: true,
        config: configJson,
      } as any), 201);
    }

    // Agent creation is unlimited — agents are just config rows with zero cost.
    // Billing is purely usage-based (LLM tokens + tool execution).

    // Build config JSON
    const newAgentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const configJson: Record<string, unknown> = decorateAgentConfigIdentity({
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
    }, {
      agentId: newAgentId,
      handle: identity.handle,
      displayName: identity.displayName,
    });

    // Phase 5 — validate enabled_skills against the bundled catalog; drop
    // unknowns and surface them via package_errors so the caller sees what
    // was dropped. Empty/absent = default ("all skills available") —
    // backward-compatible with pre-Phase-5 configs.
    const createEnabled = normalizeEnabledSkills(req.enabled_skills);
    if (createEnabled.valid.length > 0) {
      configJson.enabled_skills = createEnabled.valid;
    }

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

    // Insert agent + snapshot version + package — withOrgDb already opened
    // a transaction so we just run the writes directly.
    let packageErrors: string[] = [];

    await sql`
      INSERT INTO agents (agent_id, handle, display_name, name, org_id, project_id, config, description, is_active, created_at, updated_at)
      VALUES (
        ${newAgentId},
        ${identity.handle},
        ${identity.displayName},
        ${identity.handle},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(configJson)},
        ${req.description},
        ${true},
        now(),
        now()
      )
    `;

    // Snapshot version
    await snapshotVersion(sql, {
      agentId: newAgentId,
      handle: identity.handle,
      displayName: identity.displayName,
    }, "0.1.0", configJson, user.user_id);

    // Persist full package if provided
    const hasPackage = req.sub_agents || req.skills || req.codemode_snippets || req.guardrails || req.release_strategy;
    if (hasPackage) {
      packageErrors = await persistAgentPackage(sql, identity.handle, user.org_id, user.project_id || "", user.user_id, {
        sub_agents: req.sub_agents,
        skills: req.skills,
        codemode_snippets: req.codemode_snippets,
        guardrails: req.guardrails,
        release_strategy: req.release_strategy,
      });
    }

    const response: Record<string, unknown> = {
      agent_id: newAgentId,
      handle: identity.handle,
      display_name: identity.displayName,
      name: identity.handle,
      description: req.description,
      model: configJson.model,
      tools: req.tools,
      tags: req.tags,
      version: "0.1.0",
    };
    if (req.reasoning_strategy) response.reasoning_strategy = req.reasoning_strategy;
    if (createEnabled.valid.length > 0) response.enabled_skills = createEnabled.valid;
    if (createEnabled.dropped.length > 0) {
      response.warning_enabled_skills = `dropped ${createEnabled.dropped.length} unknown skill name(s): ${createEnabled.dropped.join(", ")}`;
      response.dropped_skills = createEnabled.dropped;
    }
    if (packageErrors.length > 0) response.package_errors = packageErrors;
    return c.json(response as any, 201);
    });
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
    body: { content: { "application/json": { schema: AgentCreateBody.partial() } } },
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    const agentRow = await resolveAgentRecord(sql, identifier);
    if (!agentRow) {
      return c.json({ error: `Agent '${identifier}' not found` }, 404);
    }
    const agentId = String(agentRow.agent_id || "");
    const currentHandle = String(agentRow.handle || agentRow.name || "");
    const currentDisplayName = String(agentRow.display_name || currentHandle);

    // Fetch existing
    const rows = await sql`
      SELECT config, description, display_name
      FROM agents
      WHERE agent_id = ${agentId}
      LIMIT 1
    `;

    const existingConfig = parseConfig((rows[0] as Record<string, unknown>).config);
    const nextIdentity = buildAgentIdentity({
      handle: req.handle || req.name || currentHandle,
      displayName: req.display_name || String(rows[0]?.display_name || currentDisplayName),
      fallbackHandle: currentHandle,
    });
    const handleConflict = await assertHandleAvailable(sql, nextIdentity.handle, agentId);
    if (handleConflict) {
      return c.json({ error: handleConflict }, 409);
    }
    if (isReservedPlatformAgentHandle(nextIdentity.handle) && nextIdentity.handle !== currentHandle) {
      return c.json({ error: `Agent handle '${nextIdentity.handle}' is reserved for a platform-owned ambient agent` }, 409);
    }

    // Merge updates
    if (req.description) existingConfig.description = req.description;
    if (req.system_prompt) existingConfig.system_prompt = req.system_prompt;
    if (req.personality) existingConfig.personality = req.personality;
    if (req.model) existingConfig.model = req.model;
    if (req.plan) existingConfig.plan = req.plan;
    if (req.max_tokens != null) existingConfig.max_tokens = req.max_tokens;
    if (req.temperature != null) existingConfig.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) existingConfig.tools = req.tools;
    if (req.tags && req.tags.length > 0) existingConfig.tags = req.tags;
    // Phase 5 — enabled_skills validated against the bundled catalog.
    // An explicit empty array clears the allowlist (back to "all skills").
    let updateDroppedSkills: string[] = [];
    if (req.enabled_skills !== undefined) {
      const { valid, dropped } = normalizeEnabledSkills(req.enabled_skills);
      existingConfig.enabled_skills = valid;
      updateDroppedSkills = dropped;
    }
    if (req.max_turns != null) existingConfig.max_turns = req.max_turns;
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
    const updatedConfig = decorateAgentConfigIdentity(existingConfig, {
      agentId,
      handle: nextIdentity.handle,
      displayName: nextIdentity.displayName,
    });

    await sql`
      UPDATE agents
      SET handle = ${nextIdentity.handle},
          display_name = ${nextIdentity.displayName},
          name = ${nextIdentity.handle},
          config = ${JSON.stringify(updatedConfig)},
          description = ${req.description || (updatedConfig.description as string) || ""},
          updated_at = now()
      WHERE agent_id = ${agentId}
    `;

    await snapshotVersion(sql, {
      agentId,
      handle: nextIdentity.handle,
      displayName: nextIdentity.displayName,
    }, newVersion, updatedConfig, user.user_id);

    // Phase 10.4: Deploy policy audit trail
    // Log policy-relevant field changes for compliance
    const policyFields = ["deploy_policy", "tools", "model", "governance", "system_prompt"];
    for (const field of policyFields) {
      const oldVal = rows[0] ? JSON.stringify((parseConfig((rows[0] as any).config) as any)[field]) : null;
      const newVal = JSON.stringify((updatedConfig as any)[field]);
      if (oldVal !== newVal) {
        sql`
          INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
          VALUES (${user.org_id}, ${user.user_id}, ${"config_change" satisfies AuditAction}, 'agent', ${nextIdentity.handle},
            ${JSON.stringify({ field, old_hash: oldVal?.slice(0, 50), new_hash: newVal?.slice(0, 50), version: newVersion })},
            NOW())
        `.catch(() => {}); // fire-and-forget
      }
    }

    // Notify runtime of config change (fire-and-forget)
    // This triggers the DO to reload config on next request
    notifyRuntimeOfConfigChange(c.env, nextIdentity.handle, newVersion).catch(() => {});

    const updateResponse: Record<string, unknown> = {
      agent_id: agentId,
      handle: nextIdentity.handle,
      display_name: nextIdentity.displayName,
      name: nextIdentity.handle,
      description: updatedConfig.description ?? "",
      model: updatedConfig.model ?? "",
      tools: Array.isArray(updatedConfig.tools) ? updatedConfig.tools : [],
      tags: Array.isArray(updatedConfig.tags) ? updatedConfig.tags : [],
      version: newVersion,
    };
    if (Array.isArray(updatedConfig.enabled_skills) && updatedConfig.enabled_skills.length > 0) {
      updateResponse.enabled_skills = updatedConfig.enabled_skills;
    }
    if (updateDroppedSkills.length > 0) {
      updateResponse.warning_enabled_skills = `dropped ${updateDroppedSkills.length} unknown skill name(s): ${updateDroppedSkills.join(", ")}`;
      updateResponse.dropped_skills = updateDroppedSkills;
    }
    return c.json(updateResponse as any);
    });
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    const agentRow = await resolveAgentRecord(sql, identifier);
    if (!agentRow) {
      return c.json({ error: `Agent '${identifier}' not found` }, 404);
    }
    const agentId = String(agentRow.agent_id || "");
    const agentHandle = String(agentRow.handle || agentRow.name || "");

    // Block deletion of personal agents (my-assistant) — they're permanent per account
    try {
      const configRows = await sql`SELECT config FROM agents WHERE agent_id = ${agentId} LIMIT 1`;
      const cfg = parseConfig(configRows[0]?.config);
      if (cfg.is_personal) {
        return c.json({ error: "Cannot delete the personal assistant. This agent is permanent for your account." }, 403);
      }
    } catch {}

    const counts: Record<string, number> = {};

    if (hardDelete) {
      // Hard delete — cascading removal of all associated records.
      // withOrgDb already opened a transaction, so the writes are atomic.
      const r1 = await sql`DELETE FROM turns WHERE session_id IN (SELECT session_id FROM sessions WHERE agent_name = ${agentHandle})`;
      counts.turns = r1.count ?? 0;

      const r2 = await sql`DELETE FROM sessions WHERE agent_name = ${agentHandle}`;
      counts.sessions = r2.count ?? 0;

      const r3 = await sql`DELETE FROM billing_records WHERE agent_name = ${agentHandle}`;
      counts.billing_records = r3.count ?? 0;

      const r4 = await sql`DELETE FROM eval_runs WHERE agent_name = ${agentHandle}`;
      counts.eval_runs = r4.count ?? 0;

      const r5 = await sql`DELETE FROM eval_results WHERE agent_name = ${agentHandle}`;
      counts.eval_results = r5.count ?? 0;

      const r6 = await sql`DELETE FROM issues WHERE agent_name = ${agentHandle}`;
      counts.issues = r6.count ?? 0;

      const r7 = await sql`DELETE FROM compliance_checks WHERE agent_name = ${agentHandle}`;
      counts.compliance_checks = r7.count ?? 0;

      const r8 = await sql`DELETE FROM schedules WHERE agent_name = ${agentHandle}`;
      counts.schedules = r8.count ?? 0;

      const r9 = await sql`DELETE FROM webhooks WHERE agent_name = ${agentHandle}`;
      counts.webhooks = r9.count ?? 0;

      const r10 = await sql`DELETE FROM agent_versions WHERE agent_id = ${agentId}`;
      counts.agent_versions = r10.count ?? 0;

      await sql`DELETE FROM agents WHERE agent_id = ${agentId}`;
      counts.agent = 1;
    } else {
      // Soft delete
      await sql`
        UPDATE agents SET is_active = false, updated_at = now()
        WHERE agent_id = ${agentId}
      `;
      counts.agent = 1;
    }

    // Audit log (fire-and-forget)
    sql`
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
      VALUES (${user.org_id}, ${user.user_id}, ${"delete" satisfies AuditAction}, 'agent', ${agentHandle}, ${JSON.stringify({
        hard_delete: hardDelete,
      })}::jsonb, now())
    `.catch(() => {});

    const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

    return c.json({
      deleted: agentHandle,
      hard_delete: hardDelete,
      db_cleanup: counts,
      total_records_affected: totalRecords,
    } as any);
    });
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    const agentRow = await resolveAgentRecord(sql, identifier);
    if (!agentRow) return c.json({ error: `Agent '${identifier}' not found` }, 404);
    const agentId = String(agentRow.agent_id || "");

    const rows = await sql`
      SELECT id, agent_handle, display_name, version, config, created_by, created_at
      FROM agent_versions
      WHERE agent_id = ${agentId}
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const agentRow = await resolveAgentRecord(sql, identifier);
  if (!agentRow) return c.json({ error: `Agent '${identifier}' not found` }, 404);

  const rows = await sql`
    SELECT config FROM agents
    WHERE agent_id = ${agentRow.agent_id as string}
    LIMIT 1
  `;

  const config = parseConfig((rows[0] as Record<string, unknown>).config);
  return c.json({ tools: Array.isArray(config.tools) ? config.tools : [] });
  });
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentRow = await resolveAgentRecord(sql, identifier);
    if (!agentRow) return c.json({ error: `Agent '${identifier}' not found` }, 404);

    const rows = await sql`
      SELECT config FROM agents
      WHERE agent_id = ${agentRow.agent_id as string}
      LIMIT 1
    `;

    return c.json(parseConfig((rows[0] as Record<string, unknown>).config) as any);
  });
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
    body: { content: { "application/json": { schema: z.object({
      new_handle: z.string().min(1).max(128).optional(),
      new_display_name: z.string().min(1).max(160).optional(),
      new_name: z.string().min(1).max(128).optional(),
    }) } } },
  },
  responses: {
    201: { description: "Agent cloned", content: { "application/json": { schema: AgentSummary } } },
    ...errorResponses(400, 404),
    409: { description: "Agent already exists", content: { "application/json": { schema: ErrorSchema } } },
  },
});
agentRoutes.openapi(cloneAgentRoute, async (c): Promise<any> => {
  const { name: identifier } = c.req.valid("param");
  const { new_handle: newHandleValue, new_display_name: newDisplayName, new_name: newNameValue } = c.req.valid("json");

  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const sourceRow = await resolveAgentRecord(sql, identifier);
    if (!sourceRow) return c.json({ error: `Agent '${identifier}' not found` }, 404);

    // Fetch source agent
    const rows = await sql`
      SELECT agent_id, handle, display_name, description, config FROM agents
      WHERE agent_id = ${String(sourceRow.agent_id || "")}
      LIMIT 1
    `;
    const cloneIdentity = buildAgentIdentity({
      handle: newHandleValue || newNameValue,
      displayName: newDisplayName,
      fallbackHandle: `${String(sourceRow.handle || "agent")}-copy`,
    });
    const handleConflict = await assertHandleAvailable(sql, cloneIdentity.handle);
    if (handleConflict) {
      return c.json({ error: handleConflict }, 409);
    }

    const config = parseConfig((rows[0] as Record<string, unknown>).config);
    const newAgentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const clonedConfig = decorateAgentConfigIdentity({
      ...config,
      version: "0.1.0",
    }, {
      agentId: newAgentId,
      handle: cloneIdentity.handle,
      displayName: cloneIdentity.displayName,
    });

    const clonePolicy = applyDeployPolicyToConfigJson(clonedConfig);
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
      INSERT INTO agents (agent_id, handle, display_name, name, org_id, project_id, config, description, is_active, created_at, updated_at)
      VALUES (
        ${newAgentId},
        ${cloneIdentity.handle},
        ${cloneIdentity.displayName},
        ${cloneIdentity.handle},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(clonedConfig)},
        ${(clonedConfig.description as string) || ""},
        true,
        now(),
        now()
      )
    `;

    await snapshotVersion(sql, {
      agentId: newAgentId,
      handle: cloneIdentity.handle,
      displayName: cloneIdentity.displayName,
    }, "0.1.0", clonedConfig, user.user_id);

    return c.json({
      agent_id: newAgentId,
      handle: cloneIdentity.handle,
      display_name: cloneIdentity.displayName,
      name: cloneIdentity.handle,
      description: clonedConfig.description ?? "",
      model: clonedConfig.model ?? "",
      tools: Array.isArray(clonedConfig.tools) ? clonedConfig.tools : [],
      tags: Array.isArray(clonedConfig.tags) ? clonedConfig.tags : [],
      version: "0.1.0",
    } as any, 201);
  });
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    const importIdentity = buildAgentIdentity({
      handle: String((config as Record<string, unknown>).handle || config.name || "imported-agent"),
      displayName: String((config as Record<string, unknown>).display_name || ""),
      fallbackHandle: "imported-agent",
    });
    const handleConflict = await assertHandleAvailable(sql, importIdentity.handle);
    if (handleConflict) {
      return c.json({ error: handleConflict }, 409);
    }

    const newAgentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const importCfg = decorateAgentConfigIdentity(config as Record<string, unknown>, {
      agentId: newAgentId,
      handle: importIdentity.handle,
      displayName: importIdentity.displayName,
    });
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
      INSERT INTO agents (agent_id, handle, display_name, name, org_id, project_id, config, description, is_active, created_at, updated_at)
      VALUES (
        ${newAgentId},
        ${importIdentity.handle},
        ${importIdentity.displayName},
        ${importIdentity.handle},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(importCfg)},
        ${String(config.description || "")},
        ${true},
        now(),
        now()
      )
      ON CONFLICT (handle, org_id) DO UPDATE
      SET
        display_name = EXCLUDED.display_name,
        name = EXCLUDED.name,
        config = EXCLUDED.config,
        updated_at = now()
    `;

    await snapshotVersion(sql, {
      agentId: newAgentId,
      handle: importIdentity.handle,
      displayName: importIdentity.displayName,
    }, String(importCfg.version || "0.1.0"), importCfg, user.user_id);

    return c.json({
      agent_id: newAgentId,
      handle: importIdentity.handle,
      display_name: importIdentity.displayName,
      name: importIdentity.handle,
      description: config.description ?? "",
      model: config.model ?? "",
      tools: Array.isArray(config.tools) ? config.tools : [],
      tags: Array.isArray(config.tags) ? config.tags : [],
      version: config.version ?? "0.1.0",
    } as any);
    });
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentRow = await resolveAgentRecord(sql, identifier);
    if (!agentRow) return c.json({ error: `Agent '${identifier}' not found` }, 404);

    const rows = await sql`
      SELECT config FROM agents
      WHERE agent_id = ${agentRow.agent_id as string}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return c.json({ error: `Agent '${identifier}' not found` }, 404);
    }

    return c.json({ agent: parseConfig((rows[0] as Record<string, unknown>).config) } as any);
  });
});

/* ── persistAgentPackage ─────────────────────────────────────────── */
/*
 * After the main agent INSERT, persist all subsidiary resources
 * (sub-agents, skills, codemode, guardrails, release channels).
 * Fire-and-forget with error collection — parent agent is never rolled back.
 */

async function persistAgentPackage(
  sql: OrgSql,
  agentHandle: string,
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
      const subIdentity = buildAgentIdentity({
        handle: String((sa as Record<string, unknown>).handle || (sa as Record<string, unknown>).name || `${agentHandle}-sub`),
        displayName: String((sa as Record<string, unknown>).display_name || ""),
        fallbackHandle: `${agentHandle}-sub`,
      });
      const subConfig = decorateAgentConfigIdentity({
        ...(sa as Record<string, unknown>),
        parent_agent: agentHandle,
        governance: { budget_limit_usd: 10 },
        harness: {},
        hidden: true,
        visibility: "hidden",
      } as Record<string, unknown>, {
        handle: subIdentity.handle,
        displayName: subIdentity.displayName,
      });
      const subPolicy = applyDeployPolicyToConfigJson(subConfig);
      if (!subPolicy.ok) {
        errors.push(`sub-agent ${(sa as Record<string, unknown>).name || subIdentity.handle}: deploy policy: ${subPolicy.errors.join("; ")}`);
        continue;
      }
      const subId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await sql`
        INSERT INTO agents (agent_id, handle, display_name, name, org_id, project_id, config, description, is_active, created_at, updated_at)
        VALUES (${subId}, ${subIdentity.handle}, ${subIdentity.displayName}, ${subIdentity.handle}, ${orgId}, ${projectId}, ${JSON.stringify(decorateAgentConfigIdentity(subConfig, {
          agentId: subId,
          handle: subIdentity.handle,
          displayName: subIdentity.displayName,
        }))},
                ${String((sa as Record<string, unknown>).description || "")}, ${true}, now(), now())
        ON CONFLICT (handle, org_id) DO UPDATE
        SET
          display_name = EXCLUDED.display_name,
          name = EXCLUDED.name,
          config = EXCLUDED.config,
          updated_at = now()
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
        INSERT INTO skills (name, description, category, prompt, prompt_template, agent_name, org_id, is_active, created_at)
        VALUES (${String(s.name)}, ${String(s.description || "")}, ${String(s.category || "general")},
                ${String(s.content || "")}, ${String(s.content || "")}, ${agentHandle}, ${orgId}, true, now())
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
        INSERT INTO codemode_snippets (id, org_id, name, description, code, scope, language, is_template, created_at, updated_at)
        VALUES (${snippetId}, ${orgId}, ${String(s.name)}, ${String(s.description || "")},
                ${String(s.code || "")}, ${String(s.scope || "agent")},
                ${'javascript'}, false, ${now}, ${now})
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
        INSERT INTO guardrail_policies (id, org_id, agent_name, policy_type, config, created_at)
        VALUES (${grId}, ${orgId}, ${agentHandle}, ${String(g.type || '')}, ${policyJson}, ${now})
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
        INSERT INTO release_channels (org_id, agent_name, channel, version, config, promoted_by, promoted_at)
        VALUES (${orgId}, ${agentHandle}, ${channel}, ${"0.1.0"}, ${JSON.stringify(release)}, ${userId}, ${now})
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    // Load org profile for the meta-agent prompt context
    let orgProfile: Record<string, unknown> | undefined;
    try {
      const settingsRows = await sql`
        SELECT settings FROM org_settings WHERE org_id = ${user.org_id} LIMIT 1
      `;
      if (settingsRows.length > 0) {
        orgProfile = parseJsonColumn(settingsRows[0].settings);
      }
    } catch { /* ignore — preferences are optional */ }

    // Generate config via Claude Sonnet 4.6 (plan + org-profile aware)
    let config: Record<string, any>;
    try {
      config = await buildFromDescription(c.env.AI, req.description, {
        name: req.handle || req.name || undefined,
        hyperdrive: c.env.HYPERDRIVE,
        orgId: user.org_id,
        plan: req.plan,
        openrouterApiKey: c.env.OPENROUTER_API_KEY || "",
        cloudflareAccountId: c.env.CLOUDFLARE_ACCOUNT_ID,
        aiGatewayId: c.env.AI_GATEWAY_ID,
        cloudflareApiToken: c.env.CLOUDFLARE_API_TOKEN,
        aiGatewayToken: c.env.AI_GATEWAY_TOKEN,
        gpuServiceKey: c.env.GPU_SERVICE_KEY || c.env.SERVICE_TOKEN || "",
        pipedream: c.env.PIPEDREAM_CLIENT_ID ? {
          clientId: c.env.PIPEDREAM_CLIENT_ID,
          clientSecret: c.env.PIPEDREAM_CLIENT_SECRET ?? "",
          projectId: c.env.PIPEDREAM_PROJECT_ID ?? "",
        } : undefined,
        orgProfile: orgProfile as any,
      });
    } catch (err) {
      return c.json(failSafe(err, "agents/create-from-description", { userMessage: "Couldn't generate the agent from that description. Please try rephrasing or contact support." }), 500);
    }

    const generatedIdentity = buildAgentIdentity({
      handle: req.handle || req.name || String(config.handle || config.name || ""),
      displayName: req.display_name || String(config.display_name || ""),
      fallbackHandle: "generated-agent",
    });
    const handleConflict = await assertHandleAvailable(sql, generatedIdentity.handle);
    if (handleConflict) {
      return c.json({ error: handleConflict }, 409);
    }
    config = decorateAgentConfigIdentity(config, {
      handle: generatedIdentity.handle,
      displayName: generatedIdentity.displayName,
    });

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
    const evalGate = await latestEvalGate(sql, String(config.handle || config.name), {
      minEvalPassRate: req.min_eval_pass_rate,
      minEvalTrials: req.min_eval_trials,
      orgId: user.org_id,
    });

    const gatePack = {
      eval_gate: evalGate,
      rollout: rolloutRecommendation({
        agentName: String(config.handle || config.name),
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
        handle: config.handle,
        display_name: config.display_name,
        name: config.handle,
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
        INSERT INTO config_audit (agent_name, action, details, created_at)
        VALUES (${String(config.handle || config.name)}, 'hold_override', ${JSON.stringify({
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
    const persistedIdentity = buildAgentIdentity({
      handle: String(config.handle || config.name || generatedIdentity.handle),
      displayName: String(config.display_name || generatedIdentity.displayName),
      fallbackHandle: generatedIdentity.handle,
    });
    const persistedConfig = decorateAgentConfigIdentity(cfgRecord, {
      agentId: generatedAgentId,
      handle: persistedIdentity.handle,
      displayName: persistedIdentity.displayName,
    });

    // withOrgDb already opened a transaction; run writes directly.
    await sql`
      INSERT INTO agents (agent_id, handle, display_name, name, org_id, project_id, config, description, is_active, created_at, updated_at)
      VALUES (
        ${generatedAgentId},
        ${persistedIdentity.handle},
        ${persistedIdentity.displayName},
        ${persistedIdentity.handle},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(persistedConfig)},
        ${String(config.description || "")},
        ${true},
        now(),
        now()
      )
      ON CONFLICT (handle, org_id) DO UPDATE
      SET
        display_name = EXCLUDED.display_name,
        name = EXCLUDED.name,
        config = EXCLUDED.config,
        updated_at = now()
    `;

    // Retrieve the actual agent_id (may differ on conflict/update)
    try {
      const idRows = await sql`SELECT agent_id FROM agents WHERE handle = ${persistedIdentity.handle} LIMIT 1`;
      if (idRows.length > 0) agentId = String(idRows[0].agent_id);
    } catch {}

    await snapshotVersion(sql, {
      agentId,
      handle: persistedIdentity.handle,
      displayName: persistedIdentity.displayName,
    }, String(config.version), persistedConfig, user.user_id);

    // Persist the full agent package (sub-agents, skills, codemode, guardrails, releases)
    if (pkg) {
      // Clean _package from config before using it
      delete (config as Record<string, unknown>)._package;
      packageErrors = await persistAgentPackage(
        sql, persistedIdentity.handle, user.org_id, user.project_id || "", user.user_id, pkg,
      );
    }

    // Notify runtime of new agent (fire-and-forget)
    notifyRuntimeOfConfigChange(c.env, persistedIdentity.handle, String(config.version)).catch(() => {});

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
          persistedIdentity.handle,
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
            UPDATE agents SET config = jsonb_set(
              config::jsonb,
              '{eval_config}',
              ${JSON.stringify(evalConfigWithTasks)}::jsonb
            )
            WHERE handle = ${persistedIdentity.handle}
          `.catch(() => {
            // Fallback: re-write the whole config if jsonb_set isn't available
            const updatedConfig = { ...persistedConfig, eval_config: evalConfigWithTasks };
            return sql`
              UPDATE agents SET config = ${JSON.stringify(updatedConfig)}
              WHERE handle = ${persistedIdentity.handle}
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
      handle: persistedIdentity.handle,
      display_name: persistedIdentity.displayName,
      name: persistedIdentity.handle,
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const agentName = await resolveAgentName(sql, identifier, user.org_id);
  if (!agentName) return c.json({ error: "Agent not found" }, 404);

  // Load agent config
  const agentRows = await sql`SELECT config FROM agents WHERE name = ${agentName} LIMIT 1`;
  if (agentRows.length === 0) return c.json({ error: "Agent not found" }, 404);
  const agentConfig = parseJsonColumn(agentRows[0].config);

  // Load eval results (latest run or specific run)
  let evalRows: any[];
  if (req.eval_run_id) {
    evalRows = await sql`SELECT * FROM eval_runs WHERE id = ${req.eval_run_id} LIMIT 1`;
  } else {
    evalRows = await sql`SELECT * FROM eval_runs WHERE agent_name = ${agentName} ORDER BY created_at DESC LIMIT 1`;
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
        UPDATE agents SET config = ${JSON.stringify(agentConfig)}, updated_at = now()
        WHERE name = ${agentName}
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
});

// ── Contextual suggestions ──────────────────────────────────────────

const suggestionsRoute = createRoute({
  method: "get",
  path: "/{name}/suggestions",
  tags: ["Agents"],
  summary: "Get contextual chat suggestions for this agent",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Suggestions", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404),
  },
});

agentRoutes.openapi(suggestionsRoute, async (c): Promise<any> => {
  const { name: identifier } = c.req.valid("param");
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  const agentName = await resolveAgentName(sql, identifier, user.org_id);
  if (!agentName) return c.json({ error: "Agent not found" }, 404);

  // Get agent config
  const [agent] = await sql`SELECT config, description FROM agents WHERE name = ${agentName} LIMIT 1`;
  if (!agent) return c.json({ suggestions: [] });
  const config = parseConfig(agent.config);
  const description = String(agent.description || config.description || "");
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const isPersonal = !!(config as any).is_personal;

  // Get recent session topics (last 5 sessions)
  const recentSessions = await sql`
    SELECT agent_name, status, step_count, created_at FROM sessions
    WHERE agent_name = ${agentName}
    ORDER BY created_at DESC LIMIT 5
  `.catch(() => []);

  // Get recent turn inputs (last 10 user messages).
  // turns is gated by sessions FK; sessions is RLS'd so the JOIN provides isolation.
  const recentInputs = await sql`
    SELECT t.input_text FROM turns t
    JOIN sessions s ON s.session_id = t.session_id
    WHERE s.agent_name = ${agentName} AND t.input_text != ''
    ORDER BY t.created_at DESC LIMIT 10
  `.catch(() => []);

  // Get saved memories for this agent
  const memories = await sql`
    SELECT content FROM facts
    WHERE agent_name = ${agentName} OR agent_name = '' OR agent_name IS NULL
    ORDER BY created_at DESC LIMIT 5
  `.catch(() => []);

  // Build context for LLM
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const sessionCount = recentSessions.length;
  const recentTopics = recentInputs.map((r: any) => String(r.input_text).slice(0, 100)).slice(0, 5);
  const memorySnippets = memories.map((m: any) => String(m.content).slice(0, 80)).slice(0, 3);

  try {
    const { callLLMGateway } = await import("../lib/llm-gateway");
    const result = await callLLMGateway(
      {
        cloudflareAccountId: c.env.CLOUDFLARE_ACCOUNT_ID,
        aiGatewayId: c.env.AI_GATEWAY_ID,
        aiGatewayToken: c.env.AI_GATEWAY_TOKEN,
        cloudflareApiToken: c.env.CLOUDFLARE_API_TOKEN,
        gpuServiceKey: c.env.GPU_SERVICE_KEY || c.env.SERVICE_TOKEN || "",
      },
      {
        model: "anthropic/claude-sonnet-4-6",
        max_tokens: 300,
        temperature: 0.8,
        messages: [{
          role: "user",
          content: `Generate 4 contextual chat suggestions for an AI agent. Return a JSON array of 4 objects with "icon" (one of: search, code, terminal, file, sparkle, lightbulb, pencil, globe, calendar, chart) and "text" (the suggestion, 4-10 words, actionable).

Agent: "${agentName}"
Description: "${description.slice(0, 200)}"
Tools: ${tools.slice(0, 10).join(", ")}
Is personal assistant: ${isPersonal}
Time of day: ${timeOfDay}
Recent sessions: ${sessionCount}
${recentTopics.length ? `Recent topics: ${recentTopics.join("; ")}` : "No recent activity"}
${memorySnippets.length ? `User context: ${memorySnippets.join("; ")}` : ""}

Rules:
- Make suggestions specific to this agent's purpose and tools, not generic
- If there's recent activity, suggest follow-ups or continuations
- For personal assistants: vary by time of day (morning briefing, afternoon tasks, evening review)
- For business agents: focus on the agent's domain
- Never repeat the same suggestion twice — be creative
- Return ONLY the JSON array, no explanation`,
        }],
      },
    );

    const text = result.content || "[]";
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return c.json({ suggestions: parsed.slice(0, 4) });
    }
  } catch (err: any) {
    console.warn(`[suggestions] LLM failed for ${agentName}: ${err.message}`);
  }

  // Fallback: tool-based static suggestions
  return c.json({ suggestions: [] });
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
            model_path: z.enum(["auto", "gemma", "sonnet"]).optional(),
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
            cost_usd: z.number().optional(),
            turns: z.number().optional(),
            model: z.string().optional(),
            model_path: z.enum(["auto", "gemma", "sonnet"]).optional(),
          }),
        },
      },
    },
    ...errorResponses(400, 404, 500),
  },
});
agentRoutes.openapi(metaChatRoute, async (c): Promise<any> => {
  const { name: identifier } = c.req.valid("param");
  const { messages, mode, model_path } = c.req.valid("json");
  const user = c.get("user");

  // Rate limit + agent lookup inside org-scoped tx; the meta-agent run
  // below opens its own DB connection through the runtime, so we close
  // ours after the lookup.
  type LookupResult =
    | { error: Response; agentName?: undefined }
    | { error?: undefined; agentName: string };
  const lookup = await withOrgDb(c.env, user.org_id, async (sql): Promise<LookupResult> => {
    try {
      const [recent] = await sql`
        SELECT count(*)::int as c FROM sessions
        WHERE agent_name LIKE 'meta:%'
          AND created_at > NOW() - INTERVAL '1 hour'
      `;
      if (Number(recent.c) >= 10) {
        return { error: c.json({
          error: "Meta-agent rate limit: max 10 calls per hour. The meta-agent uses Claude Sonnet 4.6 which costs significantly more than regular agent calls. Try again later.",
        }, 429) };
      }
    } catch {} // fail open on rate limit check

    // Check credit balance — don't run meta-agent if credits are exhausted
    try {
      const [bal] = await sql`SELECT balance_usd FROM org_credit_balance LIMIT 1`;
      if (bal && Number(bal.balance_usd) <= 0) {
        return { error: c.json({ error: "Insufficient credits. The meta-agent uses Claude Sonnet 4.6 which requires credits. Add credits in Settings > Billing." }, 402) };
      }
    } catch {}

    // Resolve agent identifier (supports both agent_id and name)
    const agentName = await resolveAgentName(sql, identifier, user.org_id);
    if (!agentName) {
      return { error: c.json({ error: `Agent '${identifier}' not found` }, 404) };
    }
    return { agentName };
  });

  if (lookup.error) return lookup.error;
  const agentName = lookup.agentName;

  try {
    const result = await runMetaChat(messages as MetaChatMessage[], {
      agentName,
      orgId: user.org_id,
      userId: user.user_id,
      userRole: user.role,
      hyperdrive: c.env.HYPERDRIVE,
      openrouterApiKey: c.env.OPENROUTER_API_KEY || "",
      cloudflareAccountId: c.env.CLOUDFLARE_ACCOUNT_ID,
      aiGatewayId: c.env.AI_GATEWAY_ID,
      cloudflareApiToken: c.env.CLOUDFLARE_API_TOKEN,
      aiGatewayToken: c.env.AI_GATEWAY_TOKEN,
      gpuServiceKey: c.env.GPU_SERVICE_KEY || c.env.SERVICE_TOKEN || "",
      modelPath: model_path || "auto",
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
      model: result.model,
      model_path: result.model_path || model_path || "auto",
    });
  } catch (err) {
    return c.json(failSafe(err, "agents/meta-chat", { userMessage: "The agent-builder chat is temporarily unavailable. Please try again in a moment." }), 500);
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    const agentRow = await resolveAgentRecord(sql, identifier);
    if (!agentRow) return c.json({ error: `Agent '${identifier}' not found` }, 404);
    const agentId = String(agentRow.agent_id || "");
    const agentHandle = String(agentRow.handle || agentRow.name || "");
    const agentDisplayName = String(agentRow.display_name || agentHandle);

    const rows = await sql`
      SELECT config, version FROM agent_versions
      WHERE id = ${commitId} AND agent_id = ${agentId}
      LIMIT 1
    `;
    if (rows.length === 0) return c.json({ error: "Version not found" }, 404);

    let configJson: string;
    try {
      const restoredCfg = parseJsonColumn<Record<string, unknown>>(rows[0].config);
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
      return c.json({ error: "Invalid config on version snapshot" }, 400);
    }

    // Snapshot current config before overwriting (for undo)
    const current = await sql`
      SELECT config FROM agents WHERE agent_id = ${agentId} LIMIT 1
    `;
    if (current.length > 0) {
      await snapshotVersion(sql, {
        agentId,
        handle: agentHandle,
        displayName: agentDisplayName,
      }, `pre-restore-${Date.now()}`,
        parseJsonColumn(current[0].config), user.user_id);
    }

    await sql`
      UPDATE agents
      SET config = ${JSON.stringify(decorateAgentConfigIdentity(JSON.parse(configJson) as Record<string, unknown>, {
        agentId,
        handle: agentHandle,
        displayName: agentDisplayName,
      }))}, updated_at = now()
      WHERE agent_id = ${agentId}
    `;
    await snapshotVersion(
      sql,
      {
        agentId,
        handle: agentHandle,
        displayName: agentDisplayName,
      },
      String(rows[0].version || "restored"),
      decorateAgentConfigIdentity(JSON.parse(configJson) as Record<string, unknown>, {
        agentId,
        handle: agentHandle,
        displayName: agentDisplayName,
      }),
      user.user_id,
    );

    return c.json({ restored: true, version: rows[0].version } as any);
    });
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {

    const agentName = await resolveAgentName(sql, identifier, user.org_id) || identifier;

    const rows = await sql`
      SELECT agent_id, name, config, updated_at, created_by
      FROM agents
      WHERE name LIKE ${agentName + '-deleted-%'} AND is_active = false
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
    return await withOrgDb(c.env, user.org_id, async (sql) => {
      const agentName = await resolveAgentName(sql, identifier, user.org_id) || identifier;

      await sql`
        UPDATE agents SET is_active = true, name = ${agentName}, updated_at = now()
        WHERE agent_id = ${trashId} AND is_active = false
      `;

      return c.json({ restored: true } as any);
    });
});
