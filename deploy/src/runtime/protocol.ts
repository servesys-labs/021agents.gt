/**
 * AgentOS Event Protocol — Type definitions for streaming events.
 * 
 * This file defines the contract between the runtime (server) and portal (client).
 * All events must conform to these types to ensure compatibility across:
 * - WebSocket (real-time bidirectional)
 * - SSE (server-sent events)
 * - Future transports
 * 
 * Event Type Version: 1.0.0
 */

// ── Base Event ───────────────────────────────────────────────────────

export type EventType =
  | "connected"
  | "session_start"
  | "setup_done"
  | "governance_pass"
  | "checkpoint_resumed"
  | "turn_start"
  | "token"
  | "tool_call"
  | "tool_result"
  | "tool_progress"
  | "turn_end"
  | "done"
  | "error"
  | "warning"
  | "system"
  | "thinking"
  | "reasoning"
  | "reset"
  // Phase 5.2: New event types for protocol completeness
  | "heartbeat"
  | "loop_detected"
  | "file_change";

export interface BaseEvent {
  type: EventType;
  timestamp?: number; // Unix ms, added by server if not provided
}

// ── Connection Events ────────────────────────────────────────────────

export interface ConnectedEvent extends BaseEvent {
  type: "connected";
  agent: string;
  session_affinity: boolean;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  session_id: string;
  trace_id: string;
  agent_name: string;
  delegation?: Record<string, unknown>;
}

/**
 * Emitted after the bootstrap step completes — config loaded, tools resolved,
 * memory ready. Gives the UI pipeline a real timing for its "Setup" step
 * instead of synthesizing one.
 */
export interface SetupDoneEvent extends BaseEvent {
  type: "setup_done";
  duration_ms: number;
  model: string;
  plan: string;
  tool_count: number;
  system_prompt_tokens: number;
  rls_enforced: boolean;
  config_migrated: boolean;
}

/**
 * Emitted after the pre-LLM guards have been evaluated. Lists each guard
 * that ran and whether it passed. UI uses this to give the "Governance"
 * step real content.
 */
export interface GovernancePassEvent extends BaseEvent {
  type: "governance_pass";
  duration_ms: number;
  guards: Array<{
    name: string;
    passed: boolean;
    detail?: string;
  }>;
}

/**
 * Emitted when a Workflow instance resumed execution from a durable
 * checkpoint — either because the Worker restarted or the Workflow was
 * retried. The UI highlights this prominently; it's the durability flex.
 */
export interface CheckpointResumedEvent extends BaseEvent {
  type: "checkpoint_resumed";
  /** Which synthetic step we resumed from (setup/governance/llm/tools/result/record). */
  resumed_at: string;
  /** Turn number the checkpoint was persisted at. */
  turn: number;
  /** Recovered cost at checkpoint time (USD). */
  recovered_cost_usd: number;
  /** Opaque checkpoint ID (workflow instance-relative). */
  checkpoint_id?: string;
}

// ── Turn Lifecycle Events ────────────────────────────────────────────

export interface TurnStartEvent extends BaseEvent {
  type: "turn_start";
  turn: number;
  model: string;
}

export interface TokenEvent extends BaseEvent {
  type: "token";
  content: string;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  name: string;
  tool_call_id: string;
  arguments?: string; // JSON string of args (optional for streaming display)
  args_preview?: string; // Human-readable preview of key argument (query, path, url)
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  name: string;
  tool_call_id: string;
  result?: string;
  error?: string;
  latency_ms?: number;
  cost_usd?: number;       // Phase 5.2: Per-tool cost for frontend display
  duration_ms?: number;    // Phase 5.2: Wall-clock execution time
}

export interface ToolProgressEvent extends BaseEvent {
  type: "tool_progress";
  name: string;
  tool_call_id: string;
  progress?: Record<string, unknown>; // Structured progress data
}

export interface HeartbeatEvent extends BaseEvent {
  type: "heartbeat";
}

export interface LoopDetectedEvent extends BaseEvent {
  type: "loop_detected";
  tool_name: string;
  repeat_count: number;
}

export interface FileChangeEvent extends BaseEvent {
  type: "file_change";
  change_type: "create" | "edit" | "delete";
  path: string;
  language?: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  size?: number;
  tool_call_id?: string;
}

