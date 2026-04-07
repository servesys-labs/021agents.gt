import { api } from "./api";

// ── API Keys ────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiKeyCreateResponse {
  id: string;
  name: string;
  key: string;
}

export function listApiKeys(): Promise<ApiKey[]> {
  return api.get<ApiKey[]>("/api-keys");
}

export function createApiKey(name: string): Promise<ApiKeyCreateResponse> {
  return api.post<ApiKeyCreateResponse>("/api-keys", { name });
}

export function deleteApiKey(id: string): Promise<void> {
  return api.del(`/api-keys/${encodeURIComponent(id)}`);
}

// ── Billing / Credits ───────────────────────────────────────────────

export interface CreditBalance {
  balance_cents: number;
  balance_usd: number;
}

export interface CreditTransaction {
  id: string;
  type: "purchase" | "burn" | "refund" | "bonus";
  amount_cents: number;
  amount_usd: number;
  description: string;
  created_at: string;
}

export interface BillingUsage {
  total_spent_usd: number;
  sessions_count: number;
  period: string;
}

export function getCreditBalance(): Promise<CreditBalance> {
  return api.get<CreditBalance>("/credits/balance");
}

export function getCreditTransactions(limit = 20): Promise<CreditTransaction[]> {
  return api.get<CreditTransaction[]>(`/credits/transactions?limit=${limit}`);
}

export function getBillingUsage(): Promise<BillingUsage> {
  return api.get<BillingUsage>("/billing/usage");
}

// ── Knowledge Base (RAG Documents) ──────────────────────────────────

export interface RagDocument {
  id: string;
  filename: string;
  size_bytes: number;
  chunk_count: number;
  status: "processing" | "ready" | "error";
  created_at: string;
}

export async function listDocuments(agentName: string): Promise<RagDocument[]> {
  const data = await api.get<RagDocument[] | { documents: RagDocument[] }>(`/rag/${encodeURIComponent(agentName)}/documents`);
  return Array.isArray(data) ? data : (data.documents ?? []);
}

export async function uploadDocument(agentName: string, file: File): Promise<RagDocument> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${api.baseUrl}/rag/${encodeURIComponent(agentName)}/documents`, {
    method: "POST",
    headers: {
      ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Upload failed: ${text}`);
  }

  return res.json() as Promise<RagDocument>;
}

export function deleteDocument(agentName: string, filename: string): Promise<void> {
  return api.del(`/rag/${encodeURIComponent(agentName)}/documents/${encodeURIComponent(filename)}`);
}

// ── Skills ──────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  version: string;
  prompt_template: string;
  allowed_tools: string[];
}

export function listSkills(): Promise<Skill[]> {
  return api.get<Skill[]>("/skills");
}

export function toggleSkill(name: string, enabled: boolean): Promise<Skill> {
  return api.put<Skill>(`/skills/${encodeURIComponent(name)}`, { enabled });
}

// ── Workspace Files ─────────────────────────────────────────────────

export interface WorkspaceFile {
  path: string;
  size_bytes: number;
  modified_at: string;
  type: string;
}

export function listWorkspaceFiles(agentName: string): Promise<WorkspaceFile[]> {
  return api.get<WorkspaceFile[]>(`/workspace/files?agent_name=${encodeURIComponent(agentName)}`);
}

export function getFileContent(agentName: string, path: string): Promise<{ content: string; mime_type: string }> {
  return api.get<{ content: string; mime_type: string }>(
    `/workspace/files/${encodeURIComponent(path)}?agent_name=${encodeURIComponent(agentName)}`
  );
}

export function deleteFile(agentName: string, path: string): Promise<void> {
  return api.del(`/workspace/files/${encodeURIComponent(path)}?agent_name=${encodeURIComponent(agentName)}`);
}
