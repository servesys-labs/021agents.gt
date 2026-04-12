import type { SignalEnvelope } from "./signals";

export interface MemorySignalCluster {
  feature: "memory";
  signature: string;
  signal_type: SignalEnvelope["signal_type"];
  topic: string;
  count: number;
  distinct_sessions: number;
  first_seen_ms: number;
  last_seen_ms: number;
  max_severity: number;
  sample_summaries: string[];
  entities: string[];
}

export interface MemorySignalAction {
  workflow_kind: "digest" | "consolidate";
  signature: string;
  dedupe_key: string;
  cooldown_ms: number;
  topic: string;
  summary: string;
  briefing: string;
}

export interface EvaluateMemoryRulesInput {
  nowMs: number;
  clusters: MemorySignalCluster[];
  activeCooldowns: Set<string>;
}

const HOUR_MS = 3_600_000;

export function evaluateMemorySignalRules(input: EvaluateMemoryRulesInput): MemorySignalAction[] {
  const actions: MemorySignalAction[] = [];

  for (const cluster of input.clusters) {
    const ageMs = Math.max(0, input.nowMs - cluster.last_seen_ms);
    const recent = ageMs <= 24 * HOUR_MS;
    if (!recent) continue;

    if (cluster.signal_type === "loop_detected" && cluster.count >= 2) {
      actions.push(makeAction(
        "consolidate",
        cluster,
        6 * HOUR_MS,
        `Repeated loop detections around ${cluster.topic || "the same workflow"} across ${cluster.distinct_sessions} session(s).`,
      ));
      continue;
    }

    if (cluster.signal_type === "memory_write_rejected" && cluster.count >= 2) {
      actions.push(makeAction(
        "consolidate",
        cluster,
        6 * HOUR_MS,
        `Memory write rejections are recurring for ${cluster.topic || "the same entity"}, suggesting contradiction churn or unstable memory shape.`,
      ));
      continue;
    }

    if (cluster.signal_type === "memory_contradiction" && cluster.count >= 2) {
      actions.push(makeAction(
        "consolidate",
        cluster,
        8 * HOUR_MS,
        `Assistant corrections keep recurring for ${cluster.topic || "the same topic"}, so memory consolidation should reconcile drift.`,
      ));
      continue;
    }

    if (cluster.signal_type === "tool_failure" && cluster.count >= 3) {
      actions.push(makeAction(
        "digest",
        cluster,
        3 * HOUR_MS,
        `Repeated tool failures around ${cluster.topic || "the same topic"} across ${cluster.distinct_sessions} session(s).`,
      ));
      continue;
    }

    if (cluster.signal_type === "topic_recurrence" && cluster.distinct_sessions >= 3) {
      actions.push(makeAction(
        "digest",
        cluster,
        12 * HOUR_MS,
        `Recurring topic ${cluster.topic || "unknown"} appeared across ${cluster.distinct_sessions} sessions and should be digested into durable memory.`,
      ));
    }
  }

  return actions;
}

export function summarizeMemoryCluster(envelopes: SignalEnvelope[]): MemorySignalCluster | null {
  if (!envelopes.length) return null;
  const sorted = [...envelopes].sort((a, b) => a.created_at_ms - b.created_at_ms);
  const sessions = new Set<string>();
  const entities = new Set<string>();
  const summaries: string[] = [];
  let maxSeverity = 0;

  for (const envelope of sorted) {
    if (envelope.session_id) sessions.add(envelope.session_id);
    for (const entity of envelope.entities || []) entities.add(entity);
    if (summaries.length < 3 && envelope.summary) summaries.push(envelope.summary);
    maxSeverity = Math.max(maxSeverity, envelope.severity || 0);
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    feature: "memory",
    signature: first.signature,
    signal_type: first.signal_type,
    topic: first.topic,
    count: sorted.length,
    distinct_sessions: sessions.size,
    first_seen_ms: first.created_at_ms,
    last_seen_ms: last.created_at_ms,
    max_severity: maxSeverity,
    sample_summaries: summaries,
    entities: [...entities].slice(0, 6),
  };
}

export function cooldownKey(signalType: string, signature: string): string {
  return `${signalType}:${signature}`;
}

function makeAction(
  workflowKind: "digest" | "consolidate",
  cluster: MemorySignalCluster,
  cooldownMs: number,
  lead: string,
): MemorySignalAction {
  const samples = cluster.sample_summaries.map((summary) => `- ${summary}`).join("\n");
  const entities = cluster.entities.length ? ` Entities: ${cluster.entities.join(", ")}.` : "";
  return {
    workflow_kind: workflowKind,
    signature: cluster.signature,
    dedupe_key: cooldownKey(cluster.signal_type, cluster.signature),
    cooldown_ms: cooldownMs,
    topic: cluster.topic,
    summary: lead,
    briefing: [
      lead,
      `Signal type: ${cluster.signal_type}. Count: ${cluster.count}. Distinct sessions: ${cluster.distinct_sessions}.`,
      entities.trim(),
      samples ? `Recent examples:\n${samples}` : "",
    ].filter(Boolean).join(" "),
  };
}
