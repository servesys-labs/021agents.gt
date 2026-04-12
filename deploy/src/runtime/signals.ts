import { createHash } from "node:crypto";

export type SignalFeature = "memory" | "approvals" | "evolve" | "release" | "incidents";

export type SignalType =
  | "tool_failure"
  | "loop_detected"
  | "memory_write_rejected"
  | "memory_contradiction"
  | "topic_recurrence";

export interface SignalEnvelope {
  id: string;
  feature: SignalFeature;
  signal_type: SignalType;
  source_type: "runtime_event" | "turn" | "loop_detected" | "artifact_manifest";
  org_id: string;
  agent_name: string;
  session_id: string;
  created_at_ms: number;
  signature: string;
  topic: string;
  summary: string;
  severity: number;
  entities: string[];
  metadata: Record<string, unknown>;
}

export interface SignalEnvelopeMessage {
  type: "signal_envelope";
  payload: SignalEnvelope;
}

type JsonRecord = Record<string, any>;

const TOPIC_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "we", "with",
  "you", "your",
]);

export function getQueuePayload(body: Record<string, unknown> | null | undefined): JsonRecord {
  if (!body || typeof body !== "object") return {};
  const typed = body as JsonRecord;
  if (typed.payload && typeof typed.payload === "object") return typed.payload as JsonRecord;
  const clone: JsonRecord = { ...typed };
  delete clone.type;
  return clone;
}

export function deriveSignalEnvelopes(type: string, rawPayload: Record<string, unknown>): SignalEnvelope[] {
  const payload = rawPayload as JsonRecord;
  if (!type) return [];
  if (type === "runtime_event") return deriveRuntimeEventSignals(payload);
  if (type === "turn") return deriveTurnSignals(payload);
  if (type === "loop_detected") return deriveLoopSignals(payload);
  if (type === "artifact_manifest") return deriveArtifactSignals(payload);
  return [];
}

export function buildSignalCoordinatorKey(feature: SignalFeature, orgId: string, agentName: string): string {
  return `${orgId || "global"}:${agentName || "agentos"}:${feature}`;
}

export function signalEnvelopeMessage(envelope: SignalEnvelope): SignalEnvelopeMessage {
  return { type: "signal_envelope", payload: envelope };
}

function deriveRuntimeEventSignals(payload: JsonRecord): SignalEnvelope[] {
  const eventType = String(payload.event_type || "");
  const details = parseStructured(payload.details);
  const orgId = String(payload.org_id || "");
  const agentName = String(payload.agent_name || "");
  const sessionId = String(payload.session_id || details.session_id || "");
  const createdAtMs = coerceTimestamp(payload.created_at);

  if (eventType === "tool_exec" && String(payload.status || "") === "error") {
    const toolName = String(details.tool || payload.node_id || "unknown");
    const topic = normalizeTopic(
      details.query || details.key || details.path || details.url || details.entity || toolName,
    );
    return [
      createEnvelope({
        feature: "memory",
        signalType: "tool_failure",
        sourceType: "runtime_event",
        orgId,
        agentName,
        sessionId,
        createdAtMs,
        signatureParts: ["tool_failure", toolName, topic],
        topic,
        summary: `Tool failure cluster candidate for ${toolName}${topic ? ` around ${topic}` : ""}`,
        severity: 0.8,
        entities: compactEntities([toolName, ...(Array.isArray(details.entities) ? details.entities : [])]),
        metadata: {
          event_type: eventType,
          tool: toolName,
          status: payload.status || "",
          duration_ms: Number(payload.duration_ms || 0),
        },
      }),
    ];
  }

  if (eventType === "memory_write_rejected") {
    const target = String(details.target || "memory");
    const topic = normalizeTopic(details.key || details.entity || details.error || target);
    return [
      createEnvelope({
        feature: "memory",
        signalType: "memory_write_rejected",
        sourceType: "runtime_event",
        orgId,
        agentName,
        sessionId,
        createdAtMs,
        signatureParts: ["memory_write_rejected", target, topic],
        topic,
        summary: `Memory write rejection for ${target}${topic ? ` around ${topic}` : ""}`,
        severity: 0.75,
        entities: compactEntities([target, ...(Array.isArray(details.entities) ? details.entities : [])]),
        metadata: {
          event_type: eventType,
          error: String(details.error || ""),
          action: String(details.action || ""),
        },
      }),
    ];
  }

  return [];
}

