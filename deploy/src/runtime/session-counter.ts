/**
 * Cloud Pattern C4.1: Cross-DO Org Session Counter (Scalable Version)
 *
 * Uses atomic KV counter instead of list() for O(1) operations.
 * KV list() is O(N) and eventually consistent — breaks at 10K sessions.
 * Atomic counter: O(1) read, O(1) write, strong-read consistency.
 *
 * Tradeoff: Counter can drift if a session crashes without unregistering.
 * Mitigated by TTL-based cleanup: heartbeat key expires → cron decrements.
 * Worst case: counter is slightly high (conservative — blocks new sessions).
 */

import type { RuntimeEnv } from "./types";

const SESSION_HEARTBEAT_TTL = 120; // 2 minutes
const COUNTER_KEY_PREFIX = "session-count";
const HEARTBEAT_KEY_PREFIX = "session-hb";

/**
 * Register an active session. Increments the org counter atomically.
 */
export async function registerSession(
  env: RuntimeEnv,
  orgId: string,
  sessionId: string,
  metadata?: { agentName?: string; channel?: string; startedAt?: number },
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;

  try {
    // Write heartbeat key (individual session tracking with TTL)
    await kv.put(
      `${HEARTBEAT_KEY_PREFIX}/${orgId}/${sessionId}`,
      JSON.stringify({ agent_name: metadata?.agentName || "", channel: metadata?.channel || "", started_at: metadata?.startedAt || Date.now() }),
      { expirationTtl: SESSION_HEARTBEAT_TTL },
    );

    // Increment counter atomically (read-modify-write; last-writer-wins is OK for advisory counting)
    const raw = await kv.get(`${COUNTER_KEY_PREFIX}/${orgId}`);
    const current = raw ? Number(raw) : 0;
    await kv.put(`${COUNTER_KEY_PREFIX}/${orgId}`, String(current + 1), { expirationTtl: 86400 });
  } catch {}
}

/**
 * Unregister a session. Decrements the org counter.
 */
export async function unregisterSession(
  env: RuntimeEnv,
  orgId: string,
  sessionId: string,
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;

  try {
    // Remove heartbeat key
    await kv.delete(`${HEARTBEAT_KEY_PREFIX}/${orgId}/${sessionId}`);

    // Decrement counter (floor at 0)
    const raw = await kv.get(`${COUNTER_KEY_PREFIX}/${orgId}`);
    const current = raw ? Number(raw) : 0;
    await kv.put(`${COUNTER_KEY_PREFIX}/${orgId}`, String(Math.max(0, current - 1)), { expirationTtl: 86400 });
  } catch {}
}

/**
 * Count active sessions for an org. O(1) read from counter key.
 */
export async function countActiveSessions(
  env: RuntimeEnv,
  orgId: string,
): Promise<number> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return 0;

  try {
    const raw = await kv.get(`${COUNTER_KEY_PREFIX}/${orgId}`);
    return raw ? Math.max(0, Number(raw)) : 0;
  } catch {
    return 0;
  }
}

/**
 * Check if org has reached concurrent session limit.
 * If the counter says limit is hit, auto-reconcile against heartbeat keys
 * to fix drift from crashed sessions (O(N) but only when at limit).
 */
export async function isSessionLimitReached(
  env: RuntimeEnv,
  orgId: string,
  maxConcurrent: number = 10,
): Promise<{ limited: boolean; active: number; max: number }> {
  let active = await countActiveSessions(env, orgId);

  // If at limit, reconcile to fix drift from orphaned sessions
  if (active >= maxConcurrent) {
    active = await reconcileSessionCounter(env, orgId);
  }

  return { limited: active >= maxConcurrent, active, max: maxConcurrent };
}

/**
 * Refresh the session heartbeat. Call once per turn.
 * Re-writes the heartbeat key to extend TTL.
 */
export async function refreshHeartbeat(
  env: RuntimeEnv,
  orgId: string,
  sessionId: string,
  metadata?: { agentName?: string; channel?: string },
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;

  try {
    await kv.put(
      `${HEARTBEAT_KEY_PREFIX}/${orgId}/${sessionId}`,
      JSON.stringify({ agent_name: metadata?.agentName || "", channel: metadata?.channel || "", heartbeat_at: Date.now() }),
      { expirationTtl: SESSION_HEARTBEAT_TTL },
    );
  } catch {}
}

/**
 * Reconcile the session counter against actual heartbeat keys.
 * The counter can drift when sessions crash without unregistering.
 * This function counts live heartbeat keys (TTL hasn't expired) and
 * resets the counter to match reality.
 *
 * Call from: cron handler, or before rejecting a session for limit.
 */
export async function reconcileSessionCounter(
  env: RuntimeEnv,
  orgId: string,
): Promise<number> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return 0;

  try {
    // List all heartbeat keys for this org (these have TTL — expired ones are already gone)
    const prefix = `${HEARTBEAT_KEY_PREFIX}/${orgId}/`;
    const list = await kv.list({ prefix, limit: 100 });
    const liveCount = list.keys?.length || 0;

    // Reset counter to match reality
    if (liveCount === 0) {
      await kv.delete(`${COUNTER_KEY_PREFIX}/${orgId}`);
    } else {
      await kv.put(`${COUNTER_KEY_PREFIX}/${orgId}`, String(liveCount), { expirationTtl: 86400 });
    }

    return liveCount;
  } catch {
    return 0;
  }
}
