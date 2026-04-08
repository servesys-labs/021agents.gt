import { useState, useRef, useEffect, useCallback } from "react";
import {
  X, Send, Wrench, Loader2, Sparkles, ChevronRight, ChevronDown, Radio, Plus, Clock,
  Trash2, Copy, Check, RefreshCw, AlertTriangle, Brain, Square, Maximize2, Minimize2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";
import { TrainingStreamPanel } from "./TrainingStreamPanel";
import { timeAgo } from "../lib/time-ago";

// ── Types ───────────────────────────────────────────────────

interface MetaMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
  isToolActivity?: boolean;
  toolName?: string;
  toolStatus?: "running" | "done" | "error";
  toolResult?: string;
  toolError?: string;
  toolLatencyMs?: number;
  toolArgsPreview?: string;
  toolCostUsd?: number;
}

interface MetaAgentPanelProps {
  agentName: string;
  open: boolean;
  onClose: () => void;
  context?: "test" | "settings" | "activity" | "tests" | "knowledge" | "channels" | "general";
  /** "demo" = showcase mode, "live" = production interview mode */
  initialMode?: "demo" | "live";
}

// ── Session Persistence ─────────────────────────────────────

interface MetaSession {
  id: string;
  agentName: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

const META_SESSIONS_KEY = "oneshots_meta_sessions_";
const META_CHAT_KEY = "oneshots_meta_chat_";
const MAX_META_SESSIONS = 20;
const MAX_META_MESSAGES = 100;

function getSessionListKey(agentName: string) { return META_SESSIONS_KEY + agentName; }
function getSessionDataKey(agentName: string, sessionId: string) { return META_CHAT_KEY + agentName + "_" + sessionId; }

function loadMetaSessionList(agentName: string): MetaSession[] {
  try {
    const raw = localStorage.getItem(getSessionListKey(agentName));
    return raw ? JSON.parse(raw) as MetaSession[] : [];
  } catch { return []; }
}

function saveMetaSessionList(agentName: string, sessions: MetaSession[]) {
  try {
    localStorage.setItem(getSessionListKey(agentName), JSON.stringify(sessions.slice(0, MAX_META_SESSIONS)));
  } catch {}
}

function loadMetaMessages(agentName: string, sessionId: string): MetaMessage[] {
  try {
    const raw = localStorage.getItem(getSessionDataKey(agentName, sessionId));
    return raw ? JSON.parse(raw) as MetaMessage[] : [];
  } catch { return []; }
}

function storeMetaMessages(agentName: string, sessionId: string, msgs: MetaMessage[]) {
  try {
    const toStore = msgs.slice(-MAX_META_MESSAGES);
    localStorage.setItem(getSessionDataKey(agentName, sessionId), JSON.stringify(toStore));

    const sessions = loadMetaSessionList(agentName);
    const title = toStore.find(m => m.role === "user")?.content.slice(0, 60) || "Conversation";
    const entry: MetaSession = {
      id: sessionId, agentName, title,
      updatedAt: new Date().toISOString(),
      messageCount: toStore.filter(m => !m.isToolActivity).length,
    };
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) sessions[idx] = entry; else sessions.unshift(entry);
    saveMetaSessionList(agentName, sessions);
  } catch {}
}

function deleteMetaSession(agentName: string, sessionId: string) {
  try {
    localStorage.removeItem(getSessionDataKey(agentName, sessionId));
    const sessions = loadMetaSessionList(agentName).filter(s => s.id !== sessionId);
    saveMetaSessionList(agentName, sessions);
  } catch {}
}

// ── Starter Prompts ─────────────────────────────────────────

