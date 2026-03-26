/**
 * Eval router — runs, datasets, evaluators, experiments, task upload.
 * Ported from agentos/api/routers/eval.py
 *
 * Datasets/evaluators stored in R2 (c.env.STORAGE).
 * Eval runs stored in Supabase. POST /run proxies to RUNTIME service binding.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const evalRoutes = new Hono<R>();

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

evalRoutes.get("/runs", requireScope("eval:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.query("agent_name") || "";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 20));
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

evalRoutes.get("/runs/:run_id", requireScope("eval:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const runId = Number(c.req.param("run_id"));
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

evalRoutes.get("/runs/:run_id/trials", requireScope("eval:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const runId = Number(c.req.param("run_id"));
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

evalRoutes.post("/run", requireScope("eval:run"), async (c) => {
  const body = await c.req.json();
  const agentName = String(body.agent_name || "").trim();
  const evalName = String(body.eval_name || "eval").trim();
  const trials = Math.max(1, Math.min(20, Number(body.trials) || 3));
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);
  if (tasks.length === 0) return c.json({ error: "tasks array is required" }, 400);

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.status >= 400) {
      const text = await resp.text();
      return c.json({ error: text.slice(0, 500) }, resp.status as any);
    }
    return c.json(await resp.json());
  } catch (e: any) {
    return c.json({ error: `Runtime eval proxy failed: ${e.message}` }, 502);
  }
});

// ── Tasks (stored in R2) ─────────────────────────────────────────────

evalRoutes.post("/tasks", requireScope("eval:run"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  if (!name) return c.json({ error: "name is required" }, 400);

  const key = `${orgId}/eval/tasks/${name}.json`;
  await r2PutJson(c.env.STORAGE, key, tasks);
  return c.json({ created: key, task_count: tasks.length });
});

evalRoutes.post("/tasks/upload", requireScope("eval:run"), async (c) => {
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

evalRoutes.delete("/runs/:run_id", requireScope("eval:run"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const runId = Number(c.req.param("run_id"));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`DELETE FROM eval_runs WHERE id = ${runId} AND org_id = ${orgId}`;
  return c.json({ deleted: runId });
});

evalRoutes.get("/tasks", requireScope("eval:read"), async (c) => {
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

evalRoutes.get("/datasets", requireScope("eval:read"), async (c) => {
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

evalRoutes.post("/datasets", requireScope("eval:run"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!name) return c.json({ error: "name is required" }, 400);

  const key = `${orgId}/eval/datasets/${name}.json`;
  await r2PutJson(c.env.STORAGE, key, items);
  return c.json({ saved: name, items: items.length, file: key });
});

evalRoutes.get("/datasets/:name", requireScope("eval:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const name = c.req.param("name");
  const key = `${orgId}/eval/datasets/${name}.json`;
  const data = await r2GetJson(c.env.STORAGE, key);
  if (data === null) return c.json({ error: "Dataset not found" }, 404);
  return c.json({ name, items: data });
});

evalRoutes.delete("/datasets/:name", requireScope("eval:run"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const name = c.req.param("name");
  await c.env.STORAGE.delete(`${orgId}/eval/datasets/${name}.json`);
  return c.json({ deleted: name });
});

// ── Evaluators (R2) ─────────────────────────────────────────────────

function evaluatorsKey(orgId: string): string {
  return `${orgId}/eval/evaluators.json`;
}

evalRoutes.get("/evaluators", requireScope("eval:read"), async (c) => {
  const user = c.get("user");
  const key = evaluatorsKey(user.org_id);
  const data = (await r2GetJson(c.env.STORAGE, key)) || [];
  return c.json({ evaluators: Array.isArray(data) ? data : [] });
});

evalRoutes.post("/evaluators", requireScope("eval:run"), async (c) => {
  const user = c.get("user");
  const key = evaluatorsKey(user.org_id);
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const kind = String(body.kind || "rule");
  const config = body.config || {};
  if (!name) return c.json({ error: "name is required" }, 400);

  let list = ((await r2GetJson(c.env.STORAGE, key)) || []) as any[];
  if (!Array.isArray(list)) list = [];
  list = list.filter((e: any) => e?.name !== name);
  list.push({ name, kind, config });
  await r2PutJson(c.env.STORAGE, key, list);
  return c.json({ saved: name });
});

evalRoutes.delete("/evaluators/:name", requireScope("eval:run"), async (c) => {
  const user = c.get("user");
  const key = evaluatorsKey(user.org_id);
  const name = c.req.param("name");
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

evalRoutes.get("/experiments", requireScope("eval:read"), async (c) => {
  const user = c.get("user");
  const key = experimentsKey(user.org_id);
  const data = (await r2GetJson(c.env.STORAGE, key)) || [];
  return c.json({ experiments: Array.isArray(data) ? data : [] });
});

evalRoutes.post("/experiments", requireScope("eval:run"), async (c) => {
  const user = c.get("user");
  const key = experimentsKey(user.org_id);
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const agentName = String(body.agent_name || "").trim();
  const dataset = String(body.dataset || "").trim();
  const evaluator = String(body.evaluator || "").trim();
  const metadata = body.metadata || {};

  if (!name || !agentName || !dataset || !evaluator) {
    return c.json({ error: "name, agent_name, dataset, and evaluator are required" }, 400);
  }

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
