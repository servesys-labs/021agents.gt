/**
 * Resolve org + agent for Vapi webhooks by matching stored voice config on agents.
 */
import type { Sql } from "../db/client";

export type VoiceTenant = { org_id: string; agent_name: string };

/**
 * Match `config.voice.vapi_assistant_id` or `vapi_phone_number_id` (top-level voice block).
 */
export async function resolveVapiVoiceTenant(
  sql: Sql,
  assistantId: string,
  phoneNumberId: string,
): Promise<VoiceTenant | null> {
  const aid = String(assistantId ?? "").trim();
  const pid = String(phoneNumberId ?? "").trim();
  if (!aid && !pid) return null;

  try {
    const rows = (await sql`
      SELECT name, org_id
      FROM agents
      WHERE
        (${aid} != '' AND (config::jsonb->'voice'->>'vapi_assistant_id') = ${aid})
        OR (${pid} != '' AND (config::jsonb->'voice'->>'vapi_phone_number_id') = ${pid})
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `) as { name?: string; org_id?: string }[];
    const r = rows[0];
    if (!r?.org_id || !r?.name) return null;
    return { org_id: String(r.org_id), agent_name: String(r.name) };
  } catch {
    return null;
  }
}

export function extractVapiCallIds(payload: Record<string, unknown>): {
  assistantId: string;
  phoneNumberId: string;
} {
  const message = (payload.message ?? payload) as Record<string, unknown>;
  const call = (message.call ?? {}) as Record<string, unknown>;
  return {
    assistantId: String(call.assistantId ?? ""),
    phoneNumberId: String(call.phoneNumberId ?? ""),
  };
}
