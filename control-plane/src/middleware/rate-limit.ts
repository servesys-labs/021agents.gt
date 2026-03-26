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
