/**
 * Deploy router — verify agent config exists, return DO URL.
 * Ported from agentos/api/routers/deploy.py
 *
 * "Deploying" an agent = ensuring its config exists in Supabase.
 * Each agent is a Durable Object instance in the main worker.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const deployRoutes = createOpenAPIRouter();

// ── POST /deploy/:agent_name ────────────────────────────────────────────

const deployAgentRoute = createRoute({
  method: "post",
  path: "/{agent_name}",
  tags: ["Deploy"],
  summary: "Deploy an agent",
  middleware: [requireScope("deploy:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Agent deployed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
deployRoutes.openapi(deployAgentRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Verify agent config exists
    const rows = await sql`SELECT name FROM agents WHERE name = ${agentName}`;
    if (rows.length === 0) return c.json({ error: `Agent '${agentName}' not found` }, 404);

    // Mark active
    const now = new Date().toISOString();
    await sql`UPDATE agents SET is_active = true, updated_at = ${now} WHERE name = ${agentName}`;

    return c.json({
      deployed: true,
      agent: agentName,
      url: `/agents/agentos-agent/${agentName}`,
      websocket: `wss://runtime.oneshots.co/agents/agentos-agent/${agentName}`,
      org_id: user.org_id,
    });
  });
});

// ── DELETE /deploy/:agent_name ──────────────────────────────────────────

const undeployAgentRoute = createRoute({
  method: "delete",
  path: "/{agent_name}",
  tags: ["Deploy"],
  summary: "Undeploy an agent",
  middleware: [requireScope("deploy:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Agent undeployed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
deployRoutes.openapi(undeployAgentRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();
    try {
      await sql`UPDATE agents SET is_active = false, updated_at = ${now} WHERE name = ${agentName}`;
    } catch {}

    return c.json({ removed: true, agent: agentName });
  });
});

// ── GET /deploy/:agent_name/status ──────────────────────────────────────

const deployStatusRoute = createRoute({
  method: "get",
  path: "/{agent_name}/status",
  tags: ["Deploy"],
  summary: "Get deploy status for an agent",
  middleware: [requireScope("deploy:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Deploy status",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
deployRoutes.openapi(deployStatusRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    try {
      const rows = await sql`SELECT name, is_active FROM agents WHERE name = ${agentName}`;
      if (rows.length > 0 && rows[0].is_active) {
        return c.json({
          deployed: true,
          agent: agentName,
          url: `/agents/agentos-agent/${agentName}`,
          websocket: `wss://runtime.oneshots.co/agents/agentos-agent/${agentName}`,
        });
      }
    } catch {}

    return c.json({ deployed: false, agent: agentName });
  });
});
