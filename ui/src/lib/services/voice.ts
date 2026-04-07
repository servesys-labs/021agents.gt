import { api } from "./api";

export interface VoiceConfig {
  voice?: string;
  greeting?: string;
  language?: string;
  max_duration?: number;
}

export interface PhoneNumber {
  id: string;
  phone_number: string;
  agent_name: string;
  provider: string;
  provider_sid: string;
  status: string;
  created_at: string;
}

export interface AvailableNumber {
  phone_number: string;
  friendly_name: string;
  locality: string;
  region: string;
  postal_code: string;
  capabilities: Record<string, boolean>;
}

export interface CallLog {
  id: string;
  caller: string;
  duration_seconds: number;
  status: "completed" | "missed" | "voicemail";
  started_at: string;
  summary?: string;
  cost_usd?: number;
}

export function getVoiceConfig(agentName: string): Promise<VoiceConfig> {
  return api.get<VoiceConfig>(
    `/voice/config?agent_name=${encodeURIComponent(agentName)}`
  );
}

export function updateVoiceConfig(
  agentName: string,
  config: VoiceConfig
): Promise<VoiceConfig> {
  return api.put<VoiceConfig>("/voice/config", { agent_name: agentName, ...config });
}

export function listPhoneNumbers(agentName: string): Promise<{ numbers: PhoneNumber[] }> {
  return api.get<{ numbers: PhoneNumber[] }>(
    `/voice/twilio/numbers?agent_name=${encodeURIComponent(agentName)}`
  );
}

export function searchPhoneNumbers(
  agentName: string,
  areaCode: string
): Promise<{ numbers: AvailableNumber[] }> {
  const params = new URLSearchParams({ country: "US", limit: "20" });
  if (areaCode.trim()) params.set("area_code", areaCode.trim());
  return api.get<{ numbers: AvailableNumber[] }>(
    `/voice/twilio/available-numbers?${params}`
  );
}

export function buyPhoneNumber(
  agentName: string,
  number: string
): Promise<{ phone_number: string; agent_name: string }> {
  return api.post<{ phone_number: string; agent_name: string }>(
    "/voice/twilio/buy",
    { phone_number: number, agent_name: agentName }
  );
}

export function releasePhoneNumber(providerSid: string): Promise<void> {
  return api.del(`/voice/twilio/numbers/${encodeURIComponent(providerSid)}`);
}

export function listCalls(
  agentName: string,
  limit = 20
): Promise<{ calls: CallLog[] }> {
  return api.get<{ calls: CallLog[] }>(
    `/voice/${encodeURIComponent(agentName)}/calls?limit=${limit}`
  );
}
