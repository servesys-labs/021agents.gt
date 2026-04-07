/**
 * Autopilot routes — manage always-on autonomous agent sessions.
 *
 * Kairos-inspired: agents run proactively with periodic ticks.
 * Ticks are driven by the control-plane cron (every minute) which
 * calls the runtime DO's autopilotTick() method.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDb } from "../db/client";

export const autopilotRoutes = createOpenAPIRouter();

const AutopilotSessionSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  agent_name: z.string(),
  channel: z.string(),
  status: z.enum(["active", "paused", "stopped"]),
  tick_interval_seconds: z.number(),
  last_tick_at: z.string().nullable(),
  tick_count: z.number(),
  total_cost_usd: z.number(),
});

const DEFAULT_SYSTEM_ADDENDUM = `## Autopilot Mode Active
You are running in autonomous mode. Between user messages, you receive periodic <tick> signals.
On each tick, you may:
- Check for pending tasks or notifications
- Proactively suggest actions based on context
- Run background checks (health, cost, status)
- Stay silent if there's nothing useful to report

Rules:
- Keep responses brief (1-3 sentences max)
- Only speak when you have something actionable
- Never repeat information you've already shared
- Prefix proactive messages with [autopilot]`;

// POST /autopilot/start — start an autopilot session
const startRoute = createRoute({
  method: "post",
  path: "/start",
  tags: ["Autopilot"],
  summary: "Start an autopilot session for an agent",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            channel: z.enum(["web", "telegram", "discord", "slack", "whatsapp"]).default("web"),
            channel_user_id: z.string().default(""),
            tick_interval_seconds: z.number().min(10).max(3600).default(30),
            system_addendum: z.string().optional(),
            config: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Autopilot session started", content: { "application/json": { schema: AutopilotSessionSchema } } },
    ...errorResponses(400, 401, 409, 500),
  },
});

autopilotRoutes.openapi(startRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDb(c.env.HYPERDRIVE);

  // Check if already active
  const existing = await sql`
    SELECT id, status FROM autopilot_sessions
    WHERE org_id = ${user.org_id} AND agent_name = ${body.agent_name}
      AND channel = ${body.channel} AND channel_user_id = ${body.channel_user_id || ""}
      AND status = 'active'
    LIMIT 1
  `;
  if (existing.length > 0) {
    return c.json({ error: "Autopilot already active for this agent/channel", id: existing[0].id }, 409);
  }

  const addendum = body.system_addendum || DEFAULT_SYSTEM_ADDENDUM;
  const now = new Date().toISOString();

  const rows = await sql`
    INSERT INTO autopilot_sessions (org_id, agent_name, channel, channel_user_id, tick_interval_seconds, system_addendum, config, created_at, updated_at)
    VALUES (${user.org_id}, ${body.agent_name}, ${body.channel}, ${body.channel_user_id || ""}, ${body.tick_interval_seconds}, ${addendum}, ${JSON.stringify(body.config || {})}, ${now}, ${now})
    ON CONFLICT (org_id, agent_name, channel, channel_user_id) DO UPDATE SET
      status = 'active', tick_interval_seconds = EXCLUDED.tick_interval_seconds,
      system_addendum = EXCLUDED.system_addendum, config = EXCLUDED.config,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;

  return c.json(rows[0]);
});

// POST /autopilot/stop — stop an autopilot session
const stopRoute = createRoute({
  method: "post",
  path: "/stop",
  tags: ["Autopilot"],
  summary: "Stop an autopilot session",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            channel: z.string().default("web"),
            channel_user_id: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Autopilot stopped" },
    ...errorResponses(400, 401, 404, 500),
  },
});

autopilotRoutes.openapi(stopRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const sql = await getDb(c.env.HYPERDRIVE);

  const rows = await sql`
    UPDATE autopilot_sessions SET status = 'stopped', updated_at = NOW()
    WHERE org_id = ${user.org_id} AND agent_name = ${body.agent_name}
      AND channel = ${body.channel} AND channel_user_id = ${body.channel_user_id || ""}
      AND status = 'active'
    RETURNING id
  `;
  if (rows.length === 0) return c.json({ error: "No active autopilot session found" }, 404);
  return c.json({ stopped: true, id: rows[0].id });
});

// GET /autopilot/status — get autopilot sessions for the org
const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Autopilot"],
  summary: "List active autopilot sessions",
  responses: {
    200: { description: "Autopilot sessions", content: { "application/json": { schema: z.object({ sessions: z.array(AutopilotSessionSchema) }) } } },
    ...errorResponses(401, 500),
  },
});

autopilotRoutes.openapi(statusRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDb(c.env.HYPERDRIVE);

  const rows = await sql`
    SELECT * FROM autopilot_sessions
    WHERE org_id = ${user.org_id} AND status IN ('active', 'paused')
    ORDER BY updated_at DESC
    LIMIT 50
  `;
  return c.json({ sessions: rows });
});

// ── Events Endpoint — returns recent tick outputs for a session ──

const eventsRoute = createRoute({
  method: "get",
  path: "/events",
  tags: ["Autopilot"],
  summary: "Get recent autopilot events for an agent",
  request: {
    query: z.object({
      agent_name: z.string().min(1),
      channel: z.string().default("web"),
    }),
  },
  responses: {
    200: {
      description: "Recent autopilot events",
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(z.object({
              content: z.string(),
              tick: z.number(),
              timestamp: z.number(),
            })),
          }),
        },
      },
    },
    ...errorResponses(401, 500),
  },
});

autopilotRoutes.openapi(eventsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name, channel } = c.req.valid("query");
  const sql = await getDb(c.env.HYPERDRIVE);

  // Get the session to verify ownership
  const sessions = await sql`
    SELECT id, tick_count, total_cost_usd FROM autopilot_sessions
    WHERE org_id = ${user.org_id} AND agent_name = ${agent_name}
      AND channel = ${channel} AND status = 'active'
    LIMIT 1
  `;
  if (sessions.length === 0) {
    return c.json({ events: [] });
  }

  // Fetch recent turns for this agent's autopilot sessions
  const rows = await sql`
    SELECT t.llm_content as content, t.turn_number as tick, t.created_at
    FROM turns t
    JOIN sessions s ON t.session_id = s.session_id
    WHERE s.org_id = ${user.org_id} AND s.agent_name = ${agent_name}
      AND s.channel = ${channel}
      AND t.created_at > now() - interval '1 hour'
    ORDER BY t.created_at DESC
    LIMIT 20
  `;

  return c.json({
    events: rows.map((r: any) => ({
      content: r.content || "",
      tick: Number(r.tick) || 0,
      timestamp: new Date(r.created_at).getTime(),
    })),
  });
});

// ── Cron Tick Handler (Queue Fan-Out) ───────────────────────────
//
// SCALING ARCHITECTURE:
//
//   Cron (1/min) → SELECT due sessions → send to JOB_QUEUE → Queue consumer processes
//                  (1 DB query, <10ms)    (N messages, ~1ms each)  (parallel, 10 at a time)
//
// This pattern scales to 10,000+ agents because:
//   1. Cron handler does O(1) work: one paginated query + N queue.send() calls
//   2. Queue.send() is non-blocking (~1ms each, can send 1000s in 30s)
//   3. Queue consumer runs in SEPARATE Worker invocations (not the cron handler)
//   4. CF Queues auto-scale consumers: max_batch_size=10, max_concurrency=10
//   5. Each consumer batch processes 10 ticks in parallel (Promise.all)
//   6. Failed ticks auto-retry via queue retry policy (3 retries + DLQ)
//
// At 10K agents: cron sends 10K queue messages in ~10s. Queue processes
// them across ~100 parallel consumer invocations over ~2 minutes.
//
// At 100K agents: cron paginates (1000/page), sends in <30s. Queue
// processes across ~1000 consumer invocations over ~5 minutes.

const DISPATCH_PAGE_SIZE = 500; // Sessions per DB query page

export async function tickAutopilotSessions(env: any): Promise<{ dispatched: number; pages: number }> {
  let dispatched = 0;
  let pages = 0;

  try {
    const { getDb: getDbFn } = await import("../db/client");
    const sql = await getDbFn(env.HYPERDRIVE);
    const queue = env.JOB_QUEUE;
    if (!queue) return { dispatched: 0, pages: 0 };

    // Paginated dispatch: fetch due sessions in batches and fan out to queue
    let hasMore = true;
    let lastId = "";

    while (hasMore) {
      const sessions = lastId
        ? await sql`
            SELECT id, org_id, agent_name, channel, channel_user_id, tick_interval_seconds, tick_count, system_addendum, config
            FROM autopilot_sessions
            WHERE status = 'active'
              AND (last_tick_at IS NULL OR last_tick_at + make_interval(secs => tick_interval_seconds) < NOW())
              AND id > ${lastId}
            ORDER BY id ASC
            LIMIT ${DISPATCH_PAGE_SIZE}
          `
        : await sql`
            SELECT id, org_id, agent_name, channel, channel_user_id, tick_interval_seconds, tick_count, system_addendum, config
            FROM autopilot_sessions
            WHERE status = 'active'
              AND (last_tick_at IS NULL OR last_tick_at + make_interval(secs => tick_interval_seconds) < NOW())
            ORDER BY id ASC
            LIMIT ${DISPATCH_PAGE_SIZE}
          `;

      pages++;
      hasMore = sessions.length === DISPATCH_PAGE_SIZE;
      if (sessions.length === 0) break;
      lastId = sessions[sessions.length - 1].id;

      // Optimistically mark as ticked (prevents re-dispatch on next cron)
      const ids = sessions.map((s: any) => s.id);
      await sql`
        UPDATE autopilot_sessions
        SET last_tick_at = NOW(), tick_count = tick_count + 1, updated_at = NOW()
        WHERE id = ANY(${ids})
      `;

      // Fan out to queue — batch send for efficiency
      // CF Queue.send() is fast (~1ms) so even 500 sends complete in <1s
      await Promise.all(sessions.map((session: any) =>
        queue.send({
          type: "autopilot_tick",
          payload: {
            session_id: session.id,
            org_id: session.org_id,
            agent_name: session.agent_name,
            channel: session.channel,
            channel_user_id: session.channel_user_id || "",
            tick_count: (session.tick_count || 0) + 1,
            system_addendum: session.system_addendum || "",
            config: session.config,
          },
        })
      ));

      dispatched += sessions.length;

      // Safety: don't exceed 30s cron budget
      if (pages > 20) break; // 20 pages × 500 = 10K sessions max per cron cycle
    }

    // Dream memory consolidation: run for sessions that have been idle 10+ minutes
    try {
      const idleSessions = await sql`
        SELECT DISTINCT org_id, agent_name FROM autopilot_sessions
        WHERE status = 'active' AND last_tick_at < NOW() - INTERVAL '10 minutes'
        LIMIT 5
      `;
      for (const session of idleSessions) {
        await queue.send({
          type: "memory_consolidation",
          payload: { org_id: session.org_id, agent_name: session.agent_name },
        });
      }
    } catch {}
  } catch {
    // DB unavailable — skip this tick cycle
  }

  return { dispatched, pages };
}

/**
 * Process a single autopilot tick. Called by the queue consumer.
 * This runs in a SEPARATE Worker invocation from the cron handler,
 * allowing parallel processing across many consumer instances.
 */
