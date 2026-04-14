/**
 * Telemetry — comprehensive OTEL event emission for the entire platform.
 *
 * Every component (Think agent, AgentSupervisor, channels, gateway) imports
 * this module to emit telemetry consistently. Events flow to three sinks:
 *
 * 1. Analytics Engine (ANALYTICS) — high-volume metrics, instant, queryable
 * 2. Telemetry Queue (TELEMETRY_QUEUE) — async → Hyperdrive → Postgres
 * 3. AgentSupervisor DO SQLite — per-org real-time queryable by Meta Agent
 *
 * The Meta Agent sees ALL events — zero blind spots.
 *
 * CF primitives used:
 * - Analytics Engine: writeDataPoint() for high-volume metrics
 * - CF Queues: send() for async Postgres writes
 * - DO SQLite: direct INSERT for per-org real-time queries
 */

// ── Event Types (from runtime/events.ts canonical registry) ──────

export type TelemetryEventType =
  // Session lifecycle
  | "session.started"
  | "session.completed"
  | "session.failed"
  | "session.timeout"
  // Turn lifecycle
  | "turn.started"
  | "turn.completed"
  | "turn.error"
  | "turn.refusal"
  | "turn.compacted"
  // Tool execution
  | "tool.called"
  | "tool.completed"
  | "tool.failed"
  | "tool.approval_requested"
  | "tool.approval_granted"
  | "tool.approval_denied"
  // LLM
  | "llm.request"
  | "llm.response"
  | "llm.fallback"
  | "llm.cache_hit"
  | "llm.error"
  // Memory
  | "memory.context_loaded"
  | "memory.context_written"
  | "memory.compaction"
  | "memory.skill_activated"
  | "memory.skill_deactivated"
  // Channels
  | "channel.message_received"
  | "channel.message_sent"
  | "channel.error"
  // Delegation
  | "delegation.started"
  | "delegation.completed"
  | "delegation.failed"
  // Security
  | "security.guardrail_triggered"
  | "security.input_blocked"
  | "security.output_filtered"
  | "security.anomaly_detected"
  // Billing
  | "billing.deducted"
  | "billing.insufficient"
  | "billing.hold_created"
  | "billing.hold_settled"
  // MCP
  | "mcp.server_connected"
  | "mcp.server_disconnected"
  | "mcp.tool_discovered"
  // Agent lifecycle
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "agent.skill_added"
  | "agent.skill_removed"
  | "agent.channel_deployed"
  // Meta Agent
  | "meta.suggestion_generated"
  | "meta.eval_run"
  | "meta.bulk_update";

// ── Event Payload ────────────────────────────────────────────────

export interface TelemetryEvent {
  type: TelemetryEventType;
  agentId?: string;
  agentName?: string;
  orgId?: string;
  sessionId?: string;
  traceId?: string;
  turnNumber?: number;
  channel?: string;
  userId?: string;
  // Metrics
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  // Tool-specific
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolError?: string;
  // LLM-specific
  model?: string;
  provider?: string;
  stopReason?: string;
  refusal?: boolean;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  // Channel-specific
  platform?: string;
  messageLength?: number;
  // Security
  severity?: "critical" | "high" | "medium" | "low" | "info";
  ruleName?: string;
  // Delegation
  parentSessionId?: string;
  childSessionId?: string;
  childAgentName?: string;
  depth?: number;
  // Generic
  metadata?: Record<string, unknown>;
  error?: string;
  timestamp?: string;
}

// ── Telemetry Emitter ────────────────────────────────────────────

export interface TelemetryBindings {
  ANALYTICS?: AnalyticsEngineDataset;
  TELEMETRY_QUEUE?: Queue;
}

/**
 * Emit a telemetry event to all three sinks.
 *
 * Non-blocking — never throws, never blocks the hot path.
 * Call this from any component: Think hooks, supervisor, channels.
 */
export function emit(env: TelemetryBindings, event: TelemetryEvent): void {
  const ts = event.timestamp || new Date().toISOString();

  // ── Sink 1: Analytics Engine (instant, high-volume) ──
  // blob1=eventType, blob2=agentName, blob3=channel, blob4=model
  // double1=latencyMs, double2=costUsd, double3=inputTokens, double4=outputTokens
  // index1=orgId (for per-org queries)
  if (env.ANALYTICS) {
    try {
      env.ANALYTICS.writeDataPoint({
        blobs: [
          event.type,
          event.agentName || "",
          event.channel || "",
          event.model || "",
          event.toolName || "",
          event.error?.slice(0, 100) || "",
        ],
        doubles: [
          event.latencyMs || 0,
          event.costUsd || 0,
          event.inputTokens || 0,
          event.outputTokens || 0,
          event.turnNumber || 0,
          event.depth || 0,
        ],
        indexes: [event.orgId || event.agentName || "unknown"],
      });
    } catch {} // never block
  }

  // ── Sink 2: Telemetry Queue (async → Postgres) ──
  // Only for events that need durable storage in Postgres.
  // High-frequency events (llm.request, tool.called) go to AE only.
  if (env.TELEMETRY_QUEUE && shouldQueueToPostgres(event.type)) {
    try {
      const queueEvent = mapToQueueEvent(event, ts);
      if (queueEvent) {
        env.TELEMETRY_QUEUE.send(queueEvent).catch(() => {});
      }
    } catch {} // never block
  }
}

