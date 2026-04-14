import { api } from "./api";

export interface ConnectorProvider {
  name: string;
  apps: string;
  status: string;
}

export interface ConnectorTool {
  name: string;
  description?: string;
  app?: string;
  provider?: string;
}

export function listConnectorProviders(): Promise<{ providers: ConnectorProvider[]; active: string }> {
  return api.get<{ providers: ConnectorProvider[]; active: string }>("/connectors/providers");
}

export function listConnectorTools(app?: string): Promise<{ tools: ConnectorTool[]; total: number; note?: string }> {
  const q = app ? `?app=${encodeURIComponent(app)}` : "";
  return api.get<{ tools: ConnectorTool[]; total: number; note?: string }>(`/connectors/tools${q}`);
}

export function getConnectorAuthUrl(app: string): Promise<{ app: string; auth_url: string; error?: string }> {
  return api.get<{ app: string; auth_url: string; error?: string }>(
    `/connectors/auth/${encodeURIComponent(app)}`,
  );
}
