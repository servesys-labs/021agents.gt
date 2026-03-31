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

export type ChatMessageRole = "user" | "assistant" | "thinking" | "tool" | "system" | "error" | "file_change";

export interface FileChange {
  changeType: "create" | "edit";
  path: string;
  language: string;
  content?: string;      // For create — full file content
  oldText?: string;      // For edit — text that was replaced
  newText?: string;      // For edit — replacement text
  size?: number;
}

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
  toolArgsPreview?: string;
  toolCostUsd?: number;
  // File change metadata (role=file_change)
  fileChange?: FileChange;
  // Turn metadata (role=assistant)
  turnInfo?: TurnInfo;
  // Reasoning strategy (role=thinking)
  strategy?: string;
}

// ── Transport: WebSocket (primary) + SSE (fallback) ─────────
//
// Architecture:
//   WebSocket: Browser → DO Agent (direct, bidirectional, reconnectable)
//   SSE:       Browser → Control-Plane Worker → KV poll → SSE stream (legacy)
//
// WebSocket is preferred because:
//   - Direct connection to DO (no proxy hop)
//   - Bidirectional (client can cancel, send mid-stream)
//   - Reconnect with seq-num (no event replay from scratch)
//   - Lower latency (~50ms vs ~200ms for SSE through CP)
//   - DO maintains session state (conversation persists)
//
// SSE fallback exists for:
//   - Environments that block WebSocket (corporate proxies)
//   - Server-to-server API usage (no persistent connection)

const API_BASE = (globalThis as any).__VITE_API_URL ?? "https://api.oneshots.co/api/v1";
const WS_BASE = (globalThis as any).__VITE_WS_URL ?? "wss://runtime.oneshots.co";

let nextId = 0;
function makeId() {
  return `msg-${++nextId}-${Date.now()}`;
}

const STORAGE_KEY_PREFIX = "oneshots_chat_";
const SESSIONS_KEY_PREFIX = "oneshots_sessions_";
const MAX_STORED_MESSAGES = 50;
const MAX_SESSIONS = 20;

export interface StoredSession {
  id: string;
  agentName: string;
  title: string; // first user message truncated
  updatedAt: string;
  messageCount: number;
}

function getSessionListKey(agentName: string) { return SESSIONS_KEY_PREFIX + agentName; }
function getSessionDataKey(agentName: string, sessionId: string) { return STORAGE_KEY_PREFIX + agentName + "_" + sessionId; }

function loadSessionList(agentName: string): StoredSession[] {
  try {
    const raw = localStorage.getItem(getSessionListKey(agentName));
    if (!raw) return [];
    return JSON.parse(raw) as StoredSession[];
  } catch { return []; }
}

