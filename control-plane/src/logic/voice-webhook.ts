/**
 * Voice webhook verification + payload handling (Vapi, Tavus).
 * Ported from agentos/integrations/voice_platforms/{vapi,tavus}.py
 */
import type { Sql } from "../db/client";
import { deductCredits } from "./credits";

export const VOICE_GENERIC_PLATFORMS = {
  tavus: {
    apiKeyEnv: "TAVUS_API_KEY",
    webhookSecretEnv: "TAVUS_WEBHOOK_SECRET",
    signatureHeader: "x-tavus-signature",
  },
} as const;

export type VoiceGenericPlatform = keyof typeof VOICE_GENERIC_PLATFORMS;

export function isVoiceGenericPlatform(p: string): p is VoiceGenericPlatform {
  return Object.hasOwn(VOICE_GENERIC_PLATFORMS, p);
}

export async function verifyWebhookHmac(
  secret: string,
  body: ArrayBuffer,
  signature: string,
): Promise<boolean> {
  if (!secret) return true;
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(body));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(expected, signature.trim().toLowerCase());
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const na = a.length;
  const nb = b.length;
  if (na !== nb) return false;
  let x = 0;
  for (let i = 0; i < na; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function nowSec(): string {
  return new Date().toISOString();
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolved tenant for Vapi webhooks (from agent voice config). */
export type VapiWebhookTenantContext = {
  org_id: string;
  agent_name: string;
};

async function recordTelephonyBilling(
  sql: Sql,
  opts: {
    org_id: string;
    agent_name: string;
    call_id: string;
    cost_usd: number;
    duration_seconds: number;
  },
): Promise<void> {
  if (!opts.org_id.trim() || !opts.call_id.trim()) return;
  const traceId = `vapi:${opts.call_id}`;
  try {
    const existing = await sql`
      SELECT 1 FROM billing_records
      WHERE org_id = ${opts.org_id}
        AND trace_id = ${traceId}
        AND cost_type = 'telephony'
      LIMIT 1
    `;
    if (existing.length > 0) return;

    const qty = opts.duration_seconds > 0 ? opts.duration_seconds : 1;
    const unit = opts.duration_seconds > 0 ? "second" : "call";
    const unitPrice = opts.cost_usd > 0 ? opts.cost_usd / qty : 0;

    await sql`
      INSERT INTO billing_records (
        org_id, agent_name, cost_type, description,
        model, provider, total_cost_usd, inference_cost_usd,
        session_id, trace_id,
        unit, quantity, unit_price_usd, pricing_source
      ) VALUES (
        ${opts.org_id},
        ${opts.agent_name || ""},
        'telephony',
        ${`Vapi call ${opts.call_id}`},
        'vapi', 'vapi',
        ${opts.cost_usd}, 0,
        ${traceId},
        ${traceId},
        ${unit},
        ${qty},
        ${unitPrice},
        'fallback_env'
      )
    `;

    // Credit deduction for telephony cost (awaited, not fire-and-forget)
    if (opts.cost_usd > 0) {
      try {
        const result = await deductCredits(sql, opts.org_id, opts.cost_usd, `Voice call: ${opts.call_id}`, opts.agent_name || "voice", traceId);
        if (!result.success) {
          console.error(`[voice-billing] FAILED to deduct $${opts.cost_usd} from org ${opts.org_id} — insufficient credits (balance: $${result.balance_after_usd})`);
        }
      } catch (err: any) {
        console.error(`[voice-billing] Credit deduction error for org ${opts.org_id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[voice-billing] recordTelephonyBilling failed: ${err.message}`);
  }
}

function parseVapiEvent(payload: Record<string, unknown>): {
  event_type: string;
  call_id: string;
} {
  const message = (payload.message ?? {}) as Record<string, unknown>;
  const eventType = String(message.type ?? payload.type ?? "unknown");
  const callFromMessage = (message.call ?? {}) as Record<string, unknown>;
  const callFromPayload = (payload.call ?? {}) as Record<string, unknown>;
  const call_id =
    String(callFromMessage.id ?? message.callId ?? callFromPayload.id ?? "");
  return { event_type: eventType, call_id };
}

export async function processVapiWebhook(
  payload: Record<string, unknown>,
  sql: Sql,
  tenant: VapiWebhookTenantContext,
): Promise<Record<string, unknown>> {
  const orgId = String(tenant.org_id ?? "");
  const agentName = String(tenant.agent_name ?? "");
  const { event_type, call_id } = parseVapiEvent(payload);
  const result: Record<string, unknown> = {
    event_type,
    call_id,
    processed: true,
  };

  const message = (payload.message ?? payload) as Record<string, unknown>;
  const callData = (message.call ?? {}) as Record<string, unknown>;
  const customer = (callData.customer ?? {}) as Record<string, unknown>;

  if (event_type === "call.started" || event_type === "assistant-request") {
    const id = call_id || randomId();
    const phone = String(customer.number ?? "");
    const direction =
      callData.type === "inboundPhoneCall" ? "inbound" : "outbound";
    const assistantId = String(callData.assistantId ?? "");
    try {
      await sql`
        INSERT INTO voice_calls (
          call_id, platform, org_id, agent_name, phone_number, direction, status,
          platform_agent_id, started_at
        ) VALUES (
          ${id}, 'vapi', ${orgId}, ${agentName}, ${phone}, ${direction}, 'connected',
          ${assistantId}, ${nowSec()}
        )
        ON CONFLICT (call_id) DO UPDATE SET
          status = EXCLUDED.status,
          phone_number = EXCLUDED.phone_number,
          direction = EXCLUDED.direction,
          platform_agent_id = EXCLUDED.platform_agent_id,
          started_at = EXCLUDED.started_at,
          org_id = COALESCE(NULLIF(TRIM(voice_calls.org_id), ''), EXCLUDED.org_id),
          agent_name = COALESCE(NULLIF(TRIM(voice_calls.agent_name), ''), EXCLUDED.agent_name)
      `;
    } catch {
      /* best-effort */
    }
    result.call = {
      call_id: id,
      org_id: orgId,
      phone_number: phone,
      direction,
      status: "connected",
      platform_agent_id: assistantId,
    };
  } else if (event_type === "call.ended" || event_type === "end-of-call-report") {
    const innerCall = (message.call ?? {}) as Record<string, unknown>;
    const duration = Number(message.durationSeconds ?? innerCall.duration ?? 0) || 0;
    const cost = Number(message.cost ?? 0) || 0;
    const transcript = String(message.transcript ?? message.summary ?? "");
    if (call_id) {
      try {
        await sql`
          UPDATE voice_calls SET
            status = 'ended',
            duration_seconds = ${duration},
            cost_usd = ${cost},
            transcript = ${transcript.slice(0, 5000)},
            ended_at = ${nowSec()},
            org_id = CASE
              WHEN ${orgId} = '' THEN org_id
              WHEN org_id IS NULL OR TRIM(org_id) = '' THEN ${orgId}
              ELSE org_id
            END,
            agent_name = CASE
              WHEN ${agentName} = '' THEN agent_name
              WHEN agent_name IS NULL OR TRIM(agent_name) = '' THEN ${agentName}
              ELSE agent_name
            END
          WHERE call_id = ${call_id} AND platform = 'vapi'
        `;
      } catch {
        /* best-effort */
      }
      let billOrg = orgId;
      let billAgent = agentName;
      if (!billOrg.trim() || !billAgent.trim()) {
        try {
          const rows = (await sql`
            SELECT org_id, agent_name FROM voice_calls
            WHERE call_id = ${call_id} AND platform = 'vapi' LIMIT 1
          `) as { org_id?: string; agent_name?: string }[];
          const r = rows[0];
          if (!billOrg.trim() && r?.org_id) billOrg = String(r.org_id);
          if (!billAgent.trim() && r?.agent_name) billAgent = String(r.agent_name);
        } catch {
          /* best-effort */
        }
      }
      if (billOrg.trim() && (cost > 0 || duration > 0)) {
        await recordTelephonyBilling(sql, {
          org_id: billOrg,
          agent_name: billAgent,
          call_id,
          cost_usd: cost,
          duration_seconds: duration,
        });
      }
    }
    result.duration_seconds = duration;
    result.cost_usd = cost;
    result.transcript_length = transcript.length;
  } else if (
    event_type === "transcript.partial" ||
    event_type === "transcript.final" ||
    event_type === "transcript"
  ) {
    const text = String(message.transcript ?? message.text ?? "");
    const role = String(message.role ?? "unknown");
    const is_final =
      message.transcriptType === "final" || event_type === "transcript.final";
    result.text = text;
    result.role = role;
    result.is_final = is_final;
  } else if (event_type === "function-call") {
    const fnCall = (message.functionCall ?? {}) as Record<string, unknown>;
    result.function_name = String(fnCall.name ?? "");
    result.parameters = fnCall.parameters ?? {};
    result.needs_response = true;
  } else if (event_type === "hang") {
    if (call_id) {
      try {
        await sql`
          UPDATE voice_calls SET status = 'ended', ended_at = ${nowSec()}
          WHERE call_id = ${call_id} AND platform = 'vapi'
        `;
      } catch {
        /* best-effort */
      }
    }
    result.hung_up = true;
  }

  if (call_id) {
    try {
      const payloadJson = JSON.stringify(payload);
      await sql`
        INSERT INTO voice_call_events (call_id, event_type, payload, org_id, platform)
        VALUES (${call_id}, ${event_type}, ${payloadJson}, ${orgId}, 'vapi')
      `;
    } catch {
      /* best-effort */
    }
  }

  result.tenant_org_id = orgId;
  result.tenant_agent_name = agentName;
  return result;
}

function parseTavusEvent(payload: Record<string, unknown>): {
  event_type: string;
  conversation_id: string;
} {
  const event_type = String(payload.event ?? payload.type ?? "unknown");
  const conv = (payload.conversation ?? {}) as Record<string, unknown>;
  const conversation_id = String(
    payload.conversation_id ?? conv.id ?? "",
  );
  return { event_type, conversation_id };
}

export async function processTavusWebhook(
  payload: Record<string, unknown>,
  sql: Sql,
  orgId: string,
): Promise<Record<string, unknown>> {
  const { event_type, conversation_id } = parseTavusEvent(payload);
  const result: Record<string, unknown> = {
    event_type,
    conversation_id,
    processed: true,
  };

  if (event_type === "conversation.started") {
    const id = conversation_id || randomId();
    const persona_id = String(payload.persona_id ?? "");
    try {
      await sql`
        INSERT INTO voice_calls (
          call_id, platform, org_id, agent_name, phone_number, direction, status,
          platform_agent_id, started_at
        ) VALUES (
          ${id}, 'tavus', ${orgId}, '', '', 'outbound', 'started',
          ${persona_id}, ${nowSec()}
        )
        ON CONFLICT (call_id) DO UPDATE SET
          status = EXCLUDED.status,
          platform_agent_id = EXCLUDED.platform_agent_id,
          started_at = EXCLUDED.started_at
      `;
    } catch {
      /* best-effort */
    }
    result.conversation = {
      conversation_id: id,
      org_id: orgId,
      persona_id,
      status: "started",
    };
  } else if (event_type === "conversation.ended") {
    const duration = Number(payload.duration ?? 0) || 0;
    const transcript = String(payload.transcript ?? "");
    if (conversation_id) {
      try {
        await sql`
          UPDATE voice_calls SET
            status = 'ended',
            duration_seconds = ${duration},
            transcript = ${transcript.slice(0, 5000)},
            ended_at = ${nowSec()}
          WHERE call_id = ${conversation_id} AND platform = 'tavus'
        `;
      } catch {
        /* best-effort */
      }
    }
    result.duration_seconds = duration;
    result.transcript_length = transcript.length;
  }

  if (conversation_id) {
    try {
      const payloadJson = JSON.stringify(payload);
      await sql`
        INSERT INTO voice_call_events (call_id, event_type, payload, org_id, platform)
        VALUES (${conversation_id}, ${event_type}, ${payloadJson}, ${orgId}, 'tavus')
      `;
    } catch {
      /* best-effort */
    }
  }

  return result;
}
