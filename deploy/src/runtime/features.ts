/**
 * Phase 7.3 + Cloud C2.2: Feature Flags with Version-Based Cache
 *
 * Read feature flags from KV with in-memory caching.
 * Cache is invalidated immediately when the version key changes
 * (bumped on every flag write), eliminating the 60s stale window.
 * Orphan cleanup: flags older than 30 days auto-expire via KV TTL.
 */

import type { RuntimeEnv } from "./types";

interface FeatureCache {
  flags: Record<string, boolean>;
  version: number;
  expiresAt: number;
  lastUsed: number;
}

const cache = new Map<string, FeatureCache>();
const CACHE_TTL_MS = 300_000; // 5 min max TTL — version check is the real invalidator
const VERSION_CHECK_MS = 5_000; // Check version key every 5s (cheap KV get)
const FLAGS_TTL_SECONDS = 86400 * 30; // 30-day KV TTL for orphan cleanup

let lastVersionCheck = 0;
const versionCache = new Map<string, number>();

/** Default flag values — new features start enabled */
const DEFAULTS: Record<string, boolean> = {
  concurrent_tools: true,
  deferred_tool_loading: true,
  context_compression: true,
  scratchpad: true,
  detailed_cost_tracking: true,
  mailbox_ipc: true,
  idle_watchdog: true,
  prompt_caching: true,
  // Gradual rollout gate for routing complex tasks to Kimi.
  // Keep off by default; enable per-org as part of canary.
  kimi_complex_canary: false,
  // Memory agent: post-session digest + decay ranking.
  // Phase 4.5: enable per-org for staged A/B rollout.
  memory_agent_enabled: false,
  // Shared signal substrate: telemetry reduction + dedicated coordinator path.
  signal_substrate_enabled: false,
  // Memory passive signals: digest/consolidate driven by buffered telemetry.
  memory_passive_signals_enabled: false,
};

/**
 * Check if a feature flag is enabled for an org.
 * Uses version-based invalidation: cheap version key check (~5s),
 * full flag reload only when version changes.
 */
export async function isEnabled(
  env: RuntimeEnv,
  flag: string,
  orgId: string,
): Promise<boolean> {
  const cacheKey = orgId || "global";
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return DEFAULTS[flag] ?? false;

  // Check version key periodically (every 5s, very cheap)
  const now = Date.now();
  if (now - lastVersionCheck > VERSION_CHECK_MS) {
    lastVersionCheck = now;
    try {
      const vRaw = await kv.get(`features-version/${cacheKey}`);
      const remoteVersion = vRaw ? Number(vRaw) : 0;
      const localVersion = versionCache.get(cacheKey) ?? -1;
      if (remoteVersion !== localVersion) {
        // Version changed — invalidate cache, force reload
        cache.delete(cacheKey);
        versionCache.set(cacheKey, remoteVersion);
      }
    } catch { /* best-effort version check */ }
  }

  // Return from cache if valid
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    cached.lastUsed = Date.now();
    return cached.flags[flag] ?? DEFAULTS[flag] ?? false;
  }

  // Reload from KV
  try {
    const raw = await kv.get(`features/${cacheKey}`);
    const flags = raw ? JSON.parse(raw) : {};
    const vRaw = await kv.get(`features-version/${cacheKey}`);
    const version = vRaw ? Number(vRaw) : 0;

    cache.set(cacheKey, { flags, version, expiresAt: now + CACHE_TTL_MS, lastUsed: now });
    versionCache.set(cacheKey, version);

    // Evict least-recently-used entries
    if (cache.size > 10_000) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (let i = 0; i < 250; i++) cache.delete(oldest[i][0]);
    }

    return flags[flag] ?? DEFAULTS[flag] ?? false;
  } catch {
    return DEFAULTS[flag] ?? false;
  }
}

/**
 * Set a feature flag for an org.
 * Bumps the version key to invalidate caches across all isolates.
 */
export async function setFlag(
  env: RuntimeEnv,
  flag: string,
  orgId: string,
  value: boolean,
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;

  const cacheKey = orgId || "global";
  const raw = await kv.get(`features/${cacheKey}`);
  const flags = raw ? JSON.parse(raw) : {};
  flags[flag] = value;
  await kv.put(`features/${cacheKey}`, JSON.stringify(flags), { expirationTtl: FLAGS_TTL_SECONDS });

  // Bump version key — invalidates all caches
  const vRaw = await kv.get(`features-version/${cacheKey}`);
  const version = (vRaw ? Number(vRaw) : 0) + 1;
  await kv.put(`features-version/${cacheKey}`, String(version));

  // Invalidate local cache immediately
  cache.delete(cacheKey);
  versionCache.set(cacheKey, version);
}

/**
 * List all feature flags for an org.
 */
export async function listFlags(
  env: RuntimeEnv,
  orgId: string,
): Promise<Record<string, boolean>> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return { ...DEFAULTS };

  const cacheKey = orgId || "global";
  try {
    const raw = await kv.get(`features/${cacheKey}`);
    const flags = raw ? JSON.parse(raw) : {};
    return { ...DEFAULTS, ...flags };
  } catch {
    return { ...DEFAULTS };
  }
}
