/**
 * Memory router — episodic, semantic (facts), procedural, working memory.
 * Ported from agentos/api/routers/memory.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const memoryRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Episodic Memory ──────────────────────────────────────────────────

memoryRoutes.get("/:agent_name/episodes", requireScope("memory:read"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50));
  const query = c.req.query("query") || "";
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

memoryRoutes.post("/:agent_name/episodes", requireScope("memory:write"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const body = await c.req.json();
  const inputText = String(body.input_text || "");
  const outputText = String(body.output_text || "");
  const outcome = String(body.outcome || "");
  const now = Date.now() / 1000;
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

memoryRoutes.delete("/:agent_name/episodes", requireScope("memory:write"), async (c) => {
  const agentName = c.req.param("agent_name");
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

memoryRoutes.get("/:agent_name/facts", requireScope("memory:read"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const query = c.req.query("query") || "";
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50));
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

memoryRoutes.post("/:agent_name/facts", requireScope("memory:write"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const body = await c.req.json();
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

memoryRoutes.delete("/:agent_name/facts/:key", requireScope("memory:write"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const key = c.req.param("key");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const agentCheck = await sql`
    SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  await sql`DELETE FROM facts WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND key = ${key}`;
  return c.json({ deleted: key });
});

memoryRoutes.delete("/:agent_name/facts", requireScope("memory:write"), async (c) => {
  const agentName = c.req.param("agent_name");
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

memoryRoutes.get("/:agent_name/procedures", requireScope("memory:read"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50));
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

memoryRoutes.delete("/:agent_name/procedures", requireScope("memory:write"), async (c) => {
  const agentName = c.req.param("agent_name");
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

memoryRoutes.get("/:agent_name/working", requireScope("memory:read"), async (c) => {
  const agentName = c.req.param("agent_name");
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