export async function processAutopilotTick(
  env: any,
  payload: {
    session_id: string;
    org_id: string;
    agent_name: string;
    channel: string;
    channel_user_id: string;
    tick_count: number;
    system_addendum: string;
    config: any;
  },
): Promise<void> {
  const tickPrompt = buildTickPrompt(payload.tick_count);

  // Invoke agent via RUNTIME service binding
  const resp = await env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/runnable/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_name: payload.agent_name,
      input: tickPrompt,
      channel: `autopilot-${payload.channel}`,
      channel_user_id: payload.channel_user_id,
      org_id: payload.org_id,
      system_prompt_override: payload.system_addendum,
      wait: true,
    }),
  });
  const result = await resp.json() as any;
  const output = result.output || "";
  const costUsd = result.cost_usd || 0;

  // Update cost (tick_count already updated optimistically)
  if (costUsd > 0) {
    try {
      const { getDb: getDbFn } = await import("../db/client");
      const sql = await getDbFn(env.HYPERDRIVE);
      await sql`
        UPDATE autopilot_sessions SET total_cost_usd = total_cost_usd + ${costUsd}, updated_at = NOW()
        WHERE id = ${payload.session_id}
      `;
    } catch {}
  }

  // Push non-empty output to channel
  if (output.trim() && output.trim() !== "(No output)") {
    try {
      const { getDb: getDbFn } = await import("../db/client");
      const sql = await getDbFn(env.HYPERDRIVE);
      await pushToChannel(env, sql, { ...payload, config: payload.config }, output);
    } catch {}
  }
}

