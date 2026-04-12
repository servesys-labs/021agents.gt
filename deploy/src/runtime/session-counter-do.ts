/**
 * Durable Object session counter — cross-isolate atomic session counting.
 *
 * Replaces the KV read-modify-write counter in `session-counter.ts`.
 * One DO instance per org_id. All isolates route to the same DO, so
 * the count is globally consistent — no more last-writer-wins race
 * where two concurrent `registerSession` calls both read `current=9`,
 * both write `10`, and the counter ends at 10 with 11 real sessions.
 *
 * DO methods are serialized (single-threaded per instance), so
 * register/unregister are naturally atomic. The session set in memory
 * provides O(1) count + dedup (re-registering the same session is a
 * no-op). Heartbeat keys in KV are retained for TTL-based crash
 * cleanup — the DO counter is authoritative, heartbeat keys are the
 * crash-recovery mechanism.
 */
import { DurableObject } from "cloudflare:workers";

export class SessionCounterDO extends DurableObject {
  private sessions = new Set<string>();

  /**
   * Register a session. Returns the new count.
   * Idempotent: re-registering the same session is a no-op.
   */
  async register(sessionId: string): Promise<number> {
    this.sessions.add(sessionId);
    return this.sessions.size;
  }

  /**
   * Unregister a session. Returns the new count.
   * Idempotent: unregistering a non-existent session is a no-op.
   */
  async unregister(sessionId: string): Promise<number> {
    this.sessions.delete(sessionId);
    return this.sessions.size;
  }

  /**
   * Get the current session count.
   */
  async count(): Promise<number> {
    return this.sessions.size;
  }

  /**
   * Check if the session limit is reached. Returns whether a new
   * session would be allowed and the current count.
   *
   * Does NOT register the session — call `register()` separately
   * after the check passes. This prevents a race where a rejected
   * request accidentally consumes a slot.
   */
  async isLimitReached(maxConcurrent: number): Promise<{
    limited: boolean;
    active: number;
    max: number;
  }> {
    return {
      limited: this.sessions.size >= maxConcurrent,
      active: this.sessions.size,
      max: maxConcurrent,
    };
  }

  /**
   * Reconcile: replace the in-memory set with a list of known-live
   * session IDs. Called by the cron reconciler after scanning
   * heartbeat keys to determine which sessions are still alive.
   */
  async reconcile(liveSessionIds: string[]): Promise<number> {
    this.sessions.clear();
    for (const id of liveSessionIds) this.sessions.add(id);
    return this.sessions.size;
  }

  /**
   * List all tracked session IDs (for debugging / admin).
   */
  async list(): Promise<string[]> {
    return [...this.sessions];
  }
}
