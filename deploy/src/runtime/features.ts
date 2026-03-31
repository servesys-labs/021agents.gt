/**
 * Phase 7.3: Feature Flags with Runtime Toggle
 *
 * NOTE: This module is infrastructure for feature-gating new capabilities.
 * Wire into workflow.ts turn loop as features are enabled per-org:
 *   if (await isEnabled(env, 'concurrent_tools', orgId)) { ... }
 *
 * KV-backed per-org feature flags. Enable new features for one org,
 * emergency-disable broken ones, A/B test without redeploy.
 *
 * Flags cached in-memory for 60s to avoid KV reads on every request.
 */

import type { RuntimeEnv } from "./types";

const FEATURES_PREFIX = "features";
const CACHE_TTL_MS = 60_000; // 60 seconds

// In-memory cache: orgId → { flags, fetchedAt }
const flagCache = new Map<string, { flags: Record<string, boolean>; fetchedAt: number }>();

/**
 * Built-in feature flags with defaults.
 * New features gate behind flags before enabling globally.
 */
const DEFAULT_FLAGS: Record<string, boolean> = {
  concurrent_tools: true,           // Phase 3.1
  deferred_tool_loading: false,     // Phase 2.2 (not yet implemented)
  context_compression: true,        // Phase 2.4
  scratchpad: true,                 // Phase 6.2
  detailed_cost_tracking: false,    // Phase 7.2
  conversation_repair: true,        // Phase 9.1
  anti_hallucination_prompts: true, // Phase 4.1
  loop_detection: true,             // Phase 1.4
};

/**
 * Check if a feature is enabled for an org.
 * Falls back to default if no org-specific override exists.
 */
export async function isEnabled(
  env: RuntimeEnv,
  flag: string,
  orgId: string,
): Promise<boolean> {
  const flags = await getFlags(env, orgId);
  return flags[flag] ?? DEFAULT_FLAGS[flag] ?? false;
}

/**
 * Get all feature flags for an org.
 */
async function getFlags(env: RuntimeEnv, orgId: string): Promise<Record<string, boolean>> {
  // Check in-memory cache
  const cached = flagCache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.flags;
  }

  // Read from KV
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return DEFAULT_FLAGS;

  try {
    const raw = await kv.get(`${FEATURES_PREFIX}/${orgId}`);
    const flags = raw ? JSON.parse(raw) : {};
    const merged = { ...DEFAULT_FLAGS, ...flags };
    flagCache.set(orgId, { flags: merged, fetchedAt: Date.now() });
    return merged;
  } catch {
    return DEFAULT_FLAGS;
  }
}

/**
 * Set a feature flag for an org. Used by control-plane /features endpoint.
 */
export async function setFlag(
  env: RuntimeEnv,
  orgId: string,
  flag: string,
  value: boolean,
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;

  const flags = await getFlags(env, orgId);
  flags[flag] = value;
  await kv.put(`${FEATURES_PREFIX}/${orgId}`, JSON.stringify(flags));

  // Invalidate cache
  flagCache.delete(orgId);
}
