/**
 * Autoresearch router — experiment tracking in Supabase.
 *
 * Start/stop/status are edge-only (return 410 for start/stop).
 * DB-backed endpoints for dashboard/UI work from Supabase.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { failSafe } from "../lib/error-response";

export const autoresearchRoutes = createOpenAPIRouter();

// ── POST /start — Start autoresearch (proxied to runtime) ──────────

const startRoute = createRoute({
  method: "post",
  path: "/start",
  tags: ["AutoResearch"],
  summary: "Start an autoresearch run",
  middleware: [requireScope("autoresearch:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.record(z.unknown()),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Autoresearch started",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(startRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
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

// ── POST /stop — Stop autoresearch (proxied to runtime) ─────────────

const stopRoute = createRoute({
  method: "post",
  path: "/stop",
  tags: ["AutoResearch"],
  summary: "Stop an autoresearch run",
  middleware: [requireScope("autoresearch:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.record(z.unknown()),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Autoresearch stopped",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(stopRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
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

// ── GET /status — Autoresearch status (proxied to runtime) ──────────

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["AutoResearch"],
  summary: "Get autoresearch status",
  middleware: [requireScope("autoresearch:read")],
  request: {
    query: z.object({
      workspace: z.string().default(".").openapi({ example: "." }),
    }),
  },
  responses: {
    200: {
      description: "Autoresearch status",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(statusRoute, async (c): Promise<any> => {
  const { workspace } = c.req.valid("query");
  try {
    const resp = await c.env.RUNTIME.fetch(
      `https://runtime/api/v1/autoresearch/status?workspace=${encodeURIComponent(workspace || ".")}`,
    );
    return c.json(await resp.json(), resp.status as any);
  } catch {
    return c.json({
      running: false,
      workspace: workspace || ".",
      iteration: 0,
      best_bpb: null,
      total_experiments: 0,
      kept: 0,
      discarded: 0,
      crashed: 0,
    });
  }
});

// ── GET /results — Autoresearch results (proxied to runtime) ────────

const resultsRoute = createRoute({
  method: "get",
  path: "/results",
  tags: ["AutoResearch"],
  summary: "Get autoresearch results",
  middleware: [requireScope("autoresearch:read")],
  request: {
    query: z.object({
      workspace: z.string().default(".").openapi({ example: "." }),
      last: z.coerce.number().default(0).openapi({ example: 0 }),
    }),
  },
  responses: {
    200: {
      description: "Autoresearch results",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(resultsRoute, async (c): Promise<any> => {
  const { workspace, last } = c.req.valid("query");
  try {
    const resp = await c.env.RUNTIME.fetch(
      `https://runtime/api/v1/autoresearch/results?workspace=${encodeURIComponent(workspace || ".")}&last=${last || 0}`,
    );
    return c.json(await resp.json(), resp.status as any);
  } catch {
    return c.json([]);
  }
});

// ── Database-backed endpoints (for dashboard/UI) ────────────────────

// POST /runs — create a new autoresearch run record

const createRunRoute = createRoute({
  method: "post",
  path: "/runs",
  tags: ["AutoResearch"],
  summary: "Create a new autoresearch run record",
  middleware: [requireScope("autoresearch:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1).openapi({ example: "my-agent" }),
            status: z.string().default("running"),
            config: z.record(z.unknown()).default({}),
            workspace: z.string().default("."),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Run created",
      content: { "application/json": { schema: z.object({ run_id: z.string(), agent_name: z.string(), status: z.string(), created: z.boolean() }) } },
    },
    ...errorResponses(400, 500),
  },
});

autoresearchRoutes.openapi(createRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "").trim();
  const status = String(body.status || "running");
  const configJson = JSON.stringify(body.config || {});
  const workspace = String(body.workspace || ".");

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await sql`
        INSERT INTO autoresearch_runs (
          run_id, agent_name, status, config, workspace,
          iteration, best_bpb, total_experiments, kept, discarded, crashed,
          org_id, created_at, updated_at
        ) VALUES (
          ${runId}, ${agentName}, ${status}, ${configJson}, ${workspace},
          ${0}, ${null}, ${0}, ${0}, ${0}, ${0},
          ${user.org_id}, ${now}, ${now}
        )
      `;
    } catch (err: any) {
      return c.json(failSafe(err, "autoresearch/runs/create", { userMessage: "Couldn't create the experiment run. Please try again in a moment." }), 500);
    }

    return c.json({ run_id: runId, agent_name: agentName, status, created: true }, 201);
  });
});

// ── PUT /runs/:run_id — update run status/metrics ───────────────────

const updateRunRoute = createRoute({
  method: "put",
  path: "/runs/{run_id}",
  tags: ["AutoResearch"],
  summary: "Update run status and metrics",
  middleware: [requireScope("autoresearch:write")],
  request: {
    params: z.object({ run_id: z.string().openapi({ example: "uuid-abc123" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.string().optional(),
            iteration: z.number().optional(),
            best_bpb: z.number().nullable().optional(),
            total_experiments: z.number().optional(),
            kept: z.number().optional(),
            discarded: z.number().optional(),
            crashed: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Run updated",
      content: { "application/json": { schema: z.object({ run_id: z.string(), updated: z.boolean() }) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(updateRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { run_id: runId } = c.req.valid("param");
  const body = c.req.valid("json");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const now = new Date().toISOString();

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
});

// ── POST /runs/:run_id/experiments — record an experiment ───────────

const createExperimentRoute = createRoute({
  method: "post",
  path: "/runs/{run_id}/experiments",
  tags: ["AutoResearch"],
  summary: "Record an experiment in a run",
  middleware: [requireScope("autoresearch:write")],
  request: {
    params: z.object({ run_id: z.string().openapi({ example: "uuid-abc123" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().default(""),
            experiment_name: z.string().min(1).openapi({ example: "exp-001" }),
            status: z.string().default("completed"),
            bpb: z.number().nullable().optional(),
            config: z.record(z.unknown()).default({}),
            results: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Experiment created",
      content: { "application/json": { schema: z.object({ experiment_id: z.string(), run_id: z.string(), created: z.boolean() }) } },
    },
    ...errorResponses(400, 500),
  },
});

autoresearchRoutes.openapi(createExperimentRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { run_id: runId } = c.req.valid("param");
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "").trim();
  const experimentName = String(body.experiment_name || "").trim();
  const status = String(body.status || "completed");
  const bpb = body.bpb != null ? Number(body.bpb) : null;
  const configJson = JSON.stringify(body.config || {});
  const resultsJson = JSON.stringify(body.results || {});

  if (!experimentName) return c.json({ error: "experiment_name is required" }, 400);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const experimentId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await sql`
        INSERT INTO autoresearch_experiments (
          experiment_id, run_id, agent_name, experiment_name, status,
          bpb, config, results, org_id, created_at
        ) VALUES (
          ${experimentId}, ${runId}, ${agentName}, ${experimentName}, ${status},
          ${bpb}, ${configJson}, ${resultsJson}, ${user.org_id}, ${now}
        )
      `;
    } catch (err: any) {
      return c.json(failSafe(err, "autoresearch/experiments/create", { userMessage: "Couldn't create the experiment. Please try again in a moment." }), 500);
    }

    return c.json({ experiment_id: experimentId, run_id: runId, created: true }, 201);
  });
});

// ── GET /runs — List autoresearch runs ──────────────────────────────

const listRunsRoute = createRoute({
  method: "get",
  path: "/runs",
  tags: ["AutoResearch"],
  summary: "List autoresearch runs",
  middleware: [requireScope("autoresearch:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional().openapi({ example: "my-agent" }),
      limit: z.coerce.number().int().min(1).max(200).default(50).openapi({ example: 50 }),
    }),
  },
  responses: {
    200: {
      description: "Autoresearch runs",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(listRunsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, limit: rawLimit } = c.req.valid("query");
  const limit = Math.min(200, Math.max(1, Number(rawLimit) || 50));
  return await withOrgDb(c.env, user.org_id, async (sql) => {
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
});

// ── GET /runs/:run_id — Get a specific autoresearch run ─────────────

const getRunRoute = createRoute({
  method: "get",
  path: "/runs/{run_id}",
  tags: ["AutoResearch"],
  summary: "Get a specific autoresearch run with experiments",
  middleware: [requireScope("autoresearch:read")],
  request: {
    params: z.object({ run_id: z.string().openapi({ example: "uuid-abc123" }) }),
  },
  responses: {
    200: {
      description: "Autoresearch run with experiments",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404, 500),
  },
});

autoresearchRoutes.openapi(getRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { run_id: runId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const runs = await sql`SELECT * FROM autoresearch_runs WHERE run_id = ${runId}`;
    if (runs.length === 0) return c.json({ error: "Autoresearch run not found" }, 404);

    const experiments = await sql`
      SELECT * FROM autoresearch_experiments WHERE run_id = ${runId}
      ORDER BY created_at LIMIT 500
    `;

    return c.json({ ...runs[0], experiments });
  });
});

// ── GET /runs/:run_id/experiments — List experiments for a run ──────

const listExperimentsRoute = createRoute({
  method: "get",
  path: "/runs/{run_id}/experiments",
  tags: ["AutoResearch"],
  summary: "List experiments for an autoresearch run",
  middleware: [requireScope("autoresearch:read")],
  request: {
    params: z.object({ run_id: z.string().openapi({ example: "uuid-abc123" }) }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100).openapi({ example: 100 }),
    }),
  },
  responses: {
    200: {
      description: "Experiments list",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(listExperimentsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { run_id: runId } = c.req.valid("param");
  const { limit: rawLimit } = c.req.valid("query");
  const limit = Math.min(500, Math.max(1, Number(rawLimit) || 100));
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM autoresearch_experiments WHERE run_id = ${runId}
      ORDER BY created_at LIMIT ${limit}
    `;
    return c.json(rows);
  });
});

// ── GET /agent/:agent_name/history — Agent experiment history ───────

const agentHistoryRoute = createRoute({
  method: "get",
  path: "/agent/{agent_name}/history",
  tags: ["AutoResearch"],
  summary: "Get agent autoresearch history",
  middleware: [requireScope("autoresearch:read")],
  request: {
    params: z.object({ agent_name: z.string().openapi({ example: "my-agent" }) }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(20).openapi({ example: 20 }),
    }),
  },
  responses: {
    200: {
      description: "Agent experiment history",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(500),
  },
});

autoresearchRoutes.openapi(agentHistoryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const { limit: rawLimit } = c.req.valid("query");
  const limit = Math.min(200, Math.max(1, Number(rawLimit) || 20));
  return await withOrgDb(c.env, user.org_id, async (sql) => {
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
});
