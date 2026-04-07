import { api } from "./api";

export interface ChannelConfig {
  channel: string;
  agent_name: string;
  is_active: boolean;
  config: Record<string, unknown>;
}

export function listChannels(agentName: string): Promise<{ channels: ChannelConfig[] }> {
  return api.get<{ channels: ChannelConfig[] }>(
    `/chat/channels?agent_name=${encodeURIComponent(agentName)}`
  );
}

export function connectChannel(
  agentName: string,
  type: string,
  config: Record<string, unknown>
): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>(`/chat/channels/${encodeURIComponent(type)}`, {
    agent_name: agentName,
    is_active: true,
    config,
  });
}

export function disconnectChannel(agentName: string, type: string): Promise<void> {
  return api.del(
    `/chat/channels/${encodeURIComponent(type)}?agent_name=${encodeURIComponent(agentName)}`
  );
}

export function updateChannel(
  agentName: string,
  type: string,
  config: Record<string, unknown>
): Promise<{ ok: boolean }> {
  return api.put<{ ok: boolean }>(`/chat/channels/${encodeURIComponent(type)}`, {
    agent_name: agentName,
    is_active: true,
    config,
  });
}
