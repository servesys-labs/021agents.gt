/**
 * Schedules router — CRUD for scheduled agent runs with cron parsing.
 * Ported from agentos/api/routers/schedules.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses, ScheduleCreateBody } from "../schemas/openapi";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { parseCron } from "../logic/cron-parser";
import { requireScope } from "../middleware/auth";

export const scheduleRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── GET /schedules ──────────────────────────────────────────────────────

const listSchedulesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Schedules"],
  summary: "List all schedules",
  middleware: [requireScope("schedules:read")],
  responses: {
    200: {
      description: "List of schedules",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
  },
});
scheduleRoutes.openapi(listSchedulesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM schedules WHERE org_id = ${user.org_id} ORDER BY created_at DESC
  `;
  return c.json(
    rows.map((r: any) => ({
      schedule_id: r.schedule_id,
      agent_name: r.agent_name,
      cron: r.cron,
      task: r.task,
      is_enabled: Boolean(r.is_enabled),
      run_count: Number(r.run_count || 0),
      last_run_at: r.last_run_at || null,
    })),
  );
});

// ── POST /schedules ─────────────────────────────────────────────────────

const createScheduleRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Schedules"],
  summary: "Create a schedule",
  middleware: [requireScope("schedules:write")],
  request: {
    body: {
      content: {
        "application/json": { schema: ScheduleCreateBody },
      },
    },
  },
  responses: {
    200: {
      description: "Schedule created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
scheduleRoutes.openapi(createScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "").trim();
  const task = String(body.task || "").trim();
  const cron = String(body.cron || "").trim();

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);
  if (!cron) return c.json({ error: "cron is required" }, 400);

  try {
    parseCron(cron);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const scheduleId = genId();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO schedules (schedule_id, org_id, agent_name, task, cron, is_enabled, created_at)
    VALUES (${scheduleId}, ${user.org_id}, ${agentName}, ${task}, ${cron}, true, ${now})
  `;

  return c.json({ schedule_id: scheduleId, agent_name: agentName, cron, task });
});

// ── PUT /schedules/:schedule_id ─────────────────────────────────────────

const updateScheduleRoute = createRoute({
  method: "put",
  path: "/{schedule_id}",
  tags: ["Schedules"],
  summary: "Update a schedule",
  middleware: [requireScope("schedules:write")],
  request: {
    params: z.object({ schedule_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            cron: z.string().optional(),
            task: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Schedule updated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404),
  },
});
scheduleRoutes.openapi(updateScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { schedule_id: scheduleId } = c.req.valid("param");
  const body = c.req.valid("json");
  const cron = String(body.cron || "").trim();
  const task = String(body.task || "").trim();

  if (cron) {
    try {
      parseCron(cron);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Schedule not found" }, 404);

  if (cron && task) {
    await sql`UPDATE schedules SET cron = ${cron}, task = ${task} WHERE schedule_id = ${scheduleId}`;
  } else if (cron) {
    await sql`UPDATE schedules SET cron = ${cron} WHERE schedule_id = ${scheduleId}`;
  } else if (task) {
    await sql`UPDATE schedules SET task = ${task} WHERE schedule_id = ${scheduleId}`;
  }

  const updated = await sql`SELECT * FROM schedules WHERE schedule_id = ${scheduleId}`;
  const s = updated[0] as any;
  return c.json({
    schedule_id: s.schedule_id,
    agent_name: s.agent_name,
    cron: s.cron,
    task: s.task,
    is_enabled: Boolean(s.is_enabled),
    run_count: Number(s.run_count || 0),
    last_run_at: s.last_run_at || null,
  });
});

// ── GET /schedules/:schedule_id/history ─────────────────────────────────

const scheduleHistoryRoute = createRoute({
  method: "get",
  path: "/{schedule_id}/history",
  tags: ["Schedules"],
  summary: "Get schedule run history",
  middleware: [requireScope("schedules:read")],
  request: {
    params: z.object({ schedule_id: z.string() }),
  },
  responses: {
    200: {
      description: "Schedule history",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
scheduleRoutes.openapi(scheduleHistoryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { schedule_id: scheduleId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Schedule not found" }, 404);

  const s = rows[0] as any;
  return c.json({
    schedule_id: s.schedule_id,
    run_count: Number(s.run_count || 0),
    last_run: s.last_run_at || null,
    last_status: s.last_status || null,
    last_output: s.last_output || null,
  });
});

// ── DELETE /schedules/:schedule_id ──────────────────────────────────────

const deleteScheduleRoute = createRoute({
  method: "delete",
  path: "/{schedule_id}",
  tags: ["Schedules"],
  summary: "Delete a schedule",
  middleware: [requireScope("schedules:write")],
  request: {
    params: z.object({ schedule_id: z.string() }),
  },
  responses: {
    200: {
      description: "Schedule deleted",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
scheduleRoutes.openapi(deleteScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { schedule_id: scheduleId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (result.count === 0) return c.json({ error: "Schedule not found" }, 404);
  return c.json({ deleted: scheduleId });
});

// ── POST /schedules/:schedule_id/enable ─────────────────────────────────

const enableScheduleRoute = createRoute({
  method: "post",
  path: "/{schedule_id}/enable",
  tags: ["Schedules"],
  summary: "Enable a schedule",
  middleware: [requireScope("schedules:write")],
  request: {
    params: z.object({ schedule_id: z.string() }),
  },
  responses: {
    200: {
      description: "Schedule enabled",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
scheduleRoutes.openapi(enableScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { schedule_id: scheduleId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT schedule_id FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Schedule not found" }, 404);

  await sql`UPDATE schedules SET is_enabled = true WHERE schedule_id = ${scheduleId}`;
  return c.json({ enabled: true });
});

// ── POST /schedules/:schedule_id/disable ────────────────────────────────

const disableScheduleRoute = createRoute({
  method: "post",
  path: "/{schedule_id}/disable",
  tags: ["Schedules"],
  summary: "Disable a schedule",
  middleware: [requireScope("schedules:write")],
  request: {
    params: z.object({ schedule_id: z.string() }),
  },
  responses: {
    200: {
      description: "Schedule disabled",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
scheduleRoutes.openapi(disableScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { schedule_id: scheduleId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT schedule_id FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Schedule not found" }, 404);

  await sql`UPDATE schedules SET is_enabled = false WHERE schedule_id = ${scheduleId}`;
  return c.json({ enabled: false });
});
