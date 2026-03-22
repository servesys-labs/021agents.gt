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