const CONTEXT_STARTERS: Record<string, { label: string; prompt: string }[]> = {
  test: [
    { label: "Why are responses slow?", prompt: "Analyze my agent's response latency and suggest improvements to make it faster." },
    { label: "Improve response quality", prompt: "Review recent conversations and suggest how to improve the system prompt for better, more detailed responses." },
    { label: "Add more tools", prompt: "What tools should this agent have that it's currently missing? Suggest tools based on how users interact with it." },
    { label: "Make it use citations", prompt: "Update the system prompt so the agent always includes source links when citing web search results." },
  ],
  settings: [
    { label: "Review my config", prompt: "Read my agent's full config and tell me if anything looks misconfigured or could be improved." },
    { label: "Optimize for cost", prompt: "Analyze my agent's cost structure. Which models and tools are most expensive? How can I reduce costs without losing quality?" },
    { label: "Change the personality", prompt: "Make my agent more friendly and conversational while keeping it professional. Update the system prompt." },
    { label: "Upgrade the model", prompt: "What model should this agent use? Compare the current model vs alternatives for my use case." },
  ],
  tests: [
    { label: "Generate test cases", prompt: "Generate 5 realistic test cases for this agent based on its description and tools." },
    { label: "Run all tests", prompt: "Run the existing test cases and tell me the results." },
    { label: "Fix failing tests", prompt: "Check which tests are failing and suggest config changes to fix them." },
    { label: "Add edge cases", prompt: "What edge cases should I test for? Generate test cases for unusual or tricky inputs." },
  ],
  activity: [
    { label: "What are users asking?", prompt: "Read recent sessions and summarize what users are asking this agent about most." },
    { label: "Find failures", prompt: "Check recent sessions for errors, failures, or poor responses. What went wrong?" },
    { label: "Usage patterns", prompt: "Analyze usage patterns — when are users active, which tools are used most, what's the average cost per session?" },
    { label: "Suggest improvements", prompt: "Based on actual usage data, what are the top 3 improvements I should make to this agent?" },
  ],
  general: [
    { label: "How is my agent doing?", prompt: "Give me an overall health check of this agent — usage, errors, cost, quality." },
    { label: "Suggest improvements", prompt: "Review the agent config and recent activity, then suggest the most impactful improvements." },
    { label: "Show current config", prompt: "Read and display the full agent configuration." },
    { label: "Optimize everything", prompt: "Do a full audit: check config, recent sessions, test results, and costs. Then make improvements." },
  ],
  knowledge: [
    { label: "What does my agent know?", prompt: "Check what's in this agent's knowledge base. Is it comprehensive enough?" },
    { label: "Add FAQs", prompt: "Based on recent conversations, what FAQs should I add to the knowledge base?" },
    { label: "Improve retrieval", prompt: "How can I improve the agent's knowledge retrieval? Are there gaps in what it knows?" },
  ],
  channels: [
    { label: "Which channels work best?", prompt: "Analyze which messaging channels get the most usage and best response quality." },
    { label: "Optimize for WhatsApp", prompt: "How should I adjust the agent for WhatsApp conversations? Shorter responses? Different tone?" },
    { label: "Set up Telegram", prompt: "Walk me through connecting this agent to Telegram." },
  ],
};

// ── Subcomponents ───────────────────────────────────────────

function CopyButton({ text, size = 11 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="p-0.5 rounded hover:bg-surface-alt transition-colors"
      title="Copy"
    >
      {copied ? <Check size={size} className="text-success" /> : <Copy size={size} className="text-text-muted" />}
    </button>
  );
}

