/**
 * Cross-Session Progress Tracking
 *
 * Implements the "cognitive anchor" pattern from harness engineering:
 * agents need persistent, structured state that survives context window
 * boundaries so each new session can orient quickly.
 *
 * Two capabilities:
 * 1. **Progress Log** — append-only log of what was done, what failed,
 *    what remains. Written at session end, read at session start.
 * 2. **Startup Sequence** — standardized warm-up protocol that loads
 *    progress, verifies environment, and orients the agent before execution.
 */

import type { AgentConfig, RuntimeEvent } from "./types";
import { log } from "./log";

// ── Types ─────────────────────────────────────────────────────

export interface ProgressEntry {
  session_id: string;
  trace_id: string;
  agent_name: string;
  org_id: string;
  timestamp: number;
  summary: ProgressSummary;
}

export interface ProgressSummary {
  /** What the session accomplished. */
  completed: string[];
  /** Errors or failures encountered. */
  failures: string[];
  /** What remains to be done (carried forward to next session). */
  remaining: string[];
  /** Quantitative metrics for the session. */
  metrics: {
    turns: number;
    tool_calls: number;
    cost_usd: number;
    wall_clock_seconds: number;
    stop_reason: string;
  };
}

export interface StartupContext {
  /** Recent progress entries (most recent first, capped at 5). */
  recent_progress: ProgressEntry[];
  /** Total sessions for this agent. */
  total_sessions: number;
  /** Cumulative cost across all sessions. */
  cumulative_cost_usd: number;
  /** Last known good state (most recent successful session). */
  last_success_session_id: string | null;
  /** Formatted context string ready for system prompt injection. */
  context_block: string;
}

// ── Progress Writing ──────────────────────────────────────────

/**
 * Build a progress summary from session results and events.
 * This extracts a structured summary from the raw execution data.
 */
export function buildProgressSummary(
  results: Array<{
    turn_number: number;
    content: string;
    tool_results?: Array<{ tool: string; error?: string }>;
    done: boolean;
    stop_reason: string;
    error?: string;
    cost_usd: number;
  }>,
  events: RuntimeEvent[],
  wallClockSeconds: number,
  stopReason: string,
): ProgressSummary {
  const completed: string[] = [];
  const failures: string[] = [];
  const remaining: string[] = [];

  let totalToolCalls = 0;
  let totalCost = 0;

  for (const result of results) {
    totalCost += result.cost_usd;

    // Track tool calls and failures
    if (result.tool_results) {
      for (const tr of result.tool_results) {
        totalToolCalls++;
        if (tr.error) {
          failures.push(`Tool ${tr.tool} failed: ${truncate(tr.error, 120)}`);
        }
      }
    }

    // Track errors
    if (result.error) {
      failures.push(`Turn ${result.turn_number}: ${truncate(result.error, 120)}`);
    }

    // Extract completed work from final assistant messages
    if (result.done && result.content) {
      completed.push(truncate(result.content, 200));
    }
  }

  // Infer remaining work from stop reason
  if (stopReason === "max_turns") {
    remaining.push("Session hit max turns — task may be incomplete.");
  } else if (stopReason === "budget") {
    remaining.push("Session hit budget limit — task may be incomplete.");
  } else if (stopReason === "loop") {
    remaining.push("Session halted due to loop detection — may need different approach.");
  } else if (stopReason === "error") {
    remaining.push("Session ended with error — investigate and retry.");
  } else if (stopReason === "breakpoint") {
    remaining.push("Session paused at approval gate — waiting for human approval.");
  }

  return {
    completed: completed.slice(0, 5),   // Cap at 5 entries
    failures: failures.slice(0, 10),     // Cap at 10
    remaining: remaining.slice(0, 5),    // Cap at 5
    metrics: {
      turns: results.length,
      tool_calls: totalToolCalls,
      cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
      wall_clock_seconds: Math.round(wallClockSeconds * 100) / 100,
      stop_reason: stopReason,
    },
  };
}

/**
 * Write a progress entry to Supabase.
 * Best-effort — failures are logged but do not block execution.
 */
