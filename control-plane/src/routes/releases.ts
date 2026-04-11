/**
 * Releases router — channels, canary splits, promotions.
 * Ported from agentos/api/routers/releases.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { latestEvalGate, rolloutRecommendation } from "../logic/gate-pack";
import { getThresholds } from "../logic/policies";
import { applyDeployPolicyToConfigJson } from "../logic/deploy-policy-contract";
import { parseJsonColumn } from "../lib/parse-json-column";

export const releaseRoutes = createOpenAPIRouter();

// ── GET /releases/:agent_name/channels ──────────────────────────────────

const listChannelsRoute = createRoute({
  method: "get",
  path: "/{agent_name}/channels",
  tags: ["Releases"],
  summary: "List release channels for an agent",
  middleware: [requireScope("releases:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Release channels",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
releaseRoutes.openapi(listChannelsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM release_channels WHERE agent_name = ${agentName} ORDER BY channel
    `;
    return c.json({ channels: rows });
  });
});

// ── POST /releases/:agent_name/promote ──────────────────────────────────

const promoteRoute = createRoute({
  method: "post",
  path: "/{agent_name}/promote",
  tags: ["Releases"],
  summary: "Promote an agent between release channels",
  middleware: [requireScope("releases:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            from_channel: z.string().optional(),
            to_channel: z.string().optional(),
            override: z.boolean().optional(),
            approved_by: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Promotion result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 403, 404),
  },
});
releaseRoutes.openapi(promoteRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const body = c.req.valid("json");
  const fromChannel = String(body.from_channel || "draft");
  const toChannel = String(body.to_channel || "staging");

  const override = body.override === true;
  const approvedBy = typeof body.approved_by === "string" ? body.approved_by : undefined;

  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // Get source channel config
  const source = await sql`
    SELECT * FROM release_channels
    WHERE agent_name = ${agentName} AND channel = ${fromChannel}
  `;

  let configJson: string;
  let version: string;

  if (source.length === 0) {
    // Try getting from agents table
    const agents = await sql`
      SELECT config, version FROM agents WHERE name = ${agentName}
    `;
    if (agents.length === 0) return c.json({ error: `Agent '${agentName}' not found` }, 404);
    configJson = agents[0].config || "{}";
    version = agents[0].version || "0.1.0";
  } else {
    configJson = source[0].config || "{}";
    version = source[0].version || "0.1.0";
  }

  let parsedPromoteConfig: Record<string, unknown>;
  try {
    parsedPromoteConfig = JSON.parse(String(configJson || "{}")) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid config on promotion source" }, 400);
  }
  const promotePolicy = applyDeployPolicyToConfigJson(parsedPromoteConfig);
  if (!promotePolicy.ok) {
    return c.json(
      {
        error: "Deploy policy validation failed",
        details: promotePolicy.errors,
        warnings: promotePolicy.warnings,
      },
      400,
    );
  }
  configJson = JSON.stringify(parsedPromoteConfig);

  // ── Eval enforcement for production promotion ──
  if (toChannel === "production") {
    const thresholds = await getThresholds(c.env, user.org_id, agentName);
    const evalGate = await latestEvalGate(sql, agentName, {
      minEvalPassRate: thresholds.eval_pass_rate,
      minEvalTrials: thresholds.eval_min_trials,
      orgId: user.org_id,
    });
    const recommendation = rolloutRecommendation({
      agentName,
      evalGate,
      targetChannel: toChannel,
    });

    if (recommendation.decision === "hold") {
      if (!override) {
        return c.json(
          {
            error: "Production promotion blocked by release gate",
            reason: recommendation.reason,
            recommended_action: recommendation.recommended_action,
            hint: "Pass { override: true } to force promotion in emergencies.",
          },
          400,
        );
      }

      // Check if org requires approval for overrides (not just audit)
      try {
        const policyRows = await sql`
          SELECT config FROM agent_policies
          WHERE policy_type = 'thresholds'
            AND (agent_name = ${agentName} OR agent_name IS NULL)
          ORDER BY agent_name DESC NULLS LAST LIMIT 1
        `;
        if (policyRows.length > 0) {
          const policy = parseJsonColumn(policyRows[0].config);
          if (policy.override_requires_approval) {
            if (!approvedBy || approvedBy === user.user_id) {
              return c.json({
                error: "Override requires approval from a different team member",
                hint: "Pass { override: true, approved_by: '<other_user_id>' } with a different user's approval.",
              }, 403);
            }
            // Verify approved_by is a real member of this org
            const memberCheck = await sql`
              SELECT 1 FROM org_members
              WHERE org_id = ${user.org_id} AND user_id = ${approvedBy}
              LIMIT 1
            `;
            if (memberCheck.length === 0) {
              return c.json({
                error: `User '${approvedBy}' is not a member of this organization`,
              }, 403);
            }
          }
        }
      } catch { /* policy check failed — allow override with audit */ }

      // Log override usage in audit
      const now = Date.now() / 1000;
      try {
        await sql`
          INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
          VALUES (${user.org_id}, ${user.user_id}, 'agent.promote_override', 'agent', ${agentName},
                  ${JSON.stringify({
                    from: fromChannel,
                    to: toChannel,
                    gate_reason: recommendation.reason,
                    override: true,
                    approved_by: approvedBy ?? null,
                  })}, ${now})
        `;
      } catch {}
    }
  }

  const now = new Date().toISOString();
  // Org-scoped upsert only: never use ON CONFLICT(agent_name, channel) when the unique
  // index may omit org_id (would cross-tenant overwrite). Update this org's row, then insert if missing.
  // RLS scopes the update to the current org automatically.
  const updated = await sql`
    UPDATE release_channels
    SET
      version = ${version},
      config = ${configJson},
      promoted_by = ${user.user_id},
      promoted_at = ${now}
    WHERE agent_name = ${agentName} AND channel = ${toChannel}
  `;
  const touched = Number((updated as { count?: number }).count ?? 0);
  if (touched === 0) {
    await sql`
      INSERT INTO release_channels (org_id, agent_name, channel, version, config, promoted_by, promoted_at)
      VALUES (${user.org_id}, ${agentName}, ${toChannel}, ${version}, ${configJson}, ${user.user_id}, ${now})
    `;
  }

  // Audit
  try {
    await sql`
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'agent.promoted', 'agent', ${agentName},
              ${JSON.stringify({ from: fromChannel, to: toChannel, version })}, ${now})
    `;
  } catch {}

  return c.json({ promoted: agentName, from: fromChannel, to: toChannel, version });
  });
});

