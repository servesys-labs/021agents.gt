/**
 * Observability router — summary, daily cost, traces, annotations, feedback, lineage, meta-control-plane.
 * Ported from agentos/api/routers/observability.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  applyDedupeWindow,
  buildCircuitIncident,
  buildIntegrityIncident,
  buildLoopIncident,
  compareSeverity,
  filterIncidentKinds,
  severityFromIntegrityPayload,
  type IncidentKind,
  type ObservabilityIncident,
} from "../logic/observability-incidents";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const observabilityRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseJsonSafe(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

observabilityRoutes.get("/summary", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const sinceDays = Math.max(1, Math.min(365, Number(c.req.query("since_days")) || 30));
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const [sessions] = await sql`
    SELECT COUNT(*) as total, COALESCE(SUM(cost_total_usd), 0) as cost,
           COALESCE(AVG(wall_clock_seconds), 0) as avg_latency,
           COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as success_rate
    FROM sessions WHERE org_id = ${user.org_id} AND created_at >= ${since}
  `;

  const [billing] = await sql`
    SELECT COALESCE(SUM(total_cost_usd), 0) as total_cost,
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM billing_records WHERE org_id = ${user.org_id} AND created_at >= ${since}
  `;

  return c.json({
    total_sessions: Number(sessions.total),
    total_cost_usd: Number(billing.total_cost),
    avg_latency_seconds: Number(sessions.avg_latency),
    success_rate: Number(sessions.success_rate),
    total_input_tokens: Number(billing.input_tokens),
    total_output_tokens: Number(billing.output_tokens),
    since_days: sinceDays,
  });
});

observabilityRoutes.get("/integrity/breaches", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50));
  const traceId = String(c.req.query("trace_id") || "").trim();

  const rows = traceId
    ? await sql`
      SELECT resource_id, changes_json, created_at, user_id
      FROM audit_log
      WHERE org_id = ${user.org_id}
        AND action = 'trace.integrity_breach'
        AND resource_type = 'trace'
        AND resource_id = ${traceId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `.catch(() => [])
    : await sql`
      SELECT resource_id, changes_json, created_at, user_id
      FROM audit_log
      WHERE org_id = ${user.org_id}
        AND action = 'trace.integrity_breach'
        AND resource_type = 'trace'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `.catch(() => []);

  const entries = rows.map((r: any) => {
    const details = parseJsonSafe(r.changes_json);
    const warnings = Array.isArray(details.warnings) ? details.warnings.map((w) => String(w)) : [];
    return {
      trace_id: String(r.resource_id || ""),
      created_at: r.created_at,
      user_id: String(r.user_id || ""),
      strict: Boolean(details.strict),
      missing_turns: Number(details.missing_turns || 0),
      missing_runtime_events: Number(details.missing_runtime_events || 0),
      missing_billing_records: Number(details.missing_billing_records || 0),
      lifecycle_mismatch: Number(details.lifecycle_mismatch || 0),
      warnings,
      severity: severityFromIntegrityPayload(details),
    };
  });

  const byTrace: Record<string, number> = {};
  let strictCount = 0;
  for (const entry of entries) {
    byTrace[entry.trace_id] = (byTrace[entry.trace_id] || 0) + 1;
    if (entry.strict) strictCount += 1;
  }
  const hottestTraces = Object.entries(byTrace)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([trace_id, breaches]) => ({ trace_id, breaches }));

  return c.json({
    total_breaches: entries.length,
    strict_breaches: strictCount,
    non_strict_breaches: entries.length - strictCount,
    hottest_traces: hottestTraces,
    entries,
  });
});

const INCIDENT_KINDS = new Set<IncidentKind>(["integrity_breach", "loop_halt", "loop_warn", "circuit_block"]);

observabilityRoutes.get("/incidents", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const sinceHours = Math.max(1, Math.min(168, Number(c.req.query("since_hours")) || 24));
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50));
  const dedupeRaw = c.req.query("dedupe_window_sec");
  const dedupeParsed = dedupeRaw !== undefined && dedupeRaw !== "" ? Number(dedupeRaw) : 300;
  const dedupeWindowSec = Math.max(0, Math.min(3600, Number.isFinite(dedupeParsed) ? dedupeParsed : 300));
  const includeSuppressed = c.req.query("include_suppressed") !== "false";
  const minSeverity = String(c.req.query("min_severity") || "").trim().toLowerCase();

  const kindsParam = String(c.req.query("kinds") || "").trim();
  const kindFilter: Set<IncidentKind> | null = kindsParam
    ? new Set(
        kindsParam
          .split(",")
          .map((k) => k.trim())
          .filter((k): k is IncidentKind => INCIDENT_KINDS.has(k as IncidentKind)),
      )
    : null;
  if (kindFilter && kindFilter.size === 0) {
    return c.json({ error: "Invalid kinds= (use integrity_breach,loop_halt,loop_warn,circuit_block)" }, 400);
  }

  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const evaluatedAt = new Date().toISOString();

  const sources = {
    audit_log: true,
    middleware_events: true,
    runtime_events: true,
  };

  const raw: ObservabilityIncident[] = [];

  const wantIntegrity = !kindFilter || kindFilter.has("integrity_breach");
  if (wantIntegrity) {
    try {
      const rows = await sql`
        SELECT resource_id, changes_json, created_at, user_id
        FROM audit_log
        WHERE org_id = ${user.org_id}
          AND action = 'trace.integrity_breach'
          AND resource_type = 'trace'
          AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      for (const r of rows as any[]) {
        const details = parseJsonSafe(r.changes_json);
        raw.push(
          buildIntegrityIncident({
            traceId: String(r.resource_id || ""),
            sessionId: null,
            openedAt: String(r.created_at || evaluatedAt),
            userId: String(r.user_id || ""),
            details,
          }),
        );
      }
    } catch {
      sources.audit_log = false;
    }
  }

  const wantLoop = !kindFilter || kindFilter.has("loop_halt") || kindFilter.has("loop_warn");
  if (wantLoop) {
    try {
      const rows = await sql`
        SELECT m.session_id, m.event_type, m.details_json, m.created_at, s.trace_id
        FROM middleware_events m
        LEFT JOIN sessions s ON s.session_id = m.session_id AND s.org_id = m.org_id
        WHERE m.org_id = ${user.org_id}
          AND m.middleware_name = 'loop_detection'
          AND m.event_type IN ('loop_halt', 'loop_warn')
          AND m.created_at >= ${since}
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `;
      for (const r of rows as any[]) {
        const et = String(r.event_type || "");
        if (et !== "loop_halt" && et !== "loop_warn") continue;
        if (kindFilter) {
          if (et === "loop_halt" && !kindFilter.has("loop_halt")) continue;
          if (et === "loop_warn" && !kindFilter.has("loop_warn")) continue;
        }
        const details = parseJsonSafe(r.details_json);
        raw.push(
          buildLoopIncident({
            eventType: et,
            openedAt: String(r.created_at || evaluatedAt),
            traceId: r.trace_id != null ? String(r.trace_id) : null,
            sessionId: String(r.session_id || ""),
            details,
          }),
        );
      }
    } catch {
      sources.middleware_events = false;
    }
  }

  const wantCircuit = !kindFilter || kindFilter.has("circuit_block");
  if (wantCircuit) {
    try {
      const rows = await sql`
        SELECT trace_id, session_id, event_type, details_json, created_at
        FROM runtime_events
        WHERE org_id = ${user.org_id}
          AND event_type = 'turn_completed'
          AND (
            COALESCE(details_json::jsonb->>'error', '') ILIKE '%circuit breaker%'
            OR COALESCE(details_json::text, '') ILIKE '%circuit breaker%'
          )
          AND created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      for (const r of rows as any[]) {
        const details = parseJsonSafe(r.details_json);
        raw.push(
          buildCircuitIncident({
            openedAt: String(r.created_at || evaluatedAt),
            traceId: r.trace_id != null ? String(r.trace_id) : null,
            sessionId: String(r.session_id || ""),
            details: { ...details, event_type: String(r.event_type || "") },
          }),
        );
      }
    } catch {
      sources.runtime_events = false;
    }
  }

  let incidents = applyDedupeWindow(raw, dedupeWindowSec);
  incidents = filterIncidentKinds(incidents, kindFilter);

  const severityRank: Record<string, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  const minRank = minSeverity ? severityRank[minSeverity] : 0;
  if (minSeverity && !minRank) {
    return c.json({ error: "Invalid min_severity (critical|high|medium|low|info)" }, 400);
  }
  if (minRank) {
    incidents = incidents.filter((i) => severityRank[i.severity] >= minRank);
  }

  if (!includeSuppressed) {
    incidents = incidents.filter((i) => i.suppression.is_primary);
  }

  incidents.sort((a, b) => {
    const t = Date.parse(b.opened_at) - Date.parse(a.opened_at);
    if (t !== 0) return t;
    return compareSeverity(b.severity, a.severity);
  });

  incidents = incidents.slice(0, limit);

  const bySeverity: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const i of incidents) {
    bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
    byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  }

  const openPrimary = incidents.filter((i) => i.suppression.is_primary).length;

  return c.json({
    window: {
      since_hours: sinceHours,
      since,
      evaluated_at: evaluatedAt,
    },
    defaults: {
      dedupe_window_sec: dedupeWindowSec,
      include_suppressed: includeSuppressed,
    },
    sources,
    counts: {
      total: incidents.length,
      open_primary: openPrimary,
      by_severity: bySeverity,
      by_kind: byKind,
    },
    incidents,
  });
});

observabilityRoutes.get("/daily-cost", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const days = Math.max(1, Math.min(365, Number(c.req.query("days")) || 30));
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT created_at, total_cost_usd FROM billing_records
    WHERE org_id = ${user.org_id} AND created_at >= ${since}
    ORDER BY created_at
  `;

  const daily: Record<string, number> = {};
  for (const row of rows) {
    const ts = Number(row.created_at || 0);
    const d = new Date(ts * 1000);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    daily[day] = (daily[day] || 0) + Number(row.total_cost_usd || 0);
  }

  return c.json({
    days: Object.keys(daily).sort().map((day) => ({ day, cost: daily[day] })),
  });
});

/**
 * GET /cost-ledger
 * Per-agent cost breakdown from billing_records or sessions.
 */
