/**
 * useAgentStream — SSE streaming hook for agent runs.
 *
 * Connects to POST /runtime-proxy/runnable/stream and parses all event types:
 * session_start, turn_start, token, thinking, reasoning, tool_call, tool_result,
 * tool_progress, turn_end, done, error, warning, system.
 *
 * Returns structured state that the ChatInterface renders in real-time.
 */
import { useState, useCallback, useRef } from "react";

// ── Event Types ──────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  result?: string;
  error?: string;
  latency_ms?: number;
}

export interface TurnInfo {
  turn: number;
  model: string;
  cost_usd: number;
  tokens: number;
}

export interface SessionMeta {
  session_id: string;
  trace_id: string;
  agent_name: string;
  reasoning_strategy?: string;
  total_turns: number;
  total_tool_calls: number;
  total_cost_usd: number;
  latency_ms: number;
}

// ── Chat Message Types ───────────────────────────────────────

export type ChatMessageRole = "user" | "assistant" | "thinking" | "tool" | "system" | "error";

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  // Tool call metadata (role=tool)
  toolName?: string;
  toolStatus?: "running" | "done" | "error";
  toolResult?: string;
  toolError?: string;
  toolLatencyMs?: number;
  // Turn metadata (role=assistant)
  turnInfo?: TurnInfo;
  // Reasoning strategy (role=thinking)
  strategy?: string;
}

// ── Hook ─────────────────────────────────────────────────────

const API_BASE = (globalThis as any).__VITE_API_URL ?? "https://api.oneshots.co/api/v1";

let nextId = 0;
function makeId() {
  return `msg-${++nextId}-${Date.now()}`;
}

