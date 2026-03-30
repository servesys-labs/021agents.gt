/**
 * Eval router — runs, datasets, evaluators, experiments, task upload.
 * Ported from agentos/api/routers/eval.py
 *
 * Datasets/evaluators stored in R2 (c.env.STORAGE).
 * Eval runs stored in Supabase. POST /run proxies to RUNTIME service binding.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { createOpenAPIRouter } from "../lib/openapi";
import { EvalRunSummary, ErrorSchema, errorResponses } from "../schemas/openapi";

export const evalRoutes = createOpenAPIRouter();

// ── Helpers ──────────────────────────────────────────────────────────

async function r2GetJson(storage: R2Bucket, key: string): Promise<any> {
  const obj = await storage.get(key);
  if (!obj) return null;
  return obj.json();
}

async function r2PutJson(storage: R2Bucket, key: string, data: unknown): Promise<void> {
  await storage.put(key, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function r2ListPrefix(storage: R2Bucket, prefix: string): Promise<string[]> {
  const list = await storage.list({ prefix });
  return list.objects.map((o) => o.key);
}

// ── Eval Runs ────────────────────────────────────────────────────────

const listRunsRoute = createRoute({
  method: "get",
  path: "/runs",
  tags: ["Eval"],
  summary: "List eval runs",
  middleware: [requireScope("eval:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional().openapi({ description: "Filter by agent name" }),
      limit: z.coerce.number().int().min(1).max(200).default(20).openapi({ description: "Max results" }),
    }),
  },
  responses: {
    200: { description: "Eval runs", content: { "application/json": { schema: z.array(EvalRunSummary) } } },
  },
});

evalRoutes.openapi(listRunsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = agentName
    ? await sql`SELECT * FROM eval_runs WHERE org_id = ${orgId} AND agent_name = ${agentName} ORDER BY created_at DESC LIMIT ${limit}`
    : await sql`SELECT * FROM eval_runs WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}`;

  return c.json(
    rows.map((r: any) => ({
      run_id: r.id,
      agent_name: r.agent_name,
      pass_rate: r.pass_rate,
      avg_score: r.avg_score,
      avg_latency_ms: r.avg_latency_ms,
      total_cost_usd: r.total_cost_usd,
      total_tasks: r.total_tasks,
      total_trials: r.total_trials,
    })),
  );
});

const getRunRoute = createRoute({
  method: "get",
  path: "/runs/{run_id}",
  tags: ["Eval"],
  summary: "Get eval run with trials",
  middleware: [requireScope("eval:read")],
  request: { params: z.object({ run_id: z.string() }) },
  responses: {
    200: { description: "Eval run detail", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(404),
  },
});

evalRoutes.openapi(getRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const runId = Number(c.req.valid("param").run_id);
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`SELECT * FROM eval_runs WHERE id = ${runId} AND org_id = ${orgId}`;
  if (rows.length === 0) return c.json({ error: "Eval run not found" }, 404);
  const data: any = { ...rows[0] };

  try {
    data.eval_conditions = JSON.parse(data.eval_conditions_json || "{}");
  } catch {
    data.eval_conditions = {};
  }
  delete data.eval_conditions_json;

  // Get trials
  try {
    const trials = await sql`SELECT * FROM eval_trials WHERE run_id = ${runId} ORDER BY trial_number`;
    data.trials = trials;
  } catch {
    data.trials = [];
  }

  return c.json(data);
});

const getTrialsRoute = createRoute({
  method: "get",
  path: "/runs/{run_id}/trials",
  tags: ["Eval"],
  summary: "List trials for an eval run",
  middleware: [requireScope("eval:read")],
  request: { params: z.object({ run_id: z.string() }) },
  responses: {
    200: { description: "Trial list", content: { "application/json": { schema: z.object({ run_id: z.number(), trials: z.array(z.record(z.unknown())) }) } } },
    ...errorResponses(404),
  },
});

evalRoutes.openapi(getTrialsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const runId = Number(c.req.valid("param").run_id);
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const check = await sql`SELECT id FROM eval_runs WHERE id = ${runId} AND org_id = ${orgId}`;
  if (check.length === 0) return c.json({ error: "Eval run not found" }, 404);

  let trials: any[] = [];
  try {
    trials = await sql`SELECT * FROM eval_trials WHERE run_id = ${runId} ORDER BY trial_number`;
  } catch {
    trials = [];
  }
  return c.json({ run_id: runId, trials });
});

const startRunRoute = createRoute({
  method: "post",
  path: "/run",
  tags: ["Eval"],
  summary: "Start an eval run",
  description: "Proxies to the runtime service to execute eval tasks against an agent.",
  middleware: [requireScope("eval:run")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1).openapi({ example: "support-agent" }),
            eval_name: z.string().default("eval"),
            trials: z.number().int().min(1).max(20).default(3),
            tasks: z.array(z.object({
              name: z.string().optional(),
              input: z.string(),
              expected: z.string().optional(),
              grader: z.string().default("contains"),
            })).min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Eval run result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 500),
    502: { description: "Runtime proxy failed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

evalRoutes.openapi(startRunRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const agentName = body.agent_name;
  const evalName = body.eval_name;
  const trials = body.trials;
  const tasks = body.tasks;

  // Normalize tasks
  const edgeTasks = tasks.map((t: any) => ({
    name: String(t?.name || ""),
    input: String(t?.input || ""),
    expected: String(t?.expected || ""),
    grader: String(t?.grader || "contains"),
  }));

  // Proxy to RUNTIME service binding
  const payload = { agent_name: agentName, eval_name: evalName, trials, tasks: edgeTasks };

  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/eval/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (resp.status >= 400) {
      const text = await resp.text();
      return c.json({ error: text.slice(0, 500) }, resp.status as any);
    }
    return c.json(await resp.json() as Record<string, unknown>);
  } catch (e: any) {
    return c.json({ error: `Runtime eval proxy failed: ${e.message}` }, 502);
  }
});

// ── Tasks (stored in R2) ─────────────────────────────────────────────

const createTasksRoute = createRoute({
  method: "post",
  path: "/tasks",
  tags: ["Eval"],
  summary: "Create a named task set",
  middleware: [requireScope("eval:run")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            tasks: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Tasks created", content: { "application/json": { schema: z.object({ created: z.string(), task_count: z.number() }) } } },
    ...errorResponses(400),
  },
});

evalRoutes.openapi(createTasksRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { name, tasks } = c.req.valid("json");

  const key = `${orgId}/eval/tasks/${name}.json`;
  await r2PutJson(c.env.STORAGE, key, tasks);
  return c.json({ created: key, task_count: tasks.length });
});

const uploadTasksRoute = createRoute({
  method: "post",
  path: "/tasks/upload",
  tags: ["Eval"],
  summary: "Upload task files (JSON/JSONL)",
  middleware: [requireScope("eval:run")],
  request: {
    body: { content: { "multipart/form-data": { schema: z.record(z.unknown()) } } },
  },
  responses: {
    200: { description: "Upload result", content: { "application/json": { schema: z.object({ uploaded: z.array(z.record(z.unknown())), count: z.number() }) } } },
  },
});

evalRoutes.openapi(uploadTasksRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const formData = await c.req.formData();
  const uploaded: any[] = [];

  for (const [, value] of formData.entries()) {
    if (typeof value === "string") continue;
    const name = (value as any).name || "";
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (!["json", "jsonl"].includes(ext)) continue;

    const content = await (value as any).text();
    const key = `${orgId}/eval/tasks/${name}`;
    await c.env.STORAGE.put(key, content, {
      httpMetadata: { contentType: "application/json" },
    });

    let taskCount = 0;
    try {
      if (ext === "json") {
        const parsed = JSON.parse(content);
        taskCount = Array.isArray(parsed) ? parsed.length : 1;
      } else {
        taskCount = content.split("\n").filter((l: string) => l.trim()).length;
      }
    } catch {}
    uploaded.push({ file: key, name: name.replace(/\.\w+$/, ""), task_count: taskCount });
  }

  return c.json({ uploaded, count: uploaded.length });
});

const deleteRunRoute = createRoute({
  method: "delete",
  path: "/runs/{run_id}",
  tags: ["Eval"],
  summary: "Delete an eval run",
  middleware: [requireScope("eval:run")],
  request: { params: z.object({ run_id: z.string() }) },
  responses: {
    200: { description: "Run deleted", content: { "application/json": { schema: z.object({ deleted: z.number() }) } } },
  },
});

evalRoutes.openapi(deleteRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const runId = Number(c.req.valid("param").run_id);
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`DELETE FROM eval_runs WHERE id = ${runId} AND org_id = ${orgId}`;
  return c.json({ deleted: runId });
});

const listTasksRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: ["Eval"],
  summary: "List task sets",
  middleware: [requireScope("eval:read")],
  responses: {
    200: { description: "Task list", content: { "application/json": { schema: z.object({ tasks: z.array(z.record(z.unknown())) }) } } },
  },
});

evalRoutes.openapi(listTasksRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const keys = await r2ListPrefix(c.env.STORAGE, `${orgId}/eval/tasks/`);
  const tasks: any[] = [];
  for (const key of keys) {
    try {
      const obj = await c.env.STORAGE.get(key);
      if (!obj) continue;
      const text = await obj.text();
      const ext = key.endsWith(".jsonl") ? "jsonl" : "json";
      let count = 0;
      if (ext === "jsonl") {
        count = text.split("\n").filter((l) => l.trim()).length;
      } else {
        const data = JSON.parse(text);
        count = Array.isArray(data) ? data.length : 1;
      }
      const name = key.split("/").pop()?.replace(/\.\w+$/, "") || key;
      tasks.push({ file: key, name, task_count: count });
    } catch {
      continue;
    }
  }
  return c.json({ tasks });
});

// ── Datasets (R2) ───────────────────────────────────────────────────

const listDatasetsRoute = createRoute({
  method: "get",
  path: "/datasets",
  tags: ["Eval"],
  summary: "List eval datasets",
  middleware: [requireScope("eval:read")],
  responses: {
    200: { description: "Dataset list", content: { "application/json": { schema: z.object({ datasets: z.array(z.record(z.unknown())) }) } } },
  },
});

evalRoutes.openapi(listDatasetsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const keys = await r2ListPrefix(c.env.STORAGE, `${orgId}/eval/datasets/`);
  const datasets: any[] = [];
  for (const key of keys) {
    try {
      const obj = await c.env.STORAGE.get(key);
      if (!obj) continue;
      const text = await obj.text();
      const parsed = JSON.parse(text);
      const count = Array.isArray(parsed) ? parsed.length : 1;
      const name = key.split("/").pop()?.replace(/\.json$/, "") || key;
      datasets.push({ name, file: key, items: count });
    } catch {
      continue;
    }
  }
  return c.json({ datasets });
});

const createDatasetRoute = createRoute({
  method: "post",
  path: "/datasets",
  tags: ["Eval"],
  summary: "Create a dataset",
  middleware: [requireScope("eval:run")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            items: z.array(z.record(z.unknown())),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Dataset saved", content: { "application/json": { schema: z.object({ saved: z.string(), items: z.number(), file: z.string() }) } } },
    ...errorResponses(400),
  },
});

evalRoutes.openapi(createDatasetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { name, items } = c.req.valid("json");

  const key = `${orgId}/eval/datasets/${name}.json`;
  await r2PutJson(c.env.STORAGE, key, items);
  return c.json({ saved: name, items: items.length, file: key });
});

const getDatasetRoute = createRoute({
  method: "get",
  path: "/datasets/{name}",
  tags: ["Eval"],
  summary: "Get a dataset by name",
  middleware: [requireScope("eval:read")],
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Dataset contents", content: { "application/json": { schema: z.object({ name: z.string(), items: z.array(z.record(z.unknown())) }) } } },
    ...errorResponses(404),
  },
});

evalRoutes.openapi(getDatasetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { name } = c.req.valid("param");
  const key = `${orgId}/eval/datasets/${name}.json`;
  const data = await r2GetJson(c.env.STORAGE, key);
  if (data === null) return c.json({ error: "Dataset not found" }, 404);
  return c.json({ name, items: data });
});

const deleteDatasetRoute = createRoute({
  method: "delete",
  path: "/datasets/{name}",
  tags: ["Eval"],
  summary: "Delete a dataset",
  middleware: [requireScope("eval:run")],
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Dataset deleted", content: { "application/json": { schema: z.object({ deleted: z.string() }) } } },
  },
});

evalRoutes.openapi(deleteDatasetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { name } = c.req.valid("param");
  await c.env.STORAGE.delete(`${orgId}/eval/datasets/${name}.json`);
  return c.json({ deleted: name });
});

// ── Evaluators (R2) ─────────────────────────────────────────────────

function evaluatorsKey(orgId: string): string {
  return `${orgId}/eval/evaluators.json`;
}

const listEvaluatorsRoute = createRoute({
  method: "get",
  path: "/evaluators",
  tags: ["Eval"],
  summary: "List evaluators",
  middleware: [requireScope("eval:read")],
  responses: {
    200: { description: "Evaluator list", content: { "application/json": { schema: z.object({ evaluators: z.array(z.record(z.unknown())) }) } } },
  },
});

evalRoutes.openapi(listEvaluatorsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const key = evaluatorsKey(user.org_id);
  const data = (await r2GetJson(c.env.STORAGE, key)) || [];
  return c.json({ evaluators: Array.isArray(data) ? data : [] });
});

const createEvaluatorRoute = createRoute({
  method: "post",
  path: "/evaluators",
  tags: ["Eval"],
  summary: "Create or update an evaluator",
  middleware: [requireScope("eval:run")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            kind: z.string().default("rule"),
            config: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Evaluator saved", content: { "application/json": { schema: z.object({ saved: z.string() }) } } },
    ...errorResponses(400),
  },
});

evalRoutes.openapi(createEvaluatorRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const key = evaluatorsKey(user.org_id);
  const { name, kind, config } = c.req.valid("json");

  let list = ((await r2GetJson(c.env.STORAGE, key)) || []) as any[];
  if (!Array.isArray(list)) list = [];
  list = list.filter((e: any) => e?.name !== name);
  list.push({ name, kind, config });
  await r2PutJson(c.env.STORAGE, key, list);
  return c.json({ saved: name });
});

const deleteEvaluatorRoute = createRoute({
  method: "delete",
  path: "/evaluators/{name}",
  tags: ["Eval"],
  summary: "Delete an evaluator",
  middleware: [requireScope("eval:run")],
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Evaluator deleted", content: { "application/json": { schema: z.object({ deleted: z.string() }) } } },
  },
});

evalRoutes.openapi(deleteEvaluatorRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const key = evaluatorsKey(user.org_id);
  const { name } = c.req.valid("param");
  let list = ((await r2GetJson(c.env.STORAGE, key)) || []) as any[];
  if (!Array.isArray(list)) list = [];
  list = list.filter((e: any) => e?.name !== name);
  await r2PutJson(c.env.STORAGE, key, list);
  return c.json({ deleted: name });
});

// ── Experiments (R2) ────────────────────────────────────────────────

function experimentsKey(orgId: string): string {
  return `${orgId}/eval/experiments.json`;
}

const listExperimentsRoute = createRoute({
  method: "get",
  path: "/experiments",
  tags: ["Eval"],
  summary: "List experiments",
  middleware: [requireScope("eval:read")],
  responses: {
    200: { description: "Experiment list", content: { "application/json": { schema: z.object({ experiments: z.array(z.record(z.unknown())) }) } } },
  },
});

evalRoutes.openapi(listExperimentsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const key = experimentsKey(user.org_id);
  const data = (await r2GetJson(c.env.STORAGE, key)) || [];
  return c.json({ experiments: Array.isArray(data) ? data : [] });
});

const createExperimentRoute = createRoute({
  method: "post",
  path: "/experiments",
  tags: ["Eval"],
  summary: "Create an experiment",
  middleware: [requireScope("eval:run")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            agent_name: z.string().min(1),
            dataset: z.string().min(1),
            evaluator: z.string().min(1),
            metadata: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Experiment created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400),
  },
});

evalRoutes.openapi(createExperimentRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const key = experimentsKey(user.org_id);
  const { name, agent_name: agentName, dataset, evaluator, metadata } = c.req.valid("json");

  let list = ((await r2GetJson(c.env.STORAGE, key)) || []) as any[];
  if (!Array.isArray(list)) list = [];

  const experimentId = `exp_${list.length + 1}`;
  const item = {
    experiment_id: experimentId,
    name,
    agent_name: agentName,
    dataset,
    evaluator,
    metadata,
    status: "created",
  };
  list.push(item);
  await r2PutJson(c.env.STORAGE, key, list);
  return c.json(item);
});

// ── GET /runs/{run_id}/progress — real-time progress from KV ────────

const evalProgressRoute = createRoute({
  method: "get",
  path: "/runs/{run_id}/progress",
  tags: ["Eval"],
  summary: "Poll real-time eval progress from KV",
  description: "Returns Workflow progress events for an eval run. Events include turn_start, thinking, tool_calls, tool_result, turn_end, done. Requires AGENT_PROGRESS_KV binding.",
  middleware: [requireScope("eval:read")],
  request: {
    params: z.object({ run_id: z.string() }),
    query: z.object({
      agent_name: z.string().optional().openapi({ description: "Agent name to filter progress keys" }),
    }),
  },
  responses: {
    200: {
      description: "Progress events",
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(z.record(z.unknown())),
            source: z.string(),
            keys_scanned: z.number(),
          }),
        },
      },
    },
  },
});

evalRoutes.openapi(evalProgressRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { run_id } = c.req.valid("param");
  const { agent_name } = c.req.valid("query");
  const events: Record<string, unknown>[] = [];

  const kv = (c.env as any).AGENT_PROGRESS_KV as KVNamespace | undefined;
  if (!kv) {
    return c.json({ events: [], source: "unavailable", keys_scanned: 0 });
  }

  try {
    // Eval runs create DO instances named "eval-{agent}-{runId}"
    // Progress keys are "rpc:eval-{agent}-{runId}:*"
    const prefix = agent_name ? `rpc:eval-${agent_name}` : `rpc:eval-`;
    const listResult = await kv.list({ prefix, limit: 50 });

    for (const key of listResult.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>[];
        events.push(...parsed);
      }
    }

    events.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

    return c.json({
      events: events.slice(-200),
      source: "kv",
      keys_scanned: listResult.keys.length,
    });
  } catch {
    return c.json({ events: [], source: "error", keys_scanned: 0 });
  }
});