function ToolCallCard({ msg }: { msg: MetaMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = msg.toolStatus === "running";
  const isError = msg.toolStatus === "error";

  return (
    <div className={`border rounded-lg overflow-hidden text-[11px] transition-colors ${
      isError ? "border-red-500/30 bg-red-500/5" :
      isRunning ? "border-primary/20 bg-primary/[0.03]" :
      "border-border/60 bg-surface-alt/20"
    }`}>
      <button
        onClick={() => !isRunning && setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
      >
        {isRunning ? (
          <div className="w-3 h-3 rounded-full border-[1.5px] border-primary border-t-transparent animate-spin shrink-0" />
        ) : isError ? (
          <AlertTriangle size={11} className="text-red-400 shrink-0" />
        ) : (
          <div className="w-3.5 h-3.5 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
            <Check size={8} className="text-green-500" />
          </div>
        )}
        <span className={`font-medium truncate ${isRunning ? "text-primary" : "text-text"}`}>{msg.toolName}</span>
        {msg.toolArgsPreview && (
          <span className="text-text-muted truncate max-w-[160px] font-normal text-[10px]" title={msg.toolArgsPreview}>
            {msg.toolArgsPreview}
          </span>
        )}
        {isRunning && !msg.toolArgsPreview && <span className="text-primary/60 animate-pulse text-[10px]">running...</span>}
        <span className="flex items-center gap-1.5 ml-auto shrink-0">
          {msg.toolCostUsd != null && msg.toolCostUsd > 0 && !isRunning && (
            <span className="text-text-muted text-[10px]">${msg.toolCostUsd.toFixed(4)}</span>
          )}
          {msg.toolLatencyMs != null && !isRunning && (
            <span className="text-text-muted text-[10px]">
              {msg.toolLatencyMs < 1000 ? `${msg.toolLatencyMs}ms` : `${(msg.toolLatencyMs / 1000).toFixed(1)}s`}
            </span>
          )}
          {!isRunning && (expanded ? <ChevronDown size={10} className="text-text-muted" /> : <ChevronRight size={10} className="text-text-muted" />)}
        </span>
      </button>
      {expanded && (msg.toolResult || msg.toolError) && (
        <div className="border-t border-border/30 px-2.5 py-1.5 max-h-40 overflow-y-auto bg-[#1e1e2e] rounded-b-lg relative">
          <div className="absolute top-1 right-1">
            <CopyButton text={msg.toolError || msg.toolResult || ""} size={10} />
          </div>
          {msg.toolError && <pre className="text-red-400 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed pr-5">{msg.toolError}</pre>}
          {msg.toolResult && <pre className="text-[#cdd6f4] whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed pr-5">{msg.toolResult}</pre>}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 80 ? content.slice(0, 80) + "..." : content;
  return (
    <div className="max-w-[90%]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] font-medium text-purple-500 hover:text-purple-400 transition-colors"
      >
        <Brain size={10} />
        <span>Thinking</span>
        {expanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
      </button>
      {expanded ? (
        <div className="mt-0.5 px-2 py-1.5 rounded-md border border-purple-500/20 bg-purple-500/5 text-[10px] leading-relaxed text-purple-300 whitespace-pre-wrap">
          {content}
        </div>
      ) : (
        <p className="text-[10px] text-purple-400/60 italic truncate max-w-[280px] px-2">{preview}</p>
      )}
    </div>
  );
}

function MessageActions({ msg, onRetry }: { msg: MetaMessage; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <CopyButton text={msg.content} size={10} />
      {onRetry && msg.role === "assistant" && (
        <button onClick={onRetry} className="p-0.5 rounded hover:bg-surface-alt transition-colors" title="Retry">
          <RefreshCw size={10} className="text-text-muted" />
        </button>
      )}
    </div>
  );
}

// ── Prose classes (compact for sidebar) ─────────────────────

const META_PROSE = `prose prose-sm prose-neutral dark:prose-invert max-w-none
  [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
  [&_p]:my-2 [&_p]:leading-relaxed
  [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
  [&_h2]:text-[15px] [&_h2]:font-bold [&_h2]:mt-4 [&_h2]:mb-2
  [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1
  [&_ul]:my-2 [&_ul]:pl-5 [&_ul]:space-y-1 [&_ul]:list-disc
  [&_ol]:my-2 [&_ol]:pl-5 [&_ol]:space-y-1 [&_ol]:list-decimal
  [&_li]:leading-relaxed [&_li]:pl-1
  [&_pre]:bg-[#1e1e2e] [&_pre]:text-[#cdd6f4] [&_pre]:rounded-xl [&_pre]:p-4 [&_pre]:my-3 [&_pre]:text-xs [&_pre]:overflow-x-auto [&_pre]:leading-relaxed
  [&_code]:bg-surface-alt [&_code]:text-primary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-md [&_code]:text-xs [&_code]:font-mono
  [&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0 [&_pre_code]:rounded-none
  [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:my-3 [&_blockquote]:text-text-secondary [&_blockquote]:italic
  [&_table]:my-3 [&_table]:text-xs [&_table]:w-full [&_table]:border-collapse
  [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:border-b [&_th]:border-border [&_th]:bg-surface-alt
  [&_td]:px-3 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-border/50
  [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-primary/30 hover:[&_a]:decoration-primary
  [&_strong]:font-semibold [&_strong]:text-text
  [&_em]:italic
`;

// ── ID generator ────────────────────────────────────────────

let nextId = 0;
function makeId() { return `meta-${++nextId}-${Date.now()}`; }

// ── Main Component ──────────────────────────────────────────

export function MetaAgentPanel({ agentName, open, onClose, context = "general", initialMode = "live" }: MetaAgentPanelProps) {
  const [metaMode, setMetaMode] = useState<"demo" | "live">(initialMode);
  const [sessionId, setSessionId] = useState<string>(() => {
    const sessions = loadMetaSessionList(agentName);
    return sessions.length > 0 ? sessions[0].id : `meta_${Date.now()}`;
  });
  const [messages, setMessages] = useState<MetaMessage[]>(() => {
    const sessions = loadMetaSessionList(agentName);
    if (sessions.length > 0) return loadMetaMessages(agentName, sessions[0].id);
    return [];
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [trainingJobId, setTrainingJobId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const pendingTrainingSummaryRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-load when agentName changes
  useEffect(() => {
    const sessions = loadMetaSessionList(agentName);
    if (sessions.length > 0) {
      setSessionId(sessions[0].id);
      setMessages(loadMetaMessages(agentName, sessions[0].id));
    } else {
      const newId = `meta_${Date.now()}`;
      setSessionId(newId);
      setMessages([]);
    }
  }, [agentName]);

  // Abort in-flight requests on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send pending training summary once meta-agent is no longer loading
  // Persist on change
  useEffect(() => {
    if (messages.length > 0) {
      storeMetaMessages(agentName, sessionId, messages);
    }
  }, [messages, agentName, sessionId]);

  // ── Session management ──────────────────────────────────

  const switchSession = useCallback((sid: string) => {
    if (loading) { abortRef.current?.abort(); setLoading(false); }
    setSessionId(sid);
    setMessages(loadMetaMessages(agentName, sid));
    setShowSessions(false);
  }, [agentName, loading]);

  const startNewSession = useCallback(() => {
    if (loading) { abortRef.current?.abort(); setLoading(false); }
    const newId = `meta_${Date.now()}`;
    setSessionId(newId);
    setMessages([]);
    setShowSessions(false);
  }, []);

  const removeSession = useCallback((sid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteMetaSession(agentName, sid);
    if (sid === sessionId) startNewSession();
  }, [agentName, sessionId, startNewSession]);

  // ── Send message ────────────────────────────────────────

  // Ref to always have current messages (avoids stale closure in sendMessage)
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: MetaMessage = { id: makeId(), role: "user", content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Read from ref to get current messages (not stale closure)
      const apiMessages = messagesRef.current
        .filter(m => !m.isToolActivity && m.role !== "tool")
        .map(m => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id, tool_calls: m.tool_calls }));
      apiMessages.push({ role: "user", content: text, tool_call_id: undefined, tool_calls: undefined });

      const res = await apiFetch<{ response: string; messages: any[]; cost_usd?: number; turns?: number }>(
        `/agents/${agentPathSegment(agentName)}/meta-chat`,
        { method: "POST", body: JSON.stringify({ messages: apiMessages, mode: metaMode }), signal: controller.signal },
      );

      // Parse tool calls into rich tool messages
      const newMsgs: MetaMessage[] = [];
      for (const m of res.messages) {
        if (m.role === "assistant" && m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            const toolId = tc.id || makeId();
            newMsgs.push({
              id: toolId,
              role: "tool",
              content: "",
              toolName: tc.function?.name || "tool",
              toolStatus: "done",
              isToolActivity: true,
            });
          }
        }
        // Match tool results to tool calls
        if (m.role === "tool" && typeof m.content === "string") {
          const lastTool = [...newMsgs].reverse().find(msg => msg.role === "tool" && msg.isToolActivity);
          if (lastTool) {
            try {
              const parsed = JSON.parse(m.content);
              lastTool.toolResult = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
            } catch {
              lastTool.toolResult = m.content;
            }
            // Detect training job IDs
            const jobIdMatch = m.content.match(/"job_id"\s*:\s*"([a-f0-9]{16})"/);
            if (jobIdMatch) setTrainingJobId(jobIdMatch[1]);
          }
        }
      }

      // Check response text for job IDs too
      const respJobMatch = res.response?.match(/Job ID[:\s]*`?([a-f0-9]{16})`?/i);
      if (respJobMatch) setTrainingJobId(respJobMatch[1]);

      const costSuffix = res.cost_usd && res.cost_usd > 0
        ? `\n\n---\n*${res.turns || 0} turns · $${res.cost_usd.toFixed(4)}*`
        : "";
      const assistantMsg: MetaMessage = {
        id: makeId(), role: "assistant", content: (res.response || "") + costSuffix,
      };

      setMessages(prev => [...prev, ...newMsgs, assistantMsg]);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setMessages(prev => [...prev, {
          id: makeId(), role: "assistant",
          content: `Error: ${err.message || "Failed to reach the meta-agent"}`,
        }]);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [agentName, messages, loading]);

  // Auto-send pending training summary after sendMessage finishes loading
  useEffect(() => {
    if (!loading && pendingTrainingSummaryRef.current) {
      const summary = pendingTrainingSummaryRef.current;
      pendingTrainingSummaryRef.current = null;
      sendMessage(summary);
    }
  }, [loading, sendMessage]);

  // ── Stop ────────────────────────────────────────────────

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
  }, []);

  // ── Retry ───────────────────────────────────────────────

  const handleRetry = useCallback((msgId: string) => {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    // Find the last user message before this assistant message
    let lastUserMsg = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserMsg = messages[i].content;
        break;
      }
    }
    if (!lastUserMsg) return;
    // Remove this message and everything after it
    setMessages(prev => prev.slice(0, idx));
    // Re-send
    setTimeout(() => sendMessage(lastUserMsg), 50);
  }, [messages, sendMessage]);

  const starters = CONTEXT_STARTERS[context] || CONTEXT_STARTERS.general;
  const sessionList = loadMetaSessionList(agentName);

  if (!open) return null;

  return (
    <div className={
      fullscreen
        ? "fixed inset-0 z-50 bg-surface flex flex-col animate-[fadeIn_150ms_ease-out]"
        : "w-full h-full bg-surface border-l border-border shadow-2xl flex flex-col animate-[slideIn_200ms_ease-out]"
    }>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
            <Sparkles size={14} className="text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-text">Agent Manager</h2>
            <p className="text-[10px] text-text-muted">Improve {agentName}</p>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {trainingJobId && (
            <button
              onClick={() => setTrainingJobId(null)}
              className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-md bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 transition-colors"
            >
              <Radio size={10} /> Live
            </button>
          )}
          <button
            onClick={startNewSession}
            className="p-1.5 rounded-lg hover:bg-surface-alt transition-colors"
            title="New session"
          >
            <Plus size={14} className="text-text-muted" />
          </button>
          <button
            onClick={() => setShowSessions(s => !s)}
            className={`p-1.5 rounded-lg transition-colors ${showSessions ? "bg-surface-alt" : "hover:bg-surface-alt"}`}
            title="Session history"
          >
            <Clock size={14} className="text-text-muted" />
          </button>
          <button
            onClick={() => setFullscreen((f) => !f)}
            className="p-1.5 rounded-lg hover:bg-surface-alt transition-colors"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 size={14} className="text-text-muted" /> : <Maximize2 size={14} className="text-text-muted" />}
          </button>
          <button onClick={() => { setFullscreen(false); onClose(); }} className="p-1.5 rounded-lg hover:bg-surface-alt transition-colors">
            <X size={14} className="text-text-muted" />
          </button>
        </div>
      </div>

      {/* Session Picker Dropdown */}
      {showSessions && (
        <div className="border-b border-border bg-surface-alt/30 max-h-[240px] overflow-y-auto">
          <div className="px-3 py-1.5">
            <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Recent sessions</p>
          </div>
          {sessionList.length === 0 && (
            <p className="px-3 py-3 text-[11px] text-text-muted text-center">No saved sessions yet</p>
          )}
          {sessionList.map(sess => (
            <button
              key={sess.id}
              onClick={() => switchSession(sess.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors border-b border-border/20 last:border-0 group/sess ${
                sess.id === sessionId
                  ? "bg-primary/5 border-l-2 border-l-primary"
                  : "hover:bg-surface-alt"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-[11px] font-medium truncate ${sess.id === sessionId ? "text-primary" : "text-text"}`}>
                  {sess.title}
                </p>
                <p className="text-[9px] text-text-muted mt-0.5">
                  {sess.messageCount} messages · {timeAgo(sess.updatedAt)}
                </p>
              </div>
              <button
                onClick={(e) => removeSession(sess.id, e)}
                className="p-1 rounded opacity-0 group-hover/sess:opacity-100 hover:bg-red-500/20 text-text-muted hover:text-red-400 transition-all"
                title="Delete session"
              >
                <Trash2 size={10} />
              </button>
            </button>
          ))}
        </div>
      )}

      {/* Messages */}
      <div className={`flex-1 overflow-y-auto py-4 space-y-3 ${fullscreen ? "px-6 mx-auto w-full max-w-3xl" : "px-4"}`}>
        {messages.length === 0 && (
          <div className="space-y-3 pt-2">
            {/* Demo/Live mode toggle */}
            <div className="flex items-center justify-center gap-1 py-1">
              <button
                onClick={() => setMetaMode("demo")}
                className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
                  metaMode === "demo"
                    ? "bg-primary text-white"
                    : "text-text-muted hover:text-text hover:bg-surface-alt"
                }`}
              >
                🎯 Demo Mode
              </button>
              <button
                onClick={() => setMetaMode("live")}
                className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
                  metaMode === "live"
                    ? "bg-primary text-white"
                    : "text-text-muted hover:text-text hover:bg-surface-alt"
                }`}
              >
                🔧 Live Mode
              </button>
            </div>
            <p className="text-[11px] text-text-secondary text-center py-0.5">
              {metaMode === "demo"
                ? "Demo mode — I'll showcase capabilities and build a sample agent for you to try."
                : "Live mode — I'll interview you about your data sources and integrations to build a production-ready agent."
              }
            </p>
            <div className="space-y-1.5">
              {starters.map((s, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(s.prompt)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-left text-text-secondary bg-surface-alt/50 border border-border rounded-lg hover:border-primary/30 hover:text-text transition-all"
                >
                  <ChevronRight size={11} className="text-text-muted shrink-0" />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => {
          // Tool call card
          if (msg.isToolActivity && msg.toolName) {
            return (
              <div key={msg.id} className="animate-[fadeInUp_100ms_ease-out]">
                <ToolCallCard msg={msg} />
              </div>
            );
          }

          // Legacy tool activity (no rich data)
          if (msg.isToolActivity) {
            return (
              <div key={msg.id} className="flex items-center gap-1.5 text-[10px] text-text-muted px-1">
                <Wrench size={9} /> {msg.content}
              </div>
            );
          }

          // User message
          if (msg.role === "user") {
            return (
              <div key={msg.id} className="flex justify-end animate-[fadeInUp_100ms_ease-out] group">
                <div className="max-w-[85%]">
                  <div className="px-4 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed bg-primary text-white">
                    {msg.content}
                  </div>
                  <div className="flex justify-end mt-0.5">
                    <MessageActions msg={msg} />
                  </div>
                </div>
              </div>
            );
          }

          // Assistant message
          return (
            <div key={msg.id} className="flex justify-start animate-[fadeInUp_100ms_ease-out] group">
              <div className="max-w-[92%] min-w-0">
                <div className={`px-4 py-3 rounded-2xl rounded-bl-md text-sm leading-relaxed bg-surface border border-border/40 text-text ${META_PROSE}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
                <div className="flex items-center mt-0.5 px-0.5">
                  <MessageActions msg={msg} onRetry={() => handleRetry(msg.id)} />
                </div>
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-surface-alt rounded-xl rounded-bl-sm px-3 py-2.5 border border-border/40">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-purple-400/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 bg-purple-400/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 bg-purple-400/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Training Stream */}
      {trainingJobId && (
        <div className="border-t border-border" style={{ height: "40%", minHeight: 200 }}>
          <TrainingStreamPanel
            jobId={trainingJobId}
            onClose={() => setTrainingJobId(null)}
            onComplete={(summary) => {
              if (loading) {
                pendingTrainingSummaryRef.current = summary;
              } else {
                sendMessage(summary);
              }
            }}
          />
        </div>
      )}

      {/* Input */}
      <div className={`border-t border-border py-2.5 ${fullscreen ? "px-6 mx-auto w-full max-w-3xl" : "px-4"}`}>
        <form onSubmit={(e) => { e.preventDefault(); sendMessage(input); }} className="flex items-end gap-1.5">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
            placeholder="Ask the meta-agent..."
            disabled={loading}
            className="flex-1 px-3 py-2 text-[11px] rounded-lg border border-border bg-surface placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all"
          />
          {loading ? (
            <button
              type="button"
              onClick={handleStop}
              className="p-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors min-w-[36px] min-h-[36px] flex items-center justify-center"
              title="Stop"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="p-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 transition-colors min-w-[36px] min-h-[36px] flex items-center justify-center"
            >
              <Send size={12} />
            </button>
          )}
        </form>
      </div>

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
