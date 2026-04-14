/**
 * WebSocket client for real-time agent communication.
 *
 * Replaces the SSE fetch-based streaming with a persistent WebSocket
 * connection to the runtime's Durable Object. Benefits:
 * - Survives page refresh (DO keeps running, client reconnects)
 * - Auto-reconnection with exponential backoff
 * - Event replay on reconnect (missed events from KV)
 * - Bidirectional communication (stop, continue, etc.)
 *
 * Protocol (matches DO's onConnect/onMessage):
 *   Client → { type: "auth", token: "..." }
 *   Client → { type: "run", input: "...", agent_name: "...", ... }
 *   Client → { type: "reconnect", from_seq: N, progress_key: "..." }
 *   Server → { type: "connected", agent, instance_id, history_count }
 *   Server → { type: "token", content: "..." }
 *   Server → { type: "tool_call", name, tool_call_id, args_preview }
 *   Server → { type: "tool_result", name, tool_call_id, result, latency_ms }
 *   Server → { type: "done", output, turns, cost_usd, session_id }
 *   Server → { type: "error", message }
 */

import { api } from "./api";

export type AgentEventType =
  | "connected"
  | "session_start"
  | "setup_done"
  | "governance_pass"
  | "checkpoint_resumed"
  | "turn_start"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "tool_heartbeat"
  | "token"
  | "turn_end"
  | "done"
  | "error"
  | "system"
  | "warning"
  | "reconnect_complete";

export interface AgentEvent {
  type: AgentEventType;
  data: Record<string, unknown>;
}

// ── DO name derivation (must match runtime's buildDoName) ──

function buildDoName(orgId: string, agentName: string, userId: string): string {
  const shortOrg = orgId.length > 12 ? orgId.slice(-8) : orgId;
  const shortUser = userId.length > 12 ? userId.slice(-8) : userId;
  const orgPrefix = shortOrg ? `${shortOrg}-` : "";
  let name = shortUser
    ? `${orgPrefix}${agentName}-u-${shortUser}`
    : `${orgPrefix}${agentName}`;
  if (name.length > 63) name = name.slice(0, 63);
  return name;
}

// ── Runtime WS URL ──

const RUNTIME_WS_BASE = "wss://runtime.oneshots.co";

function getWsUrl(doName: string): string {
  // Cloudflare Agents SDK route: /agents/{class-name-kebab}/{instance-name}
  // In agents@0.7.x, namespace comes from DO binding name: AGENTOS_AGENT -> agentos-agent
  return `${RUNTIME_WS_BASE}/agents/agentos-agent/${encodeURIComponent(doName)}`;
}

// ── Connection state ──

export interface AgentConnection {
  /** Send a run command */
  run: (input: string, opts?: RunOptions) => void;
  /** Stop the current run */
  stop: () => void;
  /** Manually reconnect */
  reconnect: () => void;
  /** Close the connection */
  close: () => void;
  /** Whether the WS is connected */
  readonly connected: boolean;
  /** The DO instance name */
  readonly doName: string;
  /** Last progress key for reconnection */
  readonly progressKey: string | null;
  /** Last sequence number for reconnection */
  readonly lastSeq: number;
}

export interface RunOptions {
  sessionId?: string;
  plan?: string;
  conversationId?: string;
  history?: Array<{ role: string; content: string }>;
}