function saveSessionList(agentName: string, sessions: StoredSession[]) {
  try {
    localStorage.setItem(getSessionListKey(agentName), JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {}
}

function loadStoredMessages(agentName: string, sessionId?: string): ChatMessage[] {
  try {
    // Try session-specific key first
    if (sessionId) {
      const raw = localStorage.getItem(getSessionDataKey(agentName, sessionId));
      if (raw) return JSON.parse(raw) as ChatMessage[];
    }
    // Fallback: load legacy single-session key and migrate
    const legacyKey = STORAGE_KEY_PREFIX + agentName;
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return [];
    const msgs = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(msgs) || msgs.length === 0) return [];
    // Migrate legacy to session format
    const newSessionId = "session_" + Date.now();
    localStorage.setItem(getSessionDataKey(agentName, newSessionId), raw);
    localStorage.removeItem(legacyKey);
    const title = msgs.find(m => m.role === "user")?.content.slice(0, 60) || "Conversation";
    const sessions = loadSessionList(agentName);
    sessions.unshift({ id: newSessionId, agentName, title, updatedAt: new Date().toISOString(), messageCount: msgs.length });
    saveSessionList(agentName, sessions);
    return msgs.slice(-MAX_STORED_MESSAGES);
  } catch { return []; }
}

function storeMessages(agentName: string, msgs: ChatMessage[], sessionId: string) {
  try {
    const toStore = msgs
      .filter(m => m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "thinking")
      .filter(m => m.role !== "tool" || m.toolStatus !== "running") // skip in-progress tool calls
      .slice(-MAX_STORED_MESSAGES);
    localStorage.setItem(getSessionDataKey(agentName, sessionId), JSON.stringify(toStore));
    // Update session list
    const sessions = loadSessionList(agentName);
    const existing = sessions.findIndex(s => s.id === sessionId);
    const title = toStore.find(m => m.role === "user")?.content.slice(0, 60) || "Conversation";
    const entry: StoredSession = { id: sessionId, agentName, title, updatedAt: new Date().toISOString(), messageCount: toStore.length };
    if (existing >= 0) {
      sessions[existing] = entry;
    } else {
      sessions.unshift(entry);
    }
    saveSessionList(agentName, sessions);
  } catch {}
}

function deleteSession(agentName: string, sessionId: string) {
  try {
    localStorage.removeItem(getSessionDataKey(agentName, sessionId));
    const sessions = loadSessionList(agentName).filter(s => s.id !== sessionId);
    saveSessionList(agentName, sessions);
  } catch {}
}

export { loadSessionList, deleteSession };

// ── Server-backed session persistence ───────────────────────
// Sessions and turns are stored in the DB by the runtime.
// These functions fetch them from the API so chat history
// survives incognito, device switches, and cache clears.
// localStorage is kept as a write-through cache for instant loads.

export interface ServerSession {
  session_id: string;
  agent_name: string;
  status: string;
  input_text: string;
  output_text: string;
  step_count: number;
  cost_total_usd: number;
  wall_clock_seconds: number;
  created_at: string | number;
}

export interface ServerTurn {
  turn_number: number;
  model_used: string;
  content: string;
  input_tokens: number;
  output_tokens: number;
  cost_total_usd: number;
  latency_ms: number;
  tool_calls: Array<{ id?: string; name: string; arguments?: string | Record<string, unknown> }>;
  tool_results?: Array<{ name: string; result?: string; error?: string; latency_ms?: number; cost_usd?: number }>;
  execution_mode: string;
  started_at: string | number;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("agentos_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

/** Fetch session list from server for an agent. Returns newest first. */
export async function fetchServerSessions(agentName: string, limit = 20): Promise<StoredSession[]> {
  try {
    const resp = await fetch(
      `${API_BASE}/sessions?agent_name=${encodeURIComponent(agentName)}&limit=${limit}`,
      { headers: authHeaders() },
    );
    if (!resp.ok) return [];
    const rows = await resp.json() as ServerSession[];
    if (!Array.isArray(rows)) return [];

    const sessions: StoredSession[] = rows.map(r => ({
      id: r.session_id,
      agentName: r.agent_name,
      title: (r.input_text || "Conversation").slice(0, 60),
      updatedAt: typeof r.created_at === "number"
        ? new Date(r.created_at).toISOString()
        : String(r.created_at || new Date().toISOString()),
      messageCount: r.step_count || 1,
    }));

    // Merge into localStorage cache so next load is instant
    try {
      const cached = loadSessionList(agentName);
      const merged = new Map<string, StoredSession>();
      for (const s of sessions) merged.set(s.id, s);
      for (const s of cached) { if (!merged.has(s.id)) merged.set(s.id, s); }
      const all = [...merged.values()].sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ).slice(0, MAX_SESSIONS);
      saveSessionList(agentName, all);
    } catch {}

    return sessions;
  } catch {
    // Offline fallback — return localStorage cache
    return loadSessionList(agentName);
  }
}

/** Fetch turns from server and reconstruct ChatMessage array. */
export async function fetchSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  try {
    // Fetch session detail + turns in parallel
    const [sessResp, turnsResp] = await Promise.all([
      fetch(`${API_BASE}/sessions/${sessionId}`, { headers: authHeaders() }),
      fetch(`${API_BASE}/sessions/${sessionId}/turns`, { headers: authHeaders() }),
    ]);
    if (!sessResp.ok || !turnsResp.ok) return [];

    const session = await sessResp.json() as ServerSession & { input_text: string; output_text: string };
    const turns = await turnsResp.json() as ServerTurn[];
    if (!Array.isArray(turns)) return [];

    const messages: ChatMessage[] = [];

    // First user message from session input
    if (session.input_text) {
      messages.push({
        id: `srv-user-0`,
        role: "user",
        content: session.input_text,
        timestamp: typeof session.created_at === "number"
          ? new Date(session.created_at).toISOString()
          : String(session.created_at),
      });
    }

    // Reconstruct from turns
    for (const turn of turns) {
      // Tool calls for this turn
      if (turn.tool_calls && turn.tool_calls.length > 0) {
        for (let tci = 0; tci < turn.tool_calls.length; tci++) {
          const tc = turn.tool_calls[tci];
          let argsPreview = "";
          try {
            const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments || "{}") : (tc.arguments || {});
            argsPreview = args.query || args.code?.slice(0, 120) || args.url || args.path || "";
          } catch {}
          // Match tool result by index (tool_calls and tool_results are parallel arrays)
          const tr = turn.tool_results?.[tci];
          messages.push({
            id: `srv-tool-${turn.turn_number}-${tc.name}-${tc.id || tci}`,
            role: "tool",
            content: "",
            timestamp: typeof turn.started_at === "number" ? new Date(turn.started_at).toISOString() : String(turn.started_at),
            toolName: tc.name,
            toolStatus: tr?.error ? "error" : "done",
            toolArgsPreview: argsPreview || undefined,
            toolResult: tr?.result?.slice(0, 2000) || undefined,
            toolError: tr?.error || undefined,
            toolLatencyMs: tr?.latency_ms || undefined,
            toolCostUsd: tr?.cost_usd || undefined,
          });
        }
      }

      // Assistant response
      if (turn.content) {
        messages.push({
          id: `srv-asst-${turn.turn_number}`,
          role: "assistant",
          content: turn.content,
          timestamp: typeof turn.started_at === "number" ? new Date(turn.started_at).toISOString() : String(turn.started_at),
          turnInfo: {
            turn: turn.turn_number,
            model: turn.model_used,
            cost_usd: turn.cost_total_usd,
            tokens: turn.input_tokens + turn.output_tokens,
          },
        });
      }
    }

    // If no turns but we have output, show it
    if (turns.length === 0 && session.output_text) {
      messages.push({
        id: `srv-asst-final`,
        role: "assistant",
        content: session.output_text,
        timestamp: typeof session.created_at === "number"
          ? new Date(session.created_at).toISOString()
          : String(session.created_at),
      });
    }

    // Cache in localStorage for instant next load
    if (messages.length > 0 && session.agent_name) {
      storeMessages(session.agent_name, messages, sessionId);
    }

    return messages;
  } catch {
    return [];
  }
}