export async function writeProgress(
  hyperdrive: Hyperdrive,
  entry: ProgressEntry,
): Promise<void> {
  try {
    const { getDb } = await import("./db");
    const sql = await getDb(hyperdrive);
    await sql`
      INSERT INTO session_progress (
        session_id, stage, message, created_at
      ) VALUES (
        ${entry.session_id},
        ${entry.agent_name || ''},
        ${JSON.stringify({ trace_id: entry.trace_id, org_id: entry.org_id, agent_name: entry.agent_name, ...entry.summary })},
        NOW()
      )
    `;
  } catch (err) {
    log.error(
      "[progress] writeProgress failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Startup Sequence ──────────────────────────────────────────

/**
 * Load startup context for an agent.
 * Returns recent progress, cumulative stats, and a formatted context block
 * ready for system prompt injection.
 */
export async function loadStartupContext(
  hyperdrive: Hyperdrive,
  agentName: string,
  orgId: string,
): Promise<StartupContext> {
  const empty: StartupContext = {
    recent_progress: [],
    total_sessions: 0,
    cumulative_cost_usd: 0,
    last_success_session_id: null,
    context_block: "",
  };

  try {
    const { getDb } = await import("./db");
    const sql = await getDb(hyperdrive);

    // Load recent progress entries (most recent 5)
    const progressRows = await sql`
      SELECT session_id, trace_id, agent_name, org_id, summary, created_at
      FROM session_progress
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
      ORDER BY created_at DESC
      LIMIT 5
    `;

    // Load aggregate session stats
    const statsRows = await sql`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(cost_total_usd), 0) as cumulative_cost,
        (
          SELECT session_id FROM sessions
          WHERE agent_name = ${agentName} AND org_id = ${orgId} AND status = 'success'
          ORDER BY created_at DESC LIMIT 1
        ) as last_success_id
      FROM sessions
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
    `;

    const recentProgress: ProgressEntry[] = progressRows.map((row: any) => ({
      session_id: String(row.session_id),
      trace_id: String(row.trace_id),
      agent_name: String(row.agent_name),
      org_id: String(row.org_id),
      timestamp: Number(row.created_at) * 1000,
      summary: typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary,
    }));

    const stats = statsRows[0] || {};
    const totalSessions = Number(stats.total_sessions) || 0;
    const cumulativeCost = Number(stats.cumulative_cost) || 0;
    const lastSuccessId = stats.last_success_id ? String(stats.last_success_id) : null;

    const contextBlock = formatContextBlock(recentProgress, totalSessions, cumulativeCost);

    return {
      recent_progress: recentProgress,
      total_sessions: totalSessions,
      cumulative_cost_usd: cumulativeCost,
      last_success_session_id: lastSuccessId,
      context_block: contextBlock,
    };
  } catch (err) {
    log.error(
      "[progress] loadStartupContext failed:",
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}

/**
 * Format progress entries into a compact context block for system prompt injection.
 * Uses progressive disclosure: only the most recent session gets full detail.
 */
function formatContextBlock(
  entries: ProgressEntry[],
  totalSessions: number,
  cumulativeCost: number,
): string {
  if (entries.length === 0) {
    return "[Session Progress] First session for this agent. No prior history.";
  }

  const lines: string[] = [
    `[Session Progress] ${totalSessions} total sessions | $${cumulativeCost.toFixed(4)} cumulative cost`,
    "",
  ];

  // Most recent session gets full detail
  const latest = entries[0];
  lines.push(`Latest session (${latest.session_id}):`);
  if (latest.summary.completed.length > 0) {
    lines.push(`  Completed: ${latest.summary.completed.join("; ")}`);
  }
  if (latest.summary.failures.length > 0) {
    lines.push(`  Failures: ${latest.summary.failures.slice(0, 3).join("; ")}`);
  }
  if (latest.summary.remaining.length > 0) {
    lines.push(`  Remaining: ${latest.summary.remaining.join("; ")}`);
  }
  lines.push(
    `  Metrics: ${latest.summary.metrics.turns} turns, ${latest.summary.metrics.tool_calls} tool calls, $${latest.summary.metrics.cost_usd.toFixed(4)}, stop=${latest.summary.metrics.stop_reason}`,
  );

  // Older sessions get one-line summaries (progressive disclosure)
  if (entries.length > 1) {
    lines.push("");
    lines.push("Prior sessions:");
    for (const entry of entries.slice(1)) {
      const completedCount = entry.summary.completed.length;
      const failureCount = entry.summary.failures.length;
      lines.push(
        `  ${entry.session_id}: ${completedCount} completed, ${failureCount} failures, stop=${entry.summary.metrics.stop_reason}`,
      );
    }
  }

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
