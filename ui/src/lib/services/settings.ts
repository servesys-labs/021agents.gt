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

// ── Account ────────────────────────────────────────────────────────

export function changePassword(currentPassword: string, newPassword: string): Promise<{ updated: boolean }> {
  return api.post<{ updated: boolean }>("/auth/password", { current_password: currentPassword, new_password: newPassword });
}

export interface UserProfile {
  user_id: string;
  email: string;
  name: string;
  org_id: string;
  provider: string;
}

export function getMe(): Promise<UserProfile> {
  return api.get<UserProfile>("/auth/me");
}

// ── Referrals ──────────────────────────────────────────────────────

export interface ReferralStats {
  total_referrals: number;
  referrals: Array<{ org_id: string; org_name: string; since: string }>;
  earnings: { total_earned_usd: number; l1_earned_usd: number; l2_earned_usd: number; total_transactions: number };
  codes: Array<{ code: string; label: string; uses: number; max_uses: number | null; active: boolean }>;
}

export function getReferralStats(): Promise<ReferralStats> {
  return api.get<ReferralStats>("/referrals/stats");
}

export function createReferralCode(label?: string, maxUses?: number): Promise<{ code: string; share_url: string }> {
  return api.post<{ code: string; share_url: string }>("/referrals/codes", { label, max_uses: maxUses });
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

/** Raw shape returned by the API (R2 manifest) */
interface WorkspaceFileRaw {
  path: string;
  size: number;
  updated_at: string;
  hash?: string;
  type?: string;
}

export async function listWorkspaceFiles(agentName: string): Promise<WorkspaceFile[]> {
  const data = await api.get<{ files: WorkspaceFileRaw[] } | WorkspaceFileRaw[]>(
    `/workspace/files?agent_name=${encodeURIComponent(agentName)}`
  );
  const raw: WorkspaceFileRaw[] = Array.isArray(data) ? data : (data.files ?? []);
  return raw.map((f) => ({
    path: f.path,
    size_bytes: f.size ?? 0,
    modified_at: f.updated_at ?? "",
    type: f.type ?? extToType(f.path),
  }));
}

function extToType(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "file";
}

export function getFileContent(agentName: string, path: string): Promise<{ content: string; mime_type: string }> {
  return api.get<{ content: string; mime_type: string }>(
    `/workspace/files/read?agent_name=${encodeURIComponent(agentName)}&path=${encodeURIComponent(path)}`
  );
}

export function deleteFile(agentName: string, path: string): Promise<void> {
  return api.del(`/workspace/files?agent_name=${encodeURIComponent(agentName)}&path=${encodeURIComponent(path)}`);
}

export function downloadFile(agentName: string, path: string): string {
  return `${api.baseUrl}/workspace/files/read?agent_name=${encodeURIComponent(agentName)}&path=${encodeURIComponent(path)}&download=true`;
}

export function createWorkspaceFile(
  agentName: string,
  path: string,
  content: string,
): Promise<{ ok: boolean; key: string; size_bytes: number }> {
  return api.post("/workspace/files/create", { agent_name: agentName, path, content });
}

const TEXT_FILE_RE = /\.(ts|tsx|js|jsx|json|md|py|rs|go|html|css|csv|xml|yaml|yml|toml|sh|bash|sql|txt|log|env|svelte|vue|rb|java|c|cpp|h|hpp|swift|kt|r|m|pl|lua|zig|asm|ini|cfg|conf|makefile|dockerfile)$/i;

export function uploadWorkspaceFile(
  agentName: string,
  file: File,
): Promise<{ ok: boolean; key: string; size_bytes: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const content = reader.result as string;
      try {
        resolve(
          await api.post("/workspace/files/create", {
            agent_name: agentName,
            path: file.name,
            content,
          }),
        );
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    if (file.type.startsWith("text/") || TEXT_FILE_RE.test(file.name)) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file); // base64 data-url for binary files
    }
  });
}
