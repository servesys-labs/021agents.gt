import { apiRequest } from "./api";

export interface ReleaseChannel {
  channel?: string;
  version?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export async function listReleaseChannels(
  token: string,
  agentName: string,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    `/api/v1/releases/${encodeURIComponent(agentName)}/channels`,
    { method: "GET" },
    token,
  );
}

export async function promoteRelease(
  token: string,
  agentName: string,
  fromChannel: string,
  toChannel: string,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    `/api/v1/releases/${encodeURIComponent(agentName)}/promote?from_channel=${encodeURIComponent(fromChannel)}&to_channel=${encodeURIComponent(toChannel)}`,
    { method: "POST" },
    token,
  );
}

export async function rollbackCanary(
  token: string,
  agentName: string,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    `/api/v1/releases/${encodeURIComponent(agentName)}/canary/rollback`,
    { method: "POST" },
    token,
  );
}

