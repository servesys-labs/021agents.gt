import { api } from "./api";

export interface VoiceConfig {
  tts_engine: "kokoro" | "chatterbox" | "sesame" | "workers-ai";
  voice: string;
  voice_clone_url?: string;
  stt_engine: "whisper-gpu" | "groq" | "workers-ai";
  greeting: string;
  language: string;
  max_duration: number;
  speed?: number;
}

export interface VoiceOption {
  id: string;
  name: string;
  language: string;
  preview_url?: string;
}

export interface CloneVoice {
  clone_id: string;
  clone_url: string;
  name: string;
  created_at: string;
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

// ── Voice config ──────────────────────────────────────────────────────

export function getVoiceConfig(agentName: string): Promise<VoiceConfig> {
  return api.get<VoiceConfig>(
    `/voice/config?agent_name=${encodeURIComponent(agentName)}`
  );
}

export function updateVoiceConfig(
  agentName: string,
  config: Partial<VoiceConfig>
): Promise<VoiceConfig> {
  return api.put<VoiceConfig>("/voice/config", { agent_name: agentName, ...config });
}

// ── Voices & cloning ──────────────────────────────────────────────────

export function listVoices(
  engine: string
): Promise<{ voices: VoiceOption[] }> {
  return api.get<{ voices: VoiceOption[] }>(
    `/voice/voices?engine=${encodeURIComponent(engine)}`
  );
}

export function uploadVoiceClone(
  agentName: string,
  audioFile: File
): Promise<{ clone_url: string; clone_id: string }> {
  const formData = new FormData();
  formData.append("file", audioFile);
  formData.append("agent_name", agentName);
  return api.postForm<{ clone_url: string; clone_id: string }>(
    "/voice/clone/upload",
    formData
  );
}

export function listCloneVoices(
  agentName: string
): Promise<{ clones: CloneVoice[] }> {
  return api.get<{ clones: CloneVoice[] }>(
    `/voice/clone/list?agent_name=${encodeURIComponent(agentName)}`
  );
}

export function deleteCloneVoice(cloneId: string): Promise<void> {
  return api.del(`/voice/clone/${encodeURIComponent(cloneId)}`);
}

export function previewVoice(
  engine: string,
  voice: string,
  text?: string
): Promise<Blob> {
  return api.postBlob("/voice/preview", {
    engine,
    voice,
    text: text || "Hello! This is a preview of how I sound.",
  });
}

// ── Twilio phone numbers ──────────────────────────────────────────────

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

// ── Call log ──────────────────────────────────────────────────────────

export function listCalls(
  agentName: string,
  limit = 20
): Promise<{ calls: CallLog[] }> {
  return api.get<{ calls: CallLog[] }>(
    `/voice/${encodeURIComponent(agentName)}/calls?limit=${limit}`
  );
}
