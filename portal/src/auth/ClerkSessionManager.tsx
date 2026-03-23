import { useAuth } from "@clerk/clerk-react";
import { useEffect, useState } from "react";

import { isClerkMode } from "./config";
import { getTokenSecondsRemaining } from "./jwt";
import { getAuthToken, setAuthSession } from "./tokens";

const REFRESH_THRESHOLD_SECONDS = 5 * 60;

export function ClerkSessionManager() {
  const { getToken } = useAuth();
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    if (!isClerkMode()) {
      return;
    }

    let cancelled = false;

    const refreshIfNeeded = async () => {
      const current = getAuthToken();
      const remaining = current ? getTokenSecondsRemaining(current) : null;
      if (remaining === null || remaining > REFRESH_THRESHOLD_SECONDS) {
        if (remaining !== null && !cancelled) {
          setStatus(`Session valid (${Math.floor(remaining / 60)}m remaining)`);
        }
        return;
      }
      try {
        const clerkToken = await getToken();
        if (!clerkToken) {
          return;
        }
        const response = await fetch("/api/v1/auth/clerk/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clerk_token: clerkToken }),
        });
        if (!response.ok) {
          if (!cancelled) {
            setStatus("Session refresh failed. Please sign in again.");
          }
          return;
        }
        const payload = (await response.json()) as {
          token: string;
          user_id: string;
          email: string;
          org_id: string;
          provider: string;
        };
        setAuthSession(payload.token, {
          user_id: payload.user_id,
          email: payload.email,
          org_id: payload.org_id,
          provider: payload.provider,
        });
        if (!cancelled) {
          const nextRemaining = getTokenSecondsRemaining(payload.token);
          setStatus(
            nextRemaining ? `Session refreshed (${Math.floor(nextRemaining / 60)}m remaining)` : "Session refreshed",
          );
        }
      } catch {
        if (!cancelled) {
          setStatus("Session refresh failed. Please sign in again.");
        }
      }
    };

    void refreshIfNeeded();
    const timer = window.setInterval(() => {
      void refreshIfNeeded();
    }, 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [getToken]);

  if (!isClerkMode() || !status) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 rounded bg-surface-raised px-3 py-2 text-xs text-text-primary shadow-lg">
      {status}
    </div>
  );
}
