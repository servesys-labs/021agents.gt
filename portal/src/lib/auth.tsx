/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { apiPost, apiGet, getStoredToken, setStoredToken, clearStoredToken } from "./api";
import { isClerkMode } from "../auth/config";

/* ── Backward compat ────────────────────────────────────────────── */

export function hasAuthToken(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  const token = storage.getItem("agentos_token") || storage.getItem("token");
  return Boolean(token && token.trim().length > 0);
}

/* ── Types ──────────────────────────────────────────────────────── */

type User = {
  id: string;
  email: string;
  name: string;
  org_id?: string;
  role?: string;
};

type AuthContextValue = {
  user: User | null;
  token: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
  isLoading: boolean;
  isClerk: boolean;
};

/* ── Context ────────────────────────────────────────────────────── */

const AuthContext = createContext<AuthContextValue | null>(null);

/* ── Clerk token exchange ───────────────────────────────────────── */

/**
 * Exchange a Clerk JWT for an AgentOS JWT.
 * Called on mount when Clerk is active, and on token refresh.
 */
async function exchangeClerkToken(clerkToken: string): Promise<{
  token: string;
  user: User;
} | null> {
  try {
    const resp = await fetch("/api/v1/auth/clerk/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clerk_token: clerkToken }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      token: string;
      user_id: string;
      email: string;
      org_id?: string;
      provider?: string;
      name?: string;
    };
    return {
      token: data.token,
      user: {
        id: data.user_id,
        email: data.email,
        name: data.name || data.email?.split("@")[0] || "",
        org_id: data.org_id || "",
        role: "member",
      },
    };
  } catch {
    return null;
  }
}

/* ── Provider ───────────────────────────────────────────────────── */

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string>(() => getStoredToken());
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const isClerk = isClerkMode();

  const isAuthenticated = !!token && !!user;

  // ── Clerk mode: auto-exchange on mount + periodic refresh ─────
  useEffect(() => {
    if (!isClerk) {
      // Local mode: validate stored token
      const stored = getStoredToken();
      if (!stored) {
        setIsLoading(false);
        return;
      }
      let cancelled = false;
      apiGet<{ user_id: string; email: string; name: string; org_id?: string; role?: string }>(
        "/api/v1/auth/me",
      )
        .then((res) => {
          if (!cancelled) {
            setUser({
              id: res.user_id,
              email: res.email,
              name: res.name || "",
              org_id: res.org_id,
              role: res.role,
            });
            setToken(stored);
          }
        })
        .catch(() => {
          if (!cancelled) {
            clearStoredToken();
            setToken("");
            setUser(null);
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
      return () => { cancelled = true; };
    }

    // Clerk mode: need to dynamically import useAuth from @clerk/clerk-react
    // Since we can't use hooks outside components, we use the Clerk client directly
    let cancelled = false;

    async function initClerkAuth() {
      try {
        // Try to get Clerk session token via the __clerk_session cookie approach
        // or wait for ClerkSessionManager to do the exchange
        const stored = getStoredToken();
        if (stored) {
          // We have a stored AgentOS token — validate it
          try {
            const res = await apiGet<{
              user_id: string;
              email: string;
              name: string;
              org_id?: string;
              role?: string;
            }>("/api/v1/auth/me");
            if (!cancelled) {
              setUser({
                id: res.user_id,
                email: res.email,
                name: res.name || "",
                org_id: res.org_id,
                role: res.role,
              });
              setToken(stored);
              setIsLoading(false);
            }
            return;
          } catch {
            // Token invalid — fall through to wait for Clerk
          }
        }

        // No valid AgentOS token — wait for ClerkSessionManager to exchange
        // Poll for token appearing (ClerkSessionManager writes it)
        let attempts = 0;
        const poll = setInterval(() => {
          attempts++;
          const t = getStoredToken();
          if (t && !cancelled) {
            clearInterval(poll);
            apiGet<{
              user_id: string;
              email: string;
              name: string;
              org_id?: string;
              role?: string;
            }>("/api/v1/auth/me")
              .then((res) => {
                if (!cancelled) {
                  setUser({
                    id: res.user_id,
                    email: res.email,
                    name: res.name || "",
                    org_id: res.org_id,
                    role: res.role,
                  });
                  setToken(t);
                }
              })
              .catch(() => {})
              .finally(() => {
                if (!cancelled) setIsLoading(false);
              });
          }
          if (attempts > 30) {
            // Give up after 15 seconds
            clearInterval(poll);
            if (!cancelled) setIsLoading(false);
          }
        }, 500);
      } catch {
        if (!cancelled) setIsLoading(false);
      }
    }

    void initClerkAuth();
    return () => { cancelled = true; };
  }, [isClerk]);

  // ── Local mode login ──────────────────────────────────────────
  const login = useCallback(async (email: string, password: string) => {
    const res = await apiPost<{
      token: string;
      user_id: string;
      email: string;
      org_id?: string;
      name?: string;
    }>("/api/v1/auth/login", { email, password });
    setStoredToken(res.token);
    setToken(res.token);
    setUser({
      id: res.user_id,
      email: res.email,
      name: res.name || "",
      org_id: res.org_id,
    });
  }, []);

  // ── Logout ─────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    clearStoredToken();
    setToken("");
    setUser(null);

    if (isClerk) {
      // Signal ClerkSessionManager to handle sign-out
      localStorage.setItem("clerk:logout", "1");
      // Redirect to Clerk sign-in — Clerk's useAuth hook will handle the actual sign-out
      window.location.href = "/login";
    } else {
      window.location.href = "/login";
    }
  }, [isClerk]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, login, logout, isAuthenticated, isLoading, isClerk }),
    [user, token, login, logout, isAuthenticated, isLoading, isClerk],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* ── Hook ───────────────────────────────────────────────────────── */

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}

/* ── Guard ──────────────────────────────────────────────────────── */

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, isClerk } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface-base text-text-muted text-sm">
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    if (isClerk) {
      // In Clerk mode, redirect to /login which shows Clerk UI
      return <Navigate to="/login" state={{ from: location }} replace />;
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
