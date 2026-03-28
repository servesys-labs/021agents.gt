/**
 * Voice router — Vapi call listing/detail, platform calls, cross-platform summary.
 * Ported from agentos/api/routers/voice_webhooks.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDb, getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  isVoiceGenericPlatform,
  processTavusWebhook,
  processVapiWebhook,
  verifyWebhookHmac,
  VOICE_GENERIC_PLATFORMS,
} from "../logic/voice-webhook";

export const voiceRoutes = createOpenAPIRouter();

function nowSec(): string {
  return new Date().toISOString();
}

// ── Cross-platform Summary ─────────────────────────────────────────────

const allSummaryRoute = createRoute({
  method: "get",
  path: "/all/summary",
  tags: ["Voice"],
  summary: "Cross-platform voice call summary",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: {
      description: "Summary across all voice platforms",
      content: {
        "application/json": {
          schema: z.object({
            vapi: z.record(z.unknown()),
            platforms: z.record(z.unknown()),
            total_calls: z.number(),
            total_cost_usd: z.number(),
            total_duration_seconds: z.number(),
          }),
        },
      },
    },
  },
});
voiceRoutes.openapi(allSummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let vapiSummary: any = { total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 };
  try {
    const [vapi] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
    `;
    vapiSummary = vapi;
  } catch {
    /* table may be missing in dev */
  }

  let platformSummary: any = { total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 };
  try {
    const [all] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform != 'vapi' AND org_id = ${user.org_id}
    `;
    platformSummary = all;
  } catch {
    /* best-effort */
  }

  return c.json({
    vapi: vapiSummary,
    platforms: platformSummary,
    total_calls: Number(vapiSummary.total_calls) + Number(platformSummary.total_calls),
    total_cost_usd:
      Math.round(
        (Number(vapiSummary.total_cost_usd) + Number(platformSummary.total_cost_usd)) * 10000,
      ) / 10000,
    total_duration_seconds:
      Math.round(
        (Number(vapiSummary.total_duration_seconds) +
          Number(platformSummary.total_duration_seconds)) *
          10,
      ) / 10,
  });
});

// ── Vapi webhook (public — signature optional) ─────────────────────────

const vapiWebhookRoute = createRoute({
  method: "post",
  path: "/vapi/webhook",
  tags: ["Voice"],
  summary: "Receive Vapi webhook events",
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401),
  },
});
voiceRoutes.openapi(vapiWebhookRoute, async (c): Promise<any> => {
  const body = await c.req.arrayBuffer();
  const secret = c.env.VAPI_WEBHOOK_SECRET ?? "";
  const sig = c.req.header("x-vapi-signature") ?? "";
  if (!(await verifyWebhookHmac(secret, body, sig))) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const sql = await getDb(c.env.HYPERDRIVE);
  const out = await processVapiWebhook(payload, sql, "");
  return c.json(out);
});

// ── Vapi Calls ─────────────────────────────────────────────────────────

const vapiCallsListRoute = createRoute({
  method: "get",
  path: "/vapi/calls",
  tags: ["Voice"],
  summary: "List Vapi calls",
  middleware: [requireScope("integrations:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: "Call list",
      content: { "application/json": { schema: z.object({ calls: z.array(z.record(z.unknown())) }) } },
    },
  },
});
voiceRoutes.openapi(vapiCallsListRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, status, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName && status) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
        AND agent_name = ${agentName} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
        AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (status) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
        AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ calls: rows });
});

// ── Vapi Calls Summary ─────────────────────────────────────────────────

const vapiCallsSummaryRoute = createRoute({
  method: "get",
  path: "/vapi/calls/summary",
  tags: ["Voice"],
  summary: "Get Vapi calls summary",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: {
      description: "Vapi call summary",
      content: {
        "application/json": {
          schema: z.object({
            total_calls: z.number(),
            total_cost_usd: z.number(),
            total_duration_seconds: z.number(),
          }),
        },
      },
    },
  },
});
voiceRoutes.openapi(vapiCallsSummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    const [summary] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
    `;
    return c.json(summary);
  } catch {
    return c.json({ total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 });
  }
});

// ── POST Vapi Calls (initiate outbound) ────────────────────────────────

