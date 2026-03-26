/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { apiPost, apiGet, getStoredToken, setStoredToken, clearStoredToken } from "./api";
import { isCfAccessMode, CF_ACCESS_TEAM_DOMAIN } from "../auth/config";

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
  isCfAccess: boolean;
};

/* ── Context ────────────────────────────────────────────────────── */

const AuthContext = createContext<AuthContextValue | null>(null);

/* ── Provider ───────────────────────────────────────────────────── */

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string>(() => getStoredToken());
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const isCfAccess = isCfAccessMode();

  const isAuthenticated = !!token && !!user;

  useEffect(() => {
    if (isCfAccess) {
      // CF Access mode: CfAccessSessionManager handles token exchange.
      // We poll for the token it writes to localStorage.
      const stored = getStoredToken();
      if (stored) {
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

      // No stored token yet — wait for CfAccessSessionManager to write one
      let cancelled = false;
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

      return () => {
        cancelled = true;
        clearInterval(poll);
      };
    }

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
  }, [isCfAccess]);

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

    if (isCfAccess && CF_ACCESS_TEAM_DOMAIN) {
      // Redirect to CF Access logout URL
      window.location.href = `https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout`;
    } else {
      window.location.href = "/login";
    }
  }, [isCfAccess]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, login, logout, isAuthenticated, isLoading, isCfAccess }),
    [user, token, login, logout, isAuthenticated, isLoading, isCfAccess],
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
  const { isAuthenticated, isLoading, isCfAccess } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface-base text-text-muted text-sm">
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    if (isCfAccess) {
      // CF Access will intercept and show the login UI
      window.location.href = "/";
      return null;
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
