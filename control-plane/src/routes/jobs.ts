/**
 * Jobs router — async job queue with retries, idempotency, dead-letter.
 * Ported from agentos/api/routers/jobs.py
 *
 * Queue submission via c.env.JOB_QUEUE, status tracking in DB.
 *
 * RLS: job_queue is org-scoped under withOrgDb. The redundant
 * `WHERE org_id = ${user.org_id}` clauses have been dropped — RLS
 * enforces tenant isolation via the GUC set inside the transaction.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";

export const jobRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── POST /jobs ──────────────────────────────────────────────────────────

const createJobRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Jobs"],
  summary: "Submit a new job",
  middleware: [requireScope("jobs:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            task: z.string().min(1),
            idempotency_key: z.string().optional(),
            max_retries: z.number().int().min(0).max(10).optional(),
            priority: z.number().optional(),
            scheduled_at: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Job submitted",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
jobRoutes.openapi(createJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "").trim();
  const task = String(body.task || "").trim();
  const idempotencyKey = String(body.idempotency_key || "");
  const maxRetries = Math.max(0, Math.min(10, Number(body.max_retries ?? 3)));
  const priority = Number(body.priority || 0);
  const scheduledAt = body.scheduled_at ? Number(body.scheduled_at) : null;

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);
  if (!task) return c.json({ error: "task is required" }, 400);

  const jobId = genId();
  const now = new Date().toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
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
});

// ── GET /jobs ───────────────────────────────────────────────────────────

const listJobsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Jobs"],
  summary: "List jobs",
  middleware: [requireScope("jobs:read")],
  request: {
    query: z.object({
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "List of jobs",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
jobRoutes.openapi(listJobsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const status = query.status || "";
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (status) {
      rows = await sql`
        SELECT * FROM job_queue WHERE status = ${status}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM job_queue
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }
    return c.json({ jobs: rows });
  });
});

// ── GET /jobs/dlq ───────────────────────────────────────────────────────

const listDlqRoute = createRoute({
  method: "get",
  path: "/dlq",
  tags: ["Jobs"],
  summary: "List dead-letter queue jobs",
  middleware: [requireScope("jobs:read")],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "Dead-letter queue jobs",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
jobRoutes.openapi(listDlqRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM job_queue WHERE status = 'dead'
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return c.json({ jobs: rows });
  });
});

// ── GET /jobs/:job_id ───────────────────────────────────────────────────

const getJobRoute = createRoute({
  method: "get",
  path: "/{job_id}",
  tags: ["Jobs"],
  summary: "Get a job by ID",
  middleware: [requireScope("jobs:read")],
  request: {
    params: z.object({ job_id: z.string() }),
  },
  responses: {
    200: {
      description: "Job details",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
jobRoutes.openapi(getJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id: jobId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM job_queue WHERE job_id = ${jobId}
    `;
    if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
    return c.json(rows[0]);
  });
});

// ── POST /jobs/:job_id/retry ────────────────────────────────────────────

const retryJobRoute = createRoute({
  method: "post",
  path: "/{job_id}/retry",
  tags: ["Jobs"],
  summary: "Retry a failed job",
  middleware: [requireScope("jobs:write")],
  request: {
    params: z.object({ job_id: z.string() }),
  },
  responses: {
    200: {
      description: "Job retried",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
jobRoutes.openapi(retryJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id: jobId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT job_id FROM job_queue WHERE job_id = ${jobId}
    `;
    if (rows.length === 0) return c.json({ error: "Job not found" }, 404);

    await sql`
      UPDATE job_queue SET status = 'pending', attempts = 0 WHERE job_id = ${jobId}
    `;
    return c.json({ retried: jobId });
  });
});

// ── POST /jobs/:job_id/cancel ───────────────────────────────────────────

const cancelJobRoute = createRoute({
  method: "post",
  path: "/{job_id}/cancel",
  tags: ["Jobs"],
  summary: "Cancel a pending or running job",
  middleware: [requireScope("jobs:write")],
  request: {
    params: z.object({ job_id: z.string() }),
  },
  responses: {
    200: {
      description: "Job cancelled",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404, 409),
  },
});
jobRoutes.openapi(cancelJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id: jobId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT status FROM job_queue WHERE job_id = ${jobId}
    `;
    if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
    if (!["pending", "running"].includes(rows[0].status)) {
      return c.json({ error: `Cannot cancel job with status '${rows[0].status}'` }, 409);
    }

    await sql`
      UPDATE job_queue SET status = 'cancelled' WHERE job_id = ${jobId}
    `;
    return c.json({ cancelled: jobId });
  });
});

// ── POST /jobs/:job_id/pause ────────────────────────────────────────────

const pauseJobRoute = createRoute({
  method: "post",
  path: "/{job_id}/pause",
  tags: ["Jobs"],
  summary: "Pause a pending job",
  middleware: [requireScope("jobs:write")],
  request: {
    params: z.object({ job_id: z.string() }),
  },
  responses: {
    200: {
      description: "Job paused",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404, 409),
  },
});
jobRoutes.openapi(pauseJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id: jobId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT status FROM job_queue WHERE job_id = ${jobId}
    `;
    if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
    if (rows[0].status !== "pending") {
      return c.json({ error: `Cannot pause job with status '${rows[0].status}' — only pending jobs can be paused` }, 409);
    }

    await sql`
      UPDATE job_queue SET status = 'paused' WHERE job_id = ${jobId}
    `;
    return c.json({ paused: jobId });
  });
});

// ── POST /jobs/:job_id/resume ───────────────────────────────────────────

const resumeJobRoute = createRoute({
  method: "post",
  path: "/{job_id}/resume",
  tags: ["Jobs"],
  summary: "Resume a paused job",
  middleware: [requireScope("jobs:write")],
  request: {
    params: z.object({ job_id: z.string() }),
  },
  responses: {
    200: {
      description: "Job resumed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404, 409),
  },
});
jobRoutes.openapi(resumeJobRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { job_id: jobId } = c.req.valid("param");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT status FROM job_queue WHERE job_id = ${jobId}
    `;
    if (rows.length === 0) return c.json({ error: "Job not found" }, 404);
    if (rows[0].status !== "paused") {
      return c.json({ error: `Cannot resume job with status '${rows[0].status}' — only paused jobs can be resumed` }, 409);
    }

    await sql`
      UPDATE job_queue SET status = 'pending' WHERE job_id = ${jobId}
    `;
    return c.json({ resumed: jobId });
  });
});
