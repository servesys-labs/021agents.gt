/**
 * Evolve router — analysis, proposals, and ledger.
 *
 * The evolution loop:
 *   POST /:agent_name/analyze  → run FailureAnalyzer on recent sessions → generate proposals
 *   GET  /:agent_name/proposals → list proposals with evidence + impact data
 *   POST /:agent_name/proposals/:id/approve → approve + record in ledger
 *   POST /:agent_name/proposals/:id/reject  → reject + record in ledger
 *   POST /:agent_name/proposals/:id/apply   → apply config diff to agent (captures baseline metrics)
 *   POST /:agent_name/proposals/:id/measure-impact → measure post-apply impact vs baseline
 *   POST /:agent_name/proposals/:id/auto-rollback  → rollback if regression detected
 *   GET  /:agent_name/ledger    → evolution history
 *   GET  /:agent_name/report    → latest analysis report
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
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

export const evolveRoutes = createOpenAPIRouter();

// ── Zod schemas ─────────────────────────────────────────────────

const analyzeBody = z.object({
  days: z.number().int().min(1).max(90).optional(),
}).optional();

const applyBody = z.object({
  autopilot: z.boolean().optional(),
  scheduled: z.boolean().optional(),
  evolution_apply_guard: z.object({
    force: z.boolean().optional(),
    reason: z.string().optional(),
  }).optional(),
}).optional();

const rollbackBody = z.object({
  reason: z.string().optional(),
}).optional();

const approveRejectBody = z.object({
  note: z.string().optional(),
}).optional();

const scheduleBody = z.object({
  interval_days: z.number().int().min(1).max(365).optional(),
  min_sessions: z.number().int().min(1).max(1000).optional(),
  is_active: z.boolean().optional(),
}).optional();

// ── POST /:agent_name/analyze ───────────────────────────────────

const analyzeRoute = createRoute({
  method: "post",
  path: "/{agent_name}/analyze",
  tags: ["Evolve"],
  summary: "Run evolution analyzer on recent sessions",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: { content: { "application/json": { schema: z.object({ days: z.number().int().min(1).max(90).optional() }) } }, required: false as const },
  },
  responses: {
    200: { description: "Analysis result with proposals", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(analyzeRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName } = c.req.valid("param");
  const body = await c.req.json().catch(() => ({}));
  const days = Math.min(90, Math.max(1, Number(body.days) || 7));

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent exists
  const agentRows = await sql`
    SELECT name, config FROM agents
    WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
  `;
  if (agentRows.length === 0) return c.json({ error: "Agent not found" }, 404);

  const agentConfig = safeJsonParse(agentRows[0].config) || {};
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  // Fetch sessions in the time window
  const sessions = await sql`
    SELECT session_id, agent_name, status, cost_total_usd, wall_clock_seconds,
           step_count, action_count, created_at
    FROM sessions
    WHERE agent_name = ${agentName} AND org_id = ${orgId} AND created_at > ${since}
    ORDER BY created_at DESC LIMIT 500
  `;

  // Batch-fetch all turns for all sessions to avoid N+1 queries
  const allSessionIds = sessions.map((s: any) => String(s.session_id));
  const allTurns = allSessionIds.length > 0
    ? await sql`
        SELECT session_id, turn_number, model_used, tool_calls, tool_results, error
        FROM turns
        WHERE session_id = ANY(${allSessionIds})
        ORDER BY session_id, turn_number ASC
      `.catch(() => [])
    : [];
  const turnsBySession = new Map<string, any[]>();
  for (const t of allTurns) {
    const sid = String(t.session_id);
    if (!turnsBySession.has(sid)) turnsBySession.set(sid, []);
    turnsBySession.get(sid)!.push(t);
  }

  // Enrich with turn-level data (tool calls + errors)
  const records: SessionRecord[] = [];
  for (const session of sessions) {
    const turns = (turnsBySession.get(String(session.session_id)) || []).slice(0, 100);

    const toolCalls: ToolCallRecord[] = [];
    const errors: ErrorRecord[] = [];

    for (const turn of turns) {
      const tcList = safeJsonParse(turn.tool_calls) || [];
      const trList = safeJsonParse(turn.tool_results) || [];

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
  const now = new Date().toISOString();
  for (const proposal of proposals) {
    await sql`
      INSERT INTO evolution_proposals (
        proposal_id, agent_name, org_id, title, rationale, category,
        priority, config_diff, evidence, status, created_at
      ) VALUES (
        ${proposal.id}, ${agentName}, ${orgId}, ${proposal.title},
        ${proposal.rationale}, ${proposal.category}, ${proposal.priority},
        ${JSON.stringify(proposal.modification)}, ${JSON.stringify(proposal.evidence)},
        'pending', ${now}
      ) ON CONFLICT (proposal_id) DO UPDATE SET
        title = EXCLUDED.title,
        rationale = EXCLUDED.rationale,
        priority = EXCLUDED.priority,
        config_diff = EXCLUDED.config_diff,
        evidence = EXCLUDED.evidence
    `.catch(() => {});
  }

  // Store report for later retrieval
  await sql`
    INSERT INTO evolution_reports (
      agent_name, org_id, report, session_count, created_at
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

// ── GET /:agent_name/report ─────────────────────────────────────

const reportRoute = createRoute({
  method: "get",
  path: "/{agent_name}/report",
  tags: ["Evolve"],
  summary: "Get latest analysis report for an agent",
  middleware: [requireScope("evolve:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "Latest report", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

evolveRoutes.openapi(reportRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT report, session_count, created_at FROM evolution_reports
    WHERE agent_name = ${agentName} AND org_id = ${orgId}
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => []);

  if (rows.length === 0) {
    return c.json({ report: null, message: "No analysis runs yet. POST to /:agent_name/analyze to start." });
  }

  return c.json({
    report: safeJsonParse(rows[0].report),
    sessions_analyzed: Number(rows[0].session_count || 0),
    analyzed_at: Number(rows[0].created_at || 0),
  });
});

// ── POST /:agent_name/proposals/:proposal_id/apply ──────────────

const applyRoute = createRoute({
  method: "post",
  path: "/{agent_name}/proposals/{proposal_id}/apply",
  tags: ["Evolve"],
  summary: "Apply an approved proposal to the agent config",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string(), proposal_id: z.string() }),
    body: { content: { "application/json": { schema: z.object({
      autopilot: z.boolean().optional(),
      scheduled: z.boolean().optional(),
      evolution_apply_guard: z.object({ force: z.boolean().optional(), reason: z.string().optional() }).optional(),
    }) } }, required: false as const },
  },
  responses: {
    200: { description: "Proposal applied", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 403, 404),
  },
});

evolveRoutes.openapi(applyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName, proposal_id: proposalId } = c.req.valid("param");
  const body = await c.req.json().catch(() => ({}));
  const autopilotRequested = body.autopilot === true || body.scheduled === true;
  const applyGuard = body.evolution_apply_guard as { force?: boolean; reason?: string } | undefined;

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
    SELECT config FROM agents
    WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true LIMIT 1
  `;
  if (agentRows.length === 0) return c.json({ error: "Agent not found" }, 404);

  const currentConfig = safeJsonParse(agentRows[0].config) || {};
  const modification = safeJsonParse(proposal.config_diff) || {};

  // ── Capture pre-apply baseline metrics (last 7 days) ──────
  const baselineMetrics = await computeAgentMetrics(sql, agentName, orgId, Date.now() / 1000 - 7 * 86400, Date.now() / 1000);

  const gateSnapshot = await buildAutopilotGateSnapshot(sql, agentName, orgId);
  if (autopilotRequested) {
    const gate = evaluateAutopilotApplyGates(gateSnapshot, applyGuard);
    if (!gate.ok) {
      return c.json(
        {
          error: "autopilot_apply_blocked",
          message: gate.reason,
          details: gate.details,
          markers_preview: { metrics_before: baselineMetrics, gate_snapshot: gateSnapshot },
        },
        403,
      );
    }
  }

  // Apply modification to config (deep merge with special-case handling)
  const newConfig = deepMergeConfig(currentConfig, modification);

  // Guard: reject configs larger than 500KB
  const configStr = JSON.stringify(newConfig);
  if (configStr.length > 500_000) {
    return c.json({ error: "Resulting config exceeds 500KB limit" }, 400);
  }

  // Update agent config
  const now = new Date().toISOString();
  await sql`
    UPDATE agents SET config = ${JSON.stringify(newConfig)}
    WHERE name = ${agentName} AND org_id = ${orgId}
  `;

  // Notify runtime DO to invalidate config cache — ensures the evolution
  // change takes effect immediately without waiting for DO cold start.
  try {
    await c.env.RUNTIME.fetch("https://runtime/api/v1/internal/config-invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ agent_name: agentName, version: "evolve-" + proposalId, timestamp: Date.now() }),
    });
  } catch {
    // Non-critical — DO will reload on next request
  }

  // R2 VCS: commit the config change for full version history
  try {
    const { commitAgentConfig } = await import("../logic/r2-vcs");
    await commitAgentConfig(
      c.env.STORAGE, orgId, agentName, newConfig,
      `evolution: ${proposal.title || proposalId}`,
      user.user_id,
      { proposal_id: proposalId, source: "evolution_apply" },
    );
  } catch {
    // Best-effort — Postgres is the source of truth
  }

  // Mark proposal as applied
  await sql`
    UPDATE evolution_proposals SET status = 'applied', reviewed_at = ${now}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  const applyContext = {
    autopilot_requested: autopilotRequested,
    applied_by: user.user_id || "",
    gates: autopilotRequested
      ? evaluateAutopilotApplyGates(gateSnapshot, applyGuard)
      : { ok: true as const, mode: "manual" },
    markers_before: {
      agent_metrics_7d: baselineMetrics,
      latest_report: gateSnapshot.latest_report,
      eval_window: gateSnapshot.eval_window,
    },
    markers_after_placeholder: {
      note: "Run measure-impact to populate metrics_after on the ledger entry",
    },
  };

  // Record in ledger with before/after configs and baseline metrics
  await sql`
    INSERT INTO evolution_ledger (
      agent_name, org_id, proposal_id, action, note,
      previous_config, new_config, metrics_before, created_at, apply_context
    ) VALUES (
      ${agentName}, ${orgId}, ${proposalId}, 'applied',
      ${proposal.title || ""},
      ${JSON.stringify(currentConfig)}, ${JSON.stringify(newConfig)},
      ${JSON.stringify(baselineMetrics)}, ${now}, ${JSON.stringify(applyContext)}
    )
  `;

  await mergeApplyMarkersIntoLatestReport(sql, agentName, orgId, {
    proposal_id: proposalId,
    applied_at: now,
    autopilot: autopilotRequested,
    markers_before: applyContext.markers_before,
  });

  return c.json({
    applied: true,
    proposal_id: proposalId,
    title: proposal.title,
    changes: Object.keys(modification),
    metrics_before: baselineMetrics,
    apply_markers: applyContext.markers_before,
    autopilot: autopilotRequested,
  });
});

// ── POST /:agent_name/proposals/:proposal_id/measure-impact ─────

const measureImpactRoute = createRoute({
  method: "post",
  path: "/{agent_name}/proposals/{proposal_id}/measure-impact",
  tags: ["Evolve"],
  summary: "Measure impact of an applied proposal",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string(), proposal_id: z.string() }),
  },
  responses: {
    200: { description: "Impact measurement", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 404),
  },
});

evolveRoutes.openapi(measureImpactRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName, proposal_id: proposalId } = c.req.valid("param");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Fetch proposal — must be applied
  const proposalRows = await sql`
    SELECT * FROM evolution_proposals
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
  `;
  if (proposalRows.length === 0) return c.json({ error: "Proposal not found" }, 404);
  const proposal = proposalRows[0];
  if (proposal.status !== "applied") {
    return c.json({ error: "Can only measure impact on applied proposals" }, 400);
  }

  // Fetch the ledger entry to get applied_at timestamp and baseline metrics
  const ledgerRows = await sql`
    SELECT * FROM evolution_ledger
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
      AND action = 'applied'
    ORDER BY created_at DESC LIMIT 1
  `;
  if (ledgerRows.length === 0) {
    return c.json({ error: "No ledger entry found for this applied proposal" }, 404);
  }
  const ledger = ledgerRows[0];
  const appliedAt = Number(ledger.created_at);
  const metricsBefore = safeJsonParse(ledger.metrics_before) || {
    success_rate: 0, avg_cost: 0, avg_turns: 0, avg_quality: 0, session_count: 0,
  };

  // Compute metrics for sessions AFTER the proposal was applied
  const now = Date.now() / 1000;
  const metricsAfter = await computeAgentMetrics(sql, agentName, orgId, appliedAt, now);

  // Compute deltas
  const delta = {
    success_rate: round(metricsAfter.success_rate - metricsBefore.success_rate, 4),
    avg_cost: round(metricsAfter.avg_cost - metricsBefore.avg_cost, 6),
    avg_turns: round(metricsAfter.avg_turns - metricsBefore.avg_turns, 2),
    avg_quality: round(metricsAfter.avg_quality - metricsBefore.avg_quality, 4),
  };

  // Determine if improved: success_rate or quality went up, cost or turns went down
  const improved =
    delta.success_rate >= 0 && delta.avg_quality >= 0 &&
    delta.avg_cost <= 0 && delta.avg_turns <= 0 &&
    // At least one metric must have meaningfully improved
    (delta.success_rate > 0.01 || delta.avg_quality > 0.01 || delta.avg_cost < -0.001 || delta.avg_turns < -0.5);

  // Check for regressions >10%
  const regressions: string[] = [];
  if (metricsBefore.success_rate > 0 && delta.success_rate / metricsBefore.success_rate < -0.10) {
    regressions.push(`success_rate regressed by ${(Math.abs(delta.success_rate) * 100).toFixed(1)}pp`);
  }
  if (metricsBefore.avg_cost > 0 && delta.avg_cost / metricsBefore.avg_cost > 0.10) {
    regressions.push(`avg_cost increased by ${((delta.avg_cost / metricsBefore.avg_cost) * 100).toFixed(1)}%`);
  }
  if (metricsBefore.avg_turns > 0 && delta.avg_turns / metricsBefore.avg_turns > 0.10) {
    regressions.push(`avg_turns increased by ${((delta.avg_turns / metricsBefore.avg_turns) * 100).toFixed(1)}%`);
  }
  if (metricsBefore.avg_quality > 0 && delta.avg_quality / metricsBefore.avg_quality < -0.10) {
    regressions.push(`avg_quality regressed by ${(Math.abs(delta.avg_quality / metricsBefore.avg_quality) * 100).toFixed(1)}%`);
  }

  const recommendation = regressions.length > 0
    ? `Rollback recommended: ${regressions.join("; ")}`
    : improved
      ? "Proposal is improving agent performance. No action needed."
      : "No significant change detected. Consider collecting more data.";

  // Store impact data
  const impactData = { metrics_before: metricsBefore, metrics_after: metricsAfter, delta, improved, regressions, recommendation };

  await sql`
    UPDATE evolution_proposals
    SET impact = ${JSON.stringify(impactData)}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  // Update ledger with metrics_after
  await sql`
    UPDATE evolution_ledger
    SET metrics_after = ${JSON.stringify(metricsAfter)}
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
      AND action = 'applied'
  `;

  return c.json({
    improved,
    metrics_before: metricsBefore,
    metrics_after: metricsAfter,
    delta,
    recommendation,
  });
});

// ── POST /:agent_name/proposals/:proposal_id/auto-rollback ──────

const autoRollbackRoute = createRoute({
  method: "post",
  path: "/{agent_name}/proposals/{proposal_id}/auto-rollback",
  tags: ["Evolve"],
  summary: "Auto-rollback an applied proposal on regression",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string(), proposal_id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ reason: z.string().optional() }) } }, required: false as const },
  },
  responses: {
    200: { description: "Rollback result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 404),
  },
});

evolveRoutes.openapi(autoRollbackRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName, proposal_id: proposalId } = c.req.valid("param");
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason || "Auto-rollback due to metric regression");

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Fetch proposal
  const proposalRows = await sql`
    SELECT * FROM evolution_proposals
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
  `;
  if (proposalRows.length === 0) return c.json({ error: "Proposal not found" }, 404);
  const proposal = proposalRows[0];
  if (proposal.status !== "applied") {
    return c.json({ error: "Can only rollback applied proposals" }, 400);
  }

  // Fetch ledger entry with previous config
  const ledgerRows = await sql`
    SELECT * FROM evolution_ledger
    WHERE proposal_id = ${proposalId} AND agent_name = ${agentName} AND org_id = ${orgId}
      AND action = 'applied'
    ORDER BY created_at DESC LIMIT 1
  `;
  if (ledgerRows.length === 0) {
    return c.json({ error: "No ledger entry found — cannot determine previous config" }, 404);
  }
  const ledger = ledgerRows[0];
  const previousConfig = safeJsonParse(ledger.previous_config);
  if (!previousConfig) {
    return c.json({ error: "Previous config not available in ledger" }, 400);
  }

  const now = Date.now() / 1000;

  // Restore previous config to the agent
  await sql`
    UPDATE agents SET config = ${JSON.stringify(previousConfig)}
    WHERE name = ${agentName} AND org_id = ${orgId}
  `;

  // Notify runtime DO to invalidate config cache
  try {
    await c.env.RUNTIME.fetch("https://runtime/api/v1/internal/config-invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ agent_name: agentName, version: "rollback-" + proposalId, timestamp: Date.now() }),
    });
  } catch {}

  // Commit rollback to R2 VCS (store config snapshot in STORAGE bucket)
  try {
    const vcsKey = `vcs/${orgId}/${agentName}/rollback-${proposalId}-${Math.floor(now)}.json`;
    const vcsPayload = JSON.stringify({
      action: "rollback",
      proposal_id: proposalId,
      reason,
      config: previousConfig,
      rolled_back_at: now,
      rolled_back_by: user.user_id || "system",
    });
    await c.env.STORAGE.put(vcsKey, vcsPayload, {
      customMetadata: {
        agent_name: agentName,
        org_id: orgId,
        action: "rollback",
        proposal_id: proposalId,
      },
    });
  } catch {
    // R2 write failure is non-fatal — the DB state is already restored
  }

  // Update proposal status to rolled_back
  await sql`
    UPDATE evolution_proposals
    SET status = 'rolled_back', rolled_back_at = ${now}, rollback_reason = ${reason}
    WHERE proposal_id = ${proposalId} AND org_id = ${orgId}
  `;

  // Record rollback in ledger
  await sql`
    INSERT INTO evolution_ledger (
      agent_name, org_id, proposal_id, action, note,
      previous_config, new_config, created_at
    ) VALUES (
      ${agentName}, ${orgId}, ${proposalId}, 'rolled_back',
      ${reason},
      ${ledger.new_config || "{}"}, ${JSON.stringify(previousConfig)}, ${now}
    )
  `;

  return c.json({
    rolled_back: true,
    proposal_id: proposalId,
    reason,
    config_restored: true,
  });
});

// ── POST /:agent_name/run (legacy) ──────────────────────────────

const legacyRunRoute = createRoute({
  method: "post",
  path: "/{agent_name}/run",
  tags: ["Evolve"],
  summary: "Legacy run endpoint (deprecated)",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    410: { description: "Gone — use /analyze instead", content: { "application/json": { schema: ErrorSchema } } },
  },
});

evolveRoutes.openapi(legacyRunRoute, async (c): Promise<any> =>
  c.json(
    {
      error: "Use POST /:agent_name/analyze instead",
      detail: "The /run endpoint has been replaced by /analyze which runs the evolution analyzer.",
    },
    410,
  ),
);

// ── GET /:agent_name/proposals ──────────────────────────────────

const listProposalsRoute = createRoute({
  method: "get",
  path: "/{agent_name}/proposals",
  tags: ["Evolve"],
  summary: "List evolution proposals for an agent",
  middleware: [requireScope("evolve:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "List of proposals", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(listProposalsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName } = c.req.valid("param");
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

    // Enrich applied/rolled_back proposals with impact data
    const proposals = rows.map((row: any) => {
      const base: any = { ...row };
      if ((row.status === "applied" || row.status === "rolled_back") && row.impact) {
        const impact = safeJsonParse(row.impact);
        if (impact) {
          base.impact = impact;
        }
      }
      if (row.status === "rolled_back" && row.rollback_reason) {
        base.rollback_reason = row.rollback_reason;
      }
      return base;
    });

    return c.json({ proposals });
  } catch {
    return c.json({ proposals: [] });
  }
});

// ── POST /:agent_name/proposals/:proposal_id/approve ────────────

const approveRoute = createRoute({
  method: "post",
  path: "/{agent_name}/proposals/{proposal_id}/approve",
  tags: ["Evolve"],
  summary: "Approve an evolution proposal",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string(), proposal_id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ note: z.string().optional() }) } }, required: false as const },
  },
  responses: {
    200: { description: "Proposal approved", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(approveRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName, proposal_id: proposalId } = c.req.valid("param");
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

  const now = new Date().toISOString();
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

// ── POST /:agent_name/proposals/:proposal_id/reject ─────────────

const rejectRoute = createRoute({
  method: "post",
  path: "/{agent_name}/proposals/{proposal_id}/reject",
  tags: ["Evolve"],
  summary: "Reject an evolution proposal",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string(), proposal_id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ note: z.string().optional() }) } }, required: false as const },
  },
  responses: {
    200: { description: "Proposal rejected", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(rejectRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName, proposal_id: proposalId } = c.req.valid("param");
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

  const now = new Date().toISOString();
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

// ── GET /:agent_name/ledger ─────────────────────────────────────

const ledgerRoute = createRoute({
  method: "get",
  path: "/{agent_name}/ledger",
  tags: ["Evolve"],
  summary: "Get evolution ledger for an agent",
  middleware: [requireScope("evolve:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "Ledger entries", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(ledgerRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName } = c.req.valid("param");
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

// ── GET /:agent_name/schedule ───────────────────────────────────

const getScheduleRoute = createRoute({
  method: "get",
  path: "/{agent_name}/schedule",
  tags: ["Evolve"],
  summary: "Get evolution schedule for an agent",
  middleware: [requireScope("evolve:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "Schedule config", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(getScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const rows = await sql`
    SELECT * FROM evolution_schedules
    WHERE agent_name = ${agentName} AND org_id = ${orgId}
    LIMIT 1
  `.catch(() => []);

  if (rows.length === 0) {
    return c.json({ schedule: null, message: "No evolution schedule configured for this agent." });
  }

  return c.json({ schedule: rows[0] });
});

// ── POST /:agent_name/schedule ──────────────────────────────────

const createScheduleRoute = createRoute({
  method: "post",
  path: "/{agent_name}/schedule",
  tags: ["Evolve"],
  summary: "Create or update evolution schedule for an agent",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: { content: { "application/json": { schema: z.object({
      interval_days: z.number().int().min(1).max(365).optional(),
      min_sessions: z.number().int().min(1).max(1000).optional(),
      is_active: z.boolean().optional(),
    }) } }, required: false as const },
  },
  responses: {
    200: { description: "Schedule created/updated", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(createScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName } = c.req.valid("param");
  const body = await c.req.json().catch(() => ({}));

  const intervalDays = Math.min(365, Math.max(1, Number(body.interval_days) || 7));
  const minSessions = Math.min(1000, Math.max(1, Number(body.min_sessions) || 10));
  const isActive = body.is_active !== false;

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  const now = Date.now() / 1000;
  const nextRunAt = now + intervalDays * 86400;
  const id = `evosched-${crypto.randomUUID().slice(0, 12)}`;

  // Upsert: create or update existing schedule for this agent+org
  await sql`
    INSERT INTO evolution_schedules (id, agent_name, org_id, is_active, interval_days, min_sessions, next_run_at, created_at)
    VALUES (${id}, ${agentName}, ${orgId}, ${isActive}, ${intervalDays}, ${minSessions}, ${nextRunAt}, ${now})
    ON CONFLICT (id) DO NOTHING
  `;

  // If a row already exists for this agent+org, update it instead
  const existing = await sql`
    SELECT id FROM evolution_schedules
    WHERE agent_name = ${agentName} AND org_id = ${orgId} AND id != ${id}
    LIMIT 1
  `.catch(() => []);

  if (existing.length > 0) {
    await sql`
      UPDATE evolution_schedules
      SET is_active = ${isActive},
          interval_days = ${intervalDays},
          min_sessions = ${minSessions},
          next_run_at = CASE WHEN next_run_at IS NULL THEN ${nextRunAt} ELSE next_run_at END
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
    `;
    // Remove the duplicate we just inserted
    await sql`DELETE FROM evolution_schedules WHERE id = ${id}`.catch(() => {});
  }

  const rows = await sql`
    SELECT * FROM evolution_schedules
    WHERE agent_name = ${agentName} AND org_id = ${orgId} LIMIT 1
  `.catch(() => []);

  return c.json({ schedule: rows[0] || null, created: existing.length === 0 });
});

// ── DELETE /:agent_name/schedule ────────────────────────────────

const deleteScheduleRoute = createRoute({
  method: "delete",
  path: "/{agent_name}/schedule",
  tags: ["Evolve"],
  summary: "Disable evolution schedule for an agent",
  middleware: [requireScope("evolve:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "Schedule disabled", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

evolveRoutes.openapi(deleteScheduleRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const orgId = user.org_id;
  const { agent_name: agentName } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify agent belongs to this org
  const agentCheck = await sql`SELECT 1 FROM agents WHERE name = ${agentName} AND org_id = ${orgId} LIMIT 1`;
  if (agentCheck.length === 0) return c.json({ error: "Agent not found" }, 404);

  // Soft-disable rather than delete, so history is preserved
  await sql`
    UPDATE evolution_schedules
    SET is_active = false
    WHERE agent_name = ${agentName} AND org_id = ${orgId}
  `.catch(() => {});

  return c.json({ disabled: true, agent_name: agentName });
});

// ── Helpers ────────────────────────────────────────────────────

interface AgentMetrics {
  success_rate: number;
  avg_cost: number;
  avg_turns: number;
  avg_quality: number;
  session_count: number;
}

/**
 * Compute aggregate metrics for an agent over a time window.
 */
