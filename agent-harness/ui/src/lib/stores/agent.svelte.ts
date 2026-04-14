/**
 * Svelte reactive agent store — bridges AgentClient to Svelte 5 reactivity.
 *
 * Usage in components:
 *   import { agentStore } from "$lib/stores/agent.svelte";
 *
 *   // Connect to an agent
 *   agentStore.connect("my-agent");
 *
 *   // Reactive state
 *   {#if agentStore.connected}
 *     <p>State: {JSON.stringify(agentStore.state)}</p>
 *   {/if}
 *
 *   // RPC calls
 *   const servers = await agentStore.call("listServers");
 *   await agentStore.stub.addServer("github", "https://...");
 *
 *   // Chat (SDK protocol)
 *   agentStore.sendChat("Hello!");
 *
 * Architecture:
 *   This store handles AGENT-INTERACTIVE operations (chat, MCP, skills).
 *   Control-plane operations (auth, billing, org) still use REST via api.ts.
 */

import {
  createAgent,
  buildDoName,
  parseJwtClaims,
  CHAT_TYPES,
  type SvelteAgentClient,
} from "$lib/services/agent-client";

// ── Reactive state (Svelte 5 runes) ──

let client: SvelteAgentClient | null = $state(null);
let connected = $state(false);
let identified = $state(false);
let agentState = $state<unknown>(undefined);
let agentName = $state("");
let chatMessages = $state<Array<{ id: string; role: string; content: string; parts?: unknown[] }>>([]);
let isStreaming = $state(false);
let currentStreamText = $state("");

// ── Store API ──

export const agentStore = {
  // Reactive getters
  get connected() { return connected; },
  get identified() { return identified; },
  get state() { return agentState; },
  get agentName() { return agentName; },
  get messages() { return chatMessages; },
  get isStreaming() { return isStreaming; },
  get streamText() { return currentStreamText; },
  get client() { return client; },

  /** Connect to an agent DO via WebSocket RPC (SDK protocol). */
  connect(name: string, opts?: { host?: string }) {
    // Disconnect existing connection
    if (client) client.close();

    agentName = name;
    const { orgId, userId } = parseJwtClaims();
    const doName = buildDoName(orgId, name, userId);

    client = createAgent({
      agent: "chat-agent",
      name: doName,
      host: opts?.host,
      onStateUpdate: (state) => {
        agentState = state;
      },
      onIdentity: (_name, _agent) => {
        identified = true;
      },
      onOpen: () => {
        connected = true;
      },
      onClose: () => {
        connected = false;
        identified = false;
      },
      onMessage: (data: any) => {
        // Handle SDK chat protocol messages
        if (data.type === CHAT_TYPES.MESSAGES) {
          // Full message list sync from server
          chatMessages = data.messages || [];
          isStreaming = false;
        }
        if (data.type === CHAT_TYPES.RESPONSE) {
          // Streaming response chunk
          isStreaming = true;
          if (data.messages) {
            chatMessages = data.messages;
          }
          // Extract text from the latest assistant message
          const lastAssistant = [...(data.messages || [])].reverse().find((m: any) => m.role === "assistant");
          if (lastAssistant) {
            currentStreamText = typeof lastAssistant.content === "string"
              ? lastAssistant.content
              : "";
          }
        }
        if (data.type === CHAT_TYPES.RESPONSE && data.done) {
          isStreaming = false;
        }
        // Broadcast events (reliability alerts, streaming_done, etc.)
        if (data.type === "streaming_done") {
          isStreaming = false;
        }
        if (data.type === "reliability_alert" || data.type === "budget_warning" || data.type === "budget_exceeded") {
          // These could be surfaced in the UI via a notification system
          console.warn(`[agent] ${data.type}:`, data);
        }
      },
    });

    return client.ready;
  },

  /** Disconnect from the current agent. */
  disconnect() {
    if (client) {
      client.close();
      client = null;
    }
    connected = false;
    identified = false;
    agentState = undefined;
    chatMessages = [];
    isStreaming = false;
    currentStreamText = "";
  },

  /** Call a @callable method on the agent DO (WebSocket RPC). */
  async call<T = unknown>(method: string, args?: unknown[]): Promise<T> {
    if (!client) throw new Error("Not connected to an agent");
    return client.call<T>(method, args);
  },

  /** Typed stub proxy for @callable methods. */
  get stub(): Record<string, (...args: unknown[]) => Promise<unknown>> {
    if (!client) {
      return new Proxy({} as any, {
        get: () => () => Promise.reject(new Error("Not connected")),
      });
    }
    return client.stub;
  },

  /** Send a chat message via SDK protocol (not REST). */
  sendChat(message: string) {
    if (!client) throw new Error("Not connected to an agent");
    // Add optimistic user message
    chatMessages = [...chatMessages, {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
    }];
    isStreaming = true;
    currentStreamText = "";
    client.sendChatMessage(message);
  },

  /** Clear chat messages. */
  clearChat() {
    chatMessages = [];
    if (client) {
      // Tell server to clear via SDK protocol
      (client as any).send?.({ type: CHAT_TYPES.CLEAR });
    }
  },
};
