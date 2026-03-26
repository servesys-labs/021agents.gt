import { useEffect, useRef, type ReactNode } from "react";

import { isCfAccessMode } from "./config";
import { getAuthToken, setAuthSession, clearAuthSession } from "./tokens";
import { setStoredToken } from "../lib/api";

/**
 * CfAccessSessionManager — bridges Cloudflare Access auth with AgentOS JWT.
 *
 * CF Access sets CF_Authorization as HttpOnly, so client JS can't read it.
 * The portal worker exposes /__auth/token which reads the cookie server-side.
 *
 * This component:
 * 1. Fetches the CF Access token from the portal worker
 * 2. Exchanges it for an AgentOS JWT via the control-plane
 * 3. Stores the AgentOS JWT in localStorage
 * 4. Refreshes every 30 minutes
 */

async function getCfAccessToken(): Promise<string | null> {
  try {
    const resp = await fetch("/__auth/token");
    if (!resp.ok) return null;
    const data = (await resp.json()) as { token: string | null };
    return data.token || null;
  } catch {
    return null;
  }
}

export function CfAccessSessionManager({ children }: { children: ReactNode }) {
  const exchanging = useRef(false);

  useEffect(() => {
    if (!isCfAccessMode()) return;

    let cancelled = false;

    async function exchangeToken() {
      if (exchanging.current || cancelled) return;
      exchanging.current = true;

      try {
        const cfToken = await getCfAccessToken();
        if (!cfToken) {
          // No CF Access cookie — clear any stale session
          if (getAuthToken()) {
            clearAuthSession();
            window.location.href = "/";
          }
          return;
        }

        const apiBase = import.meta.env.VITE_API_URL ?? "";
        const response = await fetch(`${apiBase}/api/v1/auth/cf-access/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cf_access_token: cfToken }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.warn("[CfAccessSessionManager] Token exchange failed:", response.status, body);
          return;
        }

        const payload = (await response.json()) as {
          token: string;
          user_id: string;
          email: string;
          org_id: string;
          provider: string;
          name?: string;
        };

        if (!cancelled) {
          // Write to both storage keys (tokens.ts uses "token", api.ts uses "agentos_token")
          setAuthSession(payload.token, {
            user_id: payload.user_id,
            email: payload.email,
            name: payload.name || "",
            org_id: payload.org_id,
            provider: payload.provider,
          });
          setStoredToken(payload.token);
        }
      } catch (err) {
        console.warn("[CfAccessSessionManager] Exchange error:", err);
      } finally {
        exchanging.current = false;
      }
    }

    // Initial exchange
    async function init() {
      const cfToken = await getCfAccessToken();
      if (!cancelled && cfToken && !getAuthToken()) {
        void exchangeToken();
      } else if (!cancelled && !cfToken && getAuthToken()) {
        clearAuthSession();
      }
    }

    void init();

    // Periodic refresh every 30 minutes
    const interval = setInterval(() => {
      void exchangeToken();
    }, 30 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return <>{children}</>;
}
