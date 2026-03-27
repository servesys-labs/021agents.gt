/**
 * Normalized incident model for observability / SLO alert pipeline (integrity, loop, circuit-breaker signals).
 */

export type IncidentKind = "integrity_breach" | "loop_halt" | "loop_warn" | "circuit_block";

export type IncidentSeverity = "critical" | "high" | "medium" | "low" | "info";

export type IncidentSignalSource = "audit_log" | "middleware_events" | "runtime_events";

export interface IncidentSuppressionMeta {
  dedupe_window_sec: number;
  is_primary: boolean;
  /** Same fingerprint as a newer incident within dedupe_window_sec of the newest in that group */
  is_duplicate: boolean;
}

export interface ObservabilityIncident {
  incident_key: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  status: "open";
  opened_at: string;
  trace_id: string | null;
  session_id: string | null;
  signal_source: IncidentSignalSource;
  title: string;
  details: Record<string, unknown>;
  dedupe_fingerprint: string;
  suppression: IncidentSuppressionMeta;
}

const SEVERITY_ORDER: Record<IncidentSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function compareSeverity(a: IncidentSeverity, b: IncidentSeverity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

/** Map audit_log trace.integrity_breach payload to severity. */
export function severityFromIntegrityPayload(details: Record<string, unknown>): IncidentSeverity {
  const strict = Boolean(details.strict);
  const missingTurns = Number(details.missing_turns || 0);
  const missingEvents = Number(details.missing_runtime_events || 0);
  const missingBilling = Number(details.missing_billing_records || 0);
  const lifecycleMismatch = Number(details.lifecycle_mismatch || 0);

  if (strict) return "critical";
  if (lifecycleMismatch > 0 || missingTurns > 0) return "high";
  if (missingEvents > 0) return "medium";
  if (missingBilling > 0) return "low";
  return "info";
}

export function fingerprintForIncident(kind: IncidentKind, traceId: string | null, sessionId: string | null): string {
  return `${kind}:${traceId || "none"}:${sessionId || "none"}`;
}

function hashKey(parts: string[]): string {
  return parts.join("|").slice(0, 200);
}

export function buildIntegrityIncident(params: {
  traceId: string;
  sessionId: string | null;
  openedAt: string;
  userId: string;
  details: Record<string, unknown>;
}): ObservabilityIncident {
  const severity = severityFromIntegrityPayload(params.details);
  const kind: IncidentKind = "integrity_breach";
  const fp = fingerprintForIncident(kind, params.traceId, params.sessionId);
  return {
    incident_key: hashKey(["integrity", params.traceId, params.openedAt, String(params.userId)]),
    kind,
    severity,
    status: "open",
    opened_at: params.openedAt,
    trace_id: params.traceId,
    session_id: params.sessionId,
    signal_source: "audit_log",
    title: "Trace integrity breach",
    details: {
      ...params.details,
      user_id: params.userId,
    },
    dedupe_fingerprint: fp,
    suppression: {
      dedupe_window_sec: 0,
      is_primary: true,
      is_duplicate: false,
    },
  };
}

export function buildLoopIncident(params: {
  eventType: "loop_halt" | "loop_warn";
  openedAt: string;
  traceId: string | null;
  sessionId: string;
  details: Record<string, unknown>;
}): ObservabilityIncident {
  const kind: IncidentKind = params.eventType === "loop_halt" ? "loop_halt" : "loop_warn";
  const severity: IncidentSeverity = params.eventType === "loop_halt" ? "critical" : "medium";
  const fp = fingerprintForIncident(kind, params.traceId, params.sessionId);
  return {
    incident_key: hashKey(["loop", params.eventType, params.sessionId || "", params.openedAt]),
    kind,
    severity,
    status: "open",
    opened_at: params.openedAt,
    trace_id: params.traceId,
    session_id: params.sessionId,
    signal_source: "middleware_events",
    title: params.eventType === "loop_halt" ? "Loop detection halt" : "Loop detection warning",
    details: params.details,
    dedupe_fingerprint: fp,
    suppression: {
      dedupe_window_sec: 0,
      is_primary: true,
      is_duplicate: false,
    },
  };
}

export function buildCircuitIncident(params: {
  openedAt: string;
  traceId: string | null;
  sessionId: string;
  details: Record<string, unknown>;
}): ObservabilityIncident {
  const kind: IncidentKind = "circuit_block";
  const severity: IncidentSeverity = "high";
  const fp = fingerprintForIncident(kind, params.traceId, params.sessionId);
  return {
    incident_key: hashKey(["circuit", params.sessionId || "", params.openedAt]),
    kind,
    severity,
    status: "open",
    opened_at: params.openedAt,
    trace_id: params.traceId,
    session_id: params.sessionId,
    signal_source: "runtime_events",
    title: "Tool circuit breaker blocked execution",
    details: params.details,
    dedupe_fingerprint: fp,
    suppression: {
      dedupe_window_sec: 0,
      is_primary: true,
      is_duplicate: false,
    },
  };
}

/**
 * Within each dedupe_fingerprint group, sort by time and chunk so each cluster's span
 * (max_ts - min_ts) <= dedupe_window_sec. The newest row in a cluster is primary; others are duplicates.
 */
export function applyDedupeWindow(incidents: ObservabilityIncident[], dedupeWindowSec: number): ObservabilityIncident[] {
  if (dedupeWindowSec <= 0) {
    return incidents.map((i) => ({
      ...i,
      suppression: { ...i.suppression, dedupe_window_sec: dedupeWindowSec, is_primary: true, is_duplicate: false },
    }));
  }

  const windowMs = dedupeWindowSec * 1000;
  const byFp = new Map<string, ObservabilityIncident[]>();

  for (const inc of incidents) {
    const list = byFp.get(inc.dedupe_fingerprint) ?? [];
    list.push(inc);
    byFp.set(inc.dedupe_fingerprint, list);
  }

  const out: ObservabilityIncident[] = [];

  for (const [, group] of byFp) {
    const sorted = [...group].sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at));
    const clusters: ObservabilityIncident[][] = [];
    let cur: ObservabilityIncident[] = [];

    for (const inc of sorted) {
      const t = Date.parse(inc.opened_at);
      if (cur.length === 0) {
        cur = [inc];
        continue;
      }
      const minTs = Date.parse(cur[0]!.opened_at);
      if (t - minTs <= windowMs) {
        cur.push(inc);
      } else {
        clusters.push(cur);
        cur = [inc];
      }
    }
    if (cur.length > 0) clusters.push(cur);

    for (const cl of clusters) {
      const newest = cl[cl.length - 1]!;
      for (const inc of cl) {
        const isPrimary = inc.incident_key === newest.incident_key;
        out.push({
          ...inc,
          suppression: {
            dedupe_window_sec: dedupeWindowSec,
            is_primary: isPrimary,
            is_duplicate: !isPrimary,
          },
        });
      }
    }
  }

  return out.sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
}

export function filterIncidentKinds(incidents: ObservabilityIncident[], kinds: Set<IncidentKind> | null): ObservabilityIncident[] {
  if (!kinds || kinds.size === 0) return incidents;
  return incidents.filter((i) => kinds.has(i.kind));
}
