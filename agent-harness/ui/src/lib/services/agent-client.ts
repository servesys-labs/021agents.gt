/**
 * Svelte-compatible Agent Client — wraps SDK's AgentClient for reactive state.
 *
 * Uses the Cloudflare Agents SDK communication pattern:
 *   - Persistent WebSocket connection to Agent DO
 *   - RPC calls via @callable methods (not REST)
 *   - Push-based state sync (server broadcasts → reactive $state)
 *   - Auto-reconnection with identity tracking
 *
 * Replaces agent-ws.ts (custom WebSocket) with SDK-aligned RPC.
 *
 * Usage:
 *   const agent = createAgent({ agent: "chat-agent", name: doName });
 *   await agent.ready;
 *   const result = await agent.call("addServer", ["github", "https://..."]);
 *   // or typed:
 *   agent.stub.addServer("github", "https://...");
 *
 * Architecture:
 *   Svelte UI ←→ AgentClient (WebSocket RPC) ←→ Agent DO (@callable)
 *   Svelte UI ←→ REST (api.ts) ←→ Gateway ←→ Postgres (control-plane)
 */

import { api } from "./api";

// ── Types matching SDK protocol ──

const MessageType = {
  RPC: "rpc",
  CF_AGENT_STATE: "cf_agent_state",
  CF_AGENT_STATE_ERROR: "cf_agent_state_error",
  CF_AGENT_IDENTITY: "cf_agent_identity",
} as const;

interface RPCRequest {
  type: "rpc";
  id: string;
  method: string;
  args: unknown[];
}

// SDK RPC response uses "done" (not "success") to distinguish streaming.
// - "done" absent: non-streaming response, result is final
// - done: false: streaming chunk, more to come
// - done: true: streaming complete, result is final
// - error present: call failed
interface RPCResponse {
  type: typeof MessageType.RPC;
  id: string;
  result?: unknown;
  error?: string;
  done?: boolean;
}

// ── Chat protocol message types (exact match with SDK chat/protocol.ts) ──

export const CHAT_TYPES = {
  MESSAGES: "cf_agent_chat_messages",
  REQUEST: "cf_agent_use_chat_request",
  RESPONSE: "cf_agent_use_chat_response",
  CLEAR: "cf_agent_chat_clear",
  REQUEST_CANCEL: "cf_agent_chat_request_cancel",
  STREAM_RESUMING: "cf_agent_stream_resuming",
  STREAM_RESUME_ACK: "cf_agent_stream_resume_ack",
  STREAM_RESUME_REQUEST: "cf_agent_stream_resume_request",
  STREAM_RESUME_NONE: "cf_agent_stream_resume_none",
  TOOL_RESULT: "cf_agent_tool_result",
  TOOL_APPROVAL: "cf_agent_tool_approval",
  MESSAGE_UPDATED: "cf_agent_message_updated",
} as const;

// ── Agent connection options ──

export interface AgentOptions<State = unknown> {
  /** Agent class name (kebab-case, e.g., "chat-agent") */
  agent: string;
  /** DO instance name (e.g., orgId-agentName-u-userId) */
  name?: string;
  /** Full URL path — bypasses agent/name construction (for server-side routing) */
  basePath?: string;
  /** WebSocket host (defaults to window.location.host) */
  host?: string;
  /** Called when agent state is updated (push from server). Source: "server" or "client". */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  /** Called when agent identity is confirmed on first connect */
  onIdentity?: (name: string, agent: string) => void;
  /** Called when identity changes on reconnect (different DO instance) */
  onIdentityChange?: (oldName: string, newName: string, oldAgent: string, newAgent: string) => void;
  /** Called on any message (for chat protocol handling) */
  onMessage?: (data: unknown) => void;
  /** Called on connection open */
  onOpen?: () => void;
  /** Called on connection close */
  onClose?: (code: number, reason: string) => void;
}

export interface StreamCallOptions {
  onChunk?: (chunk: unknown) => void;
  onDone?: (finalChunk: unknown) => void;
  onError?: (error: string) => void;
}

// ── Svelte Agent Client ──

export interface SvelteAgentClient<State = unknown> {
  /** Whether WebSocket is connected */
  readonly connected: boolean;
  /** Whether identity has been received from server */
  readonly identified: boolean;
  /** Promise that resolves when identity is received */
  readonly ready: Promise<void>;
  /** Current agent state (push-synced from server) */
  readonly state: State | undefined;
  /** The DO instance name */
  readonly name: string;

