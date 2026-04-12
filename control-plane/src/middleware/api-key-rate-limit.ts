/**
 * Per-API-key rate limiting for the public agent API (/v1/*).
 *
 * Enforces rate_limit_rpm (requests per minute) and rate_limit_rpd
 * (requests per day) from the api_keys table. Returns 429 when exceeded.
 *
 * Uses a Durable Object (RateLimiterDO) for cross-isolate atomic counters.
 * One DO instance per rate-limit key — all isolates in all colos route to
 * the same instance, so the counter is globally consistent. No more N×
 * overshoot from per-isolate counting.
 *
 * Fallback: if the DO binding is unavailable (dev mode, misconfigured
 * deployment), falls back to the in-memory per-isolate LRU. This is
 * deliberately fail-open — a missing binding loosens the limit rather
 * than blocking all requests.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";

// ── In-memory fallback (kept for dev/test environments without DO) ──
interface RateState {
  minuteBucket: number;
  minuteCount: number;
  dayBucket: number;
  dayCount: number;
}
const fallbackCounts = new Map<string, RateState>();
const MAX_FALLBACK_ENTRIES = 4096;

function checkFallback(rateKey: string, rpm: number, rpd: number): {
  allowed: boolean;
  minuteRemaining: number;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const minBucket = Math.floor(now / 60_000);
  const dayBucket = Math.floor(now / 86_400_000);

  let state = fallbackCounts.get(rateKey);
  if (!state) {
    state = { minuteBucket: minBucket, minuteCount: 0, dayBucket, dayCount: 0 };
    fallbackCounts.set(rateKey, state);
    if (fallbackCounts.size > MAX_FALLBACK_ENTRIES) {
      const entries = [...fallbackCounts.keys()];
      for (let i = 0; i < Math.floor(entries.length / 4); i++) fallbackCounts.delete(entries[i]);
    }
  }
  if (state.minuteBucket !== minBucket) { state.minuteBucket = minBucket; state.minuteCount = 0; }
  if (state.dayBucket !== dayBucket) { state.dayBucket = dayBucket; state.dayCount = 0; }
  state.minuteCount++;
  state.dayCount++;

  const minuteExceeded = state.minuteCount > rpm;
  const dayExceeded = state.dayCount > rpd;
  return {
    allowed: !minuteExceeded && !dayExceeded,
    minuteRemaining: Math.max(0, rpm - state.minuteCount),
    retryAfterSeconds: minuteExceeded ? Math.ceil(60 - (now % 60_000) / 1000) : 0,
  };
}

/**
 * Rate limiting middleware for public API routes.
 * Only applies to API key authenticated requests on /v1/* paths.
 */
export const apiKeyRateLimitMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: CurrentUser };
}>(async (c, next) => {
  if (!c.req.path.startsWith("/v1/") && !c.req.path.startsWith("/api/v1/")) return next();

  const user = c.get("user");
  if (!user || !user.user_id) return next();
  if (user.auth_method !== "api_key" && user.auth_method !== "end_user_token") return next();

  const rateSubject = user.auth_method === "api_key"
    ? (user.apiKeyId || user.user_id)
    : `${user.endUserApiKeyId || "unknown-key"}:${user.user_id}`;
  const rateKey = `${user.org_id}:${rateSubject}:${user.auth_method}`;

  const rpm = (user as any).rateLimitRpm || 60;
  const rpd = (user as any).rateLimitRpd || 10000;

  let allowed: boolean;
  let minuteRemaining: number;
  let retryAfterSeconds: number;

  // Try DO first, fall back to in-memory if binding is missing
  if (c.env.RATE_LIMITER) {
    try {
      const id = c.env.RATE_LIMITER.idFromName(rateKey);
      const stub = c.env.RATE_LIMITER.get(id);
      const result = await (stub as any).check(rpm, rpd);
      allowed = result.allowed;
      minuteRemaining = result.minuteRemaining;
      retryAfterSeconds = result.retryAfterSeconds;
    } catch (err) {
      // DO call failed — fall back to in-memory (fail-open)
      console.error(`[rate-limiter] DO call failed, using fallback: ${(err as Error)?.message}`);
      const fb = checkFallback(rateKey, rpm, rpd);
      allowed = fb.allowed;
      minuteRemaining = fb.minuteRemaining;
      retryAfterSeconds = fb.retryAfterSeconds;
    }
  } else {
    const fb = checkFallback(rateKey, rpm, rpd);
    allowed = fb.allowed;
    minuteRemaining = fb.minuteRemaining;
    retryAfterSeconds = fb.retryAfterSeconds;
  }

  if (!allowed) {
    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(rpm),
      "X-RateLimit-Remaining": "0",
    };
    if (retryAfterSeconds > 0) {
      headers["Retry-After"] = String(retryAfterSeconds);
      return c.json(
        { error: "Rate limit exceeded", limit: `${rpm} requests/minute`, retry_after_seconds: retryAfterSeconds },
        { status: 429, headers },
      );
    }
    return c.json(
      { error: "Daily rate limit exceeded", limit: `${rpd} requests/day` },
      { status: 429, headers },
    );
  }

  c.header("X-RateLimit-Limit", String(rpm));
  c.header("X-RateLimit-Remaining", String(minuteRemaining));
  return next();
});