observabilityRoutes.get("/cost-ledger", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let entries: Array<{
    agent_name: string;
    model: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  }> = [];

  try {
    const rows = await sql`
      SELECT
        COALESCE(agent_name, '') as agent_name,
        COALESCE(model, '') as model,
        COALESCE(SUM(total_cost_usd), 0) as cost_usd,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM billing_records
      WHERE org_id = ${user.org_id}
      GROUP BY agent_name, model
      ORDER BY cost_usd DESC
    `;
    entries = rows.map((r: any) => ({
      agent_name: String(r.agent_name),
      model: String(r.model),
      cost_usd: Number(r.cost_usd),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
    }));
  } catch {}

  return c.json({ entries });
});

observabilityRoutes.get("/trace/:trace_id", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const traceId = c.req.param("trace_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify org ownership
  const check = await sql`
    SELECT COUNT(*) as cnt FROM sessions WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
  `;
  if (Number(check[0]?.cnt) === 0) return c.json({ error: "Trace not found" }, 404);

  const sessions = await sql`
    SELECT * FROM sessions WHERE trace_id = ${traceId} AND org_id = ${user.org_id} ORDER BY created_at
  `;

  const events = await sql`
    SELECT * FROM runtime_events WHERE trace_id = ${traceId} AND org_id = ${user.org_id} ORDER BY created_at
  `.catch(() => []);

  return c.json({ trace_id: traceId, sessions, events });
});

