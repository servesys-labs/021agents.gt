import type { AuthProvider } from "@refinedev/core";

import { isCfAccessMode, CF_ACCESS_TEAM_DOMAIN } from "../auth/config";
import { getTokenSecondsRemaining } from "../auth/jwt";
import { AUTH_EXPIRED_FLAG, clearAuthSession, getAuthToken, setAuthSession } from "../auth/tokens";

const API_URL = "/api/v1";

export const authProvider: AuthProvider = {
  login: async ({ email, password }) => {
    if (isCfAccessMode()) {
      // CF Access handles login — redirect to root where CF Access intercepts
      window.location.href = "/";
      return {
        success: false,
        error: { name: "CF Access Enabled", message: "Authentication is handled by Cloudflare Access." },
      };
    }
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (response.ok) {
        const data = (await response.json()) as { token?: string; role?: string; email?: string; user_id?: string; org_id?: string; provider?: string };
        setAuthSession(data.token ?? "", data);
        return { success: true, redirectTo: "/" };
      }
    } catch {
      return { success: false, error: { name: "Login Failed", message: "Network error while signing in" } };
    }

    return { success: false, error: { name: "Login Failed", message: "Invalid credentials" } };
  },

  register: async ({ email, password, name }) => {
    if (isCfAccessMode()) {
      // CF Access handles user registration via the IdP
      window.location.href = "/";
      return {
        success: false,
        error: { name: "CF Access Enabled", message: "Registration is handled by Cloudflare Access." },
      };
    }
    try {
      const response = await fetch(`${API_URL}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });

      if (response.ok) {
        const data = (await response.json()) as { token?: string; role?: string; email?: string; user_id?: string; org_id?: string; provider?: string };
        setAuthSession(data.token ?? "", data);
        return { success: true, redirectTo: "/" };
      }
    } catch {
      return { success: false, error: { name: "Register Failed", message: "Network error while registering" } };
    }

    return { success: false, error: { name: "Register Failed", message: "Could not create account" } };
  },

  logout: async () => {
    clearAuthSession();
    if (isCfAccessMode() && CF_ACCESS_TEAM_DOMAIN) {
      return { success: true, redirectTo: `https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout` };
    }
    return { success: true, redirectTo: "/login" };
  },

  check: async () => {
    const token = getAuthToken();
    if (!token) {
      return { authenticated: false, redirectTo: "/login" };
    }
    const remaining = getTokenSecondsRemaining(token);
    if (remaining !== null && remaining <= 0) {
      clearAuthSession();
      sessionStorage.setItem(AUTH_EXPIRED_FLAG, "1");
      return { authenticated: false, redirectTo: "/login" };
    }
    return { authenticated: true };
  },

  getIdentity: async () => {
    const token = getAuthToken();
    if (!token) return null;

    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const user = (await response.json()) as { user_id: string; name?: string; email: string };
        return { id: user.user_id, name: user.name ?? user.email, email: user.email };
      }
    } catch {
      return null;
    }
    return null;
  },

  getPermissions: async () => {
    const user = localStorage.getItem("user");
    if (user) {
      const parsed = JSON.parse(user) as { role?: string };
      return parsed.role ?? "member";
    }
    return null;
  },

  onError: async (error: { status?: number }) => {
    if (error.status === 401) {
      return { logout: true };
    }
    return {};
  },
};
