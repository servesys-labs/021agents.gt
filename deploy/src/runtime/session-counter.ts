/**
 * Cloud Pattern C4.1: Cross-DO Org Session Counter
 *
 * Problem: Each DO is isolated — can't count concurrent sessions across
 * an org. Users can spawn unlimited parallel sessions, overwhelming
 * infrastructure and budget.
 *
 * Solution: KV-based session counter with TTL heartbeats. Each active
 * session writes a heartbeat every 30s. Counter reads active sessions
 * by listing KV keys with the org prefix.
 *
 * Inspired by Claude Code's PID registry + concurrent session counting.
 */

import type { RuntimeEnv } from "./types";

const SESSION_HEARTBEAT_TTL = 120; // 2 minutes — stale sessions auto-expire
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Register an active session for concurrent counting.
 * Call at session start and periodically (every 30s) during execution.
 */
export async function registerSession(
  env: RuntimeEnv,
  orgId: string,
  sessionId: string,
  metadata?: {
    agentName?: string;
    channel?: string;
    startedAt?: number;
  },
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;

  try {
    await kv.put(
      `active-sessions/${orgId}/${sessionId}`,
      JSON.stringify({
        agent_name: metadata?.agentName || "",
        channel: metadata?.channel || "",
        started_at: metadata?.startedAt || Date.now(),
        heartbeat_at: Date.now(),
      }),
      { expirationTtl: SESSION_HEARTBEAT_TTL },
    );
  } catch {
    // Best-effort registration
  }
}

/**
 * Unregister a session (session completed or failed).
 */
export async function unregisterSession(
  env: RuntimeEnv,
  orgId: string,
  sessionId: string,
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;

  try {
    await kv.delete(`active-sessions/${orgId}/${sessionId}`);
  } catch {
    // Will auto-expire via TTL anyway
  }
}

/**
 * Count active sessions for an org.
 * Uses KV list API to count keys with the org prefix.
 * Stale sessions (missed heartbeat) auto-expire via TTL.
 */
export async function countActiveSessions(
  env: RuntimeEnv,
  orgId: string,
): Promise<number> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return 0;

  try {
    const result = await kv.list({ prefix: `active-sessions/${orgId}/` });
    return result.keys?.length || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if org has reached concurrent session limit.
 * Default limit: 10 concurrent sessions per org.
 *
 * NOTE: This is ADVISORY, not hard enforcement. KV list() is eventually
 * consistent (~60s propagation), so two DOs starting simultaneously may
 * both pass the check. For hard enforcement, use a dedicated DO as
 * serialization point. Advisory limiting is sufficient for preventing
 * runaway parallel sessions from misconfigured integrations.
 */
export async function isSessionLimitReached(
  env: RuntimeEnv,
  orgId: string,
  maxConcurrent: number = 10,
): Promise<{ limited: boolean; active: number; max: number }> {
  const active = await countActiveSessions(env, orgId);
  return {
    limited: active >= maxConcurrent,
    active,
    max: maxConcurrent,
  };
}

/**
 * Refresh the session heartbeat. Call once per turn inside the workflow
 * loop instead of using setInterval (which doesn't survive Workflow step
 * boundaries — the isolate may be evicted between steps).
 *
 * Review fix: setInterval replaced with explicit per-turn call pattern.
 */
export async function refreshHeartbeat(
  env: RuntimeEnv,
  orgId: string,
  sessionId: string,
  metadata?: { agentName?: string; channel?: string },
): Promise<void> {
  await registerSession(env, orgId, sessionId, metadata);
}
