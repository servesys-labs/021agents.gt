/**
 * Memory router — episodic, semantic (facts), procedural, working memory.
 * Ported from agentos/api/routers/memory.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const memoryRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Episodic Memory ──────────────────────────────────────────────────

const listEpisodesRoute = createRoute({
  method: "get",
  path: "/{agent_name}/episodes",
  tags: ["Memory"],
  summary: "List episodic memories for an agent",
  middleware: [requireScope("memory:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
      query: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Episode list",
      content: { "application/json": { schema: z.object({ episodes: z.array(z.record(z.unknown())), total: z.number() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(listEpisodesRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const q = c.req.valid("query");
  const user = c.get("user");
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
  const query = q.query || "";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  let rows;
  if (query) {
    rows = await sql`
      SELECT * FROM episodes
      WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
        AND (input ILIKE ${"%" + query + "%"} OR output ILIKE ${"%" + query + "%"})
      ORDER BY timestamp DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM episodes WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
      ORDER BY timestamp DESC LIMIT ${limit}
    `;
  }
  return c.json({ episodes: rows, total: rows.length });
});

const createEpisodeRoute = createRoute({
  method: "post",
  path: "/{agent_name}/episodes",
  tags: ["Memory"],
  summary: "Create an episodic memory entry",
  middleware: [requireScope("memory:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            input_text: z.string().default(""),
            output_text: z.string().default(""),
            outcome: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Episode created",
      content: { "application/json": { schema: z.object({ id: z.string(), created: z.boolean() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(createEpisodeRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");
  const body = c.req.valid("json");
  const inputText = String(body.input_text || "");
  const outputText = String(body.output_text || "");
  const outcome = String(body.outcome || "");
  const now = new Date().toISOString();
  const episodeId = genId();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const metadata = JSON.stringify({ agent: agentName, source: "api" });

  await sql`
    INSERT INTO episodes (id, agent_name, org_id, input, output, outcome, metadata_json, timestamp)
    VALUES (${episodeId}, ${agentName}, ${user.org_id}, ${inputText}, ${outputText}, ${outcome}, ${metadata}, ${now})
  `;

  return c.json({ id: episodeId, created: true });
});

const clearEpisodesRoute = createRoute({
  method: "delete",
  path: "/{agent_name}/episodes",
  tags: ["Memory"],
  summary: "Clear all episodic memories for an agent",
  middleware: [requireScope("memory:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Episodes cleared",
      content: { "application/json": { schema: z.object({ cleared: z.boolean() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(clearEpisodesRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  await sql`DELETE FROM episodes WHERE agent_name = ${agentName} AND org_id = ${user.org_id}`;
  return c.json({ cleared: true });
});

// ── Semantic Memory (Facts) ──────────────────────────────────────────

const listFactsRoute = createRoute({
  method: "get",
  path: "/{agent_name}/facts",
  tags: ["Memory"],
  summary: "List semantic memory facts for an agent",
  middleware: [requireScope("memory:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      query: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "Fact list",
      content: { "application/json": { schema: z.object({ facts: z.array(z.record(z.unknown())), total: z.number() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(listFactsRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const q = c.req.valid("query");
  const user = c.get("user");
  const query = q.query || "";
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  let rows;
  if (query) {
    rows = await sql`
      SELECT key, value_json FROM facts
      WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
        AND (key ILIKE ${"%" + query + "%"} OR value_json ILIKE ${"%" + query + "%"})
      LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT key, value_json FROM facts WHERE agent_name = ${agentName} AND org_id = ${user.org_id} LIMIT ${limit}
    `;
  }

  const facts = rows.map((r: any) => {
    let value: any;
    try { value = JSON.parse(r.value_json); } catch { value = r.value_json; }
    return { key: r.key, value };
  });
  return c.json({ facts, total: facts.length });
});

const createFactRoute = createRoute({
  method: "post",
  path: "/{agent_name}/facts",
  tags: ["Memory"],
  summary: "Store a semantic memory fact",
  middleware: [requireScope("memory:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            key: z.string().min(1),
            value: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Fact stored",
      content: { "application/json": { schema: z.object({ key: z.string(), stored: z.boolean() }) } },
    },
    ...errorResponses(400, 404),
  },
});
memoryRoutes.openapi(createFactRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");
  const body = c.req.valid("json");
  const key = String(body.key || "").trim();
  const value = String(body.value || "");
  if (!key) return c.json({ error: "key is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const valueJson = JSON.stringify(value);

  await sql`
    INSERT INTO facts (agent_name, org_id, key, value_json)
    VALUES (${agentName}, ${user.org_id}, ${key}, ${valueJson})
    ON CONFLICT (agent_name, key) DO UPDATE SET value_json = EXCLUDED.value_json
  `;
  return c.json({ key, stored: true });
});

const deleteFactRoute = createRoute({
  method: "delete",
  path: "/{agent_name}/facts/{key}",
  tags: ["Memory"],
  summary: "Delete a single semantic memory fact",
  middleware: [requireScope("memory:write")],
  request: {
    params: z.object({ agent_name: z.string(), key: z.string() }),
  },
  responses: {
    200: {
      description: "Fact deleted",
      content: { "application/json": { schema: z.object({ deleted: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(deleteFactRoute, async (c): Promise<any> => {
  const { agent_name: agentName, key } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  await sql`DELETE FROM facts WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND key = ${key}`;
  return c.json({ deleted: key });
});

const clearFactsRoute = createRoute({
  method: "delete",
  path: "/{agent_name}/facts",
  tags: ["Memory"],
  summary: "Clear all semantic memory facts for an agent",
  middleware: [requireScope("memory:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Facts cleared",
      content: { "application/json": { schema: z.object({ cleared: z.boolean() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(clearFactsRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  await sql`DELETE FROM facts WHERE agent_name = ${agentName} AND org_id = ${user.org_id}`;
  return c.json({ cleared: true });
});

// ── Procedural Memory ────────────────────────────────────────────────

const listProceduresRoute = createRoute({
  method: "get",
  path: "/{agent_name}/procedures",
  tags: ["Memory"],
  summary: "List procedural memories for an agent",
  middleware: [requireScope("memory:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "Procedure list",
      content: { "application/json": { schema: z.object({ procedures: z.array(z.record(z.unknown())), total: z.number() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(listProceduresRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const q = c.req.valid("query");
  const user = c.get("user");
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const rows = await sql`
    SELECT * FROM procedures WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
    ORDER BY last_used DESC LIMIT ${limit}
  `;

  const procedures = rows.map((r: any) => {
    let steps: any[] = [];
    try { steps = JSON.parse(r.steps_json || "[]"); } catch {}
    const total = (Number(r.success_count) || 0) + (Number(r.failure_count) || 0);
    return {
      ...r,
      steps,
      success_rate: total > 0 ? (Number(r.success_count) || 0) / total : 0,
    };
  });
  return c.json({ procedures, total: procedures.length });
});

const clearProceduresRoute = createRoute({
  method: "delete",
  path: "/{agent_name}/procedures",
  tags: ["Memory"],
  summary: "Clear all procedural memories for an agent",
  middleware: [requireScope("memory:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Procedures cleared",
      content: { "application/json": { schema: z.object({ cleared: z.boolean() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(clearProceduresRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  await sql`DELETE FROM procedures WHERE agent_name = ${agentName} AND org_id = ${user.org_id}`;
  return c.json({ cleared: true });
});

// ── Working Memory (not persisted, returns empty for edge architecture) ──

const getWorkingMemoryRoute = createRoute({
  method: "get",
  path: "/{agent_name}/working",
  tags: ["Memory"],
  summary: "Get working memory snapshot for an agent",
  middleware: [requireScope("memory:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Working memory snapshot",
      content: { "application/json": { schema: z.object({ agent: z.string(), working_memory: z.record(z.unknown()), note: z.string().optional() }) } },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(getWorkingMemoryRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  // Best-effort derived snapshot from the latest persisted session/turns.
  const sessions = await sql`
    SELECT session_id, created_at
    FROM sessions
    WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (sessions.length === 0) {
    return c.json({
      agent: agentName,
      working_memory: {},
      note: "No persisted session data found for this agent yet.",
    });
  }

  const sessionId = String(sessions[0].session_id || "");
  const turns = await sql`
    SELECT turn_number, llm_content, tool_calls_json, reflection_json, plan_json
    FROM turns
    WHERE session_id = ${sessionId}
    ORDER BY turn_number DESC
    LIMIT 5
  `;

  const recentTurns = turns
    .map((t: any) => ({
      turn_number: Number(t.turn_number || 0),
      content_preview: String(t.llm_content || "").slice(0, 280),
      tool_calls: (() => {
        try { return JSON.parse(t.tool_calls_json || "[]"); } catch { return []; }
      })(),
      reflection: (() => {
        try { return JSON.parse(t.reflection_json || "{}"); } catch { return {}; }
      })(),
      plan: (() => {
        try { return JSON.parse(t.plan_json || "{}"); } catch { return {}; }
      })(),
    }))
    .sort((a, b) => a.turn_number - b.turn_number);

  return c.json({
    agent: agentName,
    working_memory: {
      source: "derived_from_persisted_turns",
      latest_session_id: sessionId,
      recent_turns: recentTurns,
    },
    note: "Derived snapshot from persisted session turns. For live in-flight state, query runtime directly.",
  });
});
