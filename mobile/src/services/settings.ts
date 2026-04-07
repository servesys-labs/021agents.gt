import { apiRequest } from "./api";

export async function getOrgSettings(token: string): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>("/api/v1/orgs/settings", { method: "GET" }, token);
}

export async function getCreditsSummary(token: string): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>("/api/v1/credits/summary", { method: "GET" }, token);
}