const vapiCallsCreateRoute = createRoute({
  method: "post",
  path: "/vapi/calls",
  tags: ["Voice"],
  summary: "Initiate outbound Vapi call",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            phone_number: z.string().default(""),
            assistant_id: z.string().default(""),
            agent_name: z.string().default(""),
            first_message: z.string().default(""),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Call initiated",
      content: {
        "application/json": {
          schema: z.object({
            call_id: z.string(),
            status: z.string(),
            vapi_response: z.record(z.unknown()),
          }),
        },
      },
    },
    ...errorResponses(400),
  },
});
voiceRoutes.openapi(vapiCallsCreateRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const apiKey = c.env.VAPI_API_KEY ?? "";
  if (!apiKey) {
    return c.json({ error: "VAPI_API_KEY not configured" }, 400);
  }
  const body = c.req.valid("json");
  const phone_number = body.phone_number;
  const assistant_id = body.assistant_id;
  const agent_name = body.agent_name;
  const first_message = body.first_message;

  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumberId: phone_number,
      ...(assistant_id ? { assistantId: assistant_id } : {}),
      ...(first_message ? { firstMessage: first_message } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    return c.json(
      { error: `Vapi API error: ${res.status} ${text.slice(0, 300)}` },
      400,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Vapi API returned non-JSON" }, 400);
  }
  const call_id = String(data.id ?? "");
  if (!call_id) {
    return c.json({ error: "Vapi API response missing call id" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await sql`
      INSERT INTO voice_calls (
        call_id, platform, org_id, agent_name, phone_number, direction, status,
        platform_agent_id, started_at
      ) VALUES (
        ${call_id}, 'vapi', ${user.org_id}, ${agent_name}, ${phone_number},
        'outbound', 'pending', ${assistant_id}, ${nowSec()}
      )
      ON CONFLICT (call_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        agent_name = EXCLUDED.agent_name,
        phone_number = EXCLUDED.phone_number,
        status = EXCLUDED.status,
        platform_agent_id = EXCLUDED.platform_agent_id
    `;
  } catch {
    /* best-effort */
  }

  return c.json({ call_id, status: "initiated", vapi_response: data });
});

// ── DELETE Vapi Call ────────────────────────────────────────────────────

const vapiCallDeleteRoute = createRoute({
  method: "delete",
  path: "/vapi/calls/{call_id}",
  tags: ["Voice"],
  summary: "End a Vapi call",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call ended",
      content: { "application/json": { schema: z.object({ ended: z.boolean(), call_id: z.string() }) } },
    },
    ...errorResponses(400),
  },
});
voiceRoutes.openapi(vapiCallDeleteRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { call_id: callId } = c.req.valid("param");
  const apiKey = c.env.VAPI_API_KEY ?? "";
  if (!apiKey) {
    return c.json({ error: "VAPI_API_KEY not configured" }, 400);
  }
  const res = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (![200, 204].includes(res.status)) {
    return c.json({ error: `Vapi API error: ${res.status}` }, 400);
  }
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await sql`
      UPDATE voice_calls SET status = 'ended', ended_at = ${nowSec()}
      WHERE call_id = ${callId} AND platform = 'vapi'
    `;
  } catch {
    /* best-effort */
  }
  return c.json({ ended: true, call_id: callId });
});

// ── GET Vapi Call Detail ───────────────────────────────────────────────