/**
 * Which events are worth persisting to Postgres?
 * High-frequency events (every LLM token) → Analytics Engine only.
 * Session-level events → Postgres for relational queries.
 */
function shouldQueueToPostgres(type: TelemetryEventType): boolean {
  const postgresEvents = new Set<TelemetryEventType>([
    "session.started", "session.completed", "session.failed", "session.timeout",
    "turn.completed", "turn.error", "turn.refusal",
    "tool.completed", "tool.failed",
    "billing.deducted", "billing.insufficient",
    "delegation.started", "delegation.completed", "delegation.failed",
    "security.guardrail_triggered", "security.input_blocked", "security.anomaly_detected",
    "agent.created", "agent.updated", "agent.deleted",
    "channel.error",
    "meta.eval_run",
  ]);
  return postgresEvents.has(type);
}

/**
 * Map a TelemetryEvent to the queue payload format expected by the consumer.
 */
function mapToQueueEvent(event: TelemetryEvent, ts: string): { type: string; payload: Record<string, unknown> } | null {
  const base = {
    org_id: event.orgId || "",
    agent_name: event.agentName || "",
    session_id: event.sessionId || "",
    trace_id: event.traceId || "",
    created_at: ts,
  };

  switch (event.type) {
    case "session.started":
    case "session.completed":
    case "session.failed":
    case "session.timeout":
      return {
        type: "session",
        payload: {
          ...base,
          model: event.model || "",
          status: event.type === "session.completed" ? "completed"
            : event.type === "session.failed" ? "failed"
            : event.type === "session.timeout" ? "timeout" : "running",
          input_text: "",
          output_text: "",
          cost_usd: event.costUsd || 0,
          wall_clock_seconds: (event.latencyMs || 0) / 1000,
          step_count: event.turnNumber || 0,
          action_count: 0,
          channel: event.channel || "web",
          termination_reason: event.stopReason || event.type.split(".")[1],
        },
      };

    case "turn.completed":
    case "turn.error":
    case "turn.refusal":
      return {
        type: "turn",
        payload: {
          ...base,
          turn_number: event.turnNumber || 0,
          model: event.model || "",
          input_tokens: event.inputTokens || 0,
          output_tokens: event.outputTokens || 0,
          latency_ms: event.latencyMs || 0,
          cost_usd: event.costUsd || 0,
          tool_calls: [],
          stop_reason: event.stopReason || "",
          refusal: event.refusal || false,
          cache_read_tokens: event.cacheReadTokens || 0,
          cache_write_tokens: event.cacheWriteTokens || 0,
        },
      };

    case "tool.completed":
    case "tool.failed":
      return {
        type: "tool_execution",
        payload: {
          ...base,
          tool_name: event.toolName || "",
          input: event.toolInput || {},
          output: event.toolOutput || {},
          latency_ms: event.latencyMs || 0,
          error: event.toolError || event.error || null,
        },
      };

    case "billing.deducted":
    case "billing.insufficient":
      return {
        type: "billing",
        payload: {
          ...base,
          model: event.model || "",
          provider: event.provider || "workers-ai",
          input_tokens: event.inputTokens || 0,
          output_tokens: event.outputTokens || 0,
          cost_usd: event.costUsd || 0,
        },
      };

    case "delegation.started":
    case "delegation.completed":
    case "delegation.failed":
      return {
        type: "event",
        payload: {
          ...base,
          event_type: event.type,
          parent_session_id: event.parentSessionId,
          child_session_id: event.childSessionId,
          child_agent_name: event.childAgentName,
          depth: event.depth || 0,
          cost_usd: event.costUsd || 0,
        },
      };

    case "security.guardrail_triggered":
    case "security.input_blocked":
    case "security.anomaly_detected":
      return {
        type: "event",
        payload: {
          ...base,
          event_type: event.type,
          severity: event.severity || "info",
          rule_name: event.ruleName || "",
          error: event.error || "",
        },
      };

    case "agent.created":
    case "agent.updated":
    case "agent.deleted":
      return {
        type: "event",
        payload: {
          ...base,
          event_type: event.type,
          ...event.metadata,
        },
      };

    case "channel.error":
      return {
        type: "event",
        payload: {
          ...base,
          event_type: event.type,
          platform: event.platform || "",
          error: event.error || "",
        },
      };

    case "meta.eval_run":
      return {
        type: "event",
        payload: {
          ...base,
          event_type: event.type,
          ...event.metadata,
        },
      };

    default:
      return null;
  }
}

