/**
 * Releases router — channels, canary splits, promotions.
 * Ported from agentos/api/routers/releases.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

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

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

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