async function computeAgentMetrics(
  sql: any,
  agentName: string,
  orgId: string,
  fromEpoch: number,
  toEpoch: number,
): Promise<AgentMetrics> {
  const sessions = await sql`
    SELECT session_id, status, cost_total_usd, step_count
    FROM sessions
    WHERE agent_name = ${agentName} AND org_id = ${orgId}
      AND created_at >= ${fromEpoch} AND created_at <= ${toEpoch}
    ORDER BY created_at DESC LIMIT 500
  `.catch(() => []);

  if (sessions.length === 0) {
    return { success_rate: 0, avg_cost: 0, avg_turns: 0, avg_quality: 0, session_count: 0 };
  }

  const successCount = sessions.filter((s: any) => s.status === "success").length;
  const successRate = successCount / sessions.length;
  const avgCost = sessions.reduce((sum: number, s: any) => sum + Number(s.cost_total_usd || 0), 0) / sessions.length;
  const avgTurns = sessions.reduce((sum: number, s: any) => sum + Number(s.step_count || 0), 0) / sessions.length;

  // Fetch quality scores from conversation_analytics
  const sessionIds = sessions.map((s: any) => String(s.session_id));
  let avgQuality = 0;
  if (sessionIds.length > 0) {
    const qualityRows = await sql`
      SELECT AVG(avg_quality) as avg_q
      FROM conversation_analytics
      WHERE session_id = ANY(${sessionIds})
    `.catch(() => []);
    if (qualityRows.length > 0 && qualityRows[0].avg_q != null) {
      avgQuality = Number(qualityRows[0].avg_q);
    }
  }

  return {
    success_rate: round(successRate, 4),
    avg_cost: round(avgCost, 6),
    avg_turns: round(avgTurns, 2),
    avg_quality: round(avgQuality, 4),
    session_count: sessions.length,
  };
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

type AutopilotGateSnapshot = {
  latest_report: { success_rate: number; session_count: number; analyzed_at?: number } | null;
  eval_qualifies: boolean;
  eval_window: {
    best_pass_rate: number;
    best_total_trials: number;
    runs_in_window: number;
  };
};

async function buildAutopilotGateSnapshot(
  sql: any,
  agentName: string,
  orgId: string,
): Promise<AutopilotGateSnapshot> {
  const windowStart = Date.now() / 1000 - 7 * 86400;
  let latest_report: AutopilotGateSnapshot["latest_report"] = null;
  const reportRows = await sql`
    SELECT report, session_count, created_at FROM evolution_reports
    WHERE agent_name = ${agentName} AND org_id = ${orgId}
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => []);
  if (reportRows[0]) {
    const r = safeJsonParse(reportRows[0].report) || {};
    latest_report = {
      success_rate: Number(r.success_rate ?? 0),
      session_count: Number(reportRows[0].session_count ?? 0),
      analyzed_at: Number(r.analyzed_at ?? 0) || undefined,
    };
  }

  const evalRows = await sql`
    SELECT pass_rate, total_trials, created_at, status
    FROM eval_runs
    WHERE agent_name = ${agentName} AND org_id = ${orgId}
      AND created_at > ${windowStart}
    ORDER BY created_at DESC
    LIMIT 20
  `.catch(() => []);

  const MIN_PASS = 0.85;
  const MIN_EVAL_TRIALS = 3;
  let bestPass = 0;
  let bestTrials = 0;
  let eval_qualifies = false;
  for (const row of evalRows) {
    const pr = Number(row.pass_rate || 0);
    const tt = Number(row.total_trials || 0);
    if (tt >= MIN_EVAL_TRIALS && pr >= MIN_PASS) eval_qualifies = true;
    if (pr > bestPass || (pr === bestPass && tt > bestTrials)) {
      bestPass = pr;
      bestTrials = tt;
    }
  }

  return {
    latest_report,
    eval_qualifies,
    eval_window: {
      best_pass_rate: round(bestPass, 4),
      best_total_trials: bestTrials,
      runs_in_window: evalRows.length,
    },
  };
}

function evaluateAutopilotApplyGates(
  snap: AutopilotGateSnapshot,
  guard?: { force?: boolean; reason?: string },
):
  | { ok: true; mode: string; detail?: string }
  | { ok: false; reason: string; details: Record<string, unknown> } {
  if (guard?.force === true) {
    return { ok: true, mode: "guard_force", detail: String(guard.reason || "force_apply") };
  }

  const MIN_PASS = 0.85;
  const MIN_EVAL_TRIALS = 3;
  const MIN_REPORT_SESSIONS = 10;

  const evalOk = snap.eval_qualifies;
  const reportOk =
    snap.latest_report != null &&
    snap.latest_report.session_count >= MIN_REPORT_SESSIONS &&
    snap.latest_report.success_rate >= MIN_PASS;

  if (evalOk || reportOk) {
    return {
      ok: true,
      mode: evalOk ? "eval_pass_threshold" : "report_success_threshold",
    };
  }

  return {
    ok: false,
    reason:
      "Autopilot apply requires recent eval (>=3 trials, pass_rate>=0.85 in 7d) OR latest analysis report " +
      "(>=10 sessions, success_rate>=0.85), or evolution_apply_guard.force=true.",
    details: {
      min_pass: MIN_PASS,
      min_eval_trials: MIN_EVAL_TRIALS,
      min_report_sessions: MIN_REPORT_SESSIONS,
      eval_window: snap.eval_window,
      latest_report: snap.latest_report,
    },
  };
}

async function mergeApplyMarkersIntoLatestReport(
  sql: any,
  agentName: string,
  orgId: string,
  payload: {
    proposal_id: string;
    applied_at: string;
    autopilot: boolean;
    markers_before: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const rows = await sql`
      SELECT id, report FROM evolution_reports
      WHERE agent_name = ${agentName} AND org_id = ${orgId}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0) return;
    const report = safeJsonParse(rows[0].report) || {};
    report.last_apply_markers = {
      proposal_id: payload.proposal_id,
      applied_at: payload.applied_at,
      autopilot: payload.autopilot,
      markers_before: payload.markers_before,
    };
    await sql`
      UPDATE evolution_reports SET report = ${JSON.stringify(report)}
      WHERE id = ${rows[0].id}
    `;
  } catch {
    /* best-effort */
  }
}

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
  depth: number = 0,
): Record<string, any> {
  if (depth > 10) throw new Error("Config merge depth exceeded (max 10)");
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
      result[key] = deepMergeConfig(current[key], value, depth + 1);
      continue;
    }

    // Direct value assignment
    result[key] = value;
  }

  return result;
}
