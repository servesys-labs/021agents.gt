/**
 * Cloud Pattern C1.1 + C1.2: Workflow Step Idempotency & Write Dedup
 *
 * Problem: Cloudflare Workflows retry failed steps. Without idempotency,
 * a retried tool execution runs again (wasting budget + causing side effects).
 * Also, session/turn writes can be duplicated on retry.
 *
 * Solution: KV-backed result cache keyed by step ID. On retry, lookup the
 * cached result instead of re-executing. UUID-based dedup for DB writes.
 *
 * Inspired by Claude Code's write-once tool results + UUID append chain.
 */

import type { RuntimeEnv } from "./types";

const IDEMPOTENCY_TTL = 3600; // 1 hour — covers longest possible workflow

/**
 * Generate a deterministic idempotency key for a workflow step.
 * Combines session ID, turn number, tool name, and a hash of arguments.
 */
export function stepIdempotencyKey(
  sessionId: string,
  turn: number,
  toolName: string,
  argsHash: string,
): string {
  return `idem/${sessionId}/t${turn}/${toolName}/${argsHash}`;
}

/**
 * Check if a step result is already cached (from a prior attempt).
 * Returns the cached result if found, null otherwise.
 */
export async function getStepResult(
  env: RuntimeEnv,
  key: string,
): Promise<string | null> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return null;
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

/**
 * Cache a step result for idempotent retries.
 * Write-once semantics: if the key already exists, this is a no-op.
 */
export async function cacheStepResult(
  env: RuntimeEnv,
  key: string,
  result: string,
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;
  try {
    // Check if already written (write-once)
    const existing = await kv.get(key);
    if (existing !== null) return; // Already cached from prior attempt
    await kv.put(key, result, { expirationTtl: IDEMPOTENCY_TTL });
  } catch {
    // Best-effort caching — don't block execution
  }
}

/**
 * Hash tool arguments for idempotency key generation.
 * Uses a fast non-crypto hash (djb2) since we only need collision resistance
 * within a single session's tool calls.
 */
export function hashArgs(args: string): string {
  let hash = 5381;
  for (let i = 0; i < args.length; i++) {
    hash = ((hash << 5) + hash + args.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

// ── C1.2: Write Deduplication ──────────────────────────────────────

/**
 * UUID-based write dedup for session/turn telemetry writes.
 * Tracks recently written UUIDs to prevent duplicate DB inserts on retry.
 *
 * Review fix: Scoped per session (not global per-isolate) to prevent
 * cross-session eviction in shared Workers isolates.
 */
const MAX_DEDUP_PER_SESSION = 200;
const MAX_SESSIONS = 50;

// Per-session dedup sets (isolate-scoped, bounded)
const sessionDedupSets = new Map<string, Set<string>>();

function getDedupSet(sessionId: string): Set<string> {
  let set = sessionDedupSets.get(sessionId);
  if (!set) {
    set = new Set();
    sessionDedupSets.set(sessionId, set);
    // Evict oldest session if too many tracked
    if (sessionDedupSets.size > MAX_SESSIONS) {
      const oldest = sessionDedupSets.keys().next().value;
      if (oldest !== undefined) sessionDedupSets.delete(oldest);
    }
  }
  return set;
}

/**
 * Check if this write UUID was already processed for a session.
 * Returns true if duplicate (should skip), false if new.
 */
export function isDuplicateWrite(sessionWriteUUID: string, sessionId: string = "default"): boolean {
  const set = getDedupSet(sessionId);
  if (set.has(sessionWriteUUID)) return true;
  set.add(sessionWriteUUID);
  if (set.size > MAX_DEDUP_PER_SESSION) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
  return false;
}

/**
 * Clean up dedup set for a completed session.
 */
export function clearSessionDedup(sessionId: string): void {
  sessionDedupSets.delete(sessionId);
}

/**
 * Generate a unique write UUID for a telemetry entry.
 * Deterministic from session + turn + type so retries produce the same UUID.
 */
export function writeUUID(sessionId: string, turn: number, type: string): string {
  return `${sessionId}-t${turn}-${type}`;
}
