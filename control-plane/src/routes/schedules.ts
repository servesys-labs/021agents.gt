/**
 * Schedules router — CRUD for scheduled agent runs with cron parsing.
 * Ported from agentos/api/routers/schedules.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { parseCron } from "../logic/cron-parser";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const scheduleRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

scheduleRoutes.get("/", requireScope("schedules:read"), async (c) => {
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

scheduleRoutes.post("/", requireScope("schedules:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
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
  const now = Date.now() / 1000;

  await sql`
    INSERT INTO schedules (schedule_id, org_id, agent_name, task, cron, is_enabled, created_at)
    VALUES (${scheduleId}, ${user.org_id}, ${agentName}, ${task}, ${cron}, true, ${now})
  `;

  return c.json({ schedule_id: scheduleId, agent_name: agentName, cron, task });
});

scheduleRoutes.put("/:schedule_id", requireScope("schedules:write"), async (c) => {
  const user = c.get("user");
  const scheduleId = c.req.param("schedule_id");
  const body = await c.req.json();
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

scheduleRoutes.get("/:schedule_id/history", requireScope("schedules:read"), async (c) => {
  const user = c.get("user");
  const scheduleId = c.req.param("schedule_id");
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

scheduleRoutes.delete("/:schedule_id", requireScope("schedules:write"), async (c) => {
  const user = c.get("user");
  const scheduleId = c.req.param("schedule_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (result.count === 0) return c.json({ error: "Schedule not found" }, 404);
  return c.json({ deleted: scheduleId });
});

scheduleRoutes.post("/:schedule_id/enable", requireScope("schedules:write"), async (c) => {
  const user = c.get("user");
  const scheduleId = c.req.param("schedule_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT schedule_id FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Schedule not found" }, 404);

  await sql`UPDATE schedules SET is_enabled = true WHERE schedule_id = ${scheduleId}`;
  return c.json({ enabled: true });
});

scheduleRoutes.post("/:schedule_id/disable", requireScope("schedules:write"), async (c) => {
  const user = c.get("user");
  const scheduleId = c.req.param("schedule_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT schedule_id FROM schedules WHERE schedule_id = ${scheduleId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Schedule not found" }, 404);

  await sql`UPDATE schedules SET is_enabled = false WHERE schedule_id = ${scheduleId}`;
  return c.json({ enabled: false });
});