observabilityRoutes.get("/trace/:trace_id/integrity", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const traceId = c.req.param("trace_id");
  const strict = c.req.query("strict") === "true";
  const alertOnBreach = c.req.query("alert_on_breach") === "true";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const sessions = await sql`
    SELECT session_id, status, created_at
    FROM sessions
    WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
    ORDER BY created_at
  `;
  if (sessions.length === 0) return c.json({ error: "Trace not found" }, 404);

  const sessionIds = sessions.map((s: any) => String(s.session_id));

  const turnCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  const billingCounts = new Map<string, number>();
  const lifecycleCounts = new Map<string, { turn_start: number; turn_end: number; session_end: number }>();

  for (const sid of sessionIds) {
    const [turnRow] = await sql`
      SELECT COUNT(*) as cnt FROM turns WHERE session_id = ${sid}
    `.catch(() => [{ cnt: 0 }]);
    const [eventRow] = await sql`
      SELECT COUNT(*) as cnt FROM runtime_events WHERE session_id = ${sid} AND org_id = ${user.org_id}
    `.catch(() => [{ cnt: 0 }]);
    const [billingRow] = await sql`
      SELECT COUNT(*) as cnt FROM billing_records WHERE session_id = ${sid} AND org_id = ${user.org_id}
    `.catch(() => [{ cnt: 0 }]);
    const [lifecycleRow] = await sql`
      SELECT
        SUM(CASE WHEN event_type = 'turn_start' THEN 1 ELSE 0 END) AS turn_start,
        SUM(CASE WHEN event_type = 'turn_end' THEN 1 ELSE 0 END) AS turn_end,
        SUM(CASE WHEN event_type = 'session_end' THEN 1 ELSE 0 END) AS session_end
      FROM runtime_events
      WHERE session_id = ${sid} AND org_id = ${user.org_id}
    `.catch(() => [{ turn_start: 0, turn_end: 0, session_end: 0 }]);
    turnCounts.set(sid, Number(turnRow?.cnt || 0));
    eventCounts.set(sid, Number(eventRow?.cnt || 0));
    billingCounts.set(sid, Number(billingRow?.cnt || 0));
    lifecycleCounts.set(sid, {
      turn_start: Number(lifecycleRow?.turn_start || 0),
      turn_end: Number(lifecycleRow?.turn_end || 0),
      session_end: Number(lifecycleRow?.session_end || 0),
    });
  }

  const missingTurns = sessionIds.filter((sid) => (turnCounts.get(sid) || 0) === 0);
  const missingEvents = sessionIds.filter((sid) => (eventCounts.get(sid) || 0) === 0);
  const missingBilling = sessionIds.filter((sid) => (billingCounts.get(sid) || 0) === 0);
  const lifecycleMismatch = sessionIds.filter((sid) => {
    const lc = lifecycleCounts.get(sid);
    if (!lc) return true;
    return lc.turn_start !== lc.turn_end || lc.session_end === 0;
  });

  const maxCreatedAtMs = Math.max(
    ...sessions.map((s: any) => new Date(String(s.created_at || "")).getTime()).filter((n: number) => Number.isFinite(n)),
  );
  const recentWindowMs = 90_000; // allow async ingest/queue fanout to settle
  const isRecentTrace = Number.isFinite(maxCreatedAtMs) && (Date.now() - maxCreatedAtMs < recentWindowMs);

  const warnings: string[] = [];
  if (missingTurns.length > 0) warnings.push(`${missingTurns.length} sessions have no turns`);
  if (missingEvents.length > 0) warnings.push(`${missingEvents.length} sessions have no runtime events`);
  if (missingBilling.length > 0 && (!isRecentTrace || strict)) {
    warnings.push(`${missingBilling.length} sessions have no billing records`);
  }
  if (lifecycleMismatch.length > 0) {
    warnings.push(`${lifecycleMismatch.length} sessions have lifecycle event mismatch`);
  }
  const complete = warnings.length === 0;
  if (!complete && alertOnBreach) {
    try {
      await sql`
        INSERT INTO audit_log (org_id, user_id, action, resource_type, resource_id, changes_json, created_at)
        VALUES (
          ${user.org_id},
          ${user.user_id},
          'trace.integrity_breach',
          'trace',
          ${traceId},
          ${JSON.stringify({
            strict,
            missing_turns: missingTurns.length,
            missing_runtime_events: missingEvents.length,
            missing_billing_records: missingBilling.length,
            lifecycle_mismatch: lifecycleMismatch.length,
            warnings,
          })},
          ${new Date().toISOString()}
        )
      `;
    } catch {
      // best-effort alerting path
    }
  }

  return c.json({
    trace_id: traceId,
    complete,
    consistency_window_ms: recentWindowMs,
    is_recent_trace: isRecentTrace,
    counts: {
      sessions: sessions.length,
      turns: sessionIds.reduce((acc, sid) => acc + (turnCounts.get(sid) || 0), 0),
      runtime_events: sessionIds.reduce((acc, sid) => acc + (eventCounts.get(sid) || 0), 0),
      billing_records: sessionIds.reduce((acc, sid) => acc + (billingCounts.get(sid) || 0), 0),
    },
    missing: {
      turns: missingTurns,
      runtime_events: missingEvents,
      billing_records: missingBilling,
      lifecycle_mismatch: lifecycleMismatch,
    },
    warnings,
  });
});

