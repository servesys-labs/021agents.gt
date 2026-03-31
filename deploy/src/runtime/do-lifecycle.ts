/**
 * Cloud Pattern C1.3 + C2.1 + C4.2: DO Lifecycle Management
 *
 * Handles the critical lifecycle events for Durable Objects:
 * - Prioritized flush on eviction (billing > session > telemetry)
 * - Snapshot-based fast hydration on cold start
 * - Cost state backup to KV (survives DO restart)
 *
 * Inspired by Claude Code's graceful shutdown with prioritized flush
 * and session-keyed cost persistence.
 */

import type { RuntimeEnv } from "./types";

// ── C1.3: Prioritized Flush on DO Eviction ──────────────────────────

interface FlushTask {
  name: string;
  priority: number; // lower = higher priority
  fn: () => Promise<void>;
  timeoutMs: number;
}

/**
 * Execute flush tasks in priority order within a total time budget.
 * Called during DO shutdown/eviction. Each task has its own timeout.
 *
 * Priority order:
 *   1. Billing records (revenue — most critical)
 *   2. Session state (conversation continuity)
 *   3. Telemetry (analytics — least critical, can be reconstructed)
 */
export async function prioritizedFlush(
  tasks: FlushTask[],
  totalBudgetMs: number = 9000, // DO has 10s, leave 1s margin
): Promise<{ completed: string[]; failed: string[]; timedOut: string[] }> {
  const sorted = [...tasks].sort((a, b) => a.priority - b.priority);
  const completed: string[] = [];
  const failed: string[] = [];
  const timedOut: string[] = [];
  const startTime = Date.now();

  for (const task of sorted) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalBudgetMs) {
      timedOut.push(task.name);
      continue;
    }

    const remainingBudget = totalBudgetMs - elapsed;
    const taskTimeout = Math.min(task.timeoutMs, remainingBudget);

    try {
      await Promise.race([
        task.fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("flush_timeout")), taskTimeout)
        ),
      ]);
      completed.push(task.name);
    } catch (e: any) {
      if (e?.message === "flush_timeout") {
        timedOut.push(task.name);
      } else {
        failed.push(task.name);
      }
    }
  }

  return { completed, failed, timedOut };
}

/**
 * Build the standard flush task list for an AgentOS DO.
 */
export function buildFlushTasks(
  env: RuntimeEnv,
  state: {
    sessionId: string;
    orgId: string;
    agentName: string;
    totalCostUsd: number;
    turnCount: number;
    pendingMessages?: Array<{ role: string; content: string }>;
  },
): FlushTask[] {
  return [
    {
      name: "billing",
      priority: 1,
      timeoutMs: 3000,
      fn: async () => {
        if (state.totalCostUsd <= 0) return;
        const queue = (env as any).TELEMETRY_QUEUE;
        if (!queue) return;
        await queue.send({
          type: "billing_flush",
          payload: {
            session_id: state.sessionId,
            org_id: state.orgId,
            agent_name: state.agentName,
            cost_usd: state.totalCostUsd,
            turns: state.turnCount,
            flushed_at: Date.now(),
          },
        });
      },
    },
    {
      name: "session_state",
      priority: 2,
      timeoutMs: 3000,
      fn: async () => {
        // Backup session cost state to KV for recovery after eviction
        const kv = (env as any).AGENT_PROGRESS_KV;
        if (!kv) return;
        await kv.put(
          `session-state/${state.sessionId}`,
          JSON.stringify({
            totalCostUsd: state.totalCostUsd,
            turnCount: state.turnCount,
            orgId: state.orgId,
            agentName: state.agentName,
            savedAt: Date.now(),
          }),
          { expirationTtl: 86400 }, // 24h
        );
      },
    },
    {
      name: "telemetry",
      priority: 3,
      timeoutMs: 2000,
      fn: async () => {
        const queue = (env as any).TELEMETRY_QUEUE;
        if (!queue) return;
        await queue.send({
          type: "do_eviction",
          payload: {
            session_id: state.sessionId,
            org_id: state.orgId,
            turns: state.turnCount,
            cost_usd: state.totalCostUsd,
            evicted_at: Date.now(),
          },
        });
      },
    },
  ];
}

// ── C2.1: Snapshot-Based Fast Hydration ─────────────────────────────

interface SessionSnapshot {
  totalCostUsd: number;
  turnCount: number;
  orgId: string;
  agentName: string;
  savedAt: number;
}

/**
 * Attempt fast hydration from KV snapshot instead of full Supabase replay.
 * Returns the snapshot if found and recent enough, null otherwise.
 *
 * KV snapshot is written during prioritized flush (C1.3) and during
 * normal session end. On cold start, this allows skipping the expensive
 * Supabase query for recent sessions.
 */
export async function hydrateFromSnapshot(
  env: RuntimeEnv,
  sessionId: string,
  maxAgeMs: number = 3600_000, // 1 hour — snapshots older than this need full replay
): Promise<SessionSnapshot | null> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return null;

  try {
    const raw = await kv.get(`session-state/${sessionId}`);
    if (!raw) return null;

    const snapshot: SessionSnapshot = JSON.parse(raw);
    if (Date.now() - snapshot.savedAt > maxAgeMs) return null;

    return snapshot;
  } catch {
    return null;
  }
}

// ── C4.2: Cost State Backup ─────────────────────────────────────────
// Review fix: Consolidated with session-state/ (was duplicated under cost-state/).
// hydrateFromSnapshot() already reads from session-state/ which includes cost.
// backupCostState now writes to the SAME key so there's one source of truth.

/**
 * Backup current cost state to KV. Called periodically during long sessions
 * (every 5 turns) and at session end. Uses the same session-state/ key as
 * hydrateFromSnapshot to avoid dual-key consistency issues.
 */
export async function backupCostState(
  env: RuntimeEnv,
  sessionId: string,
  costUsd: number,
  turnCount: number,
  orgId?: string,
  agentName?: string,
): Promise<void> {
  const kv = (env as any).AGENT_PROGRESS_KV;
  if (!kv) return;
  try {
    await kv.put(
      `session-state/${sessionId}`,
      JSON.stringify({
        totalCostUsd: costUsd,
        turnCount,
        orgId: orgId || "",
        agentName: agentName || "",
        savedAt: Date.now(),
      }),
      { expirationTtl: 86400 }, // 24h
    );
  } catch {
    // Best-effort
  }
}

/**
 * Recover cost state from KV after DO restart.
 * Reads from the unified session-state/ key.
 */
export async function recoverCostState(
  env: RuntimeEnv,
  sessionId: string,
): Promise<{ costUsd: number; turnCount: number } | null> {
  const snapshot = await hydrateFromSnapshot(env, sessionId);
  if (!snapshot) return null;
  return { costUsd: snapshot.totalCostUsd, turnCount: snapshot.turnCount };
}