  /** Call a @callable method on the agent DO */
  call<T = unknown>(method: string, args?: unknown[], options?: StreamCallOptions): Promise<T>;

  /** Typed proxy — call methods by name: agent.stub.addServer("name", "url") */
  readonly stub: Record<string, (...args: unknown[]) => Promise<unknown>>;

  /** Send a chat message (SDK chat protocol) */
  sendChatMessage(message: string, options?: { id?: string }): void;

  /** Approve or reject a tool call (SDK tool approval protocol) */
  respondToToolApproval(toolCallId: string, approved: boolean): void;

  /** Cancel the current streaming request */
  cancelStream(requestId?: string): void;

  /** Request stream resume after reconnect */
  requestStreamResume(): void;

  /** Push state update to server */
  setState(state: State): void;

  /** Close the connection */
  close(): void;

  /** Reconnect */
  reconnect(): void;
}

/** Build the WebSocket URL for an agent DO (matches SDK routeAgentRequest pattern) */
function buildAgentUrl(host: string, agent: string, name: string, basePath?: string): string {
  const protocol = host.startsWith("localhost") ? "ws" : "wss";
  if (basePath) return `${protocol}://${host}/${basePath.replace(/^\//, "")}`;
  return `${protocol}://${host}/agents/${agent}/${encodeURIComponent(name)}`;
}

/** Build DO name from JWT claims (matches gateway buildDoName) */
export function buildDoName(orgId: string, agentName: string, userId: string): string {
  const shortOrg = orgId.length > 12 ? orgId.slice(-8) : orgId;
  const shortUser = userId.length > 12 ? userId.slice(-8) : userId;
  const orgPrefix = shortOrg ? `${shortOrg}-` : "";
  let name = shortUser
    ? `${orgPrefix}${agentName}-u-${shortUser}`
    : `${orgPrefix}${agentName}`;
  if (name.length > 63) name = name.slice(0, 63);
  return name;
}

/** Extract org_id and user_id from JWT token */
export function parseJwtClaims(): { orgId: string; userId: string } {
  try {
    const token = api.token;
    if (!token) return { orgId: "", userId: "" };
    const payload = JSON.parse(atob(token.split(".")[1]));
    return {
      orgId: payload.org_id || "",
      userId: payload.user_id || payload.sub || "",
    };
  } catch {
    return { orgId: "", userId: "" };
  }
}

/**
 * Create a Svelte-compatible Agent Client.
 *
 * Connects via WebSocket to the Agent DO using the SDK's protocol.
 * Provides reactive state, typed RPC, and chat protocol support.
 */
