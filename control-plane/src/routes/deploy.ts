/**
 * Deploy router — verify agent config exists, return DO URL.
 * Ported from agentos/api/routers/deploy.py
 *
 * "Deploying" an agent = ensuring its config exists in Supabase.
 * Each agent is a Durable Object instance in the main worker.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const deployRoutes = new Hono<R>();

deployRoutes.post("/:agent_name", requireScope("deploy:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent config exists
  const rows = await sql`SELECT name FROM agents WHERE name = ${agentName}`;
  if (rows.length === 0) return c.json({ error: `Agent '${agentName}' not found` }, 404);

  // Mark active
  const now = Date.now() / 1000;
  await sql`UPDATE agents SET is_active = 1, updated_at = ${now} WHERE name = ${agentName}`;

  return c.json({
    deployed: true,
    agent: agentName,
    url: `/agents/agentos-agent/${agentName}`,
    websocket: `wss://agentos.servesys.workers.dev/agents/agentos-agent/${agentName}`,
    org_id: user.org_id,
  });
});

deployRoutes.delete("/:agent_name", requireScope("deploy:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const now = Date.now() / 1000;
  try {
    await sql`UPDATE agents SET is_active = 0, updated_at = ${now} WHERE name = ${agentName}`;
  } catch {}

  return c.json({ removed: true, agent: agentName });
});

deployRoutes.get("/:agent_name/status", requireScope("deploy:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  try {
    const rows = await sql`SELECT name, is_active FROM agents WHERE name = ${agentName}`;
    if (rows.length > 0 && rows[0].is_active) {
      return c.json({
        deployed: true,
        agent: agentName,
        url: `/agents/agentos-agent/${agentName}`,
        websocket: `wss://agentos.servesys.workers.dev/agents/agentos-agent/${agentName}`,
      });
    }
  } catch {}

  return c.json({ deployed: false, agent: agentName });
});
