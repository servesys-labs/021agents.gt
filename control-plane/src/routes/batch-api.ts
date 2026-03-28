/**
 * Batch/Async Run API — submit, monitor, and cancel batch agent runs.
 *
 * Mounted at /v1 on the control-plane alongside public-api routes.
 *
 * Endpoints:
 *   POST   /agents/:name/run/batch       — Submit a batch of tasks for async execution
 *   GET    /agents/:name/batches          — List batch jobs for an agent
 *   GET    /agents/:name/batches/:batch_id — Get batch job status and results
 *   DELETE /agents/:name/batches/:batch_id — Cancel a batch job
 *
 * All routes require API key auth (ak_...).
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const batchApiRoutes = new Hono<R>();

const MAX_TASKS_PER_BATCH = 100;

// ── Helpers (duplicated from public-api to avoid circular imports) ────────

function resolveOrgId(c: any): string {
  return c.get("resolved_org_id") || c.get("user")?.org_id || "";
}

function requireAuth(c: any): Response | null {
  const user = c.get("user");
  if (!user?.org_id && !c.get("resolved_org_id")) {
    return c.json(
      { error: "Authentication required. Provide an API key via Authorization: Bearer ak_..." },
      401,
    );
  }
  return null;
}

async function checkAgentAccess(c: any, agentName: string, orgId: string): Promise<Response | null> {
  const user = c.get("user");

  if (user?.allowedAgents && user.allowedAgents.length > 0) {
    if (!user.allowedAgents.includes(agentName) && !user.allowedAgents.includes("*")) {
      return c.json({ error: `API key not authorized for agent: ${agentName}` }, 403);
    }
  }

  let agents;
  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
    agents = await sql`
      SELECT name FROM agents WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
    `;
  } catch {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  if (agents.length === 0) {
    return c.json({ error: `Agent not found: ${agentName}` }, 404);
  }

  return null;
}

// ── POST /agents/:name/run/batch — Submit a batch job ─────────────────────

batchApiRoutes.post("/agents/:name/run/batch", async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const orgId = resolveOrgId(c);
  const agentName = c.req.param("name");

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  let body: {
    tasks?: Array<{
      input?: string;
      system_prompt?: string;
      response_format?: string;
      response_schema?: Record<string, unknown>;
      file_ids?: string[];
    }>;
    callback_url?: string;
    callback_secret?: string;
    metadata?: Record<string, unknown>;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { tasks, callback_url, callback_secret, metadata } = body;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return c.json({ error: "tasks must be a non-empty array" }, 400);
  }

  if (tasks.length > MAX_TASKS_PER_BATCH) {
    return c.json({ error: `Maximum ${MAX_TASKS_PER_BATCH} tasks per batch` }, 400);
  }

  // Validate each task has input
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].input || typeof tasks[i].input !== "string") {
      return c.json({ error: `Task at index ${i} is missing a valid "input" string` }, 400);
    }
  }

  if (callback_url && typeof callback_url !== "string") {
    return c.json({ error: "callback_url must be a string" }, 400);
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();

  let sql;
  try {
    sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  } catch {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  try {
    // Create the batch job row
    await sql`
      INSERT INTO batch_jobs (batch_id, org_id, agent_name, status, total_tasks, completed_tasks, failed_tasks,
        callback_url, callback_secret, metadata_json, created_at, updated_at)
      VALUES (
        ${batchId}, ${orgId}, ${agentName}, 'pending', ${tasks.length}, 0, 0,
        ${callback_url || null}, ${callback_secret || null},
        ${metadata ? JSON.stringify(metadata) : null},
        ${now}, ${now}
      )
    `;

    // Create individual task rows
    for (let i = 0; i < tasks.length; i++) {
      const taskId = crypto.randomUUID();
      const task = tasks[i];
      await sql`
        INSERT INTO batch_tasks (task_id, batch_id, org_id, task_index, input, system_prompt,
          response_format, response_schema, file_ids_json, status, created_at, updated_at)
        VALUES (
          ${taskId}, ${batchId}, ${orgId}, ${i}, ${task.input!},
          ${task.system_prompt || null}, ${task.response_format || null},
          ${task.response_schema ? JSON.stringify(task.response_schema) : null},
          ${task.file_ids ? JSON.stringify(task.file_ids) : null},
          'pending', ${now}, ${now}
        )
      `;
    }

    // Enqueue the batch run job
    await c.env.JOB_QUEUE.send({
      type: "batch_run",
      payload: { batch_id: batchId, org_id: orgId, agent_name: agentName },
    });
  } catch (err) {
    console.error("Failed to create batch job:", err);
    return c.json({ error: "Failed to create batch job" }, 500);
  }

  return c.json(
    { batch_id: batchId, status: "pending", total_tasks: tasks.length },
    202,
  );
});

// ── GET /agents/:name/batches — List batch jobs ───────────────────────────

batchApiRoutes.get("/agents/:name/batches", async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const orgId = resolveOrgId(c);
  const agentName = c.req.param("name");

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  let sql;
  try {
    sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  } catch {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  try {
    const rows = await sql`
      SELECT batch_id, status, total_tasks, completed_tasks, failed_tasks,
             metadata_json, created_at, updated_at, completed_at
      FROM batch_jobs
      WHERE org_id = ${orgId} AND agent_name = ${agentName}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const batches = rows.map((r: any) => ({
      batch_id: r.batch_id,
      status: r.status,
      total_tasks: Number(r.total_tasks),
      completed_tasks: Number(r.completed_tasks),
      failed_tasks: Number(r.failed_tasks),
      metadata: r.metadata_json ? JSON.parse(String(r.metadata_json)) : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      completed_at: r.completed_at || null,
    }));

    return c.json({ batches, limit, offset });
  } catch (err) {
    console.error("Failed to list batch jobs:", err);
    return c.json({ error: "Failed to list batch jobs" }, 500);
  }
});

// ── GET /agents/:name/batches/:batch_id — Get batch status + results ──────

batchApiRoutes.get("/agents/:name/batches/:batch_id", async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const orgId = resolveOrgId(c);
  const agentName = c.req.param("name");
  const batchId = c.req.param("batch_id");

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  let sql;
  try {
    sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  } catch {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  try {
    // Fetch the batch job
    const batchRows = await sql`
      SELECT batch_id, status, total_tasks, completed_tasks, failed_tasks,
             callback_url, metadata_json, created_at, updated_at, completed_at, error
      FROM batch_jobs
      WHERE batch_id = ${batchId} AND org_id = ${orgId} AND agent_name = ${agentName}
      LIMIT 1
    `;

    if (batchRows.length === 0) {
      return c.json({ error: "Batch job not found" }, 404);
    }

    const batch = batchRows[0] as any;

    // Fetch individual task results
    const taskRows = await sql`
      SELECT task_id, task_index, input, status, output, session_id, cost_usd, latency_ms, error, created_at
      FROM batch_tasks
      WHERE batch_id = ${batchId} AND org_id = ${orgId}
      ORDER BY task_index ASC
    `;

    const tasks = taskRows.map((t: any) => ({
      task_id: t.task_id,
      task_index: Number(t.task_index),
      input: t.input,
      status: t.status,
      output: t.output || "",
      session_id: t.session_id || "",
      cost_usd: Number(t.cost_usd || 0),
      latency_ms: Number(t.latency_ms || 0),
      error: t.error || null,
      created_at: t.created_at,
    }));

    return c.json({
      batch_id: batch.batch_id,
      status: batch.status,
      total_tasks: Number(batch.total_tasks),
      completed_tasks: Number(batch.completed_tasks),
      failed_tasks: Number(batch.failed_tasks),
      metadata: batch.metadata_json ? JSON.parse(String(batch.metadata_json)) : null,
      error: batch.error || null,
      created_at: batch.created_at,
      updated_at: batch.updated_at,
      completed_at: batch.completed_at || null,
      tasks,
    });
  } catch (err) {
    console.error("Failed to get batch job:", err);
    return c.json({ error: "Failed to get batch job" }, 500);
  }
});

// ── DELETE /agents/:name/batches/:batch_id — Cancel a batch job ───────────

batchApiRoutes.delete("/agents/:name/batches/:batch_id", async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const orgId = resolveOrgId(c);
  const agentName = c.req.param("name");
  const batchId = c.req.param("batch_id");

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  let sql;
  try {
    sql = await getDbForOrg(c.env.HYPERDRIVE, orgId);
  } catch {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  try {
    // Only cancel if the batch is still pending or running
    const result = await sql`
      UPDATE batch_jobs
      SET status = 'cancelled', updated_at = ${new Date().toISOString()}
      WHERE batch_id = ${batchId} AND org_id = ${orgId} AND agent_name = ${agentName}
        AND status IN ('pending', 'running')
      RETURNING batch_id, status
    `;

    if (result.length === 0) {
      // Check if the batch exists at all
      const existing = await sql`
        SELECT status FROM batch_jobs
        WHERE batch_id = ${batchId} AND org_id = ${orgId} AND agent_name = ${agentName}
        LIMIT 1
      `;

      if (existing.length === 0) {
        return c.json({ error: "Batch job not found" }, 404);
      }

      return c.json(
        { error: `Batch job cannot be cancelled — current status: ${existing[0].status}` },
        409,
      );
    }

    // Cancel any pending tasks within the batch
    await sql`
      UPDATE batch_tasks
      SET status = 'cancelled', updated_at = ${new Date().toISOString()}
      WHERE batch_id = ${batchId} AND org_id = ${orgId} AND status = 'pending'
    `;

    return c.json({ batch_id: batchId, status: "cancelled" });
  } catch (err) {
    console.error("Failed to cancel batch job:", err);
    return c.json({ error: "Failed to cancel batch job" }, 500);
  }
});