observabilityRoutes.post("/annotations", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const traceId = String(body.trace_id || "").trim();
  const annotationType = String(body.annotation_type || "note");
  const message = String(body.message || "").trim();
  const severity = String(body.severity || "info");
  const spanId = String(body.span_id || "");
  const nodeId = String(body.node_id || "");
  const turn = Number(body.turn || 0);
  const metadata = body.metadata || {};

  if (!traceId) return c.json({ error: "trace_id is required" }, 400);
  if (!message) return c.json({ error: "message is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const annotationId = genId();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO trace_annotations (annotation_id, trace_id, org_id, user_id, annotation_type, message, severity, span_id, node_id, turn, metadata_json, created_at)
    VALUES (${annotationId}, ${traceId}, ${user.org_id}, ${user.user_id}, ${annotationType}, ${message}, ${severity}, ${spanId}, ${nodeId}, ${turn}, ${JSON.stringify(metadata)}, ${now})
  `;

  return c.json({ annotation_id: annotationId, created: true });
});

observabilityRoutes.post("/feedback", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const spanId = String(body.span_id || "").trim();
  const rating = Number(body.rating || 0);
  const score = Number(body.score || 0);
  const comment = String(body.comment || "");
  const labels = Array.isArray(body.labels) ? body.labels : [];
  const sessionId = String(body.session_id || "");
  const turn = Number(body.turn || 0);
  const source = String(body.source || "human");

  if (!spanId) return c.json({ error: "span_id is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const feedbackId = genId();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO span_feedback (feedback_id, span_id, org_id, user_id, rating, score, comment, labels_json, session_id, turn, source, created_at)
    VALUES (${feedbackId}, ${spanId}, ${user.org_id}, ${user.user_id}, ${rating}, ${score}, ${comment}, ${JSON.stringify(labels)}, ${sessionId}, ${turn}, ${source}, ${now})
  `;

  return c.json({ feedback_id: feedbackId, created: true });
});

observabilityRoutes.post("/lineage", requireScope("observability:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const traceId = String(body.trace_id || "").trim();
  if (!traceId) return c.json({ error: "trace_id is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = new Date().toISOString();

  await sql`
    INSERT INTO trace_lineage (trace_id, org_id, session_id, agent_version, model, prompt_hash, eval_run_id, experiment_id, dataset_id, commit_sha, metadata_json, created_at)
    VALUES (${traceId}, ${user.org_id}, ${body.session_id || ""}, ${body.agent_version || ""}, ${body.model || ""}, ${body.prompt_hash || ""}, ${Number(body.eval_run_id || 0)}, ${body.experiment_id || ""}, ${body.dataset_id || ""}, ${body.commit_sha || ""}, ${JSON.stringify(body.metadata || {})}, ${now})
    ON CONFLICT (trace_id) DO UPDATE SET
      session_id = EXCLUDED.session_id,
      agent_version = EXCLUDED.agent_version,
      model = EXCLUDED.model,
      prompt_hash = EXCLUDED.prompt_hash,
      metadata_json = EXCLUDED.metadata_json
  `;

  return c.json({ trace_id: traceId, updated: true });
});

observabilityRoutes.get("/agents/:agent_name/meta-control-plane", requireScope("observability:read"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Gather signals
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

  const [sessionStats] = await sql`
    SELECT COUNT(*) as total, COALESCE(AVG(step_count), 0) as avg_turns,
           COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as success_rate,
           COALESCE(AVG(cost_total_usd), 0) as avg_cost
    FROM sessions WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND created_at >= ${since}
  `.catch(() => [{ total: 0, avg_turns: 0, success_rate: 0, avg_cost: 0 }]);

  const evalRows = await sql`
    SELECT pass_rate, total_trials FROM eval_runs
    WHERE agent_name = ${agentName} ORDER BY created_at DESC LIMIT 1
  `.catch(() => []);

  const signals = {
    total_sessions_7d: Number(sessionStats.total),
    avg_turns: Number(sessionStats.avg_turns),
    success_rate: Number(sessionStats.success_rate),
    avg_cost_usd: Number(sessionStats.avg_cost),
    eval_pass_rate: evalRows.length > 0 ? Number(evalRows[0].pass_rate) : null,
    eval_total_trials: evalRows.length > 0 ? Number(evalRows[0].total_trials) : null,
  };

  // API map
  const entrypoints = {
    agent_crud: {
      list: "/api/v1/agents",
      get: `/api/v1/agents/${agentName}`,
      create: "/api/v1/agents",
      update: `/api/v1/agents/${agentName}`,
      delete: `/api/v1/agents/${agentName}`,
    },
    graph_design: {
      validate: "/api/v1/graphs/validate",
      lint: "/api/v1/graphs/lint",
      autofix: "/api/v1/graphs/autofix",
    },
    telemetry: {
      meta_report: `/api/v1/observability/agents/${agentName}/meta-report`,
      meta_control_plane: `/api/v1/observability/agents/${agentName}/meta-control-plane`,
    },
    eval_experiments: {
      run_eval: "/api/v1/eval/run",
      list_runs: "/api/v1/eval/runs",
      datasets: "/api/v1/eval/datasets",
      evaluators: "/api/v1/eval/evaluators",
      experiments: "/api/v1/eval/experiments",
    },
    improvement_loops: {
      autoresearch: "/api/v1/autoresearch/start",
    },
  };

  return c.json({
    agent_name: agentName,
    signals,
    entrypoints,
  });
});

// ── Proposal generation from telemetry signals ──────────────────────
// Ported from Python _meta_proposals_from_report()

interface MetaProposal {
  id: string;
  agent_name: string;
  title: string;
  rationale: string;
  category: string;
  priority: number;
  modification: Record<string, unknown>;
  evidence: Record<string, unknown>;
  status: string;
  created_at: string;
}

function generateProposalsFromSignals(
  agentName: string,
  signals: Record<string, unknown>,
  maxProposals: number,
): MetaProposal[] {
  const proposals: MetaProposal[] = [];
  const now = new Date().toISOString();
  const id = () => crypto.randomUUID().slice(0, 12);

  const nodeErrorRate = Number(signals.node_error_rate ?? 0);
  if (nodeErrorRate > 0.03) {
    proposals.push({
      id: id(), agent_name: agentName,
      title: "Reduce node execution failures",
      rationale: `Node error rate is ${(nodeErrorRate * 100).toFixed(1)}%; add retries/fallbacks and tighten node contracts.`,
      category: "runtime",
      priority: Math.min(1.0, 0.4 + nodeErrorRate),
      modification: { harness: { max_retries: 4, retry_on_tool_failure: true } },
      evidence: { node_error_rate: nodeErrorRate },
      status: "pending", created_at: now,
    });
  }

  const pending = Number(signals.checkpoint_pending ?? 0);
  if (pending > 0) {
    proposals.push({
      id: id(), agent_name: agentName,
      title: "Improve human-approval throughput",
      rationale: `${pending} runs are pending approval; add staffing/SLA or narrower approval gating.`,
      category: "governance",
      priority: Math.min(1.0, 0.35 + pending / 50),
      modification: { harness: { require_human_approval: true } },
      evidence: { checkpoint_pending: pending },
      status: "pending", created_at: now,
    });
  }

  const evalPassRate = signals.eval_pass_rate;
  if (evalPassRate !== null && evalPassRate !== undefined && Number(evalPassRate) < 0.85) {
    proposals.push({
      id: id(), agent_name: agentName,
      title: "Raise eval pass rate with targeted regressions",
      rationale: `Eval pass rate is ${(Number(evalPassRate) * 100).toFixed(1)}%; run focused evals on failing traces and tighten prompt/tool policies.`,
      category: "eval",
      priority: 0.8,
      modification: {},
      evidence: { eval_pass_rate: Number(evalPassRate) },
      status: "pending", created_at: now,
    });
  }

  const avgTurns = Number(signals.avg_turns ?? 0);
  if (avgTurns > 8) {
    proposals.push({
      id: id(), agent_name: agentName,
      title: "Reduce turn depth and loop overhead",
      rationale: `Average turns per run is ${avgTurns.toFixed(1)}; optimize planning and tool selection to converge faster.`,
      category: "prompt",
      priority: Math.min(1.0, 0.3 + avgTurns / 30),
      modification: { max_turns: Math.max(5, Math.floor(avgTurns * 1.5)) },
      evidence: { avg_turns: avgTurns },
      status: "pending", created_at: now,
    });
  }

  // Default: if all signals are healthy, suggest optimization
  if (proposals.length === 0) {
    proposals.push({
      id: id(), agent_name: agentName,
      title: "Optimize cost/latency under stable quality",
      rationale: "Telemetry is healthy; run model/caching/tool-budget experiments to reduce cost and latency.",
      category: "optimization",
      priority: 0.3,
      modification: {},
      evidence: { signals },
      status: "pending", created_at: now,
    });
  }

  // Sort by priority descending, cap at maxProposals
  proposals.sort((a, b) => b.priority - a.priority);
  return proposals.slice(0, maxProposals);
}

// ── Meta-proposals (with org-scoped ownership checks) ────────────────

async function agentIsOwned(sql: any, agentName: string, orgId: string): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT COUNT(*) as cnt FROM sessions WHERE agent_name = ${agentName} AND org_id = ${orgId}
    `;
    if (Number(rows[0]?.cnt) > 0) return true;
  } catch {}
  try {
    const rows = await sql`
      SELECT COUNT(*) as cnt FROM agents WHERE name = ${agentName} AND org_id = ${orgId}
    `;
    if (Number(rows[0]?.cnt) > 0) return true;
  } catch {}
  return false;
}

observabilityRoutes.get("/agents/:agent_name/meta-proposals", requireScope("observability:read"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  if (!(await agentIsOwned(sql, agentName, user.org_id))) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const status = c.req.query("status") || "";
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit")) || 100));

  const rows = status
    ? await sql`SELECT * FROM meta_proposals WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit}`.catch(() => [])
    : await sql`SELECT * FROM meta_proposals WHERE agent_name = ${agentName} AND org_id = ${user.org_id} ORDER BY created_at DESC LIMIT ${limit}`.catch(() => []);

  return c.json({ agent_name: agentName, proposals: rows });
});

// Generate proposals from telemetry signals (matches Python POST /meta-proposals/generate)
observabilityRoutes.post("/agents/:agent_name/meta-proposals/generate", requireScope("observability:write"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  if (!(await agentIsOwned(sql, agentName, user.org_id))) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const persist = body.persist !== false;
  const maxProposals = Math.max(1, Math.min(20, Number(body.max_proposals) || 8));

  // Gather signals
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  let signals: Record<string, unknown> = {};
  try {
    const [stats] = await sql`
      SELECT COUNT(*) as total,
             COALESCE(AVG(step_count), 0) as avg_turns,
             COALESCE(SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as error_rate
      FROM sessions WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND created_at >= ${since}
    `;
    const evalRows = await sql`
      SELECT pass_rate, total_trials FROM eval_runs
      WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT 1
    `.catch(() => []);
    const checkpointRows = await sql`
      SELECT COUNT(*) as cnt FROM graph_checkpoints
      WHERE agent_name = ${agentName} AND status = 'pending_approval'
    `.catch(() => [{ cnt: 0 }]);

    signals = {
      avg_turns: Number(stats.avg_turns),
      node_error_rate: Number(stats.error_rate),
      eval_pass_rate: evalRows.length > 0 ? Number(evalRows[0].pass_rate) : null,
      checkpoint_pending: Number(checkpointRows[0]?.cnt ?? 0),
    };
  } catch { /* best-effort */ }

  const proposals = generateProposalsFromSignals(agentName, signals, maxProposals);

  if (persist) {
    for (const p of proposals) {
      try {
        await sql`
          INSERT INTO meta_proposals (id, agent_name, org_id, title, rationale, category, priority, modification_json, evidence_json, status, created_at)
          VALUES (${p.id}, ${agentName}, ${user.org_id}, ${p.title}, ${p.rationale},
                  ${p.category}, ${p.priority}, ${JSON.stringify(p.modification)},
                  ${JSON.stringify(p.evidence)}, 'pending', ${p.created_at})
          ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, rationale = EXCLUDED.rationale, priority = EXCLUDED.priority
        `;
      } catch { /* best-effort */ }
    }
  }

  return c.json({
    agent_name: agentName,
    generated: proposals.length,
    persisted: persist,
    proposals,
  });
});

// Meta-report endpoint (matches Python GET /agents/{agent_name}/meta-report)
observabilityRoutes.get("/agents/:agent_name/meta-report", requireScope("observability:read"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  if (!(await agentIsOwned(sql, agentName, user.org_id))) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

  const [summary] = await sql`
    SELECT COUNT(*) as total_sessions,
           COALESCE(SUM(step_count), 0) as total_turns,
           COALESCE(SUM(cost_total_usd), 0) as total_cost_usd,
           COALESCE(AVG(wall_clock_seconds * 1000), 0) as avg_latency_ms,
           COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as success_rate,
           COALESCE(SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as error_rate,
           COALESCE(AVG(step_count), 0) as avg_turns
    FROM sessions WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND created_at >= ${since}
  `.catch(() => [{ total_sessions: 0, total_turns: 0, total_cost_usd: 0, avg_latency_ms: 0, success_rate: 0, error_rate: 0, avg_turns: 0 }]);

  const evalRows = await sql`
    SELECT pass_rate, total_trials FROM eval_runs
    WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => []);

  const checkpointRows = await sql`
    SELECT COUNT(*) as cnt FROM graph_checkpoints
    WHERE agent_name = ${agentName} AND status = 'pending_approval'
  `.catch(() => [{ cnt: 0 }]);

  const signals = {
    node_error_rate: Number(summary.error_rate),
    checkpoint_pending: Number(checkpointRows[0]?.cnt ?? 0),
    eval_pass_rate: evalRows.length > 0 ? Number(evalRows[0].pass_rate) : null,
    avg_turns: Number(summary.avg_turns),
  };

  return c.json({
    agent_name: agentName,
    org_id: user.org_id,
    analyzed_at: Date.now() / 1000,
    summary: {
      total_sessions: Number(summary.total_sessions),
      total_turns: Number(summary.total_turns),
      total_cost_usd: Number(summary.total_cost_usd),
      avg_latency_ms: Number(summary.avg_latency_ms),
      success_rate: Number(summary.success_rate),
      error_rate: Number(summary.error_rate),
    },
    signals,
  });
});

observabilityRoutes.post("/agents/:agent_name/meta-proposals/:proposal_id/review", requireScope("observability:write"), async (c) => {
  const agentName = c.req.param("agent_name");
  const proposalId = c.req.param("proposal_id");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  if (!(await agentIsOwned(sql, agentName, user.org_id))) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const approved = body.approved !== false;
  const note = String(body.note || "");
  const status = approved ? "approved" : "rejected";

  const rows = await sql`
    UPDATE meta_proposals SET status = ${status}, review_note = ${note}, reviewed_at = ${new Date().toISOString()}
    WHERE id = ${proposalId} AND agent_name = ${agentName}
    RETURNING id
  `.catch(() => []);

  if (rows.length === 0) return c.json({ error: "Meta proposal not found" }, 404);

  return c.json({ proposal_id: proposalId, status });
});

// ── Trace Replay (Time Travel) ──────────────────────────────────────

observabilityRoutes.get("/trace/:trace_id/replay", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const traceId = c.req.param("trace_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify org ownership
  const check = await sql`
    SELECT COUNT(*) as cnt FROM sessions WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
  `;
  if (Number(check[0]?.cnt) === 0) return c.json({ error: "Trace not found" }, 404);

  const cursorIndex = c.req.query("cursor_index");
  const eventId = c.req.query("event_id");
  const upToId = c.req.query("up_to_id");
  const includeEvents = c.req.query("include_events") === "true";

  // Load all events for this trace ordered by id
  const events = await sql`
    SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at, s.trace_id
    FROM otel_events e
    INNER JOIN sessions s ON s.session_id = e.session_id
    WHERE s.trace_id = ${traceId} AND s.org_id = ${user.org_id}
    ORDER BY e.id ASC
  `.catch(() => []);

  const totalEvents = events.length;
  if (totalEvents === 0) {
    return c.json({
      trace_id: traceId,
      cursor: 0,
      total_events: 0,
      state_at_cursor: { messages: [], tools_called: [], cost_usd: 0, turns: 0 },
      events: [],
    });
  }

  // Determine the slice boundary
  let sliceEnd = totalEvents;
  if (cursorIndex) {
    const idx = Math.max(0, Math.min(Number(cursorIndex), totalEvents - 1));
    sliceEnd = idx + 1;
  } else if (eventId) {
    const targetIdx = events.findIndex((e: Record<string, unknown>) => String(e.id) === eventId);
    if (targetIdx >= 0) sliceEnd = targetIdx + 1;
  } else if (upToId) {
    const targetIdx = events.findIndex((e: Record<string, unknown>) => String(e.id) === upToId);
    if (targetIdx >= 0) sliceEnd = targetIdx + 1;
  }

  const prefix = events.slice(0, sliceEnd);

  // Reconstruct state at cursor from the prefix events
  let costUsd = 0;
  let turns = 0;
  const toolsCalled: string[] = [];
  const messages: Array<{ role: string; content: string; turn: number }> = [];

  for (const row of prefix) {
    const data = parseJsonSafe(row.details_json);
    const eventType = String(row.event_type || "");
    const turn = Number(row.turn_number || 0);

    if (eventType === "turn_start") {
      turns = Math.max(turns, turn);
    }
    if (eventType === "llm_response") {
      costUsd += Number(data.cost_usd || 0);
      messages.push({ role: "assistant", content: String(data.content || ""), turn });
    }
    if (eventType === "tool_call") {
      toolsCalled.push(String(data.tool_name || ""));
    }
    if (eventType === "tool_result") {
      costUsd += Number(data.cost_usd || 0);
    }
    if (eventType === "session_start") {
      messages.push({ role: "user", content: String(data.input || ""), turn: 0 });
    }
  }

  const cursorRow = prefix[prefix.length - 1];
  const cursor = Number(cursorRow?.id || 0);

  return c.json({
    trace_id: traceId,
    cursor,
    total_events: totalEvents,
    state_at_cursor: {
      messages,
      tools_called: [...new Set(toolsCalled)],
      cost_usd: costUsd,
      turns,
    },
    events: includeEvents
      ? prefix.map((r: Record<string, unknown>) => ({
          id: r.id,
          event_type: r.event_type,
          turn: r.turn_number,
          details: parseJsonSafe(r.details_json),
          created_at: r.created_at,
        }))
      : [],
  });
});

observabilityRoutes.get("/trace/:trace_id/run-tree", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const traceId = c.req.param("trace_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify org ownership
  const check = await sql`
    SELECT COUNT(*) as cnt FROM sessions WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
  `;
  if (Number(check[0]?.cnt) === 0) return c.json({ error: "Trace not found" }, 404);

  const events = await sql`
    SELECT e.id, e.session_id, e.turn AS turn_number, e.event_type, e.details_json, e.created_at
    FROM otel_events e
    INNER JOIN sessions s ON s.session_id = e.session_id
    WHERE s.trace_id = ${traceId} AND s.org_id = ${user.org_id}
    ORDER BY e.id ASC
  `.catch(() => []);

  // Group events by session_id -> turn -> event_type
  const sessionMap = new Map<string, Map<number, Array<Record<string, unknown>>>>();
  for (const row of events) {
    const sid = String(row.session_id || "");
    const turn = Number(row.turn_number || 0);
    if (!sessionMap.has(sid)) sessionMap.set(sid, new Map());
    const turnMap = sessionMap.get(sid)!;
    if (!turnMap.has(turn)) turnMap.set(turn, []);
    turnMap.get(turn)!.push({
      id: row.id,
      event_type: row.event_type,
      details: parseJsonSafe(row.details_json),
      created_at: row.created_at,
    });
  }

  const tree = [...sessionMap.entries()].map(([sessionId, turnMap]) => ({
    session_id: sessionId,
    turns: [...turnMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([turn, turnEvents]) => ({ turn, events: turnEvents })),
  }));

  return c.json({ trace_id: traceId, tree });
});

// ── End Trace Replay ────────────────────────────────────────────────

observabilityRoutes.post("/agents/:agent_name/autonomous-maintenance-run", requireScope("observability:write"), async (c) => {
  const agentName = c.req.param("agent_name");
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Strict org ownership — no filesystem fallback
  if (!(await agentIsOwned(sql, agentName, user.org_id))) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const dryRun = !!body.dry_run;
  const persistProposals = !!body.persist_proposals;
  const maxProposals = Math.max(1, Math.min(20, Number(body.max_proposals) || 8));
  const minEvalPassRate = Number(body.min_eval_pass_rate) || 0.85;
  const minEvalTrials = Number(body.min_eval_trials) || 3;
  const targetChannel = String(body.target_channel || "staging");

  // ── 1. Gather telemetry signals ─────────────────────────────────
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString(); // last 7 days
  let signals: Record<string, unknown> = {};
  try {
    const [stats] = await sql`
      SELECT COUNT(*) as total,
             COALESCE(AVG(step_count), 0) as avg_turns,
             COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as success_rate,
             COALESCE(AVG(cost_total_usd), 0) as avg_cost,
             COALESCE(SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) as error_rate
      FROM sessions WHERE agent_name = ${agentName} AND org_id = ${user.org_id} AND created_at >= ${since}
    `;
    const evalRows = await sql`
      SELECT pass_rate, total_trials FROM eval_runs
      WHERE agent_name = ${agentName} AND org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT 1
    `.catch(() => []);
    const checkpointRows = await sql`
      SELECT COUNT(*) as cnt FROM graph_checkpoints
      WHERE agent_name = ${agentName} AND status = 'pending_approval'
    `.catch(() => [{ cnt: 0 }]);

    signals = {
      total_sessions_7d: Number(stats.total),
      avg_turns: Number(stats.avg_turns),
      success_rate: Number(stats.success_rate),
      avg_cost_usd: Number(stats.avg_cost),
      node_error_rate: Number(stats.error_rate),
      eval_pass_rate: evalRows.length > 0 ? Number(evalRows[0].pass_rate) : null,
      checkpoint_pending: Number(checkpointRows[0]?.cnt ?? 0),
    };
  } catch { /* best-effort */ }

  // ── 2. Generate proposals from signals ──────────────────────────
  const proposals = generateProposalsFromSignals(agentName, signals, maxProposals);

  // ── 3. Persist proposals (unless dry_run) ───────────────────────
  const actuallyPersisted = persistProposals && !dryRun;
  if (actuallyPersisted) {
    for (const proposal of proposals) {
      try {
        await sql`
          INSERT INTO meta_proposals (id, agent_name, org_id, title, rationale, category, priority, modification_json, evidence_json, status, created_at)
          VALUES (${proposal.id}, ${agentName}, ${user.org_id}, ${proposal.title}, ${proposal.rationale},
                  ${proposal.category}, ${proposal.priority}, ${JSON.stringify(proposal.modification)},
                  ${JSON.stringify(proposal.evidence)}, 'pending', ${new Date().toISOString()})
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            rationale = EXCLUDED.rationale,
            priority = EXCLUDED.priority
        `;
      } catch { /* best-effort */ }
    }
  }

  // ── 4. Graph checks ─────────────────────────────────────────────
  let graphAvailable = false;
  let graphLint: Record<string, unknown> | null = null;
  let graphAutofix: Record<string, unknown> | null = null;
  let contractsValidate: Record<string, unknown> | null = null;

  try {
    const agentRows = await sql`
      SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id}
    `;
    if (agentRows.length > 0) {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(String(agentRows[0].config_json || "{}")); } catch {}
      const graph = (config.harness as any)?.declarative_graph ?? config.declarative_graph;
      if (graph && typeof graph === "object") {
        graphAvailable = true;
        const { lintGraphDesign, lintPayloadFromResult, summarizeGraphContracts } = await import("../logic/graph-lint");
        const { lintAndAutofixGraph } = await import("../logic/graph-autofix");

        graphAutofix = lintAndAutofixGraph(graph as Record<string, unknown>, { strict: true, apply: true });
        graphLint = (graphAutofix as any).lint_after ?? null;

        const contractsResult = lintGraphDesign(graph as Record<string, unknown>, { strict: true });
        const contractsSummary: Record<string, unknown> = { ...(contractsResult.summary ?? {}) };
        contractsSummary.contracts = summarizeGraphContracts(graph as Record<string, unknown>);
        contractsValidate = {
          valid: contractsResult.valid,
          errors: contractsResult.errors,
          warnings: contractsResult.warnings,
          summary: contractsSummary,
        };
      }
    }
  } catch { /* best-effort */ }

  // ── 5. Eval gate ────────────────────────────────────────────────
  const { latestEvalGate, rolloutRecommendation } = await import("../logic/gate-pack");
  const evalGate = await latestEvalGate(sql, agentName, {
    minEvalPassRate,
    minEvalTrials,
    orgId: user.org_id,
  });

  // ── 6. Rollout recommendation ───────────────────────────────────
  const lintValid = Boolean((graphLint as any)?.valid);
  const rollout = rolloutRecommendation({
    agentName,
    graphLint: graphAvailable ? (graphLint as any) : null,
    evalGate,
    targetChannel,
  });

  const blockingReasons: string[] = [];
  if (rollout.decision === "hold") {
    blockingReasons.push(rollout.reason || "Hold decision");
  }

  // ── 7. Build eval plan from signals + proposals ─────────────────
  const focusAreas: string[] = [];
  if (Number(signals.node_error_rate ?? 0) > 0.03) focusAreas.push("node_reliability");
  if (Number(signals.checkpoint_pending ?? 0) > 0) focusAreas.push("approval_resume_flow");
  if (signals.eval_pass_rate !== null && Number(signals.eval_pass_rate) < 0.85) focusAreas.push("regression_failures");
  if (Number(signals.avg_turns ?? 0) > 8) focusAreas.push("turn_efficiency");
  if (focusAreas.length === 0) focusAreas.push("cost_latency_optimization");

  const suggestedEvalPlan = {
    agent_name: agentName,
    focus_areas: focusAreas,
    proposal_context: proposals.slice(0, 5).map((p) => p.title),
    recommended_trials_per_task: 3,
    tasks: focusAreas.map((area) => ({
      name: `${area}-smoke`,
      input: `Run an ${area} regression scenario for ${agentName}.`,
      expected: "stable behavior",
      grader: "llm",
      criteria: `Validates ${area} with no critical errors.`,
    })),
  };

  return c.json({
    agent_name: agentName,
    dry_run: dryRun,
    generated_at: Date.now() / 1000,
    meta_report: { signals },
    graph_checks: {
      available: graphAvailable,
      graph_lint: graphLint,
      contracts_validate: contractsValidate,
      graph_autofix: graphAutofix,
    },
    eval_gate: evalGate,
    rollout,
    proposals: {
      generated: proposals.length,
      persisted: actuallyPersisted,
      items: proposals,
    },
    approval_packet: {
      requires_human_approval: true,
      ready_for_approval: rollout.decision === "promote_candidate",
      blocking_reasons: blockingReasons,
      review_endpoints: {
        meta_control_plane: `/api/v1/observability/agents/${agentName}/meta-control-plane`,
        meta_proposals: `/api/v1/observability/agents/${agentName}/meta-proposals`,
        gate_pack: "/api/v1/graphs/gate-pack",
      },
    },
    suggested_eval_plan: suggestedEvalPlan,
    suggested_actions: [
      "Review generated proposals and graph contract/lint outputs",
      "Approve config changes and run targeted eval regressions",
      "Promote only if rollout decision is promote_candidate",
    ],
  });
});

