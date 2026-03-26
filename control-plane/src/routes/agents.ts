/**
 * Agents router — CRUD, versions, clone, import/export, create-from-description.
 * Ported from agentos/api/routers/agents.py.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { requireScope } from "../middleware/auth";
import { getDbForOrg } from "../db/client";
import { lintGraphDesign, lintPayloadFromResult, summarizeGraphContracts } from "../logic/graph-lint";
import { lintAndAutofixGraph } from "../logic/graph-autofix";
import { latestEvalGate, rolloutRecommendation, lintSuggestionsFromErrors } from "../logic/gate-pack";
import { defaultNoCodeGraph, buildFromDescription, recommendTools } from "../logic/meta-agent";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const agentRoutes = new Hono<R>();

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

// ── Zod schemas ──────────────────────────────────────────────────────

const AgentCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  system_prompt: z.string().max(50000).default("You are a helpful AI assistant."),
  model: z.string().max(128).default(""),
  tools: z.array(z.string()).default([]),
  max_turns: z.number().int().min(1).max(1000).default(50),
  budget_limit_usd: z.number().min(0).max(10000).default(10),
  tags: z.array(z.string()).default([]),
  graph: z.record(z.unknown()).nullable().optional().default(null),
  strict_graph_lint: z.boolean().default(true),
  auto_graph: z.boolean().default(false),
});

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
agentRoutes.get("/", async (c) => {
  const user = c.get("user");
  const proxied = await listAgentsViaDataProxy(c.env, user);
  if (proxied) {
    return c.json(proxied.map((r) => agentResponse(r as Record<string, unknown>)));
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT name, description, config_json, is_active, created_at, updated_at
    FROM agents
    WHERE org_id = ${user.org_id} AND is_active = true
    ORDER BY created_at DESC
  `;

  return c.json(rows.map((r) => agentResponse(r as Record<string, unknown>)));
});

// GET /agents/:name — get single agent
agentRoutes.get("/:name", async (c) => {
  const { name } = c.req.param();
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

  return c.json(agentResponse(rows[0] as Record<string, unknown>));
});

// POST /agents — create agent
agentRoutes.post(
  "/",
  requireScope("agents:write"),
  async (c) => {
    const body = await c.req.json();
    const parsed = AgentCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const req = parsed.data;
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
      model: req.model || "anthropic/claude-sonnet-4.6",
      tools: req.tools,
      max_turns: req.max_turns,
      tags: req.tags,
      version: "0.1.0",
      governance: { budget_limit_usd: req.budget_limit_usd },
      harness: {},
    };

    // Attach graph if provided
    if (req.graph && typeof req.graph === "object") {
      (configJson.harness as Record<string, unknown>).declarative_graph = req.graph;
    }

    // Ensure / auto-generate graph
    const graph = ensureDeclarativeGraph(configJson, req.auto_graph);

    // Lint graph
    try {
      lintGraphOrThrow(graph, { strict: req.strict_graph_lint, source: "agents.create" });
    } catch (err: unknown) {
      const e = err as { status: number; body: unknown };
      return c.json(e.body, 422);
    }

    // Insert into DB
    await sql`
      INSERT INTO agents (name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
      VALUES (
        ${req.name},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(configJson)},
        ${req.description},
        true,
        now(),
        now()
      )
    `;

    // Snapshot version
    await snapshotVersion(sql, req.name, "0.1.0", configJson, user.user_id);

    return c.json({
      name: req.name,
      description: req.description,
      model: configJson.model,
      tools: req.tools,
      tags: req.tags,
      version: "0.1.0",
    }, 201);
  },
);

// PUT /agents/:name — update agent
agentRoutes.put(
  "/:name",
  requireScope("agents:write"),
  async (c) => {
    const { name } = c.req.param();
    const body = await c.req.json();
    const parsed = AgentCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const req = parsed.data;
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
    if (req.model) existingConfig.model = req.model;
    if (req.tools.length > 0) existingConfig.tools = req.tools;
    if (req.tags.length > 0) existingConfig.tags = req.tags;
    existingConfig.max_turns = req.max_turns;

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

    const graph = ensureDeclarativeGraph(existingConfig, req.auto_graph);

    try {
      lintGraphOrThrow(graph, { strict: req.strict_graph_lint, source: "agents.update" });
    } catch (err: unknown) {
      const e = err as { status: number; body: unknown };
      return c.json(e.body, 422);
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
    });
  },
);

// DELETE /agents/:name — delete agent with cascading cleanup
agentRoutes.delete(
  "/:name",
  requireScope("agents:write"),
  async (c) => {
    const { name } = c.req.param();
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
        UPDATE agents SET is_active = false, updated_at = now()
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
    });
  },
);

// GET /agents/:name/versions — list versions
agentRoutes.get("/:name/versions", async (c) => {
  const { name } = c.req.param();
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let versions: Record<string, unknown>[] = [];
  try {
    const rows = await sql`
      SELECT av.version_number, av.config_json, av.created_by, av.created_at
      FROM agent_versions av
      JOIN agents a ON a.name = av.agent_name AND a.org_id = ${user.org_id}
      WHERE av.agent_name = ${name}
      ORDER BY av.created_at DESC
    `;
    versions = rows as Record<string, unknown>[];
  } catch {
    // Table may not exist
  }

  // Get current version from agent config
  let current = "0.1.0";
  try {
    const agentRows = await sql`
      SELECT config_json FROM agents WHERE name = ${name} AND org_id = ${user.org_id} LIMIT 1
    `;
    if (agentRows.length > 0) {
      const config = parseConfig((agentRows[0] as Record<string, unknown>).config_json);
      current = String(config.version ?? "0.1.0");
    }
  } catch {
    // non-critical
  }

  return c.json({ versions, current });
});

// GET /agents/:name/tools — list tools for agent
agentRoutes.get("/:name/tools", async (c) => {
  const { name } = c.req.param();
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
agentRoutes.get("/:name/config", async (c) => {
  const { name } = c.req.param();
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

  return c.json(parseConfig((rows[0] as Record<string, unknown>).config_json));
});

// POST /agents/:name/clone — clone agent with new name
agentRoutes.post("/:name/clone", requireScope("agents:write"), async (c) => {
  const { name } = c.req.param();
  const body = await c.req.json();
  const newName = z.string().min(1).max(128).safeParse(body.new_name);
  if (!newName.success) {
    return c.json({ error: "new_name is required (1-128 chars)" }, 400);
  }

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
    SELECT name FROM agents WHERE name = ${newName.data} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (existCheck.length > 0) {
    return c.json({ error: `Agent '${newName.data}' already exists` }, 409);
  }

  const config = parseConfig((rows[0] as Record<string, unknown>).config_json);
  config.name = newName.data;
  config.version = "0.1.0";

  await sql`
    INSERT INTO agents (name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
    VALUES (
      ${newName.data},
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
    name: newName.data,
    description: config.description ?? "",
    model: config.model ?? "",
    tools: Array.isArray(config.tools) ? config.tools : [],
    tags: Array.isArray(config.tags) ? config.tags : [],
    version: "0.1.0",
  }, 201);
});

// POST /agents/import — import agent from JSON config
agentRoutes.post(
  "/import",
  requireScope("agents:write"),
  async (c) => {
    const body = await c.req.json();
    const parsed = ImportAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const config = parsed.data.config;
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

    await sql`
      INSERT INTO agents (name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
      VALUES (
        ${agentName},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(config)},
        ${String(config.description || "")},
        true,
        now(),
        now()
      )
      ON CONFLICT (name, org_id) DO UPDATE
      SET config_json = ${JSON.stringify(config)}, updated_at = now()
    `;

    return c.json({
      name: agentName,
      description: config.description ?? "",
      model: config.model ?? "",
      tools: Array.isArray(config.tools) ? config.tools : [],
      tags: Array.isArray(config.tags) ? config.tags : [],
      version: config.version ?? "0.1.0",
    });
  },
);

// GET /agents/:name/export — export agent config
agentRoutes.get("/:name/export", async (c) => {
  const { name } = c.req.param();
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

  return c.json({ agent: parseConfig((rows[0] as Record<string, unknown>).config_json) });
});

// POST /agents/create-from-description — LLM-powered agent creation
agentRoutes.post(
  "/create-from-description",
  requireScope("agents:write"),
  async (c) => {
    const body = await c.req.json();
    const parsed = CreateFromDescriptionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const req = parsed.data;
    const user = c.get("user");
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    // Generate config via Workers AI
    const config = await buildFromDescription(c.env.AI, req.description, {
      name: req.name || undefined,
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

    // Initialize harness + governance
    config.governance = { budget_limit_usd: 10 };
    if (typeof config.harness !== "object" || config.harness === null) {
      config.harness = {};
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

      if (!lintValid && !req.draft_only) {
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
      const payload: Record<string, unknown> = {
        created: false,
        name: config.name,
        description: config.description,
        model: config.model,
        tools: config.tools,
        tags: config.tags,
        version: config.version,
        draft: config,
        graph_lint: lintReport,
      };
      if (req.include_autofix) payload.graph_autofix = graphAutofix;
      if (req.include_gate_pack) payload.gate_pack = gatePack;
      if (req.include_contracts_validate) payload.contracts_validate = contractsValidate;
      return c.json(payload);
    }

    // Gate-pack hold enforcement
    if (rolloutDecision === "hold" && !req.override_hold) {
      return c.json(
        {
          message: "Gate-pack rollout decision is HOLD. Explicit override required to create.",
          override_required: true,
          gate_pack: gatePack,
        },
        409,
      );
    }

    if (rolloutDecision === "hold" && req.override_hold && !req.override_reason.trim()) {
      return c.json({ error: "override_reason is required when overriding a hold decision" }, 422);
    }

    if (rolloutDecision === "hold" && req.override_hold) {
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

    // Save agent
    await sql`
      INSERT INTO agents (name, org_id, project_id, config_json, description, is_active, created_at, updated_at)
      VALUES (
        ${String(config.name)},
        ${user.org_id},
        ${user.project_id || ""},
        ${JSON.stringify(config)},
        ${String(config.description || "")},
        true,
        now(),
        now()
      )
      ON CONFLICT (name, org_id) DO UPDATE
      SET config_json = ${JSON.stringify(config)}, updated_at = now()
    `;

    await snapshotVersion(sql, String(config.name), String(config.version), config, user.user_id);

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
    if (req.include_autofix) payload.graph_autofix = graphAutofix;
    if (req.include_gate_pack) payload.gate_pack = gatePack;
    if (req.include_contracts_validate) payload.contracts_validate = contractsValidate;
    payload.hold_override_applied = holdOverrideApplied;

    return c.json(payload, 201);
  },
);

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
