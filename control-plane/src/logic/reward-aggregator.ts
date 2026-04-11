/**
 * Reward aggregator — computes composite reward signals from multiple sources.
 *
 * Reads from existing tables (eval_runs, session_feedback, sessions, guardrail events)
 * and produces a normalized 0.0–1.0 reward score with per-source breakdown.
 */
import type { Sql } from "../db/client";

export interface RewardWeights {
  eval: number;
  feedback: number;
  guardrail: number;
  cost: number;
  latency: number;
}

export const DEFAULT_WEIGHTS: RewardWeights = {
  eval: 0.50,
  feedback: 0.20,
  guardrail: 0.15,
  cost: 0.10,
  latency: 0.05,
};

export interface RewardResult {
  score: number;
  breakdown: Record<string, number>;
  sources_used: string[];
}

/**
 * Compute a composite reward for a specific eval run + its sessions.
 */
export async function computeRewardForEvalRun(
  sql: Sql,
  orgId: string,
  agentName: string,
  evalRunId: number,
  weights: RewardWeights = DEFAULT_WEIGHTS,
): Promise<RewardResult> {
  const breakdown: Record<string, number> = {};
  const sourcesUsed: string[] = [];

  // 1. Eval pass rate (0.0 – 1.0)
  let evalScore = 0;
  try {
    const rows = await sql`
      SELECT pass_rate, avg_score, avg_latency_ms, total_cost_usd
      FROM eval_runs WHERE id = ${evalRunId} AND org_id = ${orgId}
    `;
    if (rows.length > 0) {
      const run = rows[0];
      evalScore = Number(run.pass_rate ?? run.avg_score ?? 0);
      breakdown.eval = evalScore;
      sourcesUsed.push("eval");

      // Cost efficiency (lower is better, normalize against $1 budget)
      const cost = Number(run.total_cost_usd ?? 0);
      breakdown.cost = Math.max(0, 1 - cost / 1.0); // 1.0 at $0, 0.0 at $1+
      if (cost > 0) sourcesUsed.push("cost");

      // Latency (lower is better, normalize against 30s)
      const latency = Number(run.avg_latency_ms ?? 0);
      breakdown.latency = Math.max(0, 1 - latency / 30000); // 1.0 at 0ms, 0.0 at 30s+
      if (latency > 0) sourcesUsed.push("latency");
    }
  } catch {
    // Non-critical
  }

  // 2. User feedback for this agent (recent window)
  let feedbackScore = 0;
  try {
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE rating > 0) as positive,
        COUNT(*) as total
      FROM session_feedback
      WHERE org_id = ${orgId}
        AND agent_name = ${agentName}
        AND created_at > now() - interval '7 days'
    `;
    if (rows.length > 0 && Number(rows[0].total) > 0) {
      feedbackScore = Number(rows[0].positive) / Number(rows[0].total);
      breakdown.feedback = feedbackScore;
      sourcesUsed.push("feedback");
    }
  } catch {
    // session_feedback.agent_name column may not exist in all environments.
    // Swallowing this error is intentional — feedback is non-critical.
  }

  // 3. Guardrail compliance (1.0 = no violations)
  let guardrailScore = 1.0;
  try {
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE action = 'block') as blocked,
        COUNT(*) as total
      FROM guardrail_events
      WHERE org_id = ${orgId}
        AND agent_name = ${agentName}
        AND created_at > now() - interval '7 days'
    `;
    if (rows.length > 0 && Number(rows[0].total) > 0) {
      guardrailScore = 1 - Number(rows[0].blocked) / Number(rows[0].total);
      breakdown.guardrail = guardrailScore;
      sourcesUsed.push("guardrail");
    }
  } catch {
    // Table may not exist
    breakdown.guardrail = 1.0;
  }

  // Fill defaults for missing sources (use explicit undefined checks so that
  // legitimate 0.0 scores, $1.00 cost, or 30000ms latency are not overwritten)
  if (breakdown.eval === undefined) breakdown.eval = 0;
  if (breakdown.feedback === undefined) breakdown.feedback = 0.5; // neutral default
  if (breakdown.guardrail === undefined) breakdown.guardrail = 1.0; // assume compliant
  if (breakdown.cost === undefined) breakdown.cost = 0.5;
  if (breakdown.latency === undefined) breakdown.latency = 0.5;

  // Weighted composite — normalize by weight sum so custom weights that don't
  // add to 1.0 still produce a valid 0–1 score.
  const weightSum =
    weights.eval + weights.feedback + weights.guardrail + weights.cost + weights.latency;
  const rawScore =
    breakdown.eval * weights.eval +
    breakdown.feedback * weights.feedback +
    breakdown.guardrail * weights.guardrail +
    breakdown.cost * weights.cost +
    breakdown.latency * weights.latency;
  const score = weightSum > 0 ? rawScore / weightSum : 0;

  return {
    score: Math.max(0, Math.min(1, score)),
    breakdown,
    sources_used: sourcesUsed,
  };
}

/**
 * Compute reward from session-level signals (without an eval run).
 */
export async function computeRewardForSessions(
  sql: Sql,
  orgId: string,
  agentName: string,
  sessionIds: string[],
  weights: RewardWeights = DEFAULT_WEIGHTS,
): Promise<RewardResult> {
  if (sessionIds.length === 0) {
    return { score: 0, breakdown: {}, sources_used: [] };
  }

  const breakdown: Record<string, number> = {};
  const sourcesUsed: string[] = [];

  // Success rate from sessions.
  // IN ${sql(array)} — see routes/dashboard.ts for Hyperdrive prepare:false notes.
  try {
    if (sessionIds.length === 0) throw new Error("no sessions");
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) as total,
        AVG(cost_total_usd) as avg_cost,
        AVG(wall_clock_seconds) as avg_wall_clock
      FROM sessions
      WHERE session_id IN ${sql(sessionIds)}
        AND org_id = ${orgId}
    `;
    if (rows.length > 0 && Number(rows[0].total) > 0) {
      breakdown.eval = Number(rows[0].completed) / Number(rows[0].total);
      breakdown.cost = Math.max(0, 1 - Number(rows[0].avg_cost ?? 0) / 1.0);
      breakdown.latency = Math.max(0, 1 - (Number(rows[0].avg_wall_clock ?? 0) * 1000) / 30000);
      sourcesUsed.push("sessions");
    }
  } catch {
    breakdown.eval = 0;
  }

  // Defaults (explicit undefined checks to preserve legitimate zero values)
  if (breakdown.eval === undefined) breakdown.eval = 0;
  if (breakdown.feedback === undefined) breakdown.feedback = 0.5;
  if (breakdown.guardrail === undefined) breakdown.guardrail = 1.0;
  if (breakdown.cost === undefined) breakdown.cost = 0.5;
  if (breakdown.latency === undefined) breakdown.latency = 0.5;

  // Normalize by weight sum so custom weights that don't add to 1.0 still
  // produce a valid 0–1 score.
  const weightSum =
    weights.eval + weights.feedback + weights.guardrail + weights.cost + weights.latency;
  const rawScore =
    breakdown.eval * weights.eval +
    breakdown.feedback * weights.feedback +
    breakdown.guardrail * weights.guardrail +
    breakdown.cost * weights.cost +
    breakdown.latency * weights.latency;
  const score = weightSum > 0 ? rawScore / weightSum : 0;

  return {
    score: Math.max(0, Math.min(1, score)),
    breakdown,
    sources_used: sourcesUsed,
  };
}
