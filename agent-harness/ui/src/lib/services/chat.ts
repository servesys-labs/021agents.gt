/**
 * Chat service — CF Agents SDK primitives.
 *
 * Uses AgentClient (WebSocket → DO) instead of old SSE/REST proxy.
 * Provides ChatEvent types and streamAgent() for consumers that
 * need event-callback streaming (test-run pipeline, meta-agent panel).
 */

import { AgentClient } from "agents/client";
import { api } from "./api";

// ── Event types ──

export type ChatEventType =
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

export interface ChatEvent {
  type: ChatEventType;
  data: Record<string, unknown>;
}

export interface TurnStartData {
  turn: number;
  model: string;
}

export interface TokenData {
  content: string;
}

export interface ThinkingData {
  content: string;
  turn: number;
}

export interface ToolCallData {
  name: string;
  tool_call_id: string;
  args_preview: string;
}

export interface ToolResultData {
  name: string;
  tool_call_id: string;
  result: string;
  latency_ms: number;
}

export interface DoneData {
  output: string;
  cost_usd: number;
  session_id: string;
  turns: number;
  tool_calls: number;
}

export interface ErrorData {
  message: string;
}

// ── DO name derivation (mirrors agent.svelte.ts) ──

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
    return {
      orgId: payload.org_id || "",
      userId: payload.user_id || payload.sub || "",
    };
  } catch {
    return { orgId: "", userId: "" };
  }
}

// ── Think chat response → ChatEvent mapping ──

/**
 * Map Think's cf_agent_use_chat_response messages to ChatEvent callbacks.
 * Think streams back messages with parts[] containing text, tool-invocation,
 * tool-result, reasoning, and step-start/step-finish types.
 */
function mapThinkResponse(data: any, onEvent: (event: ChatEvent) => void): void {
  // Think sends cf_agent_use_chat_response with a `body` field containing
  // JSON-stringified streaming chunks (text-delta, reasoning-delta, tool-call, etc.)
  if (data.type === "cf_agent_use_chat_response") {
    // Parse the streaming chunk from body
    if (data.body) {
      try {
        const chunk = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
        switch (chunk.type) {
          case "text-delta":
            onEvent({ type: "token", data: { content: chunk.delta || chunk.textDelta || "" } });
            break;
          case "reasoning-delta":
          case "reasoning":
            onEvent({ type: "thinking", data: { content: chunk.delta || chunk.textDelta || "" } });
            break;
          case "tool-input-start":
          case "tool-input-available":
            onEvent({
              type: "tool_call",
              data: {
                name: chunk.toolName || "tool",
                tool_call_id: chunk.toolCallId || "",
                args_preview: chunk.input
                  ? JSON.stringify(chunk.input).slice(0, 200)
                  : "",
              },
            });
            break;
          case "tool-output-available":
            onEvent({
              type: "tool_result",
              data: {
                name: chunk.toolName || "tool",
                tool_call_id: chunk.toolCallId || "",
                result: typeof chunk.output === "string"
                  ? chunk.output.slice(0, 4000)
                  : JSON.stringify(chunk.output || "").slice(0, 4000),
              },
            });
            break;
          case "start-step":
            onEvent({ type: "turn_start", data: { turn: 1 } });
            break;
          case "finish-step":
            onEvent({ type: "turn_end", data: {} });
            break;
          case "finish":
            onEvent({
              type: "done",
              data: {
                output: "",
                cost_usd: chunk.usage?.totalTokens ? chunk.usage.totalTokens * 0.00001 : 0,
                session_id: "",
                turns: chunk.steps || 1,
                tool_calls: 0,
              },
            });
            break;
        }
      } catch {
        // Non-JSON body — treat as raw text
        onEvent({ type: "token", data: { content: String(data.body) } });
      }
      return;
    }

    // Fallback: older format with messages[].parts[] (AIChatAgent style)
    const messages = data.messages || [];
    for (const msg of messages) {
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        if (part.type === "text") onEvent({ type: "token", data: { content: part.text || "" } });
        else if (part.type === "reasoning") onEvent({ type: "thinking", data: { content: part.reasoning || "" } });
        else if (part.type === "tool-invocation") {
          if (part.state === "call" || part.state === "partial-call") {
            onEvent({ type: "tool_call", data: { name: part.toolName || "tool", tool_call_id: part.toolCallId || "", args_preview: JSON.stringify(part.args || {}).slice(0, 200) } });
          } else if (part.state === "result") {
            onEvent({ type: "tool_result", data: { name: part.toolName || "tool", tool_call_id: part.toolCallId || "", result: JSON.stringify(part.result || "").slice(0, 4000) } });
          }
        }
      }
    }
    return;
  }

  // Platform-level events forwarded through the WS
  if (data.type && typeof data.type === "string") {
    onEvent({ type: data.type as ChatEventType, data });
  }
}

