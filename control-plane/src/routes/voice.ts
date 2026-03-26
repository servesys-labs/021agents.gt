/**
 * Voice router — Vapi call listing/detail, platform calls, cross-platform summary.
 * Ported from agentos/api/routers/voice_webhooks.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDb, getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  isVoiceGenericPlatform,
  processTavusWebhook,
  processVapiWebhook,
  verifyWebhookHmac,
  VOICE_GENERIC_PLATFORMS,
} from "../logic/voice-webhook";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const voiceRoutes = new Hono<R>();

function nowSec(): number {
  return Date.now() / 1000;
}

// ── Cross-platform Summary ──────────────────────────────────────────

voiceRoutes.get("/all/summary", requireScope("integrations:read"), async (c) => {
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

// ── Vapi webhook (public — signature optional) ────────────────────────

voiceRoutes.post("/vapi/webhook", async (c) => {
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

// ── Vapi Calls ──────────────────────────────────────────────────────────

voiceRoutes.get("/vapi/calls", requireScope("integrations:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const status = c.req.query("status") || "";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
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

voiceRoutes.get("/vapi/calls/summary", requireScope("integrations:read"), async (c) => {
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

voiceRoutes.post("/vapi/calls", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const apiKey = c.env.VAPI_API_KEY ?? "";
  if (!apiKey) {
    return c.json({ error: "VAPI_API_KEY not configured" }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const phone_number = String(body.phone_number ?? "");
  const assistant_id = String(body.assistant_id ?? "");
  const agent_name = String(body.agent_name ?? "");
  const first_message = String(body.first_message ?? "");

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

voiceRoutes.delete("/vapi/calls/:call_id", requireScope("integrations:write"), async (c) => {
  const user = c.get("user");
  const callId = c.req.param("call_id");
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

voiceRoutes.get("/vapi/calls/:call_id", requireScope("integrations:read"), async (c) => {
  const user = c.get("user");
  const callId = c.req.param("call_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM voice_calls
    WHERE call_id = ${callId} AND platform = 'vapi' AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Call not found" }, 404);
  return c.json(rows[0]);
});

voiceRoutes.get("/vapi/calls/:call_id/events", requireScope("integrations:read"), async (c) => {
  const user = c.get("user");
  const callId = c.req.param("call_id");
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

// ── Generic platform webhook (e.g. Tavus) ─────────────────────────────

voiceRoutes.post("/:platform/webhook", async (c) => {
  const platform = c.req.param("platform");
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

// ── Generic Platform Calls ────────────────────────────────────────────

voiceRoutes.get("/:platform/calls/summary", requireScope("integrations:read"), async (c) => {
  const platform = c.req.param("platform");
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

voiceRoutes.get("/:platform/calls", requireScope("integrations:read"), async (c) => {
  const platform = c.req.param("platform");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const agentName = c.req.query("agent_name") || "";
  const status = c.req.query("status") || "";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
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

voiceRoutes.post("/:platform/calls", requireScope("integrations:write"), async (c) => {
  const platform = c.req.param("platform");
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

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const persona_id = String(body.persona_id ?? "");
  const context = String(body.context ?? "");
  const agent_name = String(body.agent_name ?? "");
  const properties = (body.properties ?? {}) as Record<string, unknown>;

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

voiceRoutes.get("/:platform/calls/:call_id", requireScope("integrations:read"), async (c) => {
  const platform = c.req.param("platform");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const callId = c.req.param("call_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM voice_calls
    WHERE call_id = ${callId} AND platform = ${platform} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Call not found" }, 404);
  return c.json(rows[0]);
});

voiceRoutes.get("/:platform/calls/:call_id/events", requireScope("integrations:read"), async (c) => {
  const platform = c.req.param("platform");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const callId = c.req.param("call_id");
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
