/**
 * Evolve router — analysis, proposals, and ledger.
 *
 * The evolution loop:
 *   POST /:agent_name/analyze  → run FailureAnalyzer on recent sessions → generate proposals
 *   GET  /:agent_name/proposals → list proposals with evidence
 *   POST /:agent_name/proposals/:id/approve → approve + record in ledger
 *   POST /:agent_name/proposals/:id/reject  → reject + record in ledger
 *   POST /:agent_name/proposals/:id/apply   → apply config diff to agent
 *   GET  /:agent_name/ledger    → evolution history
 *   GET  /:agent_name/report    → latest analysis report
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  analyzeSessionRecords,
  generateProposals,
  type SessionRecord,
  type ToolCallRecord,
  type ErrorRecord,
  type AnalysisReport,
} from "../logic/evolution-analyzer";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const evolveRoutes = new Hono<R>();

// ── Analyze: run the evolution analyzer on recent sessions ────

evolveRoutes.post("/:agent_name/analyze", requireScope("evolve:write"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const body = await c.req.json().catch(() => ({}));
  const days = Math.min(90, Math.max(1, Number(body.days) || 7));

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent exists
  const agentRows = await sql`
    SELECT name, config_json FROM agents
    WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
  `;
  if (agentRows.length === 0) return c.json({ error: "Agent not found" }, 404);

  const agentConfig = safeJsonParse(agentRows[0].config_json) || {};
  const since = Date.now() / 1000 - days * 86400;

  // Fetch sessions in the time window
  const sessions = await sql`
    SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds,
           step_count, action_count, created_at
    FROM sessions
    WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${since}
    ORDER BY created_at DESC LIMIT 500
  `;

  // Enrich with turn-level data (tool calls + errors)
  const records: SessionRecord[] = [];
  for (const session of sessions) {
    const turns = await sql`
      SELECT turn_number, model_used, tool_calls_json, tool_results_json, error
      FROM turns
      WHERE session_id = ${session.session_id}
      ORDER BY turn_number ASC LIMIT 100
    `.catch(() => []);

    const toolCalls: ToolCallRecord[] = [];
    const errors: ErrorRecord[] = [];

    for (const turn of turns) {
      const tcList = safeJsonParse(turn.tool_calls_json) || [];
      const trList = safeJsonParse(turn.tool_results_json) || [];

      for (let i = 0; i < tcList.length; i++) {
        const tc = tcList[i];
        const tr = trList[i] || {};
        toolCalls.push({
          tool_name: tc.name || tc.tool || "",
          success: !tr.error,
          error: tr.error || undefined,
          latency_ms: Number(tr.latency_ms || 0),
          turn_number: Number(turn.turn_number || 0),
        });
        if (tr.error) {
          errors.push({
            source: "tool",
            message: String(tr.error).slice(0, 300),
            tool_name: tc.name || tc.tool || "",
            turn_number: Number(turn.turn_number || 0),
            recoverable: true,
          });
        }
      }

      if (turn.error) {
        errors.push({
          source: "llm",
          message: String(turn.error).slice(0, 300),
          turn_number: Number(turn.turn_number || 0),
          recoverable: false,
        });
      }
    }

    // Enrich with conversation intelligence (if scored)
    const intelRows = await sql`
      SELECT avg_quality, task_completed, dominant_sentiment
      FROM conversation_analytics
      WHERE session_id = ${session.session_id} LIMIT 1
    `.catch(() => []);
    const intel = intelRows[0] || {};

    records.push({
      session_id: String(session.session_id),
      agent_name: String(session.agent_name),
      status: String(session.status || "unknown"),
      stop_reason: String(session.status || "unknown"),
      cost_total_usd: Number(session.cost_total_usd || 0),
      wall_clock_seconds: Number(session.wall_clock_seconds || 0),
      step_count: Number(session.step_count || 0),
      action_count: Number(session.action_count || 0),
      created_at: Number(session.created_at || 0),
      tool_calls: toolCalls,
      errors,
      quality_score: intel.avg_quality != null ? Number(intel.avg_quality) : undefined,
      sentiment: intel.dominant_sentiment ? String(intel.dominant_sentiment) : undefined,
      task_completed: intel.task_completed === true || intel.task_completed === 1,
    });
  }

  // Run the analyzer
  const availableTools = Array.isArray(agentConfig.tools) ? agentConfig.tools : [];
  const report = analyzeSessionRecords(agentName, records, availableTools, days);
  const proposals = generateProposals(report, agentConfig);

  // Store proposals in DB
  const now = Date.now() / 1000;
  for (const proposal of proposals) {
    await sql`
      INSERT INTO evolution_proposals (
        proposal_id, agent_name, org_id, title, rationale, category,
        priority, config_diff_json, evidence_json, status, created_at
      ) VALUES (
        ${proposal.id}, ${agentName}, ${orgId}, ${proposal.title},
        ${proposal.rationale}, ${proposal.category}, ${proposal.priority},
        ${JSON.stringify(proposal.modification)}, ${JSON.stringify(proposal.evidence)},
        'pending', ${now}
      ) ON CONFLICT (proposal_id) DO UPDATE SET
        title = EXCLUDED.title,
        rationale = EXCLUDED.rationale,
        priority = EXCLUDED.priority,
        config_diff_json = EXCLUDED.config_diff_json,
        evidence_json = EXCLUDED.evidence_json
    `.catch(() => {});
  }

  // Store report for later retrieval
  await sql`
    INSERT INTO evolution_reports (
      agent_name, org_id, report_json, session_count, created_at
    ) VALUES (
      ${agentName}, ${orgId}, ${JSON.stringify(report)}, ${records.length}, ${now}
    )
  `.catch(() => {});

  return c.json({
    report,
    proposals,
    sessions_analyzed: records.length,
  });
});

// ── Latest analysis report ────────────────────────────────────

evolveRoutes.get("/:agent_name/report", requireScope("evolve:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT report_json, session_count, created_at FROM evolution_reports
    WHERE agent_name = ${agentName} AND org_id = ${orgId}
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => []);

  if (rows.length === 0) {
    return c.json({ report: null, message: "No analysis runs yet. POST to /:agent_name/analyze to start." });
  }

  return c.json({
    report: safeJsonParse(rows[0].report_json),
    sessions_analyzed: Number(rows[0].session_count || 0),
    analyzed_at: Number(rows[0].created_at || 0),
  });
});

// ── Apply an approved proposal to the agent config ────────────

evolveRoutes.post("/:agent_name/proposals/:proposal_id/apply", requireScope("evolve:write"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const proposalId = c.req.param("proposal_id");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Fetch the proposal
  const proposalRows = await sql`
    SELECT * FROM evolution_proposals
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
  `;
  if (proposalRows.length === 0) return c.json({ error: "Proposal not found" }, 404);
  const proposal = proposalRows[0];
  if (proposal.status !== "approved") {
    return c.json({ error: "Proposal must be approved before applying" }, 400);
  }

  // Fetch current agent config
  const agentRows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
  `;
  if (agentRows.length === 0) return c.json({ error: "Agent not found" }, 404);

  const currentConfig = safeJsonParse(agentRows[0].config_json) || {};
  const modification = safeJsonParse(proposal.config_diff_json) || {};

  // Apply modification to config (deep merge with special-case handling)
  const newConfig = deepMergeConfig(currentConfig, modification);

  // Update agent config
  const now = Date.now() / 1000;
  await sql`
    UPDATE agents SET config_json = ${JSON.stringify(newConfig)}
    WHERE name = ${agentName} AND org_id = ${orgId}
  `;

  // Mark proposal as applied
  await sql`
    UPDATE evolution_proposals SET status = 'applied', reviewed_at = ${now}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  // Record in ledger with before/after configs
  await sql`
    INSERT INTO evolution_ledger (
      agent_name, org_id, proposal_id, action, note,
      previous_config_json, new_config_json, created_at
    ) VALUES (
      ${agentName}, ${orgId}, ${proposalId}, 'applied',
      ${proposal.title || ""},
      ${JSON.stringify(currentConfig)}, ${JSON.stringify(newConfig)}, ${now}
    )
  `;

  return c.json({
    applied: true,
    proposal_id: proposalId,
    title: proposal.title,
    changes: Object.keys(modification),
  });
});

// ── Legacy run endpoint ────────────────────────────────────────

evolveRoutes.post("/:agent_name/run", requireScope("evolve:write"), (c) =>
  c.json(
    {
      error: "Use POST /:agent_name/analyze instead",
      detail: "The /run endpoint has been replaced by /analyze which runs the evolution analyzer.",
    },
    410,
  ),
);

function safeJsonParse(val: unknown): any {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "object") return val;
  try { return JSON.parse(String(val)); } catch { return undefined; }
}

/**
 * Deep merge a config modification into an existing config.
 * Handles special cases: tools.remove, system_prompt.append, nested objects like governance.
 */