// ── Public API ──

/**
 * Single-shot agent run via AgentClient @callable RPC.
 */
export async function runAgent(
  agentName: string,
  message: string,
  sessionId?: string,
): Promise<{ response: string; session_id: string }> {
  return new Promise((resolve, reject) => {
    const { orgId, userId } = parseJwtClaims();
    const instanceName = buildDoName(orgId, agentName, userId);

    const client = new AgentClient({
      agent: "chat-agent",
      name: instanceName,
      query: api.token ? { token: api.token } : undefined,
      onOpen: () => {
        // Send message via Think chat protocol
        const requestBody = JSON.stringify({
          messages: [{
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: message }],
          }],
          trigger: "submit-message",
        });
        client.send(JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: { method: "POST", body: requestBody },
        }));
      },
      onClose: () => {
        reject(new Error("Connection closed before response"));
      },
    });

    let response = "";

    client.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "cf_agent_use_chat_response") {
          for (const msg of data.messages || []) {
            for (const part of msg.parts || []) {
              if (part.type === "text") response += part.text || "";
            }
          }
        }
        if (data.type === "cf_agent_use_chat_finish") {
          client.close();
          resolve({
            response,
            session_id: data.session_id || "",
          });
        }
      } catch {}
    };
  });
}

/**
 * Streaming agent run via AgentClient WebSocket.
 *
 * Opens a dedicated AgentClient connection, sends the message using
 * Think's cf_agent_use_chat_request protocol, and maps streamed
 * responses to ChatEvent callbacks. Closes when done or aborted.
 *
 * Used by: test-run pipeline overlay, meta-agent panel.
 */
export function streamAgent(
  agentName: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
  sessionId?: string,
  plan?: string,
  history?: Array<{ role: string; content: string }>,
  conversationId?: string,
): { abort: () => void } {
  const { orgId, userId } = parseJwtClaims();
  const instanceName = buildDoName(orgId, agentName, userId);

  let client: AgentClient | null = null;

  try {
    client = new AgentClient({
      agent: "chat-agent",
      name: instanceName,
      query: api.token ? { token: api.token } : undefined,
      onOpen: () => {
        onEvent({ type: "connected", data: {} });

        // Build UIMessage array: history + current message
        const uiMessages: Array<{
          id: string;
          role: string;
          parts: Array<{ type: string; text: string }>;
        }> = [];

        if (history && history.length > 0) {
          for (const h of history) {
            uiMessages.push({
              id: crypto.randomUUID(),
              role: h.role,
              parts: [{ type: "text", text: h.content }],
            });
          }
        }

        uiMessages.push({
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: message }],
        });

        // Think chat protocol: init.body wrapper
        const requestBody = JSON.stringify({
          messages: uiMessages,
          trigger: "submit-message",
          ...(plan ? { plan } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(conversationId ? { conversation_id: conversationId } : {}),
        });

        client!.send(JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: { method: "POST", body: requestBody },
        }));
      },
      onClose: () => {
        // Connection closed — if we haven't received a done event,
        // the stream ended unexpectedly
      },
    });

    // Route all WS messages through the Think→ChatEvent mapper
    client.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        mapThinkResponse(data, onEvent);

        // Auto-close after done
        if (data.type === "cf_agent_use_chat_finish") {
          setTimeout(() => client?.close(), 100);
        }
      } catch {}
    };
  } catch (err) {
    onEvent({
      type: "error",
      data: { message: `Connection failed: ${(err as Error).message}` },
    });
  }

  return {
    abort: () => {
      // Send cancel signal before closing
      try {
        client?.send(JSON.stringify({ type: "cf_agent_chat_request_cancel" }));
      } catch {}
      setTimeout(() => client?.close(), 50);
      client = null;
    },
  };
}
