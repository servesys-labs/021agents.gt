/**
 * Evolve router — proposals + ledger stored in Supabase.
 * Run endpoint returns 410 (edge-only).
 * Ported from agentos/api/routers/evolve.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const evolveRoutes = new Hono<R>();

evolveRoutes.post("/:agent_name/run", requireScope("evolve:write"), (c) =>
  c.json(
    {
      error: "Moved to edge runtime",
      detail:
        "Evolution runtime execution is edge-only. Run trials on worker runtime and keep this API for control-plane reads/writes.",
    },
    410,
  ),
);

evolveRoutes.get("/:agent_name/proposals", requireScope("evolve:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  try {
    const rows = await sql`
      SELECT * FROM evolution_proposals
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
      ORDER BY created_at DESC
    `;
    return c.json({ proposals: rows });
  } catch {
    return c.json({ proposals: [] });
  }
});

evolveRoutes.post("/:agent_name/proposals/:proposal_id/approve", requireScope("evolve:write"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const proposalId = c.req.param("proposal_id");
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || "");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const rows = await sql`
    SELECT * FROM evolution_proposals
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
  `;
  if (rows.length === 0) return c.json({ error: "Proposal not found" }, 404);

  const now = Date.now() / 1000;
  await sql`
    UPDATE evolution_proposals
    SET status = 'approved', review_note = ${note}, reviewed_at = ${now}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  // Add ledger entry
  await sql`
    INSERT INTO evolution_ledger (agent_name, org_id, proposal_id, action, note, created_at)
    VALUES (${agentName}, ${orgId}, ${proposalId}, 'approved', ${note}, ${now})
  `;

  return c.json({ approved: proposalId, title: rows[0].title || "" });
});

evolveRoutes.post("/:agent_name/proposals/:proposal_id/reject", requireScope("evolve:write"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const proposalId = c.req.param("proposal_id");
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || "");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const rows = await sql`
    SELECT * FROM evolution_proposals
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
  `;
  if (rows.length === 0) return c.json({ error: "Proposal not found" }, 404);

  const now = Date.now() / 1000;
  await sql`
    UPDATE evolution_proposals
    SET status = 'rejected', review_note = ${note}, reviewed_at = ${now}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  await sql`
    INSERT INTO evolution_ledger (agent_name, org_id, proposal_id, action, note, created_at)
    VALUES (${agentName}, ${orgId}, ${proposalId}, 'rejected', ${note}, ${now})
  `;

  return c.json({ rejected: proposalId, title: rows[0].title || "" });
});

evolveRoutes.get("/:agent_name/ledger", requireScope("evolve:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  try {
    const rows = await sql`
      SELECT * FROM evolution_ledger
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
      ORDER BY created_at DESC
    `;
    return c.json({ entries: rows, current_version: "0.1.0" });
  } catch {
    return c.json({ entries: [], current_version: "0.1.0" });
  }
});
