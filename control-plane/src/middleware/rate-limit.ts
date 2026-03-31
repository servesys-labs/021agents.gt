/**
 * Sliding-window rate limiter — ported from agentos/api/ratelimit.py.
 * 120 req/min, 20 burst/sec per key.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

const MAX_PER_MINUTE = 120;
const BURST_PER_SEC = 20;
const MAX_KEYS = 5_000;

interface BucketEntry {
  minuteBucket: number;   // Math.floor(now / 60_000)
  minuteCount: number;
  secondBucket: number;   // Math.floor(now / 1_000)
  secondCount: number;
  lastUsed: number;       // raw timestamp for eviction
}

const windows = new Map<string, BucketEntry>();

// Bypass paths should match Python middleware parity.
const BYPASS = new Set([
  "/health",
  "/health/detailed",
  "/docs",
  "/redoc",
  "/openapi.json",
  "/.well-known/agent.json",
]);

/** Evict oldest 25% of keys. Called BEFORE insertion when at capacity. */
function evictStaleKeys(): void {
  const entries = [...windows.entries()];
  entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const toRemove = Math.floor(entries.length / 4);
  for (let i = 0; i < toRemove; i++) windows.delete(entries[i][0]);
}

export const rateLimitMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (BYPASS.has(c.req.path)) return next();

  const auth = c.req.header("Authorization") ?? "";
  let key: string;
  if (auth.startsWith("Bearer ak_")) {
    key = `ak:${auth.slice(7, 18)}`;
  } else if (auth.startsWith("Bearer ")) {
    // Keep JWT key derivation aligned with Python: auth[7:20] -> 13 chars.
    key = `jwt:${auth.slice(7, 20)}`;
  } else {
    key = `ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`;
  }

  const now = Date.now();
  const curMinute = Math.floor(now / 60_000);
  const curSecond = Math.floor(now / 1_000);

  let entry = windows.get(key);

  if (!entry) {
    // Evict BEFORE insertion if at capacity
    if (windows.size >= MAX_KEYS) evictStaleKeys();
    entry = { minuteBucket: curMinute, minuteCount: 0, secondBucket: curSecond, secondCount: 0, lastUsed: now };
    windows.set(key, entry);
  }

  // Roll minute bucket if we've moved to a new minute
  if (entry.minuteBucket !== curMinute) {
    entry.minuteBucket = curMinute;
    entry.minuteCount = 0;
  }

  // Roll second bucket if we've moved to a new second
  if (entry.secondBucket !== curSecond) {
    entry.secondBucket = curSecond;
    entry.secondCount = 0;
  }

  entry.lastUsed = now;

  // Check minute rate limit
  if (entry.minuteCount >= MAX_PER_MINUTE) {
    c.header("Retry-After", "5");
    c.header("X-RateLimit-Limit", String(MAX_PER_MINUTE));
    c.header("X-RateLimit-Remaining", "0");
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  // Check burst (per-second)
  if (entry.secondCount >= BURST_PER_SEC) {
    c.header("Retry-After", "1");
    return c.json({ error: "Burst rate limit exceeded" }, 429);
  }

  entry.minuteCount++;
  entry.secondCount++;

  c.header("X-RateLimit-Limit", String(MAX_PER_MINUTE));
  c.header("X-RateLimit-Remaining", String(MAX_PER_MINUTE - entry.minuteCount));

  return next();
});

// ── Per-route rate limiter (sliding-window counter per IP) ──────────────

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > windowMs * 2) rateLimitStore.delete(key);
  }
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Creates rate-limiting middleware.
 * @param maxRequests - Maximum requests allowed within the window.
 * @param windowMs - Time window in milliseconds.
 * @param keyPrefix - Prefix for rate limit buckets (e.g., "auth" to limit auth routes separately).
 */
export function rateLimit(maxRequests: number, windowMs: number, keyPrefix = "global") {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    cleanup(windowMs);
    const ip = getClientIp(c.req.raw);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      rateLimitStore.set(key, entry);
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", "0");
      return c.json(
        { error: "Too many requests. Please try again later.", retry_after_seconds: retryAfter },
        429,
      );
    }

    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(Math.max(0, maxRequests - entry.count)));
    return next();
  });
}