function deriveTurnSignals(payload: JsonRecord): SignalEnvelope[] {
  const orgId = String(payload.org_id || "");
  const agentName = String(payload.agent_name || "");
  const sessionId = String(payload.session_id || "");
  const createdAtMs = coerceTimestamp(payload.created_at);
  const envelopes: SignalEnvelope[] = [];
  const toolCalls = parseJsonArray(payload.tool_calls);
  const toolResults = parseJsonArray(payload.tool_results);
  const llmContent = compactText(String(payload.llm_content || payload.output_text || ""), 320);

  const toolCallById = new Map<string, JsonRecord>();
  for (const raw of toolCalls) {
    const item = raw as JsonRecord;
    toolCallById.set(String(item.id || item.tool_call_id || ""), item);
  }

  for (const raw of toolResults) {
    const result = raw as JsonRecord;
    if (!result.error) continue;
    const toolName = String(result.tool || result.name || "unknown");
    const toolCall = toolCallById.get(String(result.tool_call_id || "")) || {};
    const args = parseStructured(toolCall.arguments || toolCall.args || {});
    const topic = normalizeTopic(
      args.query || args.key || args.path || args.url || args.agent_name || llmContent || toolName,
    );
    envelopes.push(createEnvelope({
      feature: "memory",
      signalType: "tool_failure",
      sourceType: "turn",
      orgId,
      agentName,
      sessionId,
      createdAtMs,
      signatureParts: ["tool_failure", toolName, topic],
      topic,
      summary: `Turn carried ${toolName} failure${topic ? ` around ${topic}` : ""}`,
      severity: 0.85,
      entities: compactEntities([toolName, args.agent_name, ...(Array.isArray(args.entities) ? args.entities : [])]),
      metadata: {
        tool: toolName,
        error: compactText(String(result.error || ""), 180),
        turn_number: Number(payload.turn_number || 0),
      },
    }));
  }

  const contradictionTopic = extractContradictionTopic(llmContent);
  if (contradictionTopic) {
    envelopes.push(createEnvelope({
      feature: "memory",
      signalType: "memory_contradiction",
      sourceType: "turn",
      orgId,
      agentName,
      sessionId,
      createdAtMs,
      signatureParts: ["memory_contradiction", contradictionTopic],
      topic: contradictionTopic,
      summary: `Assistant emitted a correction/contradiction about ${contradictionTopic}`,
      severity: 0.7,
      entities: compactEntities(extractEntitiesFromText(llmContent)),
      metadata: {
        turn_number: Number(payload.turn_number || 0),
        sample: llmContent,
      },
    }));
  }

  const recurrenceTopic = deriveTopicFromTurn(toolCalls, llmContent);
  if (recurrenceTopic) {
    envelopes.push(createEnvelope({
      feature: "memory",
      signalType: "topic_recurrence",
      sourceType: "turn",
      orgId,
      agentName,
      sessionId,
      createdAtMs,
      signatureParts: ["topic_recurrence", recurrenceTopic],
      topic: recurrenceTopic,
      summary: `Recurring topic candidate: ${recurrenceTopic}`,
      severity: 0.55,
      entities: compactEntities(extractEntitiesFromText(recurrenceTopic)),
      metadata: {
        turn_number: Number(payload.turn_number || 0),
      },
    }));
  }

  return dedupeEnvelopes(envelopes);
}

