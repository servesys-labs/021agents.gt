import { api } from "./api";

// ── API Keys ────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  allowed_agents: string[];
  scopes: string[];
}

export interface ApiKeyCreateResponse {
  id: string;
  name: string;
  key: string;
  prefix?: string;
  allowed_agents?: string[];
}

interface ApiKeyRaw {
  id?: string;
  key_id?: string;
  name?: string;
  prefix?: string;
  key_prefix?: string;
  created_at?: string;
  last_used_at?: string | null;
  allowed_agents?: unknown;
  scopes?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function normalizeApiKey(raw: ApiKeyRaw): ApiKey {
  return {
    id: typeof raw.id === "string" ? raw.id : (typeof raw.key_id === "string" ? raw.key_id : ""),
    name: typeof raw.name === "string" ? raw.name : "",
    prefix: typeof raw.prefix === "string" ? raw.prefix : (typeof raw.key_prefix === "string" ? raw.key_prefix : ""),
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    last_used_at: typeof raw.last_used_at === "string" ? raw.last_used_at : null,
    allowed_agents: asStringArray(raw.allowed_agents),
    scopes: asStringArray(raw.scopes),
  };
}

export function listApiKeys(): Promise<ApiKey[]> {
  return api.get<ApiKeyRaw[]>("/api-keys").then((rows) =>
    rows.map(normalizeApiKey).filter((k) => k.id.length > 0),
  );
}

export function createApiKey(
  name: string,
  options?: { allowed_agents?: string[]; scopes?: string[] },
): Promise<ApiKeyCreateResponse> {
  return api.post<Record<string, unknown>>("/api-keys", {
    name,
    ...(options?.allowed_agents ? { allowed_agents: options.allowed_agents } : {}),
    ...(options?.scopes ? { scopes: options.scopes } : {}),
  }).then((row) => ({
    id: typeof row.id === "string" ? row.id : (typeof row.key_id === "string" ? row.key_id : ""),
    name: typeof row.name === "string" ? row.name : name,
    key: typeof row.key === "string" ? row.key : "",
    prefix: typeof row.prefix === "string" ? row.prefix : (typeof row.key_prefix === "string" ? row.key_prefix : undefined),
    allowed_agents: asStringArray(row.allowed_agents),
  }));
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

// ── Credit Packages & Checkout ─────────────────────────────────────

export interface CreditPackage {
  id: string;
  name: string;
  credits_usd: number;
  price_usd: number;
  stripe_price_id: string;
  is_active: boolean;
}

export function getCreditPackages(): Promise<CreditPackage[]> {
  const result = api.get<CreditPackage[] | { packages: CreditPackage[] }>("/credits/packages");
  return result.then(d => Array.isArray(d) ? d : (d.packages ?? []));
}

export function createCheckout(packageId: string): Promise<{ url: string }> {
  return api.post<{ url: string }>("/credits/checkout", {
    package_id: packageId,
    success_url: `${window.location.origin}/settings/billing?credit_purchase=success`,
    cancel_url: `${window.location.origin}/settings/billing?credit_purchase=canceled`,
  });
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

function normalizeSkill(raw: unknown): Skill {
  const row = (raw ?? {}) as Record<string, unknown>;
  const allowedToolsRaw = row.allowed_tools;
  const allowedTools = Array.isArray(allowedToolsRaw)
    ? allowedToolsRaw.filter((t): t is string => typeof t === "string")
    : [];

  return {
    name: typeof row.name === "string" ? row.name : "",
    description: typeof row.description === "string" ? row.description : "",
    category: typeof row.category === "string" ? row.category : "general",
    enabled: Boolean(row.enabled ?? row.is_active),
    version: typeof row.version === "string" ? row.version : "1.0.0",
    prompt_template: typeof row.prompt_template === "string" ? row.prompt_template : "",
    allowed_tools: allowedTools,
  };
}

export async function listSkills(): Promise<Skill[]> {
  const data = await api.get<Skill[] | { skills: Skill[] }>("/skills");
  const rows = Array.isArray(data) ? data : (data.skills ?? []);
  return rows.map(normalizeSkill).filter((s) => s.name.length > 0);
}

export async function toggleSkill(name: string, enabled: boolean): Promise<Skill> {
  const updated = await api.put<Skill>(`/skills/${encodeURIComponent(name)}`, { is_active: enabled });
  return normalizeSkill(updated);
}

// ── Workspace Files ─────────────────────────────────────────────────

export interface WorkspaceFile {
  path: string;
  size_bytes: number;
  modified_at: string;
  type: string;
  /** Which R2 scope the file lives in: "user" (uploaded by portal user)
   * or "shared" (generated by agent runs without a channel user_id). */
  scope?: "user" | "shared";
}

/** Raw shape returned by the API (R2 manifest) */
interface WorkspaceFileRaw {
  path: string;
  size: number;
  updated_at: string;
  hash?: string;
  type?: string;
  scope?: "user" | "shared";
}

// ── Workspace file access via SDK @callable RPC (WebSocket, not HTTP) ──
// Follows the SDK example pattern: agent.call("listWorkspaceFiles", ["/"])

import { agentStore } from "$lib/stores/agent.svelte";

export async function listWorkspaceFiles(_agentName: string): Promise<WorkspaceFile[]> {
  try {
    const raw = await agentStore.call<any[]>("listWorkspaceFiles", ["/"]);
    if (!Array.isArray(raw)) return [];
    return raw.map((f: any) => ({
      path: f.path ?? f.name ?? "",
      size_bytes: f.size ?? f.size_bytes ?? 0,
      modified_at: f.updated_at ?? f.modified_at ?? "",
      type: f.type ?? extToType(f.path ?? f.name ?? ""),
      scope: f.scope,
    }));
  } catch {
    return [];
  }
}

function extToType(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "file";
}

function guessMime(path: string): string {
  const ext = extToType(path);
  const map: Record<string, string> = {
    html: "text/html", css: "text/css", js: "application/javascript", ts: "application/typescript",
    json: "application/json", md: "text/markdown", py: "text/x-python", svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", xml: "text/xml",
  };
  return map[ext] ?? "text/plain";
}

export async function getFileContent(_agentName: string, path: string): Promise<{ content: string; mime_type: string }> {
  const content = await agentStore.call<string | null>("readWorkspaceFile", [path]);
  return { content: content ?? "", mime_type: guessMime(path) };
}

export async function deleteFile(_agentName: string, path: string): Promise<void> {
  await agentStore.call("deleteWorkspaceFile", [path]);
}

export function downloadFile(_agentName: string, path: string): string {
  // Download still needs HTTP — RPC can't trigger browser download.
  // Fall back to gateway URL; if route doesn't exist, the user gets the raw content from getFileContent.
  return `${api.baseUrl}/workspace/files/read?agent_name=${encodeURIComponent(_agentName)}&path=${encodeURIComponent(path)}&download=true`;
}

export async function createWorkspaceFile(
  _agentName: string,
  path: string,
  content: string,
): Promise<{ ok: boolean; key: string; size_bytes: number }> {
  const result = await agentStore.call<any>("writeWorkspaceFile", [path, content]);
  return { ok: result?.success ?? true, key: path, size_bytes: content.length };
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
    if (typeof file.type === "string" && file.type.startsWith("text/") || TEXT_FILE_RE.test(file.name)) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file); // base64 data-url for binary files
    }
  });
}