// ── GET /releases/:agent_name/canary ────────────────────────────────────

const getCanaryRoute = createRoute({
  method: "get",
  path: "/{agent_name}/canary",
  tags: ["Releases"],
  summary: "Get active canary split for an agent",
  middleware: [requireScope("releases:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Canary split",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
releaseRoutes.openapi(getCanaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM canary_splits
      WHERE agent_name = ${agentName} AND is_active = true
    `;
    if (rows.length === 0) return c.json({ canary: null });
    return c.json({ canary: rows[0] });
  });
});

// ── POST /releases/:agent_name/canary ───────────────────────────────────

const createCanaryRoute = createRoute({
  method: "post",
  path: "/{agent_name}/canary",
  tags: ["Releases"],
  summary: "Create a canary split for an agent",
  middleware: [requireScope("releases:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            primary_version: z.string().optional(),
            canary_version: z.string().optional(),
            canary_weight: z.number().min(0).max(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Canary split created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
releaseRoutes.openapi(createCanaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const body = c.req.valid("json");
  const primaryVersion = String(body.primary_version || "");
  const canaryVersion = String(body.canary_version || "");
  const canaryWeight = Number(body.canary_weight ?? 0.1);

  if (canaryWeight < 0 || canaryWeight > 1) {
    return c.json({ error: "canary_weight must be 0.0-1.0" }, 400);
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      UPDATE canary_splits
      SET is_active = false
      WHERE agent_name = ${agentName}
    `;
    await sql`
      INSERT INTO canary_splits (org_id, agent_name, primary_version, canary_version, canary_weight, is_active)
      VALUES (${user.org_id}, ${agentName}, ${primaryVersion}, ${canaryVersion}, ${canaryWeight}, true)
    `;

    return c.json({
      agent: agentName,
      primary: primaryVersion,
      canary: canaryVersion,
      weight: canaryWeight,
    });
  });
});

// ── DELETE /releases/:agent_name/canary ─────────────────────────────────

const deleteCanaryRoute = createRoute({
  method: "delete",
  path: "/{agent_name}/canary",
  tags: ["Releases"],
  summary: "Remove canary split for an agent",
  middleware: [requireScope("releases:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Canary removed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
releaseRoutes.openapi(deleteCanaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      UPDATE canary_splits
      SET is_active = false
      WHERE agent_name = ${agentName}
    `;
    return c.json({ removed: true });
  });
});

// ── POST /releases/:agent_name/canary/validate ──────────────────────────

const validateCanaryRoute = createRoute({
  method: "post",
  path: "/{agent_name}/canary/validate",
  tags: ["Releases"],
  summary: "Auto-validate canary split metrics",
  middleware: [requireScope("releases:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Canary validation result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
releaseRoutes.openapi(validateCanaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // Get active canary split
  const splits = await sql`
    SELECT * FROM canary_splits
    WHERE agent_name = ${agentName} AND is_active = true
    LIMIT 1
  `;
  if (splits.length === 0) {
    return c.json({ error: "No active canary split found" }, 404);
  }
  const split = splits[0];
  const primaryVersion = String(split.primary_version);
  const canaryVersion = String(split.canary_version);

  const since = Date.now() / 1000 - 24 * 3600; // last 24 hours

  // Query session metrics for primary version
  const primaryRows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'success')::int AS successes,
      COALESCE(AVG(cost_total_usd), 0) AS avg_cost,
      COALESCE(AVG(wall_clock_seconds), 0) AS avg_latency
    FROM sessions
    WHERE agent_name = ${agentName}
      AND version = ${primaryVersion} AND created_at > ${since}
  `;

  // Query session metrics for canary version
  const canaryRows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'success')::int AS successes,
      COALESCE(AVG(cost_total_usd), 0) AS avg_cost,
      COALESCE(AVG(wall_clock_seconds), 0) AS avg_latency
    FROM sessions
    WHERE agent_name = ${agentName}
      AND version = ${canaryVersion} AND created_at > ${since}
  `;

  const primary = primaryRows[0];
  const canary = canaryRows[0];

  const primaryTotal = Number(primary.total || 0);
  const canaryTotal = Number(canary.total || 0);

  const primarySuccessRate = primaryTotal > 0 ? Number(primary.successes) / primaryTotal : 1;
  const canarySuccessRate = canaryTotal > 0 ? Number(canary.successes) / canaryTotal : 0;

  const primaryErrorRate = 1 - primarySuccessRate;
  const canaryErrorRate = 1 - canarySuccessRate;

  const metrics = {
    primary: {
      version: primaryVersion,
      total_sessions: primaryTotal,
      success_rate: primarySuccessRate,
      error_rate: primaryErrorRate,
      avg_cost: Number(primary.avg_cost),
      avg_latency: Number(primary.avg_latency),
    },
    canary: {
      version: canaryVersion,
      total_sessions: canaryTotal,
      success_rate: canarySuccessRate,
      error_rate: canaryErrorRate,
      avg_cost: Number(canary.avg_cost),
      avg_latency: Number(canary.avg_latency),
    },
  };

  // Decision: rollback if canary error rate exceeds primary by more than 5pp
  if (canaryErrorRate > primaryErrorRate + 0.05) {
    return c.json({
      action: "rollback",
      reason: `Canary error rate (${(canaryErrorRate * 100).toFixed(1)}%) exceeds primary (${(primaryErrorRate * 100).toFixed(1)}%) by more than 5 percentage points`,
      metrics,
    });
  }

  return c.json({
    action: "promote",
    reason: `Canary error rate (${(canaryErrorRate * 100).toFixed(1)}%) is within tolerance of primary (${(primaryErrorRate * 100).toFixed(1)}%)`,
    metrics,
  });
  });
});

// ── POST /releases/:agent_name/canary/rollback ──────────────────────────

const rollbackCanaryRoute = createRoute({
  method: "post",
  path: "/{agent_name}/canary/rollback",
  tags: ["Releases"],
  summary: "Auto-rollback canary split",
  middleware: [requireScope("releases:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            reason: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Canary rolled back",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
releaseRoutes.openapi(rollbackCanaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const body = c.req.valid("json");
  const reason = String(body.reason || "canary auto-rollback");

  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // Get active canary split before deactivating
  const splits = await sql`
    SELECT * FROM canary_splits
    WHERE agent_name = ${agentName} AND is_active = true
    LIMIT 1
  `;
  if (splits.length === 0) {
    return c.json({ error: "No active canary split to roll back" }, 404);
  }
  const split = splits[0];
  const primaryVersion = String(split.primary_version);

  // Deactivate canary split
  await sql`
    UPDATE canary_splits
    SET is_active = false
    WHERE agent_name = ${agentName}
  `;

  // Revert production channel to primary_version config
  const primaryConfig = await sql`
    SELECT config FROM release_channels
    WHERE agent_name = ${agentName} AND channel = 'production'
    LIMIT 1
  `;
  const configJson = primaryConfig.length > 0 ? primaryConfig[0].config : "{}";

  const now = Date.now() / 1000;
  // Ensure production channel reflects the primary version
  const updated = await sql`
    UPDATE release_channels
    SET version = ${primaryVersion}, promoted_at = ${now}
    WHERE agent_name = ${agentName} AND channel = 'production'
  `;
  const touched = Number((updated as { count?: number }).count ?? 0);
  if (touched === 0) {
    await sql`
      INSERT INTO release_channels (org_id, agent_name, channel, version, config, promoted_at)
      VALUES (${user.org_id}, ${agentName}, 'production', ${primaryVersion}, ${configJson}, ${now})
    `;
  }

  // Record rollback in evolution_ledger
  await sql`
    INSERT INTO evolution_ledger (
      agent_name, org_id, proposal_id, action, note, created_at
    ) VALUES (
      ${agentName}, ${user.org_id}, NULL, 'canary_rollback',
      ${reason}, ${now}
    )
  `;

  // Audit log
  try {
    await sql`
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'agent.canary_rollback', 'agent', ${agentName},
              ${JSON.stringify({
                primary_version: primaryVersion,
                canary_version: String(split.canary_version),
                reason,
              })}, ${now})
    `;
  } catch {}

  return c.json({
    rolled_back: true,
    agent: agentName,
    reverted_to: primaryVersion,
    reason,
  });
  });
});

// ── Canary Auto-Promote ─────────────────────────────────────

releaseRoutes.post("/:agent_name/auto-promote", requireScope("releases:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // 1. Read the canary_splits for the agent
  const splits = await sql`
    SELECT * FROM canary_splits
    WHERE agent_name = ${agentName} AND is_active = true
    LIMIT 1
  `;
  if (splits.length === 0) {
    return c.json({ error: "No active canary split found" }, 404);
  }
  const split = splits[0];
  const primaryVersion = String(split.primary_version);
  const canaryVersion = String(split.canary_version);
  const canaryWeight = Number(split.canary_weight || 0);

  if (canaryWeight <= 0) {
    return c.json({ error: "Canary weight is already 0; no canary traffic to evaluate" }, 400);
  }

  // 2. Compare metrics between primary and canary versions (last 24h)
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const primaryRows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'success')::int AS successes,
      COALESCE(AVG(cost_total_usd), 0) AS avg_cost,
      COALESCE(AVG(wall_clock_seconds), 0) AS avg_latency
    FROM sessions
    WHERE agent_name = ${agentName}
      AND version = ${primaryVersion} AND created_at > ${since}
  `;
  const canaryRows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'success')::int AS successes,
      COALESCE(AVG(cost_total_usd), 0) AS avg_cost,
      COALESCE(AVG(wall_clock_seconds), 0) AS avg_latency
    FROM sessions
    WHERE agent_name = ${agentName}
      AND version = ${canaryVersion} AND created_at > ${since}
  `;

  const primary = primaryRows[0];
  const canary = canaryRows[0];
  const primaryTotal = Number(primary.total || 0);
  const canaryTotal = Number(canary.total || 0);

  const primarySuccessRate = primaryTotal > 0 ? Number(primary.successes) / primaryTotal : 1;
  const canarySuccessRate = canaryTotal > 0 ? Number(canary.successes) / canaryTotal : 0;

  const metrics = {
    primary: {
      version: primaryVersion,
      total_sessions: primaryTotal,
      success_rate: primarySuccessRate,
      avg_cost: Number(primary.avg_cost),
      avg_latency: Number(primary.avg_latency),
    },
    canary: {
      version: canaryVersion,
      total_sessions: canaryTotal,
      success_rate: canarySuccessRate,
      avg_cost: Number(canary.avg_cost),
      avg_latency: Number(canary.avg_latency),
    },
  };

  // 3. Check SLO targets if defined
  const sloTargets = await sql`
    SELECT metric, target FROM slo_definitions
    WHERE agent_name = ${agentName}
  `.catch(() => []);

  let canaryMeetsSlos = true;
  const sloResults: Array<{ metric: string; target: number; actual: number; pass: boolean }> = [];

  for (const slo of sloTargets) {
    const metric = String(slo.metric);
    const target = Number(slo.target);
    let actual: number | null = null;

    if (metric === "success_rate") {
      actual = canarySuccessRate;
    } else if (metric === "error_rate") {
      actual = 1 - canarySuccessRate;
    } else if (metric === "avg_latency") {
      actual = Number(canary.avg_latency);
    } else if (metric === "avg_cost") {
      actual = Number(canary.avg_cost);
    }

    if (actual !== null) {
      const higherIsBetter = ["success_rate", "eval_pass_rate"].includes(metric);
      const pass = higherIsBetter ? actual >= target : actual <= target;
      sloResults.push({ metric, target, actual, pass });
      if (!pass) canaryMeetsSlos = false;
    }
  }

  // If no SLO definitions, fall back to simple comparison: canary must not be worse than primary by >5pp
  if (sloTargets.length === 0) {
    const canaryErrorRate = 1 - canarySuccessRate;
    const primaryErrorRate = 1 - primarySuccessRate;
    canaryMeetsSlos = canaryTotal >= 3 && canaryErrorRate <= primaryErrorRate + 0.05;
  }

  const now = new Date().toISOString();

  if (canaryMeetsSlos && canaryTotal >= 3) {
    // 3a. Auto-promote: set canary_weight to 1.0 (full traffic to canary version)
    await sql`
      UPDATE canary_splits
      SET canary_weight = 1.0
      WHERE agent_name = ${agentName} AND is_active = true
    `;

    // Update production channel to canary version
    const updated = await sql`
      UPDATE release_channels
      SET version = ${canaryVersion}, promoted_at = ${now}, promoted_by = ${user.user_id}
      WHERE agent_name = ${agentName} AND channel = 'production'
    `;
    const touched = Number((updated as { count?: number }).count ?? 0);
    if (touched === 0) {
      await sql`
        INSERT INTO release_channels (org_id, agent_name, channel, version, config, promoted_by, promoted_at)
        VALUES (${user.org_id}, ${agentName}, 'production', ${canaryVersion}, '{}', ${user.user_id}, ${now})
      `;
    }

    // Audit
    try {
      await sql`
        INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
        VALUES (${user.org_id}, ${user.user_id}, 'agent.canary_auto_promoted', 'agent', ${agentName},
                ${JSON.stringify({ primary_version: primaryVersion, canary_version: canaryVersion, metrics, slo_results: sloResults })}, ${now})
      `;
    } catch {}

    return c.json({
      action: "promoted",
      agent: agentName,
      promoted_version: canaryVersion,
      canary_weight: 1.0,
      metrics,
      slo_results: sloResults,
    });
  } else {
    // 3b. Auto-rollback: set canary_weight to 0.0
    await sql`
      UPDATE canary_splits
      SET canary_weight = 0.0, is_active = false
      WHERE agent_name = ${agentName} AND is_active = true
    `;

    // Record rollback in evolution_ledger
    await sql`
      INSERT INTO evolution_ledger (agent_name, org_id, proposal_id, action, note, created_at)
      VALUES (${agentName}, ${user.org_id}, NULL, 'canary_auto_rollback',
              ${"Auto-rollback: canary version failed SLO targets"}, ${now})
    `.catch(() => {});

    // Audit
    try {
      await sql`
        INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
        VALUES (${user.org_id}, ${user.user_id}, 'agent.canary_auto_rollback', 'agent', ${agentName},
                ${JSON.stringify({ primary_version: primaryVersion, canary_version: canaryVersion, metrics, slo_results: sloResults })}, ${now})
      `;
    } catch {}

    return c.json({
      action: "rolled_back",
      agent: agentName,
      reverted_to: primaryVersion,
      canary_weight: 0.0,
      reason: canaryTotal < 3
        ? "Insufficient canary traffic (need at least 3 sessions)"
        : "Canary version failed SLO targets",
      metrics,
      slo_results: sloResults,
    });
  }
  });
});

// ── Explicit Auto-Rollback ─────────────────────────────────────

releaseRoutes.post("/:agent_name/auto-rollback", requireScope("releases:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason || "explicit auto-rollback requested");

  return await withOrgDb(c.env, user.org_id, async (sql) => {

  // Get active canary split
  const splits = await sql`
    SELECT * FROM canary_splits
    WHERE agent_name = ${agentName} AND is_active = true
    LIMIT 1
  `;
  if (splits.length === 0) {
    return c.json({ error: "No active canary split to roll back" }, 404);
  }
  const split = splits[0];
  const primaryVersion = String(split.primary_version);
  const canaryVersion = String(split.canary_version);

  // Set canary_weight to 0.0 and deactivate
  await sql`
    UPDATE canary_splits
    SET canary_weight = 0.0, is_active = false
    WHERE agent_name = ${agentName} AND is_active = true
  `;

  // Ensure production channel reflects primary version
  const now = new Date().toISOString();
  const updated = await sql`
    UPDATE release_channels
    SET version = ${primaryVersion}, promoted_at = ${now}, promoted_by = ${user.user_id}
    WHERE agent_name = ${agentName} AND channel = 'production'
  `;
  const touched = Number((updated as { count?: number }).count ?? 0);
  if (touched === 0) {
    await sql`
      INSERT INTO release_channels (org_id, agent_name, channel, version, config, promoted_by, promoted_at)
      VALUES (${user.org_id}, ${agentName}, 'production', ${primaryVersion}, '{}', ${user.user_id}, ${now})
    `;
  }

  // Record in evolution_ledger
  await sql`
    INSERT INTO evolution_ledger (agent_name, org_id, proposal_id, action, note, created_at)
    VALUES (${agentName}, ${user.org_id}, NULL, 'explicit_auto_rollback', ${reason}, ${now})
  `.catch(() => {});

  // Audit
  try {
    await sql`
      INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_name, details, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'agent.explicit_auto_rollback', 'agent', ${agentName},
              ${JSON.stringify({ primary_version: primaryVersion, canary_version: canaryVersion, reason })}, ${now})
    `;
  } catch {}

  return c.json({
    rolled_back: true,
    agent: agentName,
    reverted_to: primaryVersion,
    canary_weight: 0.0,
    reason,
  });
  });
});