function deriveLoopSignals(payload: JsonRecord): SignalEnvelope[] {
  const topic = normalizeTopic(payload.tool || payload.agent_name || "loop");
  return [
    createEnvelope({
      feature: "memory",
      signalType: "loop_detected",
      sourceType: "loop_detected",
      orgId: String(payload.org_id || ""),
      agentName: String(payload.agent_name || ""),
      sessionId: String(payload.session_id || ""),
      createdAtMs: coerceTimestamp(payload.created_at),
      signatureParts: ["loop_detected", topic],
      topic,
      summary: `Loop detected for ${topic}`,
      severity: 0.95,
      entities: compactEntities([payload.tool]),
      metadata: {
        repeat_count: Number(payload.repeat_count || 0),
        turn: Number(payload.turn || 0),
      },
    }),
  ];
}

function deriveArtifactSignals(_payload: JsonRecord): SignalEnvelope[] {
  return [];
}

function deriveTopicFromTurn(toolCalls: unknown[], llmContent: string): string {
  for (const raw of toolCalls) {
    const item = raw as JsonRecord;
    const args = parseStructured(item.arguments || item.args || {});
    const topic = normalizeTopic(args.query || args.key || args.path || args.url || "");
    if (topic) return topic;
  }
  return normalizeTopic(llmContent);
}

function extractContradictionTopic(text: string): string {
  const lower = text.toLowerCase();
  const markers = [
    "actually ",
    "correction:",
    "to clarify",
    "i was wrong",
    "instead,",
    "notably, i should correct",
  ];
  const marker = markers.find((entry) => lower.includes(entry));
  if (!marker) return "";
  const idx = lower.indexOf(marker);
  return normalizeTopic(text.slice(idx + marker.length, idx + marker.length + 120));
}

function extractEntitiesFromText(text: string): string[] {
  const matches = String(text || "").match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [];
  return compactEntities(matches);
}

function createEnvelope(input: {
  feature: SignalFeature;
  signalType: SignalType;
  sourceType: SignalEnvelope["source_type"];
  orgId: string;
  agentName: string;
  sessionId: string;
  createdAtMs: number;
  signatureParts: Array<string | number>;
  topic: string;
  summary: string;
  severity: number;
  entities: string[];
  metadata: Record<string, unknown>;
}): SignalEnvelope {
  const signature = hashParts(input.signatureParts);
  const createdAtMs = Number.isFinite(input.createdAtMs) ? input.createdAtMs : Date.now();
  return {
    id: hashParts([
      input.feature,
      input.signalType,
      input.orgId,
      input.agentName,
      input.sessionId,
      signature,
      createdAtMs,
    ]),
    feature: input.feature,
    signal_type: input.signalType,
    source_type: input.sourceType,
    org_id: input.orgId,
    agent_name: input.agentName,
    session_id: input.sessionId,
    created_at_ms: createdAtMs,
    signature,
    topic: input.topic,
    summary: compactText(input.summary, 280),
    severity: clamp(input.severity, 0, 1),
    entities: input.entities,
    metadata: input.metadata,
  };
}

function dedupeEnvelopes(envelopes: SignalEnvelope[]): SignalEnvelope[] {
  const seen = new Set<string>();
  const out: SignalEnvelope[] = [];
  for (const envelope of envelopes) {
    if (seen.has(envelope.id)) continue;
    seen.add(envelope.id);
    out.push(envelope);
  }
  return out;
}

function parseStructured(value: unknown): JsonRecord {
  if (!value) return {};
  if (typeof value === "object") return value as JsonRecord;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactEntities(input: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const value = String(item || "").trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (normalized.length < 3 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value.slice(0, 80));
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeTopic(input: unknown): string {
  const raw = compactText(String(input || ""), 240);
  let urlParts = "";
  try {
    const parsed = new URL(raw);
    urlParts = `${parsed.hostname} ${parsed.pathname}`;
  } catch {}
  const text = `${urlParts} ${raw}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s/_-]+/g, " ");
  const tokens = text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TOPIC_STOPWORDS.has(token));
  return tokens.slice(0, 8).join(" ");
}

function compactText(input: string, limit: number): string {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function hashParts(parts: Array<string | number>): string {
  const raw = parts.map((part) => String(part || "")).join("|");
  return createHash("sha1").update(raw).digest("hex");
}

function coerceTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return Date.now();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
