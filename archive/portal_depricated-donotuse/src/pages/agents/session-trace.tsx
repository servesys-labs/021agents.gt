import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  Flag,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Star,
  Terminal,
  User,
  Wrench,
  Zap,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  GitBranch,
  X,
} from "lucide-react";
import { useApiQuery, apiPost, apiGet } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type SessionDetail = {
  session_id: string;
  agent_name?: string;
  status?: string;
  trace_id?: string;
  parent_session_id?: string | null;
  depth?: number;
  cost_total_usd?: number;
  wall_clock_seconds?: number;
  created_at?: string;
  updated_at?: string;
  total_turns?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  error?: string;
};

type ToolCall = {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  latency_ms?: number;
};

type TurnData = {
  turn_number: number;
  role?: string;
  model_used?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  llm_content?: string;
  user_content?: string;
  tool_calls_json?: string;
  tool_results_json?: string;
  errors_json?: string;
  created_at?: string;
};

type ReplayState = {
  cursor_index: number;
  messages: Array<{ role: string; content: string }>;
  tools_called: string[];
  cost_so_far: number;
  turns_completed: number;
  total_events: number;
};

type RunTreeNode = {
  id: string;
  type: "session" | "turn" | "llm_call" | "tool_call" | "error";
  name: string;
  duration_ms?: number;
  status?: string;
  children?: RunTreeNode[];
};

