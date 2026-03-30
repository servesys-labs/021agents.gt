/**
 * Gate-pack logic: eval readiness + rollout recommendation.
 * Ported from agents.py _latest_eval_gate / _rollout_recommendation.
 */

import type { Sql } from "../db/client";

export interface EvalGate {
  latest_eval_run: Record<string, unknown> | null;
  min_eval_pass_rate: number;
  min_eval_trials: number;
  passed: boolean;
  eval_run_endpoint?: string;
}

export interface Rollout {
  decision: "hold" | "promote_candidate";
  target_channel: string;
  reason: string;
  recommended_action: string;
  release_endpoint: string;
}

/** Query latest eval run for an agent and determine pass/fail. */
export async function latestEvalGate(
  sql: Sql,
  agentName: string,
  opts: { minEvalPassRate: number; minEvalTrials: number; orgId?: string },
): Promise<EvalGate> {
  let latestEval: Record<string, unknown> | null = null;
  try {
    // Scope to org when available to prevent cross-tenant data leakage
    const rows = opts.orgId
      ? await sql`
          SELECT id, pass_rate, total_trials, total_tasks, created_at
          FROM eval_runs
          WHERE agent_name = ${agentName} AND org_id = ${opts.orgId}
          ORDER BY created_at DESC LIMIT 1
        `
      : await sql`
          SELECT id, pass_rate, total_trials, total_tasks, created_at
          FROM eval_runs
          WHERE agent_name = ${agentName}
          ORDER BY created_at DESC LIMIT 1
        `;
    if (rows.length > 0) {
      latestEval = rows[0] as Record<string, unknown>;
    }
  } catch {
    // eval_runs table may not exist yet — non-fatal
  }

  let passed = false;
  if (latestEval !== null) {
    const passRate = Number(latestEval.pass_rate ?? 0);
    const totalTrials = Number(latestEval.total_trials ?? 0);
    passed = passRate >= opts.minEvalPassRate && totalTrials >= opts.minEvalTrials;
  }

  return {
    latest_eval_run: latestEval,
    min_eval_pass_rate: opts.minEvalPassRate,
    min_eval_trials: opts.minEvalTrials,
    passed,
  };
}

/** Build rollout recommendation based on eval results. */
export function rolloutRecommendation(opts: {
  agentName: string;
  evalGate: EvalGate;
  targetChannel: string;
}): Rollout {
  const rollout: Rollout = {
    decision: "hold",
    target_channel: opts.targetChannel,
    reason: "",
    recommended_action: "",
    release_endpoint: `/api/v1/releases/${opts.agentName}/promote?from_channel=draft&to_channel=${opts.targetChannel}`,
  };

  const latestEval = opts.evalGate.latest_eval_run;

  if (latestEval === null) {
    rollout.reason = "No eval run found for agent.";
    rollout.recommended_action = "Run /api/v1/eval/run before promotion.";
  } else if (!opts.evalGate.passed) {
    const passRate = Number(latestEval.pass_rate ?? 0);
    const totalTrials = Number(latestEval.total_trials ?? 0);
    rollout.reason = `Eval gate failed (pass_rate=${passRate.toFixed(2)}, trials=${totalTrials}).`;
    rollout.recommended_action =
      "Run targeted eval/experiments and iterate before promotion.";
  } else {
    rollout.decision = "promote_candidate";
    rollout.reason = "Eval gate passed.";
    rollout.recommended_action =
      "Promote to target channel and optionally start canary.";
  }

  return rollout;
}

