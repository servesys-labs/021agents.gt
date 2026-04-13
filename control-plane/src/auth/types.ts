/**
 * Auth types — CurrentUser, scopes, role hierarchy.
 */

export const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export const ALL_SCOPES = new Set([
  "*",
  "agents:read", "agents:write", "agents:run",
  "sessions:read", "sessions:write",
  "eval:read", "eval:run",
  "evolve:read", "evolve:write",
  "billing:read", "billing:write",
  "memory:read", "memory:write",
  "tools:read",
  "schedules:read", "schedules:write",
  "webhooks:read", "webhooks:write",
  "rag:read", "rag:write",
  "sandbox:read", "sandbox:write",
  "deploy:read", "deploy:write",
  "policies:read", "policies:write",
  "slos:read", "slos:write",
  "releases:read", "releases:write",
  "jobs:read", "jobs:write",
  "workflows:read", "workflows:write",
  "intelligence:read", "intelligence:write",
  "issues:read", "issues:write",
  "projects:read", "projects:write",
  "secrets:read", "secrets:write",
  "api_keys:read", "api_keys:write",
  "orgs:read", "orgs:write",
  "retention:read", "retention:write",
  "observability:read", "observability:write",
  "security:read", "security:write",
  "guardrails:read", "guardrails:write",
  "dlp:read", "dlp:write",
  "gold_images:read", "gold_images:write",
  "integrations:read", "integrations:write",
  "gpu:read", "gpu:write",
  "autoresearch:read", "autoresearch:write",
  "compare:read",
  "codemode:read", "codemode:write",
  "training:read", "training:write",
  "admin",
]);

export interface CurrentUser {
  user_id: string;
  email: string;
  name: string;
  org_id: string;
  project_id: string;
  env: string;
  role: string;
  scopes: string[];
  auth_method: "jwt" | "api_key" | "end_user_token";
  /** Per-key rate limit: requests per minute (API key / end-user token auth). */
  rateLimitRpm?: number;
  /** Per-key rate limit: requests per day (API key / end-user token auth). */
  rateLimitRpd?: number;
  /** Agent handles this key/token is allowed to access (empty = all). */
  allowedAgents?: string[];
  /** IP allowlist for API key auth (empty = allow all). Supports exact IPs and CIDR ranges. */
  ipAllowlist?: string[];
  /** API key ID (key_id column) for audit logging. */
  apiKeyId?: string;
  /** The parent API key ID that minted this end-user token. */
  endUserApiKeyId?: string;
}

export function hasScope(user: CurrentUser, scope: string): boolean {
  if (user.scopes.includes("*")) return true;
  if (user.scopes.includes(scope)) return true;
  const category = scope.split(":")[0];
  if (user.scopes.includes(`${category}:*`)) return true;
  return false;
}

export function hasRole(user: CurrentUser, minRole: string): boolean {
  const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;
  return userLevel >= requiredLevel;
}

export interface TokenClaims {
  sub: string;
  email: string;
  name: string;
  provider: string;
  org_id: string;
  iat: number;
  exp: number;
  role?: string;
  [key: string]: unknown;
}
