/**
 * Per-API-key rate limiting for the public agent API (/v1/*).
 *
 * Enforces rate_limit_rpm (requests per minute) and rate_limit_rpd
 * (requests per day) from the api_keys table. Returns 429 when exceeded.
 *
 * Uses a sliding-window counter stored in-memory (per-isolate).
 * This is approximate (not globally consistent across isolates) but
 * good enough for abuse prevention. For strict enforcement, use
 * Cloudflare Rate Limiting rules or Durable Objects.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";

// Sliding window: key_id → { minute_bucket, minute_count, day_bucket, day_count }
interface RateState {
  minuteBucket: number;
  minuteCount: number;
  dayBucket: number;
  dayCount: number;
}

const rateCounts = new Map<string, RateState>();
const MAX_ENTRIES = 4096;

function getMinuteBucket(): number {
  return Math.floor(Date.now() / 60_000);
}

function getDayBucket(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function evictIfNeeded(): void {
  if (rateCounts.size <= MAX_ENTRIES) return;
  // Evict oldest 25%
  const entries = [...rateCounts.keys()];
  const toRemove = Math.floor(entries.length / 4);
  for (let i = 0; i < toRemove; i++) rateCounts.delete(entries[i]);
}

/**
 * Rate limiting middleware for public API routes.
 * Only applies to API key authenticated requests on /v1/* paths.
 */
export const apiKeyRateLimitMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: CurrentUser };
}>(async (c, next) => {
  // Only rate-limit public API routes
  if (!c.req.path.startsWith("/v1/") && !c.req.path.startsWith("/api/v1/")) return next();

  const user = c.get("user");
  if (!user || !user.user_id) return next();

  // Rate limit API key and end-user token requests (both have rateLimitRpm/Rpd)
  // Portal JWT users are rate-limited by the global middleware, not here
  if (user.auth_method !== "api_key" && user.auth_method !== "end_user_token") return next();

  // Use key-anchored subjects so distinct API keys do not share limits.
  // End-user tokens are bucketed by parent key + end-user id.
  const rateSubject = user.auth_method === "api_key"
    ? (user.apiKeyId || user.user_id)
    : `${user.endUserApiKeyId || "unknown-key"}:${user.user_id}`;
  const rateKey = `${user.org_id}:${rateSubject}:${user.auth_method}`;

  const minBucket = getMinuteBucket();
  const dayBucket = getDayBucket();

  let state = rateCounts.get(rateKey);
  if (!state) {
    state = { minuteBucket: minBucket, minuteCount: 0, dayBucket: dayBucket, dayCount: 0 };
    rateCounts.set(rateKey, state);
    evictIfNeeded();
  }

  // Reset minute counter on new bucket
  if (state.minuteBucket !== minBucket) {
    state.minuteBucket = minBucket;
    state.minuteCount = 0;
  }
  // Reset day counter on new bucket
  if (state.dayBucket !== dayBucket) {
    state.dayBucket = dayBucket;
    state.dayCount = 0;
  }

  state.minuteCount++;
  state.dayCount++;

  // Default limits (overridden per-key if stored in DB)
  const rpm = (user as any).rateLimitRpm || 60;
  const rpd = (user as any).rateLimitRpd || 10000;

  if (state.minuteCount > rpm) {
    const retryAfter = 60 - (Date.now() % 60_000) / 1000;
    return c.json(
      { error: "Rate limit exceeded", limit: `${rpm} requests/minute`, retry_after_seconds: Math.ceil(retryAfter) },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfter)), "X-RateLimit-Limit": String(rpm), "X-RateLimit-Remaining": "0" } },
    );
  }

  if (state.dayCount > rpd) {
    return c.json(
      { error: "Daily rate limit exceeded", limit: `${rpd} requests/day` },
      { status: 429, headers: { "X-RateLimit-Limit": String(rpd), "X-RateLimit-Remaining": "0" } },
    );
  }

  // Add rate limit headers
  c.header("X-RateLimit-Limit", String(rpm));
  c.header("X-RateLimit-Remaining", String(Math.max(0, rpm - state.minuteCount)));

  return next();
});
