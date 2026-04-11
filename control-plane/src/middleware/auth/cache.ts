/**
 * Auth resolver cache — bounded in-memory map plus cross-isolate
 * invalidation via a KV version key.
 *
 * Each Worker isolate keeps its own small TTL cache. When an API key
 * is revoked or rotated, callers bump the KV version key and every
 * isolate flushes its local cache on the next incoming request
 * (checked at most once per VERSION_CHECK_INTERVAL).
 */
import type { CurrentUser } from "../../auth/types";

const AUTH_CACHE_MAX = 2048;
const AUTH_CACHE_TTL = 60_000; // 1 min safety backstop

const authCache = new Map<string, { ts: number; user: CurrentUser }>();

export function cacheGet(key: string): CurrentUser | null {
  const entry = authCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > AUTH_CACHE_TTL) {
    authCache.delete(key);
    return null;
  }
  return entry.user;
}

export function cachePut(key: string, user: CurrentUser): void {
  authCache.set(key, { ts: Date.now(), user });
  if (authCache.size > AUTH_CACHE_MAX) {
    const entries = [...authCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = Math.floor(entries.length / 4);
    for (let i = 0; i < toRemove; i++) authCache.delete(entries[i][0]);
  }
}

// ── Cross-isolate cache invalidation via KV version key ────────────
// When API keys are revoked, the version key is bumped. Each isolate
// checks the version every 30s and flushes its cache on change.
// This reduces stale-token window from 5 minutes to ~30 seconds.
let _lastVersionCheck = 0;
const VERSION_CHECK_INTERVAL = 30_000;
const _versionCache = new Map<string, number>();

export async function checkCacheVersion(env: any): Promise<void> {
  if (Date.now() - _lastVersionCheck < VERSION_CHECK_INTERVAL) return;
  _lastVersionCheck = Date.now();

  const kv = env?.AGENT_PROGRESS_KV;
  if (!kv) return;

  try {
    const globalVersion = await kv.get("auth-cache-version");
    const remote = globalVersion ? Number(globalVersion) : 0;
    const local = _versionCache.get("global") ?? -1;
    if (remote !== local) {
      authCache.clear();
      _versionCache.set("global", remote);
    }
  } catch {}
}

/**
 * Bump the auth cache version. Call this when API keys are revoked/rotated.
 * All isolates will flush their caches within VERSION_CHECK_INTERVAL.
 */
export async function invalidateAuthCache(env: any): Promise<void> {
  const kv = env?.AGENT_PROGRESS_KV;
  if (!kv) return;
  try {
    const raw = await kv.get("auth-cache-version");
    const version = (raw ? Number(raw) : 0) + 1;
    await kv.put("auth-cache-version", String(version));
    authCache.clear();
    _versionCache.set("global", version);
  } catch {}
}

export async function hashForCache(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
