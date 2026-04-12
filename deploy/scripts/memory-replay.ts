#!/usr/bin/env npx tsx
/**
 * Memory agent replay script — Stage 1 offline A/B comparison.
 *
 * Reads recent sessions from the episodes table and compares memory retrieval
 * quality between the baseline path (no decay ranking) and the memory-agent
 * path (effectiveConfidence ranking + filtering).
 *
 * Usage:
 *   npx tsx deploy/scripts/memory-replay.ts --db-url <HYPERDRIVE_URL> [--limit 50]
 *
 * Output: JSON report with per-session comparison metrics.
 *
 * This script does NOT modify any data. Read-only analysis.
 */

import { effectiveConfidence } from "../src/runtime/memory";

// ── Types ────────────────────────────────────────────────────

interface Fact {
  key: string;
  value: string;
  category: string;
  confidence: number;
  created_at: string;
  last_reinforced_at: string | null;
}

interface ReplayResult {
  session_id: string;
  query: string;
  baseline_facts: string[];
  ranked_facts: string[];
  baseline_stale_count: number;
  ranked_stale_count: number;
  ranking_changed: boolean;
  archived_by_decay: number;
}

// ── Decay comparison ─────────────────────────────────────────

function compareRanking(facts: Fact[], query: string): ReplayResult {
  const now = Date.now();
  const STALE_THRESHOLD_DAYS = 90;
  const staleMs = STALE_THRESHOLD_DAYS * 86_400_000;

  // Baseline: merge order, slice to 8 (old behavior)
  const baselineFacts = facts.slice(0, 8);

  // Ranked: effectiveConfidence sort + filter (new behavior)
  const withDecay = facts
    .map(f => {
      const reinforcedAt = f.last_reinforced_at
        ? new Date(f.last_reinforced_at).getTime()
        : new Date(f.created_at).getTime();
      return { ...f, effConf: effectiveConfidence(f.confidence, reinforcedAt) };
    })
    .filter(f => f.effConf > 0.1)
    .sort((a, b) => b.effConf - a.effConf)
    .slice(0, 8);

  const baselineKeys = baselineFacts.map(f => f.key);
  const rankedKeys = withDecay.map(f => f.key);

  const baselineStale = baselineFacts.filter(f => {
    const age = now - new Date(f.last_reinforced_at || f.created_at).getTime();
    return age > staleMs;
  }).length;

  const rankedStale = withDecay.filter(f => {
    const age = now - new Date(f.last_reinforced_at || f.created_at).getTime();
    return age > staleMs;
  }).length;

  const archived = facts.length - withDecay.length - (facts.length - facts.length); // facts filtered out by decay
  const archivedByDecay = facts.filter(f => {
    const reinforcedAt = f.last_reinforced_at
      ? new Date(f.last_reinforced_at).getTime()
      : new Date(f.created_at).getTime();
    return effectiveConfidence(f.confidence, reinforcedAt) <= 0.1;
  }).length;

  return {
    session_id: "",
    query,
    baseline_facts: baselineKeys,
    ranked_facts: rankedKeys,
    baseline_stale_count: baselineStale,
    ranked_stale_count: rankedStale,
    ranking_changed: JSON.stringify(baselineKeys) !== JSON.stringify(rankedKeys),
    archived_by_decay: archivedByDecay,
  };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dbUrlIdx = args.indexOf("--db-url");
  const limitIdx = args.indexOf("--limit");

  if (dbUrlIdx === -1 || !args[dbUrlIdx + 1]) {
    console.error("Usage: npx tsx deploy/scripts/memory-replay.ts --db-url <URL> [--limit 50]");
    process.exit(1);
  }

  const dbUrl = args[dbUrlIdx + 1];
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] || "50") : 50;

  // Dynamic import postgres
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);

  try {
    // Fetch recent episodes
    const episodes = await sql`
      SELECT DISTINCT ON (session_id) session_id, content, created_at, org_id, agent_name
      FROM episodes
      ORDER BY session_id, created_at DESC
      LIMIT ${limit}
    `;

    if (episodes.length === 0) {
      console.log(JSON.stringify({ error: "no_episodes", message: "No episodes found in database" }));
      return;
    }

    const results: ReplayResult[] = [];
    let totalChanged = 0;
    let totalBaselineStale = 0;
    let totalRankedStale = 0;
    let totalArchived = 0;

    for (const ep of episodes) {
      // Fetch facts for this agent/org
      const facts = await sql`
        SELECT key, value, category, confidence, created_at, last_reinforced_at
        FROM facts
        WHERE agent_name = ${ep.agent_name} AND org_id = ${ep.org_id} AND scope = 'agent'
        ORDER BY created_at DESC
        LIMIT 20
      `;

      if (facts.length === 0) continue;

      const query = (ep.content || "").slice(0, 200);
      const result = compareRanking(facts as unknown as Fact[], query);
      result.session_id = ep.session_id;

      results.push(result);
      if (result.ranking_changed) totalChanged++;
      totalBaselineStale += result.baseline_stale_count;
      totalRankedStale += result.ranked_stale_count;
      totalArchived += result.archived_by_decay;
    }

    const report = {
      timestamp: new Date().toISOString(),
      sessions_analyzed: results.length,
      summary: {
        ranking_changed_count: totalChanged,
        ranking_changed_pct: results.length > 0 ? Math.round((totalChanged / results.length) * 100) : 0,
        baseline_stale_facts_total: totalBaselineStale,
        ranked_stale_facts_total: totalRankedStale,
        stale_reduction_pct: totalBaselineStale > 0
          ? Math.round(((totalBaselineStale - totalRankedStale) / totalBaselineStale) * 100)
          : 0,
        facts_archived_by_decay: totalArchived,
      },
      details: results,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch(err => {
  console.error("Replay failed:", err.message);
  process.exit(1);
});
