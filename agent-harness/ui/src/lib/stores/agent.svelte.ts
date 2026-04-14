/**
 * Svelte Agent Store — thin reactive wrapper around SDK's AgentClient.
 *
 * Does NOT implement protocol logic. Uses AgentClient directly from
 * the agents SDK package. Only adds Svelte 5 reactivity ($state).
 *
 * Architecture:
 *   AgentClient (SDK) → WebSocket → Agent Worker DO (@callable + chat)
 *   api.ts (REST) → Gateway → Postgres (control-plane only)
 */

import { AgentClient } from "agents/client";
import { api } from "$lib/services/api";

// ── DO name derivation (must match gateway + server) ──
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

function parseJwtClaims(): { orgId: string; userId: string } {
  try {
    const token = api.token;
    if (!token) return { orgId: "", userId: "" };
    const payload = JSON.parse(atob(token.split(".")[1]));
    return { orgId: payload.org_id || "", userId: payload.user_id || payload.sub || "" };
  } catch { return { orgId: "", userId: "" }; }
}

// ── Reactive state ──
let client: AgentClient | null = $state(null);
let connected = $state(false);
let identified = $state(false);
let agentState = $state<unknown>(undefined);
let agentName = $state("");

// Message listeners — chat page registers to receive protocol events
let messageListeners: Array<(data: any) => void> = [];

export const agentStore = {
  get connected() { return connected; },
  get identified() { return identified; },
  get state() { return agentState; },
  get agentName() { return agentName; },
  get client() { return client; },

  /**
   * Connect to an Agent DO via SDK's AgentClient.
   * Builds DO instance name from JWT claims automatically.
   */
  connect(name: string) {
    if (client) client.close();
    agentName = name;

    const { orgId, userId } = parseJwtClaims();
    const instanceName = buildDoName(orgId, name, userId);

    // SDK's AgentClient handles: WebSocket connection, identity,
    // state sync, RPC, reconnection — all via the SDK protocol.
    client = new AgentClient({
      agent: "chat-agent",
      name: instanceName,
      // Pass JWT token via query param (browsers can't set WS headers)
      query: api.token ? { _pk: api.token } : undefined,
      onStateUpdate: (state: unknown) => { agentState = state; },
      onOpen: () => { connected = true; },
      onClose: () => { connected = false; identified = false; },
      onIdentity: () => { identified = true; },
    });

    // Forward WebSocket messages to registered listeners (chat protocol events)
    const originalOnMessage = client.onmessage;
    client.onmessage = (event: MessageEvent) => {
      // Let SDK handle its own messages first
      originalOnMessage?.call(client, event);
      // Forward to listeners for chat protocol events
      try {
        const data = JSON.parse(event.data);
        for (const listener of messageListeners) {
          listener(data);
        }
      } catch {}
    };
  },

  /** Register a listener for WebSocket messages (chat protocol events). */
  onMessage(fn: (data: any) => void): () => void {
    messageListeners.push(fn);
    return () => {
      messageListeners = messageListeners.filter(l => l !== fn);
    };
  },

  disconnect() {
    client?.close();
    client = null;
    connected = false;
    identified = false;
    agentState = undefined;
    messageListeners = [];
  },

  async call<T = unknown>(method: string, args?: unknown[]): Promise<T> {
    if (!client) throw new Error("Not connected");
    return client.call(method, args) as Promise<T>;
  },

  get stub() {
    return client?.stub ?? new Proxy({}, {
      get: () => () => Promise.reject(new Error("Not connected")),
    });
  },
};