export interface TurnEndEvent extends BaseEvent {
  type: "turn_end";
  turn: number;
  model: string;
  cost_usd: number;
  tokens: number; // Total tokens (input + output) for this turn — kept for backcompat
  input_tokens?: number; // Per-turn input tokens (added for live UI stats)
  output_tokens?: number; // Per-turn output tokens (added for live UI stats)
  tool_calls?: number; // Number of tool calls in this turn
  latency_ms?: number; // End-to-end turn latency
  llm_latency_ms?: number; // Model-only latency
  phase_pre_llm_ms?: number; // Guard/routing/prep before LLM dispatch
  phase_tool_exec_ms?: number; // Tool execution phase duration
  done: boolean; // true if this is the final turn
}

// ── Completion Events ────────────────────────────────────────────────

export interface DoneEvent extends BaseEvent {
  type: "done";
  session_id: string;
  trace_id: string;
  output: string;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  termination_reason?: string;
}

// ── Error/Warning Events ─────────────────────────────────────────────

export interface ErrorEvent extends BaseEvent {
  type: "error";
  message: string;
  code?: string; // Machine-readable error code
  retry_after?: number; // Seconds to wait before retry
}

export interface WarningEvent extends BaseEvent {
  type: "warning";
  message: string;
}

export interface SystemEvent extends BaseEvent {
  type: "system";
  message: string;
}

// ── Control Events ───────────────────────────────────────────────────

export interface ResetEvent extends BaseEvent {
  type: "reset";
  ok: boolean;
}

// ── Union Type ───────────────────────────────────────────────────────

export type RuntimeEvent =
  | ConnectedEvent
  | SessionStartEvent
  | SetupDoneEvent
  | GovernancePassEvent
  | CheckpointResumedEvent
  | TurnStartEvent
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolProgressEvent
  | TurnEndEvent
  | DoneEvent
  | ErrorEvent
  | WarningEvent
  | SystemEvent
  | ResetEvent
  | HeartbeatEvent
  | LoopDetectedEvent
  | FileChangeEvent;

// ── Client → Server Messages (WebSocket only) ────────────────────────

export type ClientMessageType = "run" | "reset" | "new";

export interface ClientRunMessage {
  type: "run";
  input: string;
  agent_name?: string;
  org_id?: string;
  project_id?: string;
  channel?: string;
  history_messages?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ClientResetMessage {
  type: "reset" | "new";
}

export type ClientMessage = ClientRunMessage | ClientResetMessage;

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate that an event conforms to the protocol.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateEvent(event: unknown): { valid: boolean; error?: string } {
  if (!event || typeof event !== "object") {
    return { valid: false, error: "Event must be an object" };
  }
  
  const e = event as Record<string, unknown>;
  
  if (!e.type || typeof e.type !== "string") {
    return { valid: false, error: "Event must have a 'type' string" };
  }
  
  const validTypes: EventType[] = [
    "connected", "session_start", "setup_done", "governance_pass", "checkpoint_resumed",
    "turn_start", "token",
    "tool_call", "tool_result", "tool_progress", "turn_end", "done",
    "error", "warning", "system", "thinking", "reasoning", "reset",
    "heartbeat", "loop_detected", "file_change"
  ];
  
  if (!validTypes.includes(e.type as EventType)) {
    return { valid: false, error: `Invalid event type: ${e.type}` };
  }
  
  // Type-specific validation
  switch (e.type) {
    case "token":
      if (typeof e.content !== "string") {
        return { valid: false, error: "Token event must have 'content' string" };
      }
      break;
    case "error":
      if (typeof e.message !== "string") {
        return { valid: false, error: "Error event must have 'message' string" };
      }
      break;
    case "turn_end":
      if (typeof e.turn !== "number") {
        return { valid: false, error: "Turn end event must have 'turn' number" };
      }
      if (typeof e.tokens !== "number") {
        return { valid: false, error: "Turn end event must have 'tokens' number" };
      }
      break;
  }
  
  return { valid: true };
}

/**
 * Serialize event for SSE transport.
 */
export function serializeForSSE(event: RuntimeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Serialize event for WebSocket transport.
 */
export function serializeForWebSocket(event: RuntimeEvent): string {
  return JSON.stringify(event);
}