export function useAgentStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Mutable ref for building the streaming assistant message
  const streamBuf = useRef("");
  const assistantIdRef = useRef("");
  const toolCallsRef = useRef<Map<string, string>>(new Map()); // tool_call_id -> message_id
  // Conversation history for multi-turn context — persists across sends
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);

  const send = useCallback(async (agentName: string, input: string) => {
    if (streaming) return;

    // Add user message
    const userMsg: ChatMessage = {
      id: makeId(), role: "user", content: input, timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setStreaming(true);
    setSessionMeta(null);
    streamBuf.current = "";
    assistantIdRef.current = "";
    toolCallsRef.current.clear();

    // Add to conversation history for multi-turn context
    historyRef.current.push({ role: "user", content: input });

    const token = localStorage.getItem("agentos_token");
    if (!token) {
      setMessages(prev => [...prev, {
        id: makeId(), role: "error", content: "Sign in required to use the playground.",
        timestamp: new Date().toISOString(),
      }]);
      setStreaming(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(`${API_BASE}/runtime-proxy/runnable/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agent_name: agentName,
          input,
          // Pass conversation history for multi-turn context
          history: historyRef.current.slice(0, -1), // exclude current message (already in input)
        }),
        signal: controller.signal,
      });

      if (resp.status === 401) {
        localStorage.removeItem("agentos_token");
        window.location.href = "/login";
        return;
      }

      if (resp.status === 402) {
        setMessages(prev => [...prev, {
          id: makeId(), role: "error",
          content: "You've run out of credits. [Buy more credits](/settings?tab=billing) to continue using your assistant.",
          timestamp: new Date().toISOString(),
        }]);
        setStreaming(false);
        return;
      }

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "Unknown error");
        throw new Error(text);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json || json === "[DONE]") continue;

          try {
            const event = JSON.parse(json) as StreamEvent;
            processEvent(event);
          } catch {
            // Malformed JSON — skip
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setMessages(prev => [...prev, {
        id: makeId(), role: "error",
        content: `Connection error: ${err.message || "Failed to reach agent"}`,
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming]);

  function processEvent(event: StreamEvent) {
    switch (event.type) {
      case "session_start":
        // Session started — store metadata
        break;

      case "reasoning": {
        // Reasoning strategy selected
        const strategyMsg: ChatMessage = {
          id: makeId(), role: "system",
          content: `Reasoning: ${event.strategy || "auto"} strategy activated`,
          timestamp: new Date().toISOString(),
          strategy: String(event.strategy || "auto"),
        };
        setMessages(prev => [...prev, strategyMsg]);
        break;
      }

      case "thinking": {
        // Agent's internal reasoning before tool calls
        const thinkMsg: ChatMessage = {
          id: makeId(), role: "thinking",
          content: String(event.content || ""),
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, thinkMsg]);
        break;
      }

      case "turn_start":
        // New turn starting — could show model indicator
        break;

      case "token": {
        // Streaming token — append to current assistant message
        const chunk = String(event.content || event.token || "");
        if (!chunk) break;
        streamBuf.current += chunk;

        if (!assistantIdRef.current) {
          assistantIdRef.current = makeId();
          setMessages(prev => [...prev, {
            id: assistantIdRef.current, role: "assistant",
            content: streamBuf.current,
            timestamp: new Date().toISOString(),
          }]);
        } else {
          const content = streamBuf.current;
          const msgId = assistantIdRef.current;
          setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, content } : m
          ));
        }
        break;
      }

      case "tool_call": {
        // Tool execution started
        const toolMsgId = makeId();
        toolCallsRef.current.set(String(event.tool_call_id || event.name), toolMsgId);
        const toolMsg: ChatMessage = {
          id: toolMsgId, role: "tool",
          content: "",
          timestamp: new Date().toISOString(),
          toolName: String(event.name || ""),
          toolStatus: "running",
        };
        setMessages(prev => [...prev, toolMsg]);
        // Reset assistant buffer for next text after tools
        streamBuf.current = "";
        assistantIdRef.current = "";
        break;
      }

      case "tool_result": {
        // Tool execution completed
        const key = String(event.tool_call_id || event.name);
        const existingId = toolCallsRef.current.get(key);
        if (existingId) {
          setMessages(prev => prev.map(m =>
            m.id === existingId ? {
              ...m,
              toolStatus: event.error ? "error" as const : "done" as const,
              toolResult: String(event.result || "").slice(0, 2000),
              toolError: event.error ? String(event.error) : undefined,
              toolLatencyMs: Number(event.latency_ms) || undefined,
            } : m
          ));
        }
        break;
      }

      case "tool_progress": {
        // Long-running tool progress update
        const key = String(event.tool_call_id || event.tool || "");
        const existingId = toolCallsRef.current.get(key);
        if (existingId) {
          setMessages(prev => prev.map(m =>
            m.id === existingId ? {
              ...m, content: String(event.message || m.content),
            } : m
          ));
        }
        break;
      }

      case "turn_end": {
        // Turn completed — attach cost info to last assistant message
        if (assistantIdRef.current) {
          const turnInfo: TurnInfo = {
            turn: Number(event.turn) || 0,
            model: String(event.model || ""),
            cost_usd: Number(event.cost_usd) || 0,
            tokens: Number(event.tokens) || 0,
          };
          const msgId = assistantIdRef.current;
          setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, turnInfo } : m
          ));
        }
        break;
      }

      case "done": {
        // Run complete
        setSessionMeta({
          session_id: String(event.session_id || ""),
          trace_id: String(event.trace_id || ""),
          agent_name: String(event.agent_name || ""),
          total_turns: Number(event.turns) || 0,
          total_tool_calls: Number(event.tool_calls) || 0,
          total_cost_usd: Number(event.cost_usd) || 0,
          latency_ms: Number(event.latency_ms) || 0,
        });

        // Capture assistant response into conversation history for multi-turn
        const finalOutput = String(event.output || streamBuf.current || "");
        if (finalOutput) {
          historyRef.current.push({ role: "assistant", content: finalOutput });
        }

        // If we have output but no streamed tokens (non-streaming model), add it
        if (finalOutput && !assistantIdRef.current) {
          setMessages(prev => [...prev, {
            id: makeId(), role: "assistant", content: finalOutput,
            timestamp: new Date().toISOString(),
          }]);
        }
        break;
      }

      case "error": {
        setMessages(prev => [...prev, {
          id: makeId(), role: "error",
          content: String(event.message || "Unknown error"),
          timestamp: new Date().toISOString(),
        }]);
        break;
      }

      case "warning": {
        setMessages(prev => [...prev, {
          id: makeId(), role: "system",
          content: `Warning: ${event.message || ""}`,
          timestamp: new Date().toISOString(),
        }]);
        break;
      }

      case "system": {
        setMessages(prev => [...prev, {
          id: makeId(), role: "system",
          content: String(event.message || ""),
          timestamp: new Date().toISOString(),
        }]);
        break;
      }
    }
  }

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setSessionMeta(null);
    historyRef.current = [];
  }, []);

  return { messages, streaming, sessionMeta, send, stop, clear };
}
