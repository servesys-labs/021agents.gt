/**
 * Dream Memory Consolidation — background memory optimization.
 *
 * Runs during autopilot idle ticks or scheduled via cron.
 * Three consolidation passes:
 *   1. Episode merging: group similar episodes by keyword overlap
 *   2. Procedure promotion: if same tool sequence appears 3+ times, create procedure
 *   3. Fact decay: reduce relevance score of facts not accessed in 30 days
 *
 * Inspired by Claude Code's KAIROS "dream" consolidation that runs during background sessions.
 */

import type { RuntimeEnv } from "./types";
import { parseJsonColumn } from "./parse-json-column";

interface ConsolidationResult {
  episodes_merged: number;
  procedures_promoted: number;
  facts_decayed: number;
  duration_ms: number;
}

/**
 * Run a full memory consolidation pass for an agent.
 * Should be called during low-activity periods (autopilot idle, cron).
 */
export async function consolidateMemory(
  env: RuntimeEnv,
  orgId: string,
  agentName: string,
): Promise<ConsolidationResult> {
  const started = Date.now();
  let episodesMerged = 0;
  let proceduresPromoted = 0;
  let factsDecayed = 0;

  try {
    const pg = (await import("postgres")).default;
    const sql = pg((env as any).HYPERDRIVE?.connectionString || "", { max: 1, prepare: false });

    // ── Pass 1: Episode Merging ──
    // Find episodes with >60% keyword overlap and merge them
    const episodes = await sql`
      SELECT id, session_id, keywords, summary, score
      FROM agent_episodes
      WHERE org_id = ${orgId} AND agent_name = ${agentName}
      ORDER BY score DESC
      LIMIT 200
    `.catch(() => []);

    const merged = new Set<string>();
    for (let i = 0; i < episodes.length; i++) {
      if (merged.has(episodes[i].id)) continue;
      const kw1 = new Set((episodes[i].keywords || "").split(",").map((k: string) => k.trim().toLowerCase()));
      if (kw1.size === 0) continue;

      for (let j = i + 1; j < episodes.length; j++) {
        if (merged.has(episodes[j].id)) continue;
        const kw2 = new Set((episodes[j].keywords || "").split(",").map((k: string) => k.trim().toLowerCase()));
        if (kw2.size === 0) continue;

        // Calculate Jaccard similarity
        const intersection = [...kw1].filter(k => kw2.has(k)).length;
        const union = new Set([...kw1, ...kw2]).size;
        const similarity = union > 0 ? intersection / union : 0;

        if (similarity > 0.6) {
          // Merge: keep higher-scored episode, delete lower
          const keep = episodes[i].score >= episodes[j].score ? episodes[i] : episodes[j];
          const drop = keep === episodes[i] ? episodes[j] : episodes[i];

          // Combine summaries
          const combinedSummary = `${keep.summary || ""}\n---\n${drop.summary || ""}`.slice(0, 2000);
          const combinedKeywords = [...new Set([...kw1, ...kw2])].join(", ");

          await sql`
            UPDATE agent_episodes SET summary = ${combinedSummary}, keywords = ${combinedKeywords},
              score = ${Math.max(keep.score, drop.score)}, updated_at = NOW()
            WHERE id = ${keep.id}
          `.catch(() => {});

          await sql`DELETE FROM agent_episodes WHERE id = ${drop.id}`.catch(() => {});
          merged.add(drop.id);
          episodesMerged++;
        }
      }
    }

    // ── Pass 2: Procedure Promotion ──
    // Find tool sequences that appear 3+ times in recent episodes → create procedure
    const recentSessions = await sql`
      SELECT session_id, tool_calls FROM turns
      WHERE session_id IN (
        SELECT session_id FROM sessions
        WHERE org_id = ${orgId} AND agent_name = ${agentName}
          AND status = 'success' AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 50
      )
      ORDER BY turn_number ASC
    `.catch(() => []);

    // Build tool sequences per session
    const sequences = new Map<string, { tools: string[]; count: number }>();
    let currentSession = "";
    let currentTools: string[] = [];

    for (const row of recentSessions) {
      if (row.session_id !== currentSession) {
        if (currentTools.length >= 2 && currentSession) {
          const key = currentTools.join(" → ");
          const existing = sequences.get(key) || { tools: currentTools, count: 0 };
          existing.count++;
          sequences.set(key, existing);
        }
        currentSession = row.session_id;
        currentTools = [];
      }
      try {
        const calls = parseJsonColumn<Array<{ name?: string }>>(row.tool_calls, []);
        for (const tc of calls) {
          if (tc.name) currentTools.push(tc.name);
        }
      } catch {}
    }
    // Don't forget last session
    if (currentTools.length >= 2) {
      const key = currentTools.join(" → ");
      const existing = sequences.get(key) || { tools: currentTools, count: 0 };
      existing.count++;
      sequences.set(key, existing);
    }

    // Promote sequences appearing 3+ times
    for (const [pattern, data] of sequences) {
      if (data.count >= 3) {
        await sql`
          INSERT INTO procedures (org_id, agent_name, task_pattern, tool_sequence, success_rate, avg_turns, created_at)
          VALUES (${orgId}, ${agentName}, ${pattern.slice(0, 200)}, ${JSON.stringify(data.tools)}, ${0.8}, ${data.tools.length}, NOW())
          ON CONFLICT (org_id, agent_name, task_pattern) DO UPDATE SET
            success_rate = GREATEST(procedures.success_rate, 0.8),
            updated_at = NOW()
        `.catch(() => {});
        proceduresPromoted++;
      }
    }

    // ── Pass 3: Fact Decay ──
    // Reduce score of facts not accessed in 30 days
    const decayed = await sql`
      UPDATE agent_facts SET score = score * 0.8, updated_at = NOW()
      WHERE org_id = ${orgId} AND agent_name = ${agentName}
        AND updated_at < NOW() - INTERVAL '30 days'
        AND score > 0.1
      RETURNING id
    `.catch(() => []);
    factsDecayed = decayed.length;

    // Delete very low-score facts (below 0.1)
    await sql`
      DELETE FROM agent_facts
      WHERE org_id = ${orgId} AND agent_name = ${agentName} AND score < 0.1
    `.catch(() => {});

    await sql.end();
  } catch {}

  return {
    episodes_merged: episodesMerged,
    procedures_promoted: proceduresPromoted,
    facts_decayed: factsDecayed,
    duration_ms: Date.now() - started,
  };
}