function deepMergeConfig(
  current: Record<string, any>,
  modification: Record<string, any>,
): Record<string, any> {
  const result = { ...current };

  for (const [key, value] of Object.entries(modification)) {
    // Special: tools.remove — remove specific tools from array
    if (key === "tools" && typeof value === "object" && value !== null && (value as any).remove) {
      const toRemove = new Set((value as any).remove);
      result.tools = (current.tools || []).filter((t: string) => !toRemove.has(t));
      continue;
    }

    // Special: system_prompt.append — append to existing prompt
    if (key === "system_prompt" && typeof value === "object" && value !== null && (value as any).append) {
      result.system_prompt = (current.system_prompt || "") + (value as any).append;
      continue;
    }

    // Special: system_prompt.review / .improve_quality — skip (advisory only)
    if (key === "system_prompt" && typeof value === "object" && value !== null &&
        ((value as any).review || (value as any).improve_quality)) {
      continue;
    }

    // Special: model.evaluate_alternatives — skip (advisory only)
    if (key === "model" && typeof value === "object" && value !== null && (value as any).evaluate_alternatives) {
      continue;
    }

    // Deep merge nested objects (e.g., governance, memory, routing)
    if (typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof current[key] === "object" && current[key] !== null && !Array.isArray(current[key])) {
      result[key] = deepMergeConfig(current[key], value);
      continue;
    }

    // Direct value assignment
    result[key] = value;
  }

  return result;
}