type Annotation = {
  id: string;
  trace_id: string;
  span_id?: string;
  turn?: number;
  annotation_type: "note" | "issue" | "hypothesis" | "fix";
  message: string;
  severity: "info" | "warn" | "error";
  created_at?: string;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function safeParse<T>(json: string | undefined | null): T[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function truncateId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}...` : id;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "--";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatTime(iso?: string): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* ── Session Trace Page ──────────────────────────────────────────── */

export function SessionTracePage() {
  const { name: agentName, sessionId } = useParams<{ name: string; sessionId: string }>();
  const navigate = useNavigate();

  const [replayMode, setReplayMode] = useState(false);
  const [runTreeMode, setRunTreeMode] = useState(false);

  const sessionQuery = useApiQuery<SessionDetail>(
    `/api/v1/sessions/${sessionId ?? ""}`,
    Boolean(sessionId),
  );

  const turnsQuery = useApiQuery<{ turns: TurnData[] } | TurnData[]>(
    `/api/v1/sessions/${sessionId ?? ""}/turns`,
    Boolean(sessionId),
  );

  const session = sessionQuery.data;
  const turns: TurnData[] = useMemo(() => {
    const raw = turnsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ("turns" in raw && Array.isArray(raw.turns)) return raw.turns;
    return [];
  }, [turnsQuery.data]);

  const totalTokens = useMemo(() => {
    const inp = session?.total_input_tokens ?? turns.reduce((s, t) => s + (t.input_tokens ?? 0), 0);
    const out = session?.total_output_tokens ?? turns.reduce((s, t) => s + (t.output_tokens ?? 0), 0);
    return { input: inp, output: out, total: inp + out };
  }, [session, turns]);

  const isError = session?.status === "error" || session?.status === "failed";

  if (sessionQuery.loading || turnsQuery.loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-text-muted text-[var(--text-sm)]">
        Loading session trace...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="mb-[var(--space-4)]">
        <button
          onClick={() => navigate(`/agents/${agentName}?tab=traces`)}
          className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-text-muted hover:text-text-primary transition-colors mb-[var(--space-3)] min-h-[var(--touch-target-min)]"
        >
          <ArrowLeft size={16} />
          Back to {agentName}
        </button>
        <div className="flex items-center gap-[var(--space-3)]">
          <h1 className="text-[var(--text-lg)] font-bold text-text-primary">
            Session Trace
          </h1>
          <span className="text-[var(--text-xs)] font-mono text-text-muted">
            {sessionId ? truncateId(sessionId, 24) : ""}
          </span>
          {isError && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-status-error/10 text-status-error border border-status-error/20">
              <XCircle size={10} />
              Error
            </span>
          )}

          {/* Mode toggles */}
          <div className="flex-1" />
          <button
            onClick={() => { setReplayMode(!replayMode); if (!replayMode) setRunTreeMode(false); }}
            className={`btn text-[var(--text-xs)] min-h-[var(--touch-target-min)] ${
              replayMode ? "btn-primary" : "btn-secondary"
            }`}
          >
            <Play size={14} />
            Replay
          </button>
          <button
            onClick={() => { setRunTreeMode(!runTreeMode); if (!runTreeMode) setReplayMode(false); }}
            className={`btn text-[var(--text-xs)] min-h-[var(--touch-target-min)] ${
              runTreeMode ? "btn-primary" : "btn-secondary"
            }`}
          >
            <GitBranch size={14} />
            Run Tree
          </button>
        </div>
      </div>

      {(session?.depth ?? 0) > 0 || session?.parent_session_id ? (
        <div className="card mb-[var(--space-4)] py-[var(--space-3)]">
          <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
            Delegation Lineage
          </p>
          <div className="flex items-center gap-[var(--space-4)] flex-wrap">
            <div>
              <p className="text-[10px] text-text-muted uppercase">Depth</p>
              <p className="text-[var(--text-sm)] font-mono text-text-primary">{session?.depth ?? 0}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-muted uppercase">Parent Session</p>
              {session?.parent_session_id ? (
                <button
                  className="text-[var(--text-xs)] font-mono text-accent hover:underline"
                  onClick={() => navigate(`/sessions?q=${encodeURIComponent(session.parent_session_id || "")}`)}
                >
                  {truncateId(session.parent_session_id, 24)}
                </button>
              ) : (
                <p className="text-[var(--text-xs)] text-text-muted">None</p>
              )}
            </div>
            <div>
              <p className="text-[10px] text-text-muted uppercase">Trace</p>
              <p className="text-[var(--text-xs)] font-mono text-text-secondary">
                {session?.trace_id ? truncateId(session.trace_id, 24) : "--"}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Replay Panel */}
      {replayMode && sessionId && (
        <TraceReplayPanel traceId={sessionId} />
      )}

      {/* Run Tree Panel */}
      {runTreeMode && sessionId && (
        <RunTreePanel traceId={sessionId} />
      )}

      {/* Two panel layout */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-[var(--space-4)] min-h-0 overflow-hidden">
        {/* Left: Conversation Panel */}
        <div className="card overflow-y-auto min-h-0">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-4)] sticky top-0 bg-surface-raised pt-[var(--space-1)] pb-[var(--space-2)]">
            <MessageSquare size={12} className="inline mr-1" />
            Conversation
          </h3>
          <div className="space-y-[var(--space-3)]">
            {turns.length === 0 ? (
              <p className="text-[var(--text-sm)] text-text-muted">No turns recorded</p>
            ) : (
              turns.map((turn) => (
                <ConversationTurn key={turn.turn_number} turn={turn} />
              ))
            )}
          </div>
        </div>

        {/* Right: Execution Trace */}
        <div className="card overflow-y-auto min-h-0">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-4)] sticky top-0 bg-surface-raised pt-[var(--space-1)] pb-[var(--space-2)]">
            <Terminal size={12} className="inline mr-1" />
            Execution Trace
          </h3>
          <ExecutionTimeline turns={turns} session={session} traceId={sessionId} />
        </div>
      </div>

      {/* Bottom bar */}
      <SessionBottomBar
        session={session}
        totalTokens={totalTokens}
        turnCount={turns.length}
        agentName={agentName}
        sessionId={sessionId}
      />
    </div>
  );
}

/* ── Trace Replay Panel ──────────────────────────────────────────── */

function TraceReplayPanel({ traceId }: { traceId: string }) {
  const [replayState, setReplayState] = useState<ReplayState | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [totalEvents, setTotalEvents] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch replay state at cursor
  const fetchReplay = useCallback(async (idx: number) => {
    setLoading(true);
    try {
      const data = await apiGet<ReplayState>(
        `/api/v1/observability/trace/${traceId}/replay?cursor_index=${idx}`,
      );
      setReplayState(data);
      if (data?.total_events) setTotalEvents(data.total_events);
    } catch {
      // Gracefully handle — keep existing state
    } finally {
      setLoading(false);
    }
  }, [traceId]);

  // Initial load
  useEffect(() => {
    void fetchReplay(0);
  }, [fetchReplay]);

  // Auto-play
  useEffect(() => {
    if (playing) {
      playRef.current = setInterval(() => {
        setCursorIndex((prev) => {
          const next = prev + 1;
          if (next >= totalEvents) {
            setPlaying(false);
            return prev;
          }
          void fetchReplay(next);
          return next;
        });
      }, 1000);
    }
    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [playing, totalEvents, fetchReplay]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setCursorIndex(val);
    void fetchReplay(val);
  };

  const maxEvents = totalEvents > 0 ? totalEvents - 1 : 0;

  return (
    <div className="card mb-[var(--space-4)] glass-light border border-glass-border">
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-3)]">
        <button
          onClick={() => setPlaying(!playing)}
          className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-3)]"
          aria-label={playing ? "Pause replay" : "Play replay"}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
          {playing ? "Pause" : "Play"}
        </button>
        <div className="flex-1 flex items-center gap-[var(--space-3)]">
          <input
            type="range"
            min={0}
            max={maxEvents}
            value={cursorIndex}
            onChange={handleSliderChange}
            className="flex-1 h-2 rounded-full appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, var(--color-accent) ${maxEvents > 0 ? (cursorIndex / maxEvents) * 100 : 0}%, var(--color-surface-overlay) ${maxEvents > 0 ? (cursorIndex / maxEvents) * 100 : 0}%)`,
            }}
            aria-label="Trace event scrubber"
          />
          <span className="text-[var(--text-xs)] font-mono text-text-muted min-w-[4rem] text-right">
            {cursorIndex + 1} / {totalEvents || "..."}
          </span>
        </div>
        {loading && (
          <span className="text-[10px] text-text-muted">Loading...</span>
        )}
      </div>

      {/* Replay state summary */}
      {replayState && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-[var(--space-3)]">
          <div className="p-[var(--space-2)] rounded-lg bg-surface-base">
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Messages</p>
            <p className="text-[var(--text-sm)] font-mono text-text-primary">
              {replayState.messages?.length ?? 0}
            </p>
          </div>
          <div className="p-[var(--space-2)] rounded-lg bg-surface-base">
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Tools Called</p>
            <p className="text-[var(--text-sm)] font-mono text-text-primary">
              {replayState.tools_called?.length ?? 0}
            </p>
          </div>
          <div className="p-[var(--space-2)] rounded-lg bg-surface-base">
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Cost</p>
            <p className="text-[var(--text-sm)] font-mono text-text-primary">
              ${(replayState.cost_so_far ?? 0).toFixed(4)}
            </p>
          </div>
          <div className="p-[var(--space-2)] rounded-lg bg-surface-base">
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Turns</p>
            <p className="text-[var(--text-sm)] font-mono text-text-primary">
              {replayState.turns_completed ?? 0}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Run Tree Panel ──────────────────────────────────────────────── */

function RunTreePanel({ traceId }: { traceId: string }) {
  const treeQuery = useApiQuery<RunTreeNode | { tree: RunTreeNode }>(
    `/api/v1/observability/trace/${traceId}/run-tree`,
    true,
  );

  const tree = useMemo(() => {
    const raw = treeQuery.data;
    if (!raw) return null;
    if ("tree" in raw) return raw.tree;
    return raw;
  }, [treeQuery.data]);

  if (treeQuery.loading) {
    return (
      <div className="card mb-[var(--space-4)]">
        <p className="text-[var(--text-sm)] text-text-muted">Loading run tree...</p>
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="card mb-[var(--space-4)]">
        <p className="text-[var(--text-sm)] text-text-muted">No run tree data available</p>
      </div>
    );
  }

  return (
    <div className="card mb-[var(--space-4)] overflow-x-auto">
      <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
        <GitBranch size={12} className="inline mr-1" />
        Run Tree
      </h3>
      <RunTreeNodeView node={tree} depth={0} />
    </div>
  );
}

function RunTreeNodeView({ node, depth }: { node: RunTreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;

  const typeIcon: Record<string, React.ReactNode> = {
    session: <Zap size={12} className="text-status-info" />,
    turn: <MessageSquare size={12} className="text-accent" />,
    llm_call: <Bot size={12} className="text-chart-purple" />,
    tool_call: <Wrench size={12} className="text-chart-cyan" />,
    error: <XCircle size={12} className="text-status-error" />,
  };

  const statusColors: Record<string, string> = {
    success: "bg-status-live/10 text-status-live border-status-live/20",
    completed: "bg-status-live/10 text-status-live border-status-live/20",
    error: "bg-status-error/10 text-status-error border-status-error/20",
    failed: "bg-status-error/10 text-status-error border-status-error/20",
    running: "bg-status-info/10 text-status-info border-status-info/20",
  };

  const statusClass = statusColors[node.status ?? ""] ?? "bg-surface-overlay text-text-muted border-border-subtle";

  return (
    <div>
      <button
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={`w-full flex items-center gap-[var(--space-2)] py-[var(--space-1)] px-[var(--space-2)] rounded-lg hover:bg-surface-overlay transition-colors text-left min-h-[var(--touch-target-min)]`}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth * 20}px)` }}
      >
        {/* Indent lines */}
        {depth > 0 && (
          <div
            className="absolute border-l-2 border-accent/30"
            style={{
              left: `calc(${(depth - 1) * 20 + 10}px)`,
              top: 0,
              bottom: 0,
            }}
          />
        )}

        {hasChildren ? (
          expanded ? <ChevronDown size={12} className="text-text-muted flex-shrink-0" /> : <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        {typeIcon[node.type] ?? <Zap size={12} className="text-text-muted" />}

        <span className="text-[var(--text-xs)] font-medium text-text-primary flex-1 truncate">
          {node.name}
        </span>

        {node.duration_ms != null && (
          <span className="text-[10px] font-mono text-text-muted flex-shrink-0">
            {node.duration_ms}ms
          </span>
        )}

        {node.status && (
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${statusClass}`}>
            {node.status}
          </span>
        )}
      </button>

      {expanded && hasChildren && (
        <div className="relative">
          <div
            className="absolute border-l-2 border-accent/20"
            style={{
              left: `calc(${depth * 20 + 18}px)`,
              top: 0,
              bottom: 0,
            }}
          />
          {node.children!.map((child, i) => (
            <RunTreeNodeView key={child.id || `${node.id}-${i}`} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Annotation Form ─────────────────────────────────────────────── */

function AnnotationButton({ traceId, turnNumber }: { traceId?: string; turnNumber: number }) {
  const [open, setOpen] = useState(false);
  const [annotationType, setAnnotationType] = useState<Annotation["annotation_type"]>("note");
  const [severity, setSeverity] = useState<Annotation["severity"]>("info");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  const handleSave = async () => {
    if (!traceId || !message.trim()) return;
    setSaving(true);
    try {
      const result = await apiPost<Annotation>("/api/v1/observability/annotations", {
        trace_id: traceId,
        annotation_type: annotationType,
        message: message.trim(),
        severity,
        turn: turnNumber,
      });
      if (result) {
        setAnnotations((prev) => [...prev, result]);
      }
      setSaved(true);
      setMessage("");
      setTimeout(() => {
        setSaved(false);
        setOpen(false);
      }, 1000);
    } catch {
      // Handle silently
    } finally {
      setSaving(false);
    }
  };

  const severityColors: Record<string, string> = {
    info: "bg-status-info/10 text-status-info border-status-info/20",
    warn: "bg-status-warning/10 text-status-warning border-status-warning/20",
    error: "bg-status-error/10 text-status-error border-status-error/20",
  };

  return (
    <div className="relative inline-flex">
      {/* Annotation badges */}
      {annotations.map((ann) => (
        <span
          key={ann.id}
          className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border mr-1 ${severityColors[ann.severity] ?? severityColors.info}`}
          title={ann.message}
        >
          {ann.annotation_type}
        </span>
      ))}

      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center justify-center min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] rounded-lg hover:bg-surface-overlay transition-colors text-text-muted hover:text-text-primary"
        aria-label="Add annotation"
        title="Add annotation"
      >
        <Pencil size={10} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-xl glass-dropdown border border-border-default p-[var(--space-3)] space-y-[var(--space-2)]">
            <div className="flex items-center justify-between mb-[var(--space-1)]">
              <span className="text-[var(--text-xs)] font-medium text-text-primary">Add Annotation</span>
              <button onClick={() => setOpen(false)} className="p-1 hover:bg-surface-overlay rounded min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center">
                <X size={12} className="text-text-muted" />
              </button>
            </div>

            <div>
              <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">Type</label>
              <select
                value={annotationType}
                onChange={(e) => setAnnotationType(e.target.value as Annotation["annotation_type"])}
                className="w-full text-[var(--text-xs)]"
              >
                <option value="note">Note</option>
                <option value="issue">Issue</option>
                <option value="hypothesis">Hypothesis</option>
                <option value="fix">Fix</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">Severity</label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as Annotation["severity"])}
                className="w-full text-[var(--text-xs)]"
              >
                <option value="info">Info</option>
                <option value="warn">Warning</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">Message</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="w-full text-[var(--text-xs)]"
                placeholder="Describe your observation..."
              />
            </div>

            <button
              onClick={handleSave}
              disabled={saving || !message.trim()}
              className="btn btn-primary text-[var(--text-xs)] w-full min-h-[var(--touch-target-min)]"
            >
              {saving ? "Saving..." : saved ? "Saved" : "Save Annotation"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Conversation Turn ───────────────────────────────────────────── */

function ConversationTurn({ turn }: { turn: TurnData }) {
  const toolCalls = safeParse<ToolCall>(turn.tool_calls_json);
  const errors = safeParse<{ message?: string; error?: string }>(turn.errors_json);
  const hasError = errors.length > 0;

  return (
    <div className="space-y-[var(--space-2)]">
      {/* User message */}
      {turn.user_content && (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg p-[var(--space-3)] bg-surface-overlay text-[var(--text-sm)] text-text-primary">
            <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
              <User size={12} className="text-text-muted" />
              <span className="text-[10px] text-text-muted uppercase tracking-wide font-medium">User</span>
            </div>
            <p className="whitespace-pre-wrap leading-relaxed">{turn.user_content}</p>
          </div>
        </div>
      )}

      {/* Tool calls */}
      {toolCalls.map((tc, i) => (
        <ToolCallCard key={`${turn.turn_number}-tool-${i}`} toolCall={tc} />
      ))}

      {/* Agent message */}
      {turn.llm_content && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg p-[var(--space-3)] bg-surface-raised border border-border-subtle text-[var(--text-sm)] text-text-primary">
            <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
              <Bot size={12} className="text-accent" />
              <span className="text-[10px] text-accent uppercase tracking-wide font-medium">Agent</span>
              {turn.model_used && (
                <span className="text-[10px] text-text-muted font-mono">{turn.model_used}</span>
              )}
            </div>
            <p className="whitespace-pre-wrap leading-relaxed">{turn.llm_content}</p>
          </div>
        </div>
      )}

      {/* Errors */}
      {hasError && (
        <div className="rounded-lg p-[var(--space-3)] bg-node-glow-red border border-status-error/20">
          <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
            <AlertTriangle size={12} className="text-status-error" />
            <span className="text-[10px] text-status-error uppercase tracking-wide font-semibold">Error</span>
          </div>
          {errors.map((err, i) => (
            <p key={i} className="text-[var(--text-sm)] text-status-error whitespace-pre-wrap">
              {err.message || err.error || JSON.stringify(err)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Tool Call Card ──────────────────────────────────────────────── */

function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const isError = toolCall.status === "error" || toolCall.status === "failed";

  return (
    <div className="mx-[var(--space-4)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full rounded-lg p-[var(--space-2)] glass-light border transition-all min-h-[var(--touch-target-min)] text-left ${
          isError ? "border-status-error/20 bg-node-glow-red" : "border-glass-border"
        }`}
      >
        <div className="flex items-center gap-[var(--space-2)]">
          <Wrench size={12} className={isError ? "text-status-error" : "text-text-muted"} />
          <span className="text-[var(--text-xs)] font-mono font-medium text-text-primary flex-1">
            {toolCall.name}
          </span>
          {toolCall.status && (
            <span className={`text-[10px] font-medium ${isError ? "text-status-error" : "text-status-live"}`}>
              {toolCall.status}
            </span>
          )}
          {toolCall.latency_ms != null && (
            <span className="text-[10px] text-text-muted font-mono">{toolCall.latency_ms}ms</span>
          )}
          {expanded ? <ChevronDown size={12} className="text-text-muted" /> : <ChevronRight size={12} className="text-text-muted" />}
        </div>
      </button>
      {expanded && (
        <div className="mt-[var(--space-1)] rounded-lg border border-border-subtle bg-surface-base p-[var(--space-3)] text-[var(--text-xs)] font-mono overflow-x-auto transition-all">
          {toolCall.input != null && (
            <div className="mb-[var(--space-2)]">
              <span className="text-text-muted">Input:</span>
              <pre className="text-text-secondary mt-1 whitespace-pre-wrap break-all">
                {typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.output != null && (
            <div>
              <span className="text-text-muted">Output:</span>
              <pre className="text-text-secondary mt-1 whitespace-pre-wrap break-all">
                {typeof toolCall.output === "string" ? toolCall.output : JSON.stringify(toolCall.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Execution Timeline ──────────────────────────────────────────── */

function ExecutionTimeline({ turns, session, traceId }: { turns: TurnData[]; session: SessionDetail | null; traceId?: string }) {
  return (
    <div className="relative pl-[var(--space-6)]">
      {/* Vertical line */}
      <div className="absolute left-2 top-0 bottom-0 w-px bg-border-default" />

      {/* Session start */}
      <TimelineEvent
        icon={<Zap size={12} />}
        label="Session Start"
        detail={formatTime(session?.created_at)}
        color="text-status-info"
      />

      {turns.map((turn) => {
        const toolCalls = safeParse<ToolCall>(turn.tool_calls_json);
        const errors = safeParse<{ message?: string; error?: string }>(turn.errors_json);
        const hasError = errors.length > 0;

        return (
          <div key={turn.turn_number} className="mb-[var(--space-3)]">
            {/* LLM call */}
            <div className="flex items-center gap-[var(--space-1)]">
              <div className="flex-1">
                <TimelineEvent
                  icon={<Bot size={12} />}
                  label={`Turn ${turn.turn_number} — LLM Call`}
                  detail={[
                    turn.model_used,
                    turn.input_tokens != null ? `${turn.input_tokens + (turn.output_tokens ?? 0)} tok` : null,
                    turn.latency_ms != null ? `${turn.latency_ms}ms` : null,
                  ].filter(Boolean).join(" / ")}
                  color={hasError ? "text-status-error" : "text-accent"}
                  isError={hasError}
                />
              </div>
              <AnnotationButton traceId={traceId} turnNumber={turn.turn_number} />
            </div>

            {/* Tool calls in this turn */}
            {toolCalls.map((tc, i) => (
              <TimelineEvent
                key={`${turn.turn_number}-tc-${i}`}
                icon={<Wrench size={12} />}
                label={tc.name}
                detail={[
                  tc.status,
                  tc.latency_ms != null ? `${tc.latency_ms}ms` : null,
                ].filter(Boolean).join(" / ")}
                color={tc.status === "error" || tc.status === "failed" ? "text-status-error" : "text-text-muted"}
                isError={tc.status === "error" || tc.status === "failed"}
                indent
              />
            ))}

            {/* Errors */}
            {errors.map((err, i) => (
              <TimelineEvent
                key={`${turn.turn_number}-err-${i}`}
                icon={<XCircle size={12} />}
                label="Error"
                detail={err.message || err.error || "Unknown error"}
                color="text-status-error"
                isError
              />
            ))}
          </div>
        );
      })}

      {/* Session end */}
      <TimelineEvent
        icon={session?.status === "error" ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
        label={`Session End — ${session?.status ?? "unknown"}`}
        detail={formatTime(session?.updated_at)}
        color={session?.status === "error" ? "text-status-error" : "text-status-live"}
      />
    </div>
  );
}

/* ── Timeline Event ──────────────────────────────────────────────── */

function TimelineEvent({
  icon,
  label,
  detail,
  color,
  isError,
  indent,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  color: string;
  isError?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={`relative flex items-start gap-[var(--space-2)] mb-[var(--space-2)] ${indent ? "ml-[var(--space-4)]" : ""} ${
        isError ? "rounded-lg p-[var(--space-2)] bg-node-glow-red" : "p-[var(--space-1)]"
      }`}
    >
      {!indent && (
        <div className={`absolute -left-[var(--space-6)] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-surface-raised ${
          isError ? "bg-status-error" : "bg-border-strong"
        }`} />
      )}
      <span className={color}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-[var(--text-xs)] font-medium ${isError ? "text-status-error" : "text-text-primary"}`}>
          {label}
        </p>
        {detail && (
          <p className="text-[10px] text-text-muted font-mono truncate">{detail}</p>
        )}
      </div>
    </div>
  );
}

/* ── Bottom Bar ──────────────────────────────────────────────────── */

function SessionBottomBar({
  session,
  totalTokens,
  turnCount,
  agentName,
  sessionId,
}: {
  session: SessionDetail | null;
  totalTokens: { input: number; output: number; total: number };
  turnCount: number;
  agentName?: string;
  sessionId?: string;
}) {
  const navigate = useNavigate();
  const [rating, setRating] = useState<number | null>(null);

  const handleCreateIssue = useCallback(async () => {
    try {
      const result = await apiPost<{ issue_id?: string }>("/api/v1/issues", {
        agent_name: agentName,
        session_ids: [sessionId],
        title: `Issue from session ${sessionId?.slice(0, 12)}`,
        severity: "medium",
      });
      if (result?.issue_id) {
        navigate(`/agents/${agentName}/issues/${result.issue_id}`);
      }
    } catch {
      // handle silently
    }
  }, [agentName, sessionId, navigate]);

  const handleRate = useCallback(async (value: number) => {
    setRating(value);
    try {
      await apiPost(`/api/v1/sessions/${sessionId}/feedback`, { rating: value });
    } catch {
      // handle silently
    }
  }, [sessionId]);

  return (
    <div className="mt-[var(--space-4)] p-[var(--space-3)] rounded-lg bg-surface-raised border border-border-default flex items-center gap-[var(--space-6)] flex-wrap">
      {/* Metadata */}
      <div className="flex items-center gap-[var(--space-4)] text-[var(--text-xs)] text-text-muted">
        <span className="flex items-center gap-1">
          <DollarSign size={12} />
          ${(session?.cost_total_usd ?? 0).toFixed(4)}
        </span>
        <span className="flex items-center gap-1">
          <Clock size={12} />
          {formatDuration(session?.wall_clock_seconds)}
        </span>
        <span className="flex items-center gap-1">
          <MessageSquare size={12} />
          {turnCount} turns
        </span>
        <span className="flex items-center gap-1 font-mono">
          {totalTokens.total.toLocaleString()} tokens
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Rating */}
      <div className="flex items-center gap-[var(--space-1)]">
        {[1, 2, 3, 4, 5].map((val) => (
          <button
            key={val}
            onClick={() => handleRate(val)}
            className={`p-1 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center transition-colors ${
              rating != null && val <= rating ? "text-status-warning" : "text-text-muted hover:text-status-warning"
            }`}
            aria-label={`Rate ${val} star${val > 1 ? "s" : ""}`}
          >
            <Star size={14} fill={rating != null && val <= rating ? "currentColor" : "none"} />
          </button>
        ))}
      </div>

      {/* Actions */}
      <button onClick={handleCreateIssue} className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]">
        <Flag size={14} />
        Create Issue
      </button>
    </div>
  );
}

export { SessionTracePage as default };
