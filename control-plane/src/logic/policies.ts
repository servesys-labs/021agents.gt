/**
 * Agent policies — configurable thresholds per-org or per-agent.
 * Falls back to platform defaults when no policy exists.
 */

import { getDb } from "../db/client";

export interface Thresholds {
  eval_pass_rate: number;
  eval_min_trials: number;
  canary_error_drift_pp: number;
  quality_drop_trigger_pp: number;
  regression_rollback_pct: number;
  quality_drop_dedup_hours: number;
}

const PLATFORM_DEFAULTS: Thresholds = {
  eval_pass_rate: 0.8,
  eval_min_trials: 5,
  canary_error_drift_pp: 0.05,
  quality_drop_trigger_pp: 0.10,
  regression_rollback_pct: 0.10,
  quality_drop_dedup_hours: 24,
};

/**
 * Load thresholds for an agent, with fallback chain:
 *   agent-specific → org-wide → platform defaults
 */
export async function getThresholds(
  hyperdrive: Hyperdrive,
  orgId: string,
  agentName?: string,
): Promise<Thresholds> {
  try {
    const sql = await getDb(hyperdrive);

    // Try agent-specific policy first
    if (agentName) {
      const agentRows = await sql`
        SELECT config_json FROM agent_policies
        WHERE org_id = ${orgId} AND agent_name = ${agentName} AND policy_type = 'thresholds'
        LIMIT 1
      `;
      if (agentRows.length > 0) {
        return { ...PLATFORM_DEFAULTS, ...JSON.parse(String(agentRows[0].config_json)) };
      }
    }

    // Try org-wide policy
    const orgRows = await sql`
      SELECT config_json FROM agent_policies
      WHERE org_id = ${orgId} AND agent_name IS NULL AND policy_type = 'thresholds'
      LIMIT 1
    `;
    if (orgRows.length > 0) {
      return { ...PLATFORM_DEFAULTS, ...JSON.parse(String(orgRows[0].config_json)) };
    }
  } catch {
    // DB error — use platform defaults
  }

  return PLATFORM_DEFAULTS;
}

export { PLATFORM_DEFAULTS };