const vapiCallDetailRoute = createRoute({
  method: "get",
  path: "/vapi/calls/{call_id}",
  tags: ["Voice"],
  summary: "Get Vapi call detail",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(vapiCallDetailRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { call_id: callId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM voice_calls
    WHERE call_id = ${callId} AND platform = 'vapi' AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Call not found" }, 404);
  return c.json(rows[0]);
});

// ── GET Vapi Call Events ───────────────────────────────────────────────

const vapiCallEventsRoute = createRoute({
  method: "get",
  path: "/vapi/calls/{call_id}/events",
  tags: ["Voice"],
  summary: "Get Vapi call events",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call events",
      content: { "application/json": { schema: z.object({ events: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(vapiCallEventsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { call_id: callId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const own = await sql`
    SELECT 1 FROM voice_calls
    WHERE call_id = ${callId} AND platform = 'vapi' AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (own.length === 0) return c.json({ error: "Call not found" }, 404);
  const rows = await sql`
    SELECT e.* FROM voice_call_events e
    INNER JOIN voice_calls vc ON vc.call_id = e.call_id
    WHERE e.call_id = ${callId} AND vc.org_id = ${user.org_id} AND vc.platform = 'vapi'
    ORDER BY e.created_at
  `;
  return c.json({ events: rows });
});

// ── Generic platform webhook (e.g. Tavus) ──────────────────────────────

const platformWebhookRoute = createRoute({
  method: "post",
  path: "/{platform}/webhook",
  tags: ["Voice"],
  summary: "Receive webhook events for a voice platform",
  request: {
    params: z.object({ platform: z.string() }),
  },
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 404),
  },
});
voiceRoutes.openapi(platformWebhookRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const cfg = VOICE_GENERIC_PLATFORMS[platform];
  const body = await c.req.arrayBuffer();
  const secret =
    platform === "tavus" ? (c.env.TAVUS_WEBHOOK_SECRET ?? "") : "";
  const sigHeader = c.req.header(cfg.signatureHeader) ?? "";
  if (!(await verifyWebhookHmac(secret, body, sigHeader))) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const sql = await getDb(c.env.HYPERDRIVE);
  if (platform === "tavus") {
    const out = await processTavusWebhook(payload, sql, "");
    return c.json(out);
  }
  return c.json({ error: "Unsupported platform" }, 400);
});

// ── Generic Platform Calls Summary ─────────────────────────────────────

const platformCallsSummaryRoute = createRoute({
  method: "get",
  path: "/{platform}/calls/summary",
  tags: ["Voice"],
  summary: "Get call summary for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string() }),
  },
  responses: {
    200: {
      description: "Call summary",
      content: {
        "application/json": {
          schema: z.object({
            total_calls: z.number(),
            total_cost_usd: z.number(),
            total_duration_seconds: z.number(),
          }),
        },
      },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallsSummaryRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    const [summary] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
    `;
    return c.json(summary);
  } catch {
    return c.json({ total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 });
  }
});

// ── Generic Platform Calls List ────────────────────────────────────────

const platformCallsListRoute = createRoute({
  method: "get",
  path: "/{platform}/calls",
  tags: ["Voice"],
  summary: "List calls for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string() }),
    query: z.object({
      agent_name: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: "Call list",
      content: { "application/json": { schema: z.object({ calls: z.array(z.record(z.unknown())), platform: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallsListRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const { agent_name: agentName, status, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName && status) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
        AND agent_name = ${agentName} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
        AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ calls: rows, platform });
});

// ── Generic Platform Create Call ───────────────────────────────────────

const platformCallCreateRoute = createRoute({
  method: "post",
  path: "/{platform}/calls",
  tags: ["Voice"],
  summary: "Initiate a call on a voice platform",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ platform: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            persona_id: z.string().default(""),
            context: z.string().default(""),
            agent_name: z.string().default(""),
            properties: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Call initiated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404),
  },
});
voiceRoutes.openapi(platformCallCreateRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  if (platform !== "tavus") {
    return c.json({ error: `Create not supported for ${platform}` }, 400);
  }

  const user = c.get("user");
  const apiKey = c.env.TAVUS_API_KEY ?? "";
  if (!apiKey) {
    return c.json({ error: "TAVUS_API_KEY not configured" }, 400);
  }

  const body = c.req.valid("json");
  const persona_id = body.persona_id;
  const context = body.context;
  const agent_name = body.agent_name;
  const properties = body.properties;

  const reqBody: Record<string, unknown> = { persona_id };
  if (context) reqBody.conversational_context = context;
  if (properties && Object.keys(properties).length > 0) reqBody.properties = properties;

  const res = await fetch("https://api.tavus.io/v2/conversations", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });
  const text = await res.text();
  if (![200, 201].includes(res.status)) {
    return c.json(
      { error: `Tavus API error: ${res.status} ${text.slice(0, 300)}` },
      400,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Tavus API returned non-JSON" }, 400);
  }
  const conversation_id = String(
    data.conversation_id ?? data.id ?? "",
  );
  if (!conversation_id) {
    return c.json({ error: "Tavus API response missing conversation id" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await sql`
      INSERT INTO voice_calls (
        call_id, platform, org_id, agent_name, phone_number, direction, status,
        platform_agent_id, started_at
      ) VALUES (
        ${conversation_id}, 'tavus', ${user.org_id}, ${agent_name}, '',
        'outbound', 'pending', ${persona_id}, ${nowSec()}
      )
      ON CONFLICT (call_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        agent_name = EXCLUDED.agent_name,
        status = EXCLUDED.status,
        platform_agent_id = EXCLUDED.platform_agent_id
    `;
  } catch {
    /* best-effort */
  }

  return c.json({
    conversation_id,
    status: "initiated",
    tavus_response: data,
  });
});

// ── Generic Platform Call Detail ───────────────────────────────────────

const platformCallDetailRoute = createRoute({
  method: "get",
  path: "/{platform}/calls/{call_id}",
  tags: ["Voice"],
  summary: "Get call detail for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string(), call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallDetailRoute, async (c): Promise<any> => {
  const { platform, call_id: callId } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM voice_calls
    WHERE call_id = ${callId} AND platform = ${platform} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Call not found" }, 404);
  return c.json(rows[0]);
});

// ── Generic Platform Call Events ───────────────────────────────────────

const platformCallEventsRoute = createRoute({
  method: "get",
  path: "/{platform}/calls/{call_id}/events",
  tags: ["Voice"],
  summary: "Get call events for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string(), call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call events",
      content: { "application/json": { schema: z.object({ events: z.array(z.record(z.unknown())), platform: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallEventsRoute, async (c): Promise<any> => {
  const { platform, call_id: callId } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const own = await sql`
    SELECT 1 FROM voice_calls
    WHERE call_id = ${callId} AND platform = ${platform} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (own.length === 0) return c.json({ error: "Call not found" }, 404);
  const rows = await sql`
    SELECT e.* FROM voice_call_events e
    INNER JOIN voice_calls vc ON vc.call_id = e.call_id
    WHERE e.call_id = ${callId} AND vc.org_id = ${user.org_id} AND vc.platform = ${platform}
    ORDER BY e.created_at
  `;
  return c.json({ events: rows, platform });
});
