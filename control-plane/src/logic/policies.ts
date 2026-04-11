/**
 * Agent policies — configurable thresholds per-org or per-agent.
 * Falls back to platform defaults when no policy exists.
 */

import type { Env } from "../env";
import { withOrgDb } from "../db/client";
import { parseJsonColumn } from "../lib/parse-json-column";

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
 *
 * Takes the Env (not a raw Hyperdrive) so the call flows through
 * withOrgDb with the caller's org_id set for RLS.
 */
export async function getThresholds(
  env: Pick<Env, "HYPERDRIVE">,
  orgId: string,
  agentName?: string,
): Promise<Thresholds> {
  try {
    return await withOrgDb(env, orgId, async (sql) => {
      // RLS filters agent_policies to the current org automatically.
      if (agentName) {
        const agentRows = await sql`
          SELECT config FROM agent_policies
          WHERE agent_name = ${agentName} AND policy_type = 'thresholds'
          LIMIT 1
        `;
        if (agentRows.length > 0) {
          return { ...PLATFORM_DEFAULTS, ...parseJsonColumn(agentRows[0].config) };
        }
      }

      // Try org-wide policy (agent_name IS NULL)
      const orgRows = await sql`
        SELECT config FROM agent_policies
        WHERE agent_name IS NULL AND policy_type = 'thresholds'
        LIMIT 1
      `;
      if (orgRows.length > 0) {
        return { ...PLATFORM_DEFAULTS, ...parseJsonColumn(orgRows[0].config) };
      }
      return PLATFORM_DEFAULTS;
    });
  } catch {
    // DB error — use platform defaults
    return PLATFORM_DEFAULTS;
  }
}

export { PLATFORM_DEFAULTS };
