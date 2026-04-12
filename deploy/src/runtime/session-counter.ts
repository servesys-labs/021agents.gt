/**
 * Org session counter — tracks concurrent sessions per org.
 *
 * Uses SessionCounterDO (Durable Object) for cross-isolate atomic
 * counting when available. Falls back to KV read-modify-write for
 * environments without the DO binding.
 *
 * The DO eliminates the KV RMW race from the reliability audit (§3.4):
 * two concurrent registerSession calls both reading `current=9` and
 * both writing `10`. DO methods are serialized per instance, so the
 * count is always accurate.
 *
 * Heartbeat keys in KV are retained regardless of DO availability —
 * they provide TTL-based crash cleanup (heartbeat expires → cron
 * reconciles). The DO counter is authoritative when present; KV
 * heartbeats are the crash-recovery fallback.
 */

import type { RuntimeEnv } from "./types";

const SESSION_HEARTBEAT_TTL = 120; // 2 minutes
const COUNTER_KEY_PREFIX = "session-count";
const HEARTBEAT_KEY_PREFIX = "session-hb";

function getCounterDO(env: RuntimeEnv, orgId: string): any | null {
  const ns = (env as any).SESSION_COUNTER;
  if (!ns) return null;
  try {
    const id = ns.idFromName(orgId);
    return ns.get(id);
  } catch {
    return null;
  }
}

/**
 * Register an active session. Returns the new count.
 */
export async function registerSession(
  env: RuntimeEnv,
  orgId: string,
  sessionId: string,
  metadata?: { agentName?: string; channel?: string; startedAt?: number },
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;

  // Write heartbeat key (TTL-based crash cleanup, always via KV)
  if (kv) {
    try {
      await kv.put(
        `${HEARTBEAT_KEY_PREFIX}/${orgId}/${sessionId}`,
        JSON.stringify({ agent_name: metadata?.agentName || "", channel: metadata?.channel || "", started_at: metadata?.startedAt || Date.now() }),
        { expirationTtl: SESSION_HEARTBEAT_TTL },
      );
    } catch {}
  }

  // Increment counter: DO if available, KV fallback
  const stub = getCounterDO(env, orgId);
  if (stub) {
    try {
      await stub.register(sessionId);
      return;
    } catch {}
  }

  // KV fallback (racy but functional)
  if (kv) {
    try {
      const raw = await kv.get(`${COUNTER_KEY_PREFIX}/${orgId}`);
      const current = raw ? Number(raw) : 0;
      await kv.put(`${COUNTER_KEY_PREFIX}/${orgId}`, String(current + 1), { expirationTtl: 86400 });
    } catch {}
  }
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

  // Remove heartbeat key
  if (kv) {
    try { await kv.delete(`${HEARTBEAT_KEY_PREFIX}/${orgId}/${sessionId}`); } catch {}
  }

  // Decrement counter: DO if available, KV fallback
  const stub = getCounterDO(env, orgId);
  if (stub) {
    try {
      await stub.unregister(sessionId);
      return;
    } catch {}
  }

  // KV fallback
  if (kv) {
    try {
      const raw = await kv.get(`${COUNTER_KEY_PREFIX}/${orgId}`);
      const current = raw ? Number(raw) : 0;
      await kv.put(`${COUNTER_KEY_PREFIX}/${orgId}`, String(Math.max(0, current - 1)), { expirationTtl: 86400 });
    } catch {}
  }
}

/**
 * Count active sessions for an org.
 */
export async function countActiveSessions(
  env: RuntimeEnv,
  orgId: string,
): Promise<number> {
  const stub = getCounterDO(env, orgId);
  if (stub) {
    try { return await stub.count(); } catch {}
  }

  // KV fallback
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
 */
export async function isSessionLimitReached(
  env: RuntimeEnv,
  orgId: string,
  maxConcurrent: number = 10,
): Promise<{ limited: boolean; active: number; max: number }> {
  const stub = getCounterDO(env, orgId);
  if (stub) {
    try {
      return await stub.isLimitReached(maxConcurrent);
    } catch {}
  }

  // KV fallback with reconcile-on-limit
  let active = await countActiveSessions(env, orgId);
  if (active >= maxConcurrent) {
    active = await reconcileSessionCounter(env, orgId);
  }
  return { limited: active >= maxConcurrent, active, max: maxConcurrent };
}

/**
 * Refresh the session heartbeat. Call once per turn.
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
 * When using the DO, also syncs the DO's session set with KV reality.
 */
export async function reconcileSessionCounter(
  env: RuntimeEnv,
  orgId: string,
): Promise<number> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return 0;

  try {
    const prefix = `${HEARTBEAT_KEY_PREFIX}/${orgId}/`;
    const list = await kv.list({ prefix, limit: 100 });
    const liveIds = (list.keys || []).map((k: any) => {
      const parts = k.name.split("/");
      return parts[parts.length - 1];
    });

    // Sync DO if available
    const stub = getCounterDO(env, orgId);
    if (stub) {
      try {
        return await stub.reconcile(liveIds);
      } catch {}
    }

    // KV fallback: reset counter to live count
    const liveCount = liveIds.length;
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
