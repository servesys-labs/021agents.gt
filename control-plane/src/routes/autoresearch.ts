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

// POST /autoresearch/runs — create a new autoresearch run record
autoresearchRoutes.post("/runs", requireScope("autoresearch:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const agentName = String(body.agent_name || "").trim();
  const status = String(body.status || "running");
  const configJson = JSON.stringify(body.config || {});
  const workspace = String(body.workspace || ".");

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const runId = crypto.randomUUID();
  const now = Date.now() / 1000;

  try {
    await sql`
      INSERT INTO autoresearch_runs (
        run_id, agent_name, status, config_json, workspace,
        iteration, best_bpb, total_experiments, kept, discarded, crashed,
        org_id, created_at, updated_at
      ) VALUES (
        ${runId}, ${agentName}, ${status}, ${configJson}, ${workspace},
        ${0}, ${null}, ${0}, ${0}, ${0}, ${0},
        ${user.org_id}, ${now}, ${now}
      )
    `;
  } catch (err: any) {
    return c.json({ error: `Failed to create run: ${err.message}` }, 500);
  }

  return c.json({ run_id: runId, agent_name: agentName, status, created: true }, 201);
});

// PUT /autoresearch/runs/:run_id — update run status/metrics
autoresearchRoutes.put("/runs/:run_id", requireScope("autoresearch:write"), async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");
  const body = await c.req.json();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = Date.now() / 1000;

  await sql`
    UPDATE autoresearch_runs SET
      status = COALESCE(${body.status ?? null}, status),
      iteration = COALESCE(${body.iteration ?? null}, iteration),
      best_bpb = COALESCE(${body.best_bpb ?? null}, best_bpb),
      total_experiments = COALESCE(${body.total_experiments ?? null}, total_experiments),
      kept = COALESCE(${body.kept ?? null}, kept),
      discarded = COALESCE(${body.discarded ?? null}, discarded),
      crashed = COALESCE(${body.crashed ?? null}, crashed),
      updated_at = ${now}
    WHERE run_id = ${runId}
  `;

  return c.json({ run_id: runId, updated: true });
});

// POST /autoresearch/runs/:run_id/experiments — record an experiment
autoresearchRoutes.post("/runs/:run_id/experiments", requireScope("autoresearch:write"), async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");
  const body = await c.req.json();
  const agentName = String(body.agent_name || "").trim();
  const experimentName = String(body.experiment_name || "").trim();
  const status = String(body.status || "completed");
  const bpb = body.bpb != null ? Number(body.bpb) : null;
  const configJson = JSON.stringify(body.config || {});
  const resultsJson = JSON.stringify(body.results || {});

  if (!experimentName) return c.json({ error: "experiment_name is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const experimentId = crypto.randomUUID();
  const now = Date.now() / 1000;

  try {
    await sql`
      INSERT INTO autoresearch_experiments (
        experiment_id, run_id, agent_name, experiment_name, status,
        bpb, config_json, results_json, org_id, created_at
      ) VALUES (
        ${experimentId}, ${runId}, ${agentName}, ${experimentName}, ${status},
        ${bpb}, ${configJson}, ${resultsJson}, ${user.org_id}, ${now}
      )
    `;
  } catch (err: any) {
    return c.json({ error: `Failed to create experiment: ${err.message}` }, 500);
  }

  return c.json({ experiment_id: experimentId, run_id: runId, created: true }, 201);
});

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
