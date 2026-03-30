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
  | "reset";

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
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  name: string;
  tool_call_id: string;
  result?: string;
  error?: string;
  latency_ms?: number;
}

export interface TurnEndEvent extends BaseEvent {
  type: "turn_end";
  turn: number;
  model: string;
  cost_usd: number;
  tokens: number; // Total tokens (input + output) for this turn
  tool_calls?: number; // Number of tool calls in this turn
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
  latency_ms: number;
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
  | TurnStartEvent
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | TurnEndEvent
  | DoneEvent
  | ErrorEvent
  | WarningEvent
  | SystemEvent
  | ResetEvent;

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
    "connected", "session_start", "turn_start", "token",
    "tool_call", "tool_result", "turn_end", "done",
    "error", "warning", "system", "reset"
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