export interface AgentConnectionOptions {
  agentName: string;
  orgId: string;
  userId: string;
  onEvent: (event: AgentEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export function createAgentConnection(opts: AgentConnectionOptions): AgentConnection {
  const doName = buildDoName(opts.orgId, opts.agentName, opts.userId);
  const wsUrl = getWsUrl(doName);

  let ws: WebSocket | null = null;
  let connected = false;
  let authenticated = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let progressKey: string | null = null;
  let lastSeq = 0;
  let closed = false;
  let transportErrorReported = false;

  function connect() {
    if (closed) return;
    try {
      // Pass JWT token as query param — browsers can't set headers on WebSocket
      const token = api.token;
      const urlWithAuth = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
      ws = new WebSocket(urlWithAuth);
    } catch (err) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      connected = true;
      reconnectAttempts = 0;
      transportErrorReported = false;

      // Also send auth message for the DO-level auth check
      const token = api.token;
      if (token) {
        ws!.send(JSON.stringify({ type: "auth", token }));
      }

      // If we have a progress key from a previous connection, request replay
      if (progressKey && lastSeq > 0) {
        ws!.send(JSON.stringify({
          type: "reconnect",
          from_seq: lastSeq,
          progress_key: progressKey,
        }));
      }

      opts.onConnect?.();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const eventType = data.type as AgentEventType;

        // Track sequence numbers for reconnection
        if (typeof data._seq === "number") {
          lastSeq = data._seq;
        }

        // Track progress key from session_start
        if (eventType === "session_start" && data.progress_key) {
          progressKey = String(data.progress_key);
        }

        // Auth response
        if (eventType === "connected" || data.type === "auth_ok") {
          authenticated = true;
        }

        opts.onEvent({ type: eventType, data });
      } catch {
        // Non-JSON message, ignore
      }
    };

    ws.onclose = () => {
      connected = false;
      authenticated = false;
      opts.onDisconnect?.();
      if (!closed) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // Surface a single transport error so callers can fail over to SSE.
      if (!transportErrorReported) {
        transportErrorReported = true;
        opts.onEvent({
          type: "error",
          data: { message: "WebSocket connection failed" },
        });
      }
    };
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    // Stop reconnecting after 5 failed attempts — don't spam
    if (reconnectAttempts >= 5) {
      closed = true;
      return;
    }
    // Exponential backoff: 1s, 2s, 4s, 8s, max 15s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(msg: Record<string, unknown>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // Initial connection
  connect();

  return {
    run(input: string, runOpts?: RunOptions) {
      send({
        type: "run",
        input,
        agent_name: opts.agentName,
        ...(runOpts?.sessionId ? { session_id: runOpts.sessionId } : {}),
        ...(runOpts?.plan ? { plan: runOpts.plan } : {}),
        ...(runOpts?.conversationId ? { conversation_id: runOpts.conversationId } : {}),
        ...(runOpts?.history ? { history: runOpts.history } : {}),
      });
    },

    stop() {
      send({ type: "stop" });
    },

    reconnect() {
      if (ws) {
        ws.close();
      }
      reconnectAttempts = 0;
      connect();
    },

    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
      connected = false;
    },

    get connected() { return connected; },
    get doName() { return doName; },
    get progressKey() { return progressKey; },
    get lastSeq() { return lastSeq; },
  };
}

/**
 * Adapter: wraps the WS connection to match the existing streamAgent API
 * so the chat page can switch with minimal changes.
 */
export function streamAgentWs(
  agentName: string,
  message: string,
  onEvent: (event: AgentEvent) => void,
  sessionId?: string,
  plan?: string,
  history?: Array<{ role: string; content: string }>,
  conversationId?: string,
  existingConnection?: AgentConnection,
): { abort: () => void; connection: AgentConnection } {
  // If an existing connection is provided, reuse it
  if (existingConnection && existingConnection.connected) {
    existingConnection.run(message, { sessionId, plan, history, conversationId });
    return { abort: () => existingConnection.stop(), connection: existingConnection };
  }

  // Extract org_id and user_id from JWT
  let orgId = "";
  let userId = "";
  try {
    const token = api.token;
    if (token) {
      const payload = JSON.parse(atob(token.split(".")[1]));
      orgId = payload.org_id || "";
      userId = payload.user_id || payload.sub || "";
    }
  } catch {}

  const conn = createAgentConnection({
    agentName,
    orgId,
    userId,
    onEvent,
    onConnect: () => {
      // Send the run command once connected + authenticated
      // Small delay to allow auth to complete
      setTimeout(() => {
        conn.run(message, { sessionId, plan, history, conversationId });
      }, 100);
    },
  });

  return { abort: () => conn.stop(), connection: conn };
}
