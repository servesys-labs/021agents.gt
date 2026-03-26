/**
 * Autoresearch router — experiment tracking in Supabase.
 * Ported from agentos/api/routers/autoresearch.py
 *
 * Start/stop/status are edge-only (return 410 for start/stop).
 * DB-backed endpoints for dashboard/UI work from Supabase.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const autoresearchRoutes = new Hono<R>();

autoresearchRoutes.post("/start", requireScope("autoresearch:write"), async (c) => {
  // Autoresearch start is a long-running process — forward to RUNTIME
  const body = await c.req.json();
  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/autoresearch/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return c.json(await resp.json(), resp.status as any);
  } catch (e: any) {
    return c.json({ error: `Runtime unavailable: ${e.message}` }, 502);
  }
});

autoresearchRoutes.post("/stop", requireScope("autoresearch:write"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/autoresearch/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return c.json(await resp.json(), resp.status as any);
  } catch (e: any) {
    return c.json({ error: `Runtime unavailable: ${e.message}` }, 502);
  }
});

autoresearchRoutes.get("/status", requireScope("autoresearch:read"), async (c) => {
  const workspace = c.req.query("workspace") || ".";
  try {
    const resp = await c.env.RUNTIME.fetch(
      `https://runtime/api/v1/autoresearch/status?workspace=${encodeURIComponent(workspace)}`,
    );
    return c.json(await resp.json(), resp.status as any);
  } catch {
    return c.json({
      running: false,
      workspace,
      iteration: 0,
      best_bpb: null,
      total_experiments: 0,
      kept: 0,
      discarded: 0,
      crashed: 0,
    });
  }
});

autoresearchRoutes.get("/results", requireScope("autoresearch:read"), async (c) => {
  const workspace = c.req.query("workspace") || ".";
  const last = Number(c.req.query("last")) || 0;
  try {
    const resp = await c.env.RUNTIME.fetch(
      `https://runtime/api/v1/autoresearch/results?workspace=${encodeURIComponent(workspace)}&last=${last}`,
    );
    return c.json(await resp.json(), resp.status as any);
  } catch {
    return c.json([]);
  }
});

// ── Database-backed endpoints (for dashboard/UI) ────────────────────

autoresearchRoutes.get("/runs", requireScope("autoresearch:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT * FROM autoresearch_runs WHERE agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM autoresearch_runs ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return c.json(rows);
});

autoresearchRoutes.get("/runs/:run_id", requireScope("autoresearch:read"), async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const runs = await sql`SELECT * FROM autoresearch_runs WHERE run_id = ${runId}`;
  if (runs.length === 0) return c.json({ error: "Autoresearch run not found" }, 404);

  const experiments = await sql`
    SELECT * FROM autoresearch_experiments WHERE run_id = ${runId}
    ORDER BY created_at LIMIT 500
  `;

  return c.json({ ...runs[0], experiments });
});

autoresearchRoutes.get("/runs/:run_id/experiments", requireScope("autoresearch:read"), async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM autoresearch_experiments WHERE run_id = ${runId}
    ORDER BY created_at LIMIT ${limit}
  `;
  return c.json(rows);
});

autoresearchRoutes.get("/agent/:agent_name/history", requireScope("autoresearch:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 20));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const runs = await sql`
    SELECT * FROM autoresearch_runs WHERE agent_name = ${agentName}
    ORDER BY created_at DESC LIMIT ${limit}
  `;

  const experiments = await sql`
    SELECT * FROM autoresearch_experiments WHERE agent_name = ${agentName}
    ORDER BY created_at DESC LIMIT ${limit * 10}
  `;

  return c.json({
    agent_name: agentName,
    total_runs: runs.length,
    runs,
    total_experiments: experiments.length,
    experiments,
  });
});
