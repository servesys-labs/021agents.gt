/**
 * Sliding-window rate limiter — ported from agentos/api/ratelimit.py.
 * 120 req/min, 20 burst/sec per key.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

const WINDOW_MS = 60_000; // 1 minute
const MAX_PER_WINDOW = 120;
const BURST_PER_SEC = 20;
const MAX_KEYS = 10_000;

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

// Bypass paths should match Python middleware parity.
const BYPASS = new Set([
  "/health",
  "/health/detailed",
  "/docs",
  "/redoc",
  "/openapi.json",
  "/.well-known/agent.json",
]);

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
  let entry = windows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(key, entry);
  }

  // Prune old timestamps
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < WINDOW_MS);

  // Check rate limit
  if (entry.timestamps.length >= MAX_PER_WINDOW) {
    c.header("Retry-After", "5");
    c.header("X-RateLimit-Limit", String(MAX_PER_WINDOW));
    c.header("X-RateLimit-Remaining", "0");
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  // Check burst
  const recentSecond = entry.timestamps.filter((ts) => now - ts < 1000);
  if (recentSecond.length >= BURST_PER_SEC) {
    c.header("Retry-After", "1");
    return c.json({ error: "Burst rate limit exceeded" }, 429);
  }

  entry.timestamps.push(now);
  c.header("X-RateLimit-Limit", String(MAX_PER_WINDOW));
  c.header("X-RateLimit-Remaining", String(MAX_PER_WINDOW - entry.timestamps.length));

  // Evict stale keys if too many
  if (windows.size > MAX_KEYS) {
    const entries = [...windows.entries()];
    entries.sort((a, b) => {
      const aLast = a[1].timestamps[a[1].timestamps.length - 1] ?? 0;
      const bLast = b[1].timestamps[b[1].timestamps.length - 1] ?? 0;
      return aLast - bLast;
    });
    for (let i = 0; i < entries.length / 4; i++) windows.delete(entries[i][0]);
  }

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
