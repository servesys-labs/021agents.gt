import { useAuth } from "@clerk/clerk-react";
import { useEffect, useRef } from "react";

import { isClerkMode } from "./config";
import { getAuthToken, setAuthSession } from "./tokens";

/**
 * ClerkSessionManager — bridges Clerk auth with AgentOS JWT.
 *
 * On every Clerk session change (sign-in, token refresh):
 * 1. Gets Clerk session JWT via getToken()
 * 2. Exchanges it for an AgentOS JWT via POST /api/v1/auth/clerk/exchange
 * 3. Stores the AgentOS JWT in localStorage (where AuthProvider picks it up)
 *
 * This runs as an invisible component mounted when Clerk mode is active.
 */
export function ClerkSessionManager() {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const exchanging = useRef(false);

  useEffect(() => {
    if (!isClerkMode() || !isLoaded) return;

    let cancelled = false;

    async function exchangeToken() {
      if (exchanging.current || cancelled) return;
      exchanging.current = true;

      try {
        // Get Clerk JWT
        const clerkToken = await getToken();
        if (!clerkToken || cancelled) {
          exchanging.current = false;
          return;
        }

        // Exchange for AgentOS JWT
        const response = await fetch("/api/v1/auth/clerk/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clerk_token: clerkToken }),
        });

        if (!response.ok) {
          console.warn("[ClerkSessionManager] Token exchange failed:", response.status);
          exchanging.current = false;
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
          setAuthSession(payload.token, {
            user_id: payload.user_id,
            email: payload.email,
            name: payload.name || "",
            org_id: payload.org_id,
            provider: payload.provider,
          });
        }
      } catch (err) {
        console.warn("[ClerkSessionManager] Exchange error:", err);
      } finally {
        exchanging.current = false;
      }
    }

    if (isSignedIn) {
      // Exchange immediately on sign-in
      const existing = getAuthToken();
      if (!existing) {
        void exchangeToken();
      }

      // Periodic refresh (every 4 minutes — tokens expire in 7 days but we refresh aggressively)
      const interval = setInterval(() => {
        void exchangeToken();
      }, 4 * 60 * 1000);

      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    } else if (isLoaded && !isSignedIn) {
      // User signed out of Clerk — clear AgentOS session
      const existing = getAuthToken();
      if (existing) {
        import("./tokens").then(({ clearAuthSession }) => {
          clearAuthSession();
          window.location.href = "/login";
        });
      }
    }

    return () => { cancelled = true; };
  }, [getToken, isSignedIn, isLoaded]);

  // Invisible component — no UI
  return null;
}
