/**
 * Memory router — episodic, semantic (facts), procedural, working memory.
 *
 * RLS: episodes, facts, procedures, agents, sessions are all org-scoped
 * under withOrgDb. Redundant `WHERE org_id = ${user.org_id}` clauses
 * removed. The `turns` table is NOT RLS-enforced — its lookup uses
 * session_id which is already filtered upstream by the RLS-enforced
 * sessions query.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { parseJsonColumn } from "../lib/parse-json-column";

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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    let rows;
    if (query) {
      rows = await sql`
        SELECT * FROM episodes
        WHERE agent_name = ${agentName}
          AND content ILIKE ${"%" + query + "%"}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM episodes WHERE agent_name = ${agentName}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }
    return c.json({ episodes: rows, total: rows.length });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    const content = [inputText, outputText, outcome].filter(Boolean).join("\n");
    const metadata = JSON.stringify({ agent: agentName, source: "api", input: inputText, output: outputText, outcome });

    await sql`
      INSERT INTO episodes (id, agent_name, org_id, content, source, metadata, created_at)
      VALUES (${episodeId}, ${agentName}, ${user.org_id}, ${content}, ${"api"}, ${metadata}, ${now})
    `;

    return c.json({ id: episodeId, created: true });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    await sql`DELETE FROM episodes WHERE agent_name = ${agentName}`;
    return c.json({ cleared: true });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    let rows;
    if (query) {
      rows = await sql`
        SELECT key, value, category FROM facts
        WHERE agent_name = ${agentName}
          AND (key ILIKE ${"%" + query + "%"} OR value ILIKE ${"%" + query + "%"})
        LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT key, value, category FROM facts WHERE agent_name = ${agentName} LIMIT ${limit}
      `;
    }

    const facts = rows.map((r: any) => {
      return { key: r.key, value: r.value, category: r.category };
    });
    return c.json({ facts, total: facts.length });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    await sql`
      INSERT INTO facts (id, agent_name, org_id, key, value, category, created_at)
      VALUES (${genId()}, ${agentName}, ${user.org_id}, ${key}, ${value}, ${"general"}, ${new Date().toISOString()})
      ON CONFLICT (agent_name, org_id, key) DO UPDATE SET value = EXCLUDED.value
    `;
    return c.json({ key, stored: true });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    await sql`DELETE FROM facts WHERE agent_name = ${agentName} AND key = ${key}`;
    return c.json({ deleted: key });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    await sql`DELETE FROM facts WHERE agent_name = ${agentName}`;
    return c.json({ cleared: true });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    const rows = await sql`
      SELECT * FROM procedures WHERE agent_name = ${agentName}
      ORDER BY last_used DESC LIMIT ${limit}
    `;

    const procedures = rows.map((r: any) => {
      let steps: any[] = [];
      steps = parseJsonColumn(r.steps, []);
      const total = (Number(r.success_count) || 0) + (Number(r.failure_count) || 0);
      return {
        ...r,
        steps,
        success_rate: total > 0 ? (Number(r.success_count) || 0) / total : 0,
      };
    });
    return c.json({ procedures, total: procedures.length });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    await sql`DELETE FROM procedures WHERE agent_name = ${agentName}`;
    return c.json({ cleared: true });
  });
});

const memoryHealthRoute = createRoute({
  method: "get",
  path: "/{agent_name}/health",
  tags: ["Memory"],
  summary: "Get memory health/status for an agent",
  middleware: [requireScope("memory:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: {
      description: "Memory health summary",
      content: {
        "application/json": {
          schema: z.object({
            agent: z.string(),
            semantic_facts_count: z.number(),
            episodic_entries_count: z.number(),
            procedures_count: z.number(),
            curated_entries_count: z.number(),
            stale_facts_30d_count: z.number(),
            latest_memory_at: z.string().nullable(),
          }),
        },
      },
    },
    ...errorResponses(404),
  },
});
memoryRoutes.openapi(memoryHealthRoute, async (c): Promise<any> => {
  const { agent_name: agentName } = c.req.valid("param");
  const user = c.get("user");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    const [factsCountRows, episodesCountRows, proceduresCountRows, staleFactsRows, latestFactRows, latestEpisodeRows, latestProcedureRows] =
      await Promise.all([
        sql`SELECT COUNT(*)::int AS count FROM facts WHERE agent_name = ${agentName}`,
        sql`SELECT COUNT(*)::int AS count FROM episodes WHERE agent_name = ${agentName}`,
        sql`SELECT COUNT(*)::int AS count FROM procedures WHERE agent_name = ${agentName}`,
        sql`
          SELECT COUNT(*)::int AS count
          FROM facts
          WHERE agent_name = ${agentName}
            AND created_at < NOW() - INTERVAL '30 days'
        `,
        sql`SELECT MAX(created_at) AS latest FROM facts WHERE agent_name = ${agentName}`,
        sql`SELECT MAX(created_at) AS latest FROM episodes WHERE agent_name = ${agentName}`,
        sql`SELECT MAX(updated_at) AS latest FROM procedures WHERE agent_name = ${agentName}`,
      ]);

    let curatedEntriesCount = 0;
    try {
      const curatedRows = await sql`
        SELECT COUNT(*)::int AS count
        FROM curated_memory
        WHERE agent_name = ${agentName}
      `;
      curatedEntriesCount = Number(curatedRows?.[0]?.count || 0);
    } catch {
      curatedEntriesCount = 0;
    }

    const timestamps = [
      latestFactRows?.[0]?.latest ? Date.parse(String(latestFactRows[0].latest)) : NaN,
      latestEpisodeRows?.[0]?.latest ? Date.parse(String(latestEpisodeRows[0].latest)) : NaN,
      latestProcedureRows?.[0]?.latest ? Date.parse(String(latestProcedureRows[0].latest)) : NaN,
    ].filter((ts) => Number.isFinite(ts)) as number[];
    const latestMemoryAt = timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;

    return c.json({
      agent: agentName,
      semantic_facts_count: Number(factsCountRows?.[0]?.count || 0),
      episodic_entries_count: Number(episodesCountRows?.[0]?.count || 0),
      procedures_count: Number(proceduresCountRows?.[0]?.count || 0),
      curated_entries_count: curatedEntriesCount,
      stale_facts_30d_count: Number(staleFactsRows?.[0]?.count || 0),
      latest_memory_at: latestMemoryAt,
    });
  });
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

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const agentCheck = await sql`
      SELECT 1 FROM agents WHERE name = ${agentName}
    `;
    if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

    // Best-effort derived snapshot from the latest persisted session/turns.
    const sessions = await sql`
      SELECT session_id, created_at
      FROM sessions
      WHERE agent_name = ${agentName}
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
    // turns is NOT RLS-enforced; lookup is constrained by the
    // session_id which we just resolved through the RLS-protected
    // sessions query above.
    const turns = await sql`
      SELECT turn_number, llm_content, tool_calls, reflection, plan_artifact
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
          return parseJsonColumn(t.tool_calls, []);
        })(),
        reflection: (() => {
          return parseJsonColumn(t.reflection);
        })(),
        plan: (() => {
          return parseJsonColumn(t.plan_artifact);
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
});

// ── Team Memory Endpoints ────────────────────────────────────

memoryRoutes.get("/team/facts", async (c) => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT id, author_agent, content, category, score, created_at
      FROM facts
      ORDER BY score DESC LIMIT 50
    `;
    return c.json({ facts: rows });
  });
});

memoryRoutes.post("/team/facts", async (c) => {
  const user = c.get("user");
  const body = await c.req.json() as { content: string; category?: string };
  if (!body.content) return c.json({ error: "content required" }, 400);
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO facts (org_id, author_agent, content, category, score, created_at)
      VALUES (${user.org_id}, ${"portal-user"}, ${body.content.slice(0, 1000)}, ${body.category || "general"}, ${0.7}, NOW())
      ON CONFLICT (org_id, content) DO UPDATE SET score = facts.score + 0.1, updated_at = NOW()
    `;
    return c.json({ saved: true });
  });
});

memoryRoutes.delete("/team/facts/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`DELETE FROM facts WHERE id = ${id}`;
    return c.json({ deleted: true });
  });
});

memoryRoutes.get("/team/observations", async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent") || "";
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = agentName
      ? await sql`SELECT * FROM facts WHERE (target_agent = ${agentName} OR target_agent IS NULL) ORDER BY created_at DESC LIMIT 50`
      : await sql`SELECT * FROM facts ORDER BY created_at DESC LIMIT 50`;
    return c.json({ observations: rows });
  });
});
