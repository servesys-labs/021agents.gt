/**
 * Memory-tool handlers extracted from tools.ts.
 *
 * These live in a separate file so tools.ts can stay within its LoC budget
 * while the feature-surface for memory grows. tools.ts dispatches to the
 * handlers here and wraps each call with telemetry at the call site — these
 * functions return plain JSON strings and never emit events themselves.
 *
 * Org-id resolution is fail-closed: if the caller cannot supply an org_id,
 * we return a structured error instead of silently picking the first row
 * from the `orgs` table (the prior cross-tenant leak pattern).
 */

import type { RuntimeEnv } from "./types";

import { getDb } from "./db";
import { curatedMemoryTool } from "./curated-memory";

function resolveOrgIdStrict(env: RuntimeEnv): string {
  const cfg = (env as any).__agentConfig;
  return String(cfg?.org_id || cfg?.orgId || "").trim();
}

function resolveAgentName(env: RuntimeEnv, fallback = ""): string {
  return String((env as any).__agentConfig?.name || fallback);
}

// ── Session Search — full-text search across past conversations ──

export async function sessionSearch(
  env: RuntimeEnv,
  args: Record<string, any>,
): Promise<string> {
  const query = String(args.query || "").trim();
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20));

  const orgId = resolveOrgIdStrict(env);
  if (!orgId) {
    return JSON.stringify({
      success: false,
      tool: "session-search",
      error: "org_id required — call is unscoped and session-search must not fall back to another tenant.",
    });
  }

  try {
    const sql = await getDb(env.HYPERDRIVE);
    const agentName = resolveAgentName(env);

    const rows = query
      ? await sql`
          SELECT session_id, input_text, output_text, status, created_at, cost_total_usd, step_count
          FROM sessions
          WHERE org_id = ${orgId}
            AND (${agentName} = '' OR agent_name = ${agentName})
            AND (LOWER(input_text) LIKE ${"%" + query.toLowerCase() + "%"} OR LOWER(output_text) LIKE ${"%" + query.toLowerCase() + "%"})
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT session_id, input_text, output_text, status, created_at, cost_total_usd, step_count
          FROM sessions
          WHERE org_id = ${orgId}
            AND (${agentName} = '' OR agent_name = ${agentName})
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;

    if (!rows.length) {
      return JSON.stringify({
        success: true,
        mode: query ? "search" : "recent",
        query: query || undefined,
        count: 0,
        results: [],
      });
    }

    const results = (rows as any[]).map((r: any) => ({
      session_id: String(r.session_id || ""),
      created_at: String(r.created_at || ""),
      status: String(r.status || ""),
      user_request: String(r.input_text || "").slice(0, 220),
      outcome: String(r.output_text || "").slice(0, 260),
      turns: Number(r.step_count || 0),
      cost_usd: Number(r.cost_total_usd || 0),
    }));

    return JSON.stringify({
      success: true,
      mode: query ? "search" : "recent",
      query: query || undefined,
      count: results.length,
      results,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      tool: "session-search",
      error: `Session search failed: ${err?.message || String(err)}`,
    });
  }
}

// ── Memory Health — summary of memory tier state for an agent ──

export async function memoryHealth(
  env: RuntimeEnv,
  args: Record<string, any>,
): Promise<string> {
  const agentName = resolveAgentName(env, "my-assistant");
  const hyperdrive = (env as any).HYPERDRIVE;
  if (!hyperdrive) {
    return JSON.stringify({
      success: false,
      tool: "memory-health",
      error: "Memory not available (no database binding)",
    });
  }

  const orgId = resolveOrgIdStrict(env);
  if (!orgId) {
    return JSON.stringify({
      success: false,
      tool: "memory-health",
      error: "org_id required — memory-health must not fall back to another tenant.",
    });
  }

  try {
    const sql = await getDb(hyperdrive);
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
    const [factsRows, episodesRows] = await Promise.all([
      sql`
        SELECT key, value, category, created_at
        FROM facts
        WHERE agent_name = ${agentName} AND org_id = ${orgId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
      sql`
        SELECT content, created_at
        FROM episodes
        WHERE agent_name = ${agentName} AND org_id = ${orgId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
    ]);
    const now = Date.now();
    const dayMs = 86_400_000;
    const staleFacts = (factsRows as any[]).filter((r) => {
      const ts = Date.parse(String(r.created_at || ""));
      return Number.isFinite(ts) && now - ts > dayMs * 30;
    }).length;
    return JSON.stringify({
      success: true,
      tool: "memory-health",
      agent_name: agentName,
      org_id: orgId,
      semantic_facts_count: (factsRows as any[]).length,
      episodic_entries_count: (episodesRows as any[]).length,
      stale_facts_30d_count: staleFacts,
      sample_limit: limit,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      tool: "memory-health",
      error: `memory-health failed: ${err?.message || String(err)}`,
    });
  }
}

// ── Curated memory dispatcher — thin pass-through to curated-memory.ts ──

export function curatedMemoryHandler(
  env: RuntimeEnv,
  args: Record<string, any>,
): Promise<string> {
  return curatedMemoryTool(env, args);
}