function buildTickPrompt(tickNum: number): string {
  const now = new Date().toISOString();
  if (tickNum % 10 === 0) {
    return `<tick n="${tickNum}" time="${now}" type="status_check">Check system health, pending tasks, and cost status. Report only if something needs attention.</tick>`;
  }
  if (tickNum % 5 === 0) {
    return `<tick n="${tickNum}" time="${now}" type="summary">Briefly summarize what you've accomplished and what's pending. One sentence max.</tick>`;
  }
  return `<tick n="${tickNum}" time="${now}" type="heartbeat">Any pending work or observations? Stay silent if nothing to report.</tick>`;
}

async function pushToChannel(env: any, sql: any, session: any, output: string): Promise<void> {
  const config = typeof session.config === "string" ? JSON.parse(session.config) : (session.config || {});

  // Write to KV for web UI polling
  const kv = env.AGENT_PROGRESS_KV;
  if (kv) {
    const key = `autopilot/${session.org_id}/${session.agent_name}/${session.channel}`;
    const existing = await kv.get(key).catch(() => null);
    const events = existing ? JSON.parse(existing) : [];
    events.push({
      type: "autopilot_message",
      content: output,
      tick: session.tick_count + 1,
      timestamp: Date.now(),
    });
    // Keep last 50 events, 1h TTL
    await kv.put(key, JSON.stringify(events.slice(-50)), { expirationTtl: 3600 });
  }

  // Push to Telegram
  if (session.channel === "telegram" && config.chat_id) {
    try {
      const token = await getSecretValue(sql, "TELEGRAM_BOT_TOKEN", session.org_id);
      if (token) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: config.chat_id, text: `[autopilot] ${output}`, parse_mode: "Markdown" }),
        });
      }
    } catch {}
  }

  // Push to Discord
  if (session.channel === "discord" && config.webhook_url) {
    try {
      await fetch(config.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `**[autopilot]** ${output}` }),
      });
    } catch {}
  }

  // Push to Slack
  if (session.channel === "slack" && config.webhook_url) {
    try {
      await fetch(config.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `[autopilot] ${output}` }),
      });
    } catch {}
  }
}

async function getSecretValue(sql: any, name: string, orgId: string): Promise<string> {
  try {
    const rows = await sql`
      SELECT value_encrypted FROM secrets WHERE name = ${name} AND org_id = ${orgId}
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows.length > 0 ? String(rows[0].value_encrypted) : "";
  } catch { return ""; }
}