evolveRoutes.get("/:agent_name/proposals", requireScope("evolve:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  try {
    const rows = await sql`
      SELECT * FROM evolution_proposals
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
      ORDER BY created_at DESC
    `;
    return c.json({ proposals: rows });
  } catch {
    return c.json({ proposals: [] });
  }
});

evolveRoutes.post("/:agent_name/proposals/:proposal_id/approve", requireScope("evolve:write"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const proposalId = c.req.param("proposal_id");
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || "");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const rows = await sql`
    SELECT * FROM evolution_proposals
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
  `;
  if (rows.length === 0) return c.json({ error: "Proposal not found" }, 404);

  const now = Date.now() / 1000;
  await sql`
    UPDATE evolution_proposals
    SET status = 'approved', review_note = ${note}, reviewed_at = ${now}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  // Add ledger entry
  await sql`
    INSERT INTO evolution_ledger (agent_name, org_id, proposal_id, action, note, created_at)
    VALUES (${agentName}, ${orgId}, ${proposalId}, 'approved', ${note}, ${now})
  `;

  return c.json({ approved: proposalId, title: rows[0].title || "" });
});

evolveRoutes.post("/:agent_name/proposals/:proposal_id/reject", requireScope("evolve:write"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const proposalId = c.req.param("proposal_id");
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note || "");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const rows = await sql`
    SELECT * FROM evolution_proposals
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
  `;
  if (rows.length === 0) return c.json({ error: "Proposal not found" }, 404);

  const now = Date.now() / 1000;
  await sql`
    UPDATE evolution_proposals
    SET status = 'rejected', review_note = ${note}, reviewed_at = ${now}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  await sql`
    INSERT INTO evolution_ledger (agent_name, org_id, proposal_id, action, note, created_at)
    VALUES (${agentName}, ${orgId}, ${proposalId}, 'rejected', ${note}, ${now})
  `;

  return c.json({ rejected: proposalId, title: rows[0].title || "" });
});

evolveRoutes.get("/:agent_name/ledger", requireScope("evolve:read"), async (c) => {
  const user = c.get("user");
  const orgId = user.org_id;
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  try {
    const rows = await sql`
      SELECT * FROM evolution_ledger
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
      ORDER BY created_at DESC
    `;
    return c.json({ entries: rows, current_version: "0.1.0" });
  } catch {
    return c.json({ entries: [], current_version: "0.1.0" });
  }
});