// ── OTLP Trace Export ─────────────────────────────────────────────────

observabilityRoutes.get("/export/otlp", requireScope("observability:read"), async (c) => {
  const user = c.get("user");
  const traceId = c.req.query("trace_id");

  if (!traceId) {
    return c.json({ error: "trace_id query parameter is required" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Verify org ownership
  const check = await sql`
    SELECT COUNT(*) as cnt FROM sessions WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
  `;
  if (Number(check[0]?.cnt) === 0) {
    return c.json({ error: "Trace not found" }, 404);
  }

  // Fetch sessions for this trace
  const sessions = await sql`
    SELECT session_id, agent_name, status, version, wall_clock_seconds, created_at, trace_id
    FROM sessions
    WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
    ORDER BY created_at
  `;

  // Fetch runtime_events (spans) for this trace
  const events = await sql`
    SELECT event_id, session_id, trace_id, span_id, parent_span_id,
           event_type, event_name, status_code, start_time, end_time,
           attributes_json, resource_json
    FROM runtime_events
    WHERE trace_id = ${traceId} AND org_id = ${user.org_id}
    ORDER BY start_time
  `.catch(() => []);

  // Fetch turns for each session to enrich spans
  const sessionIds = sessions.map((s: any) => String(s.session_id));
  const turns = sessionIds.length > 0
    ? await sql`
        SELECT session_id, turn_number, tool_calls_json, tool_results_json, error, created_at
        FROM turns
        WHERE session_id = ANY(${sessionIds})
        ORDER BY session_id, turn_number
      `.catch(() => [])
    : [];

  // Convert to OTLP JSON format
  // https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding

  // Build a hex trace ID (pad to 32 hex chars)
  const hexTraceId = traceId.replace(/-/g, "").padEnd(32, "0").slice(0, 32);

  // Group spans by resource (agent_name)
  const resourceSpansMap = new Map<string, any[]>();

  // Convert runtime_events to OTLP spans
  for (const event of events) {
    const agentName = String(
      sessions.find((s: any) => s.session_id === event.session_id)?.agent_name || "unknown"
    );

    let attributes: Record<string, unknown> = {};
    try { attributes = JSON.parse(String(event.attributes_json || "{}")); } catch {}

    let resource: Record<string, unknown> = {};
    try { resource = JSON.parse(String(event.resource_json || "{}")); } catch {}

    const spanId = String(event.span_id || genId() + genId()).padEnd(16, "0").slice(0, 16);
    const parentSpanId = event.parent_span_id ? String(event.parent_span_id).padEnd(16, "0").slice(0, 16) : "";

    const startTimeUnixNano = String(BigInt(Math.floor(Number(event.start_time || 0) * 1e9)));
    const endTimeUnixNano = String(BigInt(Math.floor(Number(event.end_time || event.start_time || 0) * 1e9)));

    const statusCode = String(event.status_code || "STATUS_CODE_UNSET");
    const otlpStatus: Record<string, unknown> = {
      code: statusCode === "error" || statusCode === "STATUS_CODE_ERROR" ? 2 : statusCode === "ok" || statusCode === "STATUS_CODE_OK" ? 1 : 0,
    };

    const otlpAttributes = Object.entries(attributes).map(([key, value]) => ({
      key,
      value: typeof value === "number"
        ? { intValue: String(Math.floor(value)) }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { stringValue: String(value ?? "") },
    }));

    // Add standard OTLP attributes
    otlpAttributes.push(
      { key: "agentos.session_id", value: { stringValue: String(event.session_id || "") } },
      { key: "agentos.event_type", value: { stringValue: String(event.event_type || "") } },
    );

    const span = {
      traceId: hexTraceId,
      spanId,
      parentSpanId: parentSpanId || undefined,
      name: String(event.event_name || event.event_type || "span"),
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano,
      endTimeUnixNano,
      attributes: otlpAttributes,
      status: otlpStatus,
    };

    if (!resourceSpansMap.has(agentName)) {
      resourceSpansMap.set(agentName, []);
    }
    resourceSpansMap.get(agentName)!.push(span);
  }

  // If no runtime_events exist, synthesize spans from sessions + turns
  if (events.length === 0) {
    for (const session of sessions) {
      const agentName = String(session.agent_name);
      const sessionSpanId = genId() + genId().slice(0, 4);
      const startNs = String(BigInt(Math.floor(Number(session.created_at || 0) * 1e9)));
      const endNs = String(BigInt(Math.floor((Number(session.created_at || 0) + Number(session.wall_clock_seconds || 0)) * 1e9)));

      const sessionSpan = {
        traceId: hexTraceId,
        spanId: sessionSpanId.padEnd(16, "0").slice(0, 16),
        name: `session:${String(session.session_id).slice(0, 8)}`,
        kind: 1,
        startTimeUnixNano: startNs,
        endTimeUnixNano: endNs,
        attributes: [
          { key: "agentos.session_id", value: { stringValue: String(session.session_id) } },
          { key: "agentos.agent_name", value: { stringValue: agentName } },
          { key: "agentos.status", value: { stringValue: String(session.status || "") } },
          { key: "agentos.version", value: { stringValue: String(session.version || "") } },
        ],
        status: { code: session.status === "success" ? 1 : session.status === "error" ? 2 : 0 },
      };

      if (!resourceSpansMap.has(agentName)) {
        resourceSpansMap.set(agentName, []);
      }
      resourceSpansMap.get(agentName)!.push(sessionSpan);

      // Add turn-level child spans
      const sessionTurns = (turns as any[]).filter((t: any) => t.session_id === session.session_id);
      for (const turn of sessionTurns) {
        const turnSpanId = genId() + genId().slice(0, 4);
        const turnStartNs = String(BigInt(Math.floor(Number(turn.created_at || session.created_at || 0) * 1e9)));

        const turnAttrs: any[] = [
          { key: "agentos.turn_number", value: { intValue: String(Number(turn.turn_number || 0)) } },
          { key: "agentos.session_id", value: { stringValue: String(session.session_id) } },
        ];

        if (turn.error) {
          turnAttrs.push({ key: "error.message", value: { stringValue: String(turn.error).slice(0, 500) } });
        }

        let toolCalls: any[] = [];
        try { toolCalls = JSON.parse(String(turn.tool_calls_json || "[]")); } catch {}
        if (toolCalls.length > 0) {
          turnAttrs.push({ key: "agentos.tool_call_count", value: { intValue: String(toolCalls.length) } });
          turnAttrs.push({ key: "agentos.tool_names", value: { stringValue: toolCalls.map((tc: any) => tc.name || tc.tool || "").join(",") } });
        }

        resourceSpansMap.get(agentName)!.push({
          traceId: hexTraceId,
          spanId: turnSpanId.padEnd(16, "0").slice(0, 16),
          parentSpanId: sessionSpan.spanId,
          name: `turn:${turn.turn_number}`,
          kind: 1,
          startTimeUnixNano: turnStartNs,
          endTimeUnixNano: turnStartNs, // No separate end time for turns
          attributes: turnAttrs,
          status: { code: turn.error ? 2 : 1 },
        });
      }
    }
  }

  // Build OTLP JSON response
  const resourceSpans = [...resourceSpansMap.entries()].map(([agentName, spans]) => ({
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: `agentos-agent-${agentName}` } },
        { key: "service.version", value: { stringValue: "0.2.0" } },
        { key: "agentos.agent_name", value: { stringValue: agentName } },
        { key: "agentos.org_id", value: { stringValue: user.org_id } },
      ],
    },
    scopeSpans: [
      {
        scope: {
          name: "agentos",
          version: "0.2.0",
        },
        spans,
      },
    ],
  }));

  return c.json({
    resourceSpans,
  });
});
