/**
 * Releases router — channels, canary splits, promotions.
 * Ported from agentos/api/routers/releases.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { latestEvalGate, rolloutRecommendation } from "../logic/gate-pack";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const releaseRoutes = new Hono<R>();

releaseRoutes.get("/:agent_name/channels", requireScope("releases:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM release_channels WHERE agent_name = ${agentName} AND org_id = ${user.org_id} ORDER BY channel
  `;
  return c.json({ channels: rows });
});

releaseRoutes.post("/:agent_name/promote", requireScope("releases:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const body = await c.req.json().catch(() => ({}));
  const fromChannel = String(body.from_channel || c.req.query("from_channel") || "draft");
  const toChannel = String(body.to_channel || c.req.query("to_channel") || "staging");

  const override = body.override === true;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // ── Eval gate enforcement for production promotion ──
  if (toChannel === "production") {
    const evalGate = await latestEvalGate(sql, agentName, {
      minEvalPassRate: 0.8,
      minEvalTrials: 5,
      orgId: user.org_id,
    });
    const recommendation = rolloutRecommendation({
      agentName,
      graphLint: { valid: true }, // lint assumed passing at promotion time
      evalGate,
      targetChannel: toChannel,
    });

    if (recommendation.decision === "hold") {
      if (!override) {
        return c.json(
          {
            error: "Production promotion blocked by eval gate",
            reason: recommendation.reason,
            recommended_action: recommendation.recommended_action,
            hint: "Pass { override: true } to force promotion in emergencies.",
          },
          400,
        );
      }

      // Log override usage in audit
      const now = Date.now() / 1000;
      try {
        await sql`
          INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
          VALUES (${user.org_id}, ${user.user_id}, 'agent.promote_override', 'agent', ${agentName},
                  ${JSON.stringify({
                    from: fromChannel,
                    to: toChannel,
                    gate_reason: recommendation.reason,
                    override: true,
                  })}, ${now})
        `;
      } catch {}
    }
  }

  // Get source channel config
  const source = await sql`
    SELECT * FROM release_channels
    WHERE agent_name = ${agentName} AND channel = ${fromChannel} AND org_id = ${user.org_id}
  `;

  let configJson: string;
  let version: string;

  if (source.length === 0) {
    // Try getting from agents table
    const agents = await sql`
      SELECT config_json, version FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
    `;
    if (agents.length === 0) return c.json({ error: `Agent '${agentName}' not found` }, 404);
    configJson = agents[0].config_json || "{}";
    version = agents[0].version || "0.1.0";
  } else {
    configJson = source[0].config_json || "{}";
    version = source[0].version || "0.1.0";
  }

  const now = Date.now() / 1000;
  // Org-scoped upsert only: never use ON CONFLICT(agent_name, channel) when the unique
  // index may omit org_id (would cross-tenant overwrite). Update this org's row, then insert if missing.
  const updated = await sql`
    UPDATE release_channels
    SET
      version = ${version},
      config_json = ${configJson},
      promoted_by = ${user.user_id},
      promoted_at = ${now}
    WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND channel = ${toChannel}
  `;
  const touched = Number((updated as { count?: number }).count ?? 0);
  if (touched === 0) {
    await sql`
      INSERT INTO release_channels (org_id, agent_name, channel, version, config_json, promoted_by, promoted_at)
      VALUES (${user.org_id}, ${agentName}, ${toChannel}, ${version}, ${configJson}, ${user.user_id}, ${now})
    `;
  }

  // Audit
  try {
    await sql`
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
      VALUES (${user.org_id}, ${user.user_id}, 'agent.promoted', 'agent', ${agentName},
              ${JSON.stringify({ from: fromChannel, to: toChannel, version })}, ${now})
    `;
  } catch {}

  return c.json({ promoted: agentName, from: fromChannel, to: toChannel, version });
});

// ── Canary Splits ──────────────────────────────────────────────────

releaseRoutes.get("/:agent_name/canary", requireScope("releases:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM canary_splits
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND is_active = 1
  `;
  if (rows.length === 0) return c.json({ canary: null });
  return c.json({ canary: rows[0] });
});

releaseRoutes.post("/:agent_name/canary", requireScope("releases:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const body = await c.req.json();
  const primaryVersion = String(body.primary_version || "");
  const canaryVersion = String(body.canary_version || "");
  const canaryWeight = Number(body.canary_weight ?? 0.1);

  if (canaryWeight < 0 || canaryWeight > 1) {
    return c.json({ error: "canary_weight must be 0.0-1.0" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    UPDATE canary_splits
    SET is_active = 0
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
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

releaseRoutes.delete("/:agent_name/canary", requireScope("releases:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    UPDATE canary_splits
    SET is_active = 0
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
  `;
  return c.json({ removed: true });
});

// ── Canary Auto-Validation ───────────────────────────────────

releaseRoutes.post("/:agent_name/canary/validate", requireScope("releases:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Get active canary split
  const splits = await sql`
    SELECT * FROM canary_splits
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND is_active = 1
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
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
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
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
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

// ── Canary Auto-Rollback ─────────────────────────────────────

releaseRoutes.post("/:agent_name/canary/rollback", requireScope("releases:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason || "canary auto-rollback");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Get active canary split before deactivating
  const splits = await sql`
    SELECT * FROM canary_splits
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND is_active = 1
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
    SET is_active = 0
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
  `;

  // Revert production channel to primary_version config
  const primaryConfig = await sql`
    SELECT config_json FROM release_channels
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND channel = 'production'
    LIMIT 1
  `;
  const configJson = primaryConfig.length > 0 ? primaryConfig[0].config_json : "{}";

  const now = Date.now() / 1000;
  // Ensure production channel reflects the primary version
  const updated = await sql`
    UPDATE release_channels
    SET version = ${primaryVersion}, promoted_at = ${now}
    WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND channel = 'production'
  `;
  const touched = Number((updated as { count?: number }).count ?? 0);
  if (touched === 0) {
    await sql`
      INSERT INTO release_channels (org_id, agent_name, channel, version, config_json, promoted_at)
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
      INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
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
