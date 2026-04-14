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
  | "session.progress"       // progress %, stage — maps to session_progress
  // Turn lifecycle
  | "turn.started"
  | "turn.completed"
  | "turn.error"
  | "turn.refusal"
  | "turn.compacted"         // compaction triggered — maps to compaction_count
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
  | "llm.ttft"               // time to first token — maps to turns.ttft_ms
  | "llm.tokens_per_sec"     // streaming throughput
  // Memory
  | "memory.context_loaded"
  | "memory.context_written"
  | "memory.compaction"
  | "memory.skill_activated"
  | "memory.skill_deactivated"
  | "memory.fact_extracted"   // fact extraction — maps to facts table
  | "memory.episode_stored"  // episodic memory — maps to episodes table
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
  | "security.scan_completed" // security scan — maps to security_scans
  // Billing
  | "billing.deducted"
  | "billing.insufficient"
  | "billing.hold_created"
  | "billing.hold_settled"
  | "billing.exception"      // billing anomaly — maps to billing_exceptions
  // MCP
  | "mcp.server_connected"
  | "mcp.server_disconnected"
  | "mcp.tool_discovered"
  | "mcp.tool_called"        // MCP tool invocation (not our tool, external)
  // Agent lifecycle
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "agent.skill_added"
  | "agent.skill_removed"
  | "agent.channel_deployed"
  | "agent.version_snapshot"  // agent version saved — maps to agent_versions
  // Eval & Training
  | "eval.run_started"       // eval run created — maps to eval_runs
  | "eval.run_completed"
  | "eval.trial_completed"   // individual trial — maps to eval_trials
  | "training.job_started"   // training loop — maps to training_jobs
  | "training.iteration"     // iteration result — maps to training_iterations
  | "training.job_completed"
  // Conversation quality (scored per-turn)
  | "conversation.scored"    // quality metrics — maps to conversation_scores
  | "conversation.feedback"  // user thumbs up/down — maps to session_feedback
  // Voice
  | "voice.call_started"     // voice call lifecycle — maps to voice_calls
  | "voice.call_ended"
  | "voice.call_event"       // mid-call events — maps to voice_call_events
  // Workflow
  | "workflow.started"       // durable workflow — maps to workflow_runs
  | "workflow.step_completed"
  | "workflow.completed"
  | "workflow.approval_requested" // maps to workflow_approvals
  | "workflow.approval_resolved"
  // Autopilot
  | "autopilot.session_started"  // autonomous run — maps to autopilot_sessions
  | "autopilot.session_ended"
  // Artifacts
  | "artifact.created"       // generated file — maps to run_artifacts
  | "artifact.accessed"
  // API access
  | "api.request"            // every API hit — maps to api_access_log
  // Meta Agent
  | "meta.suggestion_generated"
  | "meta.eval_run"
  | "meta.bulk_update"
  | "meta.agent_improved";
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
  spanId?: string;
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
  ttftMs?: number;             // time to first token
  tokensPerSec?: number;       // streaming throughput
  llmRetryCount?: number;
  gatewayLogId?: string;       // AI Gateway log correlation
  // Channel-specific
  platform?: string;
  messageLength?: number;
  // Security
  severity?: "critical" | "high" | "medium" | "low" | "info";
  ruleName?: string;
  riskScore?: number;
  // Delegation
  parentSessionId?: string;
  childSessionId?: string;
  childAgentName?: string;
  depth?: number;
  spawnMode?: "sync" | "async";
  // Eval & Training
  evalRunId?: string;
  testInput?: string;
  expectedOutput?: string;
  actualOutput?: string;
  passed?: boolean;
  score?: number;
  passRate?: number;
  trainingJobId?: string;
  iterationNumber?: number;
  rewardScore?: number;
  // Conversation quality (per-turn scoring)
  sentiment?: string;
  sentimentScore?: number;
  relevanceScore?: number;
  coherenceScore?: number;
  helpfulnessScore?: number;
  safetyScore?: number;
  qualityOverall?: number;
  topic?: string;
  intent?: string;
  hasToolFailure?: boolean;
  hasHallucinationRisk?: boolean;
  // Voice
  callId?: string;
  callDurationMs?: number;
  callEvent?: string;
  // Workflow
  workflowId?: string;
  workflowStepName?: string;
  approvalStatus?: string;
  // Artifacts
  artifactName?: string;
  artifactKind?: string;
  artifactSizeBytes?: number;
  storageKey?: string;
  // Progress
  progressPct?: number;
  stage?: string;
  // Session composition
  stepCount?: number;
  actionCount?: number;
  wallClockSeconds?: number;
  terminationReason?: string;
  compactionCount?: number;
  repairCount?: number;
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
    // Session lifecycle (→ sessions table)
    "session.started", "session.completed", "session.failed", "session.timeout",
    // Turn lifecycle (→ turns table)
    "turn.completed", "turn.error", "turn.refusal",
    // Tool execution (→ tool_executions table)
    "tool.completed", "tool.failed",
    // Billing (→ billing_records, billing_exceptions)
    "billing.deducted", "billing.insufficient", "billing.exception",
    "billing.hold_created", "billing.hold_settled",
    // Delegation (→ delegation_events table)
    "delegation.started", "delegation.completed", "delegation.failed",
    // Security (→ security_events, guardrail_events)
    "security.guardrail_triggered", "security.input_blocked",
    "security.anomaly_detected", "security.scan_completed",
    // Agent lifecycle (→ agents table audit)
    "agent.created", "agent.updated", "agent.deleted", "agent.version_snapshot",
    // Channel errors (→ runtime_events)
    "channel.error",
    // Eval & Training (→ eval_runs, eval_trials, training_jobs)
    "eval.run_started", "eval.run_completed", "eval.trial_completed",
    "training.job_started", "training.iteration", "training.job_completed",
    // Conversation quality (→ conversation_scores)
    "conversation.scored", "conversation.feedback",
    // Voice (→ voice_calls, voice_call_events)
    "voice.call_started", "voice.call_ended", "voice.call_event",
    // Workflow (→ workflow_runs, workflow_approvals)
    "workflow.started", "workflow.completed",
    "workflow.approval_requested", "workflow.approval_resolved",
    // Artifacts (→ run_artifacts)
    "artifact.created",
    // Meta Agent
    "meta.eval_run", "meta.agent_improved",
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
          // CodeMode failures include code preview for debugging
          ...(event.metadata?.codePreview ? { code_preview: String(event.metadata.codePreview).slice(0, 500) } : {}),
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

    // ── Eval & Training ──
    case "eval.run_started":
    case "eval.run_completed":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, eval_run_id: event.evalRunId, pass_rate: event.passRate, score: event.score },
      };
    case "eval.trial_completed":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, eval_run_id: event.evalRunId, test_input: event.testInput?.slice(0, 500), expected_output: event.expectedOutput?.slice(0, 500), actual_output: event.actualOutput?.slice(0, 500), passed: event.passed, score: event.score },
      };
    case "training.job_started":
    case "training.job_completed":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, training_job_id: event.trainingJobId },
      };
    case "training.iteration":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, training_job_id: event.trainingJobId, iteration_number: event.iterationNumber, reward_score: event.rewardScore, pass_rate: event.passRate },
      };

    // ── Conversation quality ──
    case "conversation.scored":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, turn_number: event.turnNumber, sentiment: event.sentiment, sentiment_score: event.sentimentScore, relevance_score: event.relevanceScore, coherence_score: event.coherenceScore, helpfulness_score: event.helpfulnessScore, safety_score: event.safetyScore, quality_overall: event.qualityOverall, topic: event.topic, intent: event.intent, has_tool_failure: event.hasToolFailure, has_hallucination_risk: event.hasHallucinationRisk },
      };
    case "conversation.feedback":
      return {
        type: "feedback",
        payload: { ...base, rating: event.score, feedback: event.error || "", user_id: event.userId },
      };

    // ── Voice ──
    case "voice.call_started":
    case "voice.call_ended":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, call_id: event.callId, call_duration_ms: event.callDurationMs, channel: "voice" },
      };
    case "voice.call_event":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, call_id: event.callId, call_event: event.callEvent },
      };

    // ── Workflow ──
    case "workflow.started":
    case "workflow.completed":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, workflow_id: event.workflowId },
      };
    case "workflow.approval_requested":
    case "workflow.approval_resolved":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, workflow_id: event.workflowId, approval_status: event.approvalStatus },
      };

    // ── Artifacts ──
    case "artifact.created":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, artifact_name: event.artifactName, artifact_kind: event.artifactKind, size_bytes: event.artifactSizeBytes, storage_key: event.storageKey },
      };

    // ── Billing extended ──
    case "billing.exception":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, cost_usd: event.costUsd, error: event.error },
      };
    case "billing.hold_created":
    case "billing.hold_settled":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, cost_usd: event.costUsd },
      };

    // ── Security extended ──
    case "security.scan_completed":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, risk_score: event.riskScore, severity: event.severity },
      };

    // ── Agent lifecycle extended ──
    case "agent.version_snapshot":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, ...event.metadata },
      };

    // ── Meta Agent ──
    case "meta.agent_improved":
      return {
        type: "event",
        payload: { ...base, event_type: event.type, ...event.metadata },
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

    // ── Eval & Training ──
    evalRunStarted: (evalRunId: string) =>
      emit(env, { type: "eval.run_started", agentName, orgId, evalRunId }),

    evalRunCompleted: (evalRunId: string, passRate: number) =>
      emit(env, { type: "eval.run_completed", agentName, orgId, evalRunId, passRate }),

    evalTrialCompleted: (evalRunId: string, opts: { testInput: string; expectedOutput: string; actualOutput: string; passed: boolean; score: number }) =>
      emit(env, { type: "eval.trial_completed", agentName, orgId, evalRunId, ...opts }),

    trainingStarted: (trainingJobId: string) =>
      emit(env, { type: "training.job_started", agentName, orgId, trainingJobId }),

    trainingIteration: (trainingJobId: string, iterationNumber: number, rewardScore: number) =>
      emit(env, { type: "training.iteration", agentName, orgId, trainingJobId, iterationNumber, rewardScore }),

    trainingCompleted: (trainingJobId: string) =>
      emit(env, { type: "training.job_completed", agentName, orgId, trainingJobId }),

    // ── Conversation quality ──
    conversationScored: (sessionId: string, opts: { turnNumber: number; sentiment: string; sentimentScore: number; relevanceScore: number; coherenceScore: number; helpfulnessScore: number; safetyScore: number; qualityOverall: number; topic: string; intent: string }) =>
      emit(env, { type: "conversation.scored", agentName, orgId, sessionId, ...opts }),

    conversationFeedback: (sessionId: string, rating: number, feedback: string) =>
      emit(env, { type: "conversation.feedback", agentName, orgId, sessionId, score: rating, error: feedback }),

    // ── Voice ──
    voiceCallStarted: (callId: string) =>
      emit(env, { type: "voice.call_started", agentName, orgId, callId, channel: "voice" }),

    voiceCallEnded: (callId: string, durationMs: number) =>
      emit(env, { type: "voice.call_ended", agentName, orgId, callId, callDurationMs: durationMs }),

    voiceCallEvent: (callId: string, event: string) =>
      emit(env, { type: "voice.call_event", agentName, orgId, callId, callEvent: event }),

    // ── Workflow ──
    workflowStarted: (workflowId: string) =>
      emit(env, { type: "workflow.started", agentName, orgId, workflowId }),

    workflowCompleted: (workflowId: string) =>
      emit(env, { type: "workflow.completed", agentName, orgId, workflowId }),

    workflowApproval: (workflowId: string, status: string) =>
      emit(env, { type: "workflow.approval_requested", agentName, orgId, workflowId, approvalStatus: status }),

    // ── Artifacts ──
    artifactCreated: (sessionId: string, name: string, kind: string, sizeBytes: number) =>
      emit(env, { type: "artifact.created", agentName, orgId, sessionId, artifactName: name, artifactKind: kind, artifactSizeBytes: sizeBytes }),

    // ── Progress ──
    sessionProgress: (sessionId: string, pct: number, stage: string) =>
      emit(env, { type: "session.progress", agentName, orgId, sessionId, progressPct: pct, stage }),

    // ── MCP ──
    mcpConnected: (serverName: string) =>
      emit(env, { type: "mcp.server_connected", agentName, orgId, metadata: { server: serverName } }),

    mcpDisconnected: (serverName: string) =>
      emit(env, { type: "mcp.server_disconnected", agentName, orgId, metadata: { server: serverName } }),

    // ── Agent lifecycle ──
    agentCreated: (agentId: string, name: string) =>
      emit(env, { type: "agent.created", agentName: name, orgId, agentId }),

    agentUpdated: (agentId: string, name: string, changes: Record<string, unknown>) =>
      emit(env, { type: "agent.updated", agentName: name, orgId, agentId, metadata: changes }),

    agentDeleted: (agentId: string, name: string) =>
      emit(env, { type: "agent.deleted", agentName: name, orgId, agentId }),

    // ── LLM extended ──
    llmTtft: (sessionId: string, ttftMs: number) =>
      emit(env, { type: "llm.ttft", agentName, orgId, sessionId, ttftMs }),

    llmError: (sessionId: string, error: string, model: string) =>
      emit(env, { type: "llm.error", agentName, orgId, sessionId, error, model }),

    llmCacheHit: (sessionId: string, cacheReadTokens: number) =>
      emit(env, { type: "llm.cache_hit", agentName, orgId, sessionId, cacheReadTokens }),

    // ── Turn extended ──
    turnStarted: (sessionId: string, turnNumber: number) =>
      emit(env, { type: "turn.started", agentName, orgId, sessionId, turnNumber }),

    turnError: (sessionId: string, turnNumber: number, error: string) =>
      emit(env, { type: "turn.error", agentName, orgId, sessionId, turnNumber, error }),

    turnCompacted: (sessionId: string, tokensBefore: number, tokensAfter: number) =>
      emit(env, { type: "turn.compacted", agentName, orgId, sessionId, metadata: { tokensBefore, tokensAfter } }),

    // ── Tool approval ──
    toolApprovalRequested: (sessionId: string, toolName: string) =>
      emit(env, { type: "tool.approval_requested", agentName, orgId, sessionId, toolName }),

    toolApprovalGranted: (sessionId: string, toolName: string) =>
      emit(env, { type: "tool.approval_granted", agentName, orgId, sessionId, toolName }),

    toolApprovalDenied: (sessionId: string, toolName: string) =>
      emit(env, { type: "tool.approval_denied", agentName, orgId, sessionId, toolName }),

    // ── Security extended ──
    securityScanCompleted: (scanId: string, riskScore: number) =>
      emit(env, { type: "security.scan_completed", agentName, orgId, riskScore, metadata: { scanId } }),

    inputBlocked: (sessionId: string, ruleName: string) =>
      emit(env, { type: "security.input_blocked", agentName, orgId, sessionId, ruleName }),

    outputFiltered: (sessionId: string, ruleName: string) =>
      emit(env, { type: "security.output_filtered", agentName, orgId, sessionId, ruleName }),

    anomalyDetected: (details: string, severity: TelemetryEvent["severity"]) =>
      emit(env, { type: "security.anomaly_detected", agentName, orgId, error: details, severity }),
  };
}