export function createAgent<State = unknown>(
  options: AgentOptions<State>,
): SvelteAgentClient<State> {
  const host = options.host || (typeof window !== "undefined" ? window.location.host : "localhost:8787");
  const token = api.token;

  let ws: WebSocket | null = null;
  let connected = false;
  let identified = false;
  let agentState: State | undefined = undefined;
  let readyResolve: (() => void) | null = null;
  let readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // Identity tracking for change detection (SDK pattern)
  let previousIdentityName: string | null = null;
  let previousIdentityAgent: string | null = null;

  // Pending RPC calls
  const pendingCalls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    stream?: StreamCallOptions;
  }>();

  function connect() {
    if (closed) return;

    const instanceName = options.name || "default";
    const url = buildAgentUrl(host, options.agent, instanceName, options.basePath);
    // Pass JWT as query param (browsers can't set WebSocket headers — SDK pattern)
    const urlWithAuth = token ? `${url}?_pk=${encodeURIComponent(token)}` : url;

    try {
      ws = new WebSocket(urlWithAuth);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      connected = true;
      reconnectAttempts = 0;
      options.onOpen?.();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Identity message — SDK sends this on connect
        if (data.type === MessageType.CF_AGENT_IDENTITY) {
          identified = true;
          readyResolve?.();

          // Detect identity change on reconnect (SDK pattern from client.ts:328-380)
          if (previousIdentityName !== null && previousIdentityAgent !== null &&
              (previousIdentityName !== data.name || previousIdentityAgent !== data.agent)) {
            if (options.onIdentityChange) {
              options.onIdentityChange(
                previousIdentityName, data.name,
                previousIdentityAgent, data.agent,
              );
            } else {
              console.warn(
                `[agents] Identity changed on reconnect: ` +
                `agent "${previousIdentityAgent}" → "${data.agent}", ` +
                `instance "${previousIdentityName}" → "${data.name}"`,
              );
            }
          }
          previousIdentityName = data.name;
          previousIdentityAgent = data.agent;

          options.onIdentity?.(data.name, data.agent);
          return;
        }

        // State sync — push from server (with source tracking)
        if (data.type === MessageType.CF_AGENT_STATE) {
          agentState = data.state as State;
          options.onStateUpdate?.(agentState, "server");
          return;
        }

        if (data.type === MessageType.CF_AGENT_STATE_ERROR) {
          console.warn("[agents] State update error:", data.error);
          return;
        }

        // RPC response — SDK uses "done" presence (not "success") to distinguish streaming
        // See SDK client.ts:392-416
        if (data.type === MessageType.RPC && data.id) {
          const pending = pendingCalls.get(data.id);
          if (pending) {
            // Error check first
            if (data.error) {
              pending.reject(new Error(data.error));
              pending.stream?.onError?.(data.error);
              pendingCalls.delete(data.id);
              return;
            }

            // Streaming: "done" property determines if stream is over
            if ("done" in data) {
              if (data.done) {
                // Final chunk — resolve the promise
                pending.resolve(data.result);
                pendingCalls.delete(data.id);
                pending.stream?.onDone?.(data.result);
              } else {
                // Intermediate chunk
                pending.stream?.onChunk?.(data.result);
              }
            } else {
              // Non-streaming response — result is final
              pending.resolve(data.result);
              pendingCalls.delete(data.id);
            }
          }
          return;
        }

        // Pass all other messages to onMessage (chat protocol, etc.)
        options.onMessage?.(data);
      } catch {
        // Non-JSON message
      }
    };

    ws.onclose = (_event) => {
      connected = false;
      identified = false;
      // Reset ready promise for next connection
      readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });
      // Reject all pending calls
      for (const [id, pending] of pendingCalls) {
        pending.reject(new Error("Connection closed"));
        pendingCalls.delete(id);
      }
      options.onClose?.(_event.code, _event.reason);
      if (!closed) scheduleReconnect();
    };

    ws.onerror = () => {
      // Will trigger onclose
    };
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    if (reconnectAttempts >= 5) { closed = true; return; }
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(msg: unknown) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // Initial connection
  connect();

  // Typed stub proxy (matches SDK pattern)
  const stub = new Proxy<Record<string, (...args: unknown[]) => Promise<unknown>>>(
    {} as any,
    {
      get: (_target, method) => {
        if (typeof method !== "string") return undefined;
        return (...args: unknown[]) => call(method, args);
      },
    },
  );

  // RPC call function
  function call<T = unknown>(method: string, args: unknown[] = [], streamOpts?: StreamCallOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingCalls.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        stream: streamOpts,
      });

      const request: RPCRequest = { type: "rpc", id, method, args };
      send(request);

      // Timeout after 30s
      setTimeout(() => {
        if (pendingCalls.has(id)) {
          pendingCalls.delete(id);
          reject(new Error(`RPC call "${method}" timed out after 30s`));
        }
      }, 30_000);
    });
  }

  return {
    get connected() { return connected; },
    get identified() { return identified; },
    get ready() { return readyPromise; },
    get state() { return agentState; },
    get name() { return options.name; },

    call,
    stub,

    sendChatMessage(message: string, opts?: { id?: string }) {
      send({
        type: CHAT_TYPES.REQUEST,
        id: opts?.id || crypto.randomUUID(),
        messages: [{ role: "user", content: message }],
      });
    },

    respondToToolApproval(toolCallId: string, approved: boolean) {
      send({
        type: CHAT_TYPES.TOOL_APPROVAL,
        toolCallId,
        approved,
      });
    },

    cancelStream(requestId?: string) {
      send({
        type: CHAT_TYPES.REQUEST_CANCEL,
        ...(requestId ? { id: requestId } : {}),
      });
    },

    requestStreamResume() {
      send({ type: CHAT_TYPES.STREAM_RESUME_REQUEST });
    },

    setState(state: State) {
      agentState = state;
      send({ type: MessageType.CF_AGENT_STATE, state });
      options.onStateUpdate?.(state, "client");
    },

    close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.close(); ws = null; }
      connected = false;
    },

    reconnect() {
      if (ws) ws.close();
      reconnectAttempts = 0;
      closed = false;
      connect();
    },
  };
}