export function useAgentStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentAgentRef = useRef("");
  const currentSessionIdRef = useRef("session_" + Date.now());

  // Mutable ref for building the streaming assistant message
  const streamBuf = useRef("");
  const assistantIdRef = useRef("");
  const toolCallsRef = useRef<Map<string, string>>(new Map()); // tool_call_id -> message_id
  // Conversation history for multi-turn context — persists across sends
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);

  // Load conversation when agent is set/changed.
  // DB is the source of truth. localStorage is a write-through cache for instant paint.
  // Flow: show cache instantly → fetch from server → replace with server data.
  const loadHistory = useCallback((agentName: string, sessionId?: string) => {
    if (!agentName) return;
    currentAgentRef.current = agentName;

    const setMsgs = (msgs: ChatMessage[]) => {
      setMessages(msgs);
      historyRef.current = msgs
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
    };

    // Resolve session ID
    if (sessionId) {
      currentSessionIdRef.current = sessionId;
    } else {
      // Check cache for most recent session
      const cached = loadSessionList(agentName);
      if (cached.length > 0) currentSessionIdRef.current = cached[0].id;
    }

    // 1. Instant paint from localStorage cache (may be stale or empty)
    const cachedMsgs = loadStoredMessages(agentName, currentSessionIdRef.current);
    if (cachedMsgs.length > 0) setMsgs(cachedMsgs);

    // 2. Always fetch from server — DB is source of truth
    const targetSession = currentSessionIdRef.current;
    if (sessionId) {
      // Loading a specific session — fetch its messages from server
      fetchSessionMessages(sessionId).then(msgs => {
        if (msgs.length > 0 && currentSessionIdRef.current === targetSession) {
          setMsgs(msgs);
        }
      });
    } else {
      // Loading most recent — fetch session list from server, then load the latest
      fetchServerSessions(agentName, 1).then(sessions => {
        if (sessions.length > 0 && currentAgentRef.current === agentName) {
          const latest = sessions[0];
          currentSessionIdRef.current = latest.id;
          fetchSessionMessages(latest.id).then(msgs => {
            if (msgs.length > 0 && currentSessionIdRef.current === latest.id) {
              setMsgs(msgs);
            }
          });
        }
      });
    }
  }, []);

  // Active plan override — can be changed mid-session
  const planRef = useRef<string | undefined>(undefined);

  const setPlan = useCallback((plan: string | undefined) => {
    planRef.current = plan;
  }, []);

  // WebSocket connection ref (persists across sends for multi-turn)
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const wsReconnectAttempts = useRef(0);

  // Connect to DO WebSocket (or reuse existing connection)
  function getOrCreateWs(agentName: string, token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        resolve(wsRef.current);
        return;
      }

      // Close stale connection
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }

      // Build DO WebSocket URL: runtime.oneshots.co/agent/{org}-{agent}-{user}
      // The DO name encodes org+agent+user for session affinity
      const orgId = localStorage.getItem("agentos_org_id") || "default";
      const userId = localStorage.getItem("agentos_user_id") || "web";
      const doName = `${orgId}-${agentName}-${userId}`;
      const wsUrl = `${WS_BASE}/agents/agentos-agent/${encodeURIComponent(doName)}`;

      const ws = new WebSocket(wsUrl);
      let resolved = false;

      ws.onopen = () => {
        wsReconnectAttempts.current = 0;

        // Authenticate via first message
        ws.send(JSON.stringify({ type: "auth", token }));

        // If reconnecting, request missed events
        if (lastSeqRef.current > 0) {
          ws.send(JSON.stringify({
            type: "reconnect",
            from_seq: lastSeqRef.current,
            progress_key: `progress/${currentSessionIdRef.current}`,
          }));
        }

        resolved = true;
        resolve(ws);
      };

      ws.onerror = (err) => {
        if (!resolved) reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        wsRef.current = null;
      };

      wsRef.current = ws;
    });
  }

  const send = useCallback(async (agentName: string, input: string) => {
    if (streaming) return;
    if (currentAgentRef.current !== agentName) {
      loadHistory(agentName);
    }

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

    // Try WebSocket first, fall back to SSE
    try {
      const ws = await getOrCreateWs(agentName, token).catch(() => null);

      if (ws && ws.readyState === WebSocket.OPEN) {
        // ── WebSocket transport (primary) ──
        await sendViaWebSocket(ws, agentName, input);
      } else {
        // ── SSE transport (fallback) ──
        await sendViaSSE(agentName, input, token);
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setMessages(prev => {
        const updated = [...prev, {
          id: makeId(), role: "error" as const,
          content: `Connection error: ${err.message || "Failed to reach agent"}`,
          timestamp: new Date().toISOString(),
        }];
        if (currentAgentRef.current) storeMessages(currentAgentRef.current, updated, currentSessionIdRef.current);
        return updated;
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming]);

  // ── WebSocket send ──────────────────────────────────────────
  async function sendViaWebSocket(ws: WebSocket, agentName: string, input: string) {
    return new Promise<void>((resolve, reject) => {
      const onMessage = (evt: MessageEvent) => {
        try {
          const event = JSON.parse(evt.data) as StreamEvent;

          // Track seq-num for reconnect
          if (typeof (event as any)._seq === "number") {
            lastSeqRef.current = (event as any)._seq;
          }

          // Process event (same handler as SSE)
          processEvent(event);

          // Done event = resolve the promise
          if (event.type === "done") {
            ws.removeEventListener("message", onMessage);
            ws.removeEventListener("error", onError);
            resolve();
          }
        } catch {}
      };

      const onError = () => {
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("error", onError);
        reject(new Error("WebSocket error during streaming"));
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);

      // Send run request
      ws.send(JSON.stringify({
        type: "run",
        input,
        agent_name: agentName,
        session_id: currentSessionIdRef.current,
        history: historyRef.current.slice(0, -1),
        ...(planRef.current ? { plan: planRef.current } : {}),
      }));
    });
  }

  // ── SSE send (fallback) ─────────────────────────────────────
  async function sendViaSSE(agentName: string, input: string, token: string) {
    const controller = new AbortController();
    abortRef.current = controller;

    const resp = await fetch(`${API_BASE}/runtime-proxy/runnable/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agent_name: agentName,
        input,
        session_id: currentSessionIdRef.current,
        history: historyRef.current.slice(0, -1),
        ...(planRef.current ? { plan: planRef.current } : {}),
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
        } catch {}
      }
    }
  }

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
          toolArgsPreview: event.args_preview ? String(event.args_preview) : undefined,
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
          setMessages(prev => {
            const updated = prev.map(m =>
              m.id === existingId ? {
                ...m,
                toolStatus: event.error ? "error" as const : "done" as const,
                toolResult: String(event.result || "").slice(0, 2000),
                toolError: event.error ? String(event.error) : undefined,
                toolLatencyMs: Number(event.latency_ms) || undefined,
                toolCostUsd: Number(event.cost_usd) || undefined,
              } : m
            );
            // Persist incrementally — survives page refresh mid-stream
            if (currentAgentRef.current) storeMessages(currentAgentRef.current, updated, currentSessionIdRef.current);
            return updated;
          });
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

      case "file_change": {
        // File created or edited — show inline code preview
        const fileMsg: ChatMessage = {
          id: makeId(), role: "file_change",
          content: String(event.path || ""),
          timestamp: new Date().toISOString(),
          fileChange: {
            changeType: String(event.change_type || "create") as "create" | "edit",
            path: String(event.path || ""),
            language: String(event.language || ""),
            content: event.content ? String(event.content) : undefined,
            oldText: event.old_text ? String(event.old_text) : undefined,
            newText: event.new_text ? String(event.new_text) : undefined,
            size: Number(event.size) || undefined,
          },
        };
        setMessages(prev => [...prev, fileMsg]);
        break;
      }

      case "tool_calls": {
        // Plural tool_calls event — emit individual tool cards
        const toolNames = Array.isArray(event.tools) ? event.tools : [];
        for (const name of toolNames) {
          const toolMsgId = makeId();
          toolCallsRef.current.set(String(name), toolMsgId);
          setMessages(prev => [...prev, {
            id: toolMsgId, role: "tool" as const,
            content: "",
            timestamp: new Date().toISOString(),
            toolName: String(name),
            toolStatus: "running" as const,
          }]);
        }
        streamBuf.current = "";
        assistantIdRef.current = "";
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
          setMessages(prev => {
            const updated = prev.map(m =>
              m.id === msgId ? { ...m, turnInfo } : m
            );
            // Persist after each turn — survives page refresh between turns
            if (currentAgentRef.current) storeMessages(currentAgentRef.current, updated, currentSessionIdRef.current);
            return updated;
          });
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

        // If we have output but no streamed tokens, add a new assistant message
        // If tokens were streamed, update the existing message with the final complete output
        if (finalOutput) {
          if (assistantIdRef.current) {
            // Update existing streamed message with final output (ensures completeness)
            const msgId = assistantIdRef.current;
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, content: finalOutput } : m
            ));
          } else {
            // No streaming happened — create the message
            setMessages(prev => [...prev, {
              id: makeId(), role: "assistant", content: finalOutput,
              timestamp: new Date().toISOString(),
            }]);
          }
        }

        // Persist conversation to localStorage
        setMessages(prev => {
          if (currentAgentRef.current) storeMessages(currentAgentRef.current, prev, currentSessionIdRef.current);
          return prev;
        });
        break;
      }

      case "error": {
        setMessages(prev => {
          const updated = [...prev, {
            id: makeId(), role: "error" as const,
            content: String(event.message || "Unknown error"),
            timestamp: new Date().toISOString(),
          }];
          if (currentAgentRef.current) storeMessages(currentAgentRef.current, updated, currentSessionIdRef.current);
          return updated;
        });
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
    // Cancel SSE if active
    abortRef.current?.abort();
    abortRef.current = null;
    // Send cancel to WebSocket (DO can abort tools)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: "cancel" })); } catch {}
    }
    setStreaming(false);
    // Finalize any partial assistant message
    if (streamBuf.current && assistantIdRef.current) {
      const finalContent = streamBuf.current;
      const msgId = assistantIdRef.current;
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: finalContent } : m
      ));
    }
    // Mark any running tools as stopped
    setMessages(prev => prev.map(m =>
      m.role === "tool" && (m as any).toolStatus === "running"
        ? { ...m, toolStatus: "error" as const, toolError: "Stopped by user" }
        : m
    ));
    // Save conversation even if stopped early
    if (currentAgentRef.current) {
      setMessages(prev => {
        storeMessages(currentAgentRef.current, prev, currentSessionIdRef.current);
        return prev;
      });
    }
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setSessionMeta(null);
    historyRef.current = [];
    // Start a new session (old one stays in session list)
    currentSessionIdRef.current = "session_" + Date.now();
  }, []);

  const retry = useCallback((messageId: string) => {
    if (!currentAgentRef.current) return;
    // Use functional update to read current messages (avoids stale closure)
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === messageId);
      if (idx < 0) return prev;
      // Find the last user message before this assistant message
      let lastUserContent = "";
      for (let i = idx - 1; i >= 0; i--) {
        if (prev[i].role === "user") {
          lastUserContent = prev[i].content;
          break;
        }
      }
      if (!lastUserContent) return prev;
      // Trim history to match — find the last user message in historyRef
      let histIdx = -1;
      for (let j = historyRef.current.length - 1; j >= 0; j--) {
        if (historyRef.current[j].role === "user" && historyRef.current[j].content === lastUserContent) {
          histIdx = j;
          break;
        }
      }
      if (histIdx >= 0) {
        historyRef.current = historyRef.current.slice(0, histIdx);
      }
      // Schedule re-send after state update
      setTimeout(() => send(currentAgentRef.current, lastUserContent), 50);
      return prev.slice(0, idx);
    });
  }, [send]);

  return { messages, streaming, sessionMeta, send, stop, clear, loadHistory, retry, setPlan, currentSessionId: currentSessionIdRef.current };
}