// ── Helper: emit from Think lifecycle hooks ──────────────────────

/**
 * Create a telemetry emitter bound to a specific agent context.
 * Call once in the agent constructor, use throughout the lifecycle.
 */
export function createAgentEmitter(
  env: TelemetryBindings,
  agentName: string,
  orgId?: string,
) {
  return {
    sessionStarted: (sessionId: string, model: string, channel: string) =>
      emit(env, { type: "session.started", agentName, orgId, sessionId, model, channel }),

    sessionCompleted: (sessionId: string, opts: { costUsd: number; latencyMs: number; turnNumber: number; stopReason: string; model: string }) =>
      emit(env, { type: "session.completed", agentName, orgId, sessionId, ...opts }),

    sessionFailed: (sessionId: string, error: string) =>
      emit(env, { type: "session.failed", agentName, orgId, sessionId, error }),

    turnCompleted: (sessionId: string, opts: { turnNumber: number; model: string; inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number; stopReason?: string; cacheReadTokens?: number; cacheWriteTokens?: number }) =>
      emit(env, { type: "turn.completed", agentName, orgId, sessionId, ...opts }),

    turnRefusal: (sessionId: string, turnNumber: number) =>
      emit(env, { type: "turn.refusal", agentName, orgId, sessionId, turnNumber, refusal: true }),

    toolCalled: (sessionId: string, toolName: string) =>
      emit(env, { type: "tool.called", agentName, orgId, sessionId, toolName }),

    toolCompleted: (sessionId: string, toolName: string, opts: { latencyMs: number; costUsd?: number }) =>
      emit(env, { type: "tool.completed", agentName, orgId, sessionId, toolName, ...opts }),

    toolFailed: (sessionId: string, toolName: string, error: string) =>
      emit(env, { type: "tool.failed", agentName, orgId, sessionId, toolName, toolError: error }),

    llmRequest: (sessionId: string, model: string) =>
      emit(env, { type: "llm.request", agentName, orgId, sessionId, model }),

    llmResponse: (sessionId: string, opts: { model: string; inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number }) =>
      emit(env, { type: "llm.response", agentName, orgId, sessionId, ...opts }),

    llmFallback: (sessionId: string, fromModel: string, toModel: string) =>
      emit(env, { type: "llm.fallback", agentName, orgId, sessionId, model: toModel, metadata: { from: fromModel } }),

    skillActivated: (sessionId: string, skillName: string) =>
      emit(env, { type: "memory.skill_activated", agentName, orgId, sessionId, metadata: { skill: skillName } }),

    contextCompacted: (sessionId: string, tokensBefore: number, tokensAfter: number) =>
      emit(env, { type: "memory.compaction", agentName, orgId, sessionId, metadata: { tokensBefore, tokensAfter } }),

    channelReceived: (channel: string, userId: string) =>
      emit(env, { type: "channel.message_received", agentName, orgId, channel, userId }),

    channelSent: (channel: string, userId: string, latencyMs: number) =>
      emit(env, { type: "channel.message_sent", agentName, orgId, channel, userId, latencyMs }),

    channelError: (channel: string, error: string) =>
      emit(env, { type: "channel.error", agentName, orgId, channel, error, platform: channel }),

    delegationStarted: (parentSessionId: string, childAgentName: string) =>
      emit(env, { type: "delegation.started", agentName, orgId, parentSessionId, childAgentName }),

    delegationCompleted: (parentSessionId: string, childAgentName: string, costUsd: number) =>
      emit(env, { type: "delegation.completed", agentName, orgId, parentSessionId, childAgentName, costUsd }),

    guardrailTriggered: (sessionId: string, ruleName: string, severity: TelemetryEvent["severity"]) =>
      emit(env, { type: "security.guardrail_triggered", agentName, orgId, sessionId, ruleName, severity }),

    billingDeducted: (sessionId: string, costUsd: number, model: string) =>
      emit(env, { type: "billing.deducted", agentName, orgId, sessionId, costUsd, model }),
  };
}
