export const TOKEN_KEY = "token";
export const USER_KEY = "user";
export const CLERK_LOGOUT_FLAG = "clerk:logout";
export const AUTH_EXPIRED_FLAG = "auth:expired";

export function getAuthToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setAuthSession(token: string, user: unknown): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuthSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

type StoredUser = {
  role?: string;
  org_role?: string;
  is_admin?: boolean;
};

export function getStoredUser(): StoredUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

export function getStoredUserRole(): string {
  const user = getStoredUser();
  if (!user) return "member";
  if (user.is_admin) return "admin";
  return (user.org_role ?? user.role ?? "member").toString().toLowerCase();
}
