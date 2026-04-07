import type { AuthUser } from "../services/auth";

export function hasScope(user: AuthUser | null, scope: string): boolean {
  if (!user) return false;
  const scopes = user.scopes ?? [];
  return scopes.includes("*") || scopes.includes(scope);
}

