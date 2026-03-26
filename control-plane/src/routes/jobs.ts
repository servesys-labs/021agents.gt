/**
 * Jobs router — async job queue with retries, idempotency, dead-letter.
 * Ported from agentos/api/routers/jobs.py
 *
 * Queue submission via c.env.JOB_QUEUE, status tracking in DB.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const jobRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

jobRoutes.post("/", requireScope("jobs:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const agentName = String(body.agent_name || "").trim();
  const task = String(body.task || "").trim();
  const idempotencyKey = String(body.idempotency_key || "");
  const maxRetries = Math.max(0, Math.min(10, Number(body.max_retries ?? 3)));
  const priority = Number(body.priority || 0);
  const scheduledAt = body.scheduled_at ? Number(body.scheduled_at) : null;

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);
  if (!task) return c.json({ error: "task is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const jobId = genId();
  const now = Date.now() / 1000;

  await sql`
    INSERT INTO job_queue (job_id, org_id, agent_name, task, idempotency_key, max_retries, priority, scheduled_at, status, created_at)
    VALUES (${jobId}, ${user.org_id}, ${agentName}, ${task}, ${idempotencyKey}, ${maxRetries}, ${priority}, ${scheduledAt}, 'pending', ${now})
  `;

  // Submit to Cloudflare Queue
  try {
    await c.env.JOB_QUEUE.send({
      job_id: jobId,
      agent_name: agentName,
      task,
      org_id: user.org_id,
      max_retries: maxRetries,
      priority,
    });
  } catch {
    // Queue submission is best-effort; job is tracked in DB
  }

  return c.json({ job_id: jobId, status: "pending" });
});

jobRoutes.get("/", requireScope("jobs:read"), async (c) => {
  const user = c.get("user");
  const status = c.req.query("status") || "";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (status) {
    rows = await sql`
      SELECT * FROM job_queue WHERE org_id = ${user.org_id} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM job_queue WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ jobs: rows });
});

jobRoutes.get("/dlq", requireScope("jobs:read"), async (c) => {
  const user = c.get("user");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM job_queue WHERE org_id = ${user.org_id} AND status = 'dead'
    ORDER BY created_at DESC LIMIT ${limit}
  `;
  return c.json({ jobs: rows });
});

jobRoutes.get("/:job_id", requireScope("jobs:read"), async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("job_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM job_queue WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
  return c.json(rows[0]);
});

jobRoutes.post("/:job_id/retry", requireScope("jobs:write"), async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("job_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT job_id FROM job_queue WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Job not found" }, 404);

  await sql`
    UPDATE job_queue SET status = 'pending', retries = 0 WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  return c.json({ retried: jobId });
});

jobRoutes.post("/:job_id/cancel", requireScope("jobs:write"), async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("job_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT status FROM job_queue WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
  if (!["pending", "running"].includes(rows[0].status)) {
    return c.json({ error: `Cannot cancel job with status '${rows[0].status}'` }, 409);
  }

  await sql`
    UPDATE job_queue SET status = 'cancelled' WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  return c.json({ cancelled: jobId });
});

jobRoutes.post("/:job_id/pause", requireScope("jobs:write"), async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("job_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT status FROM job_queue WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
  if (rows[0].status !== "pending") {
    return c.json({ error: `Cannot pause job with status '${rows[0].status}' — only pending jobs can be paused` }, 409);
  }

  await sql`
    UPDATE job_queue SET status = 'paused' WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  return c.json({ paused: jobId });
});

jobRoutes.post("/:job_id/resume", requireScope("jobs:write"), async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("job_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT status FROM job_queue WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
  if (rows[0].status !== "paused") {
    return c.json({ error: `Cannot resume job with status '${rows[0].status}' — only paused jobs can be resumed` }, 409);
  }

  await sql`
    UPDATE job_queue SET status = 'pending' WHERE job_id = ${jobId} AND org_id = ${user.org_id}
  `;
  return c.json({ resumed: jobId });
});
