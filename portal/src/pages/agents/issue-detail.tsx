import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  Play,
  Pencil,
  X,
} from "lucide-react";
import { useApiQuery, apiPost } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type IssueDetail = {
  issue_id?: string;
  id?: string;
  title: string;
  agent_name?: string;
  severity?: string;
  status?: string;
  category?: string;
  description?: string;
  pattern_description?: string;
  root_cause?: string;
  first_occurrence?: string;
  last_occurrence?: string;
  session_ids?: string[];
  affected_sessions_count?: number;
  suggested_fix?: SuggestedFix;
  created_at?: string;
  updated_at?: string;
};

type SuggestedFix = {
  description?: string;
  changes?: FixChange[];
  config_diff?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

type FixChange = {
  field: string;
  before: unknown;
  after: unknown;
  reason?: string;
};

type TriageResult = {
  severity?: string;
  category?: string;
  root_cause?: string;
  pattern_description?: string;
  suggested_fix?: SuggestedFix;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function severityBadge(severity?: string) {
  const s = (severity ?? "medium").toLowerCase();
  if (s === "high" || s === "critical") {
    return {
      icon: "bg-status-error",
      bg: "bg-status-error/10",
      text: "text-status-error",
      border: "border-status-error/20",
      label: `HIGH`,
    };
  }
  if (s === "low") {
    return {
      icon: "bg-status-live",
      bg: "bg-status-live/10",
      text: "text-status-live",
      border: "border-status-live/20",
      label: `LOW`,
    };
  }
  return {
    icon: "bg-status-warning",
    bg: "bg-status-warning/10",
    text: "text-status-warning",
    border: "border-status-warning/20",
    label: `MEDIUM`,
  };
}

function formatTime(iso?: string): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Issue Detail Page ───────────────────────────────────────────── */

export function IssueDetailPage() {
  const { name: agentName, issueId } = useParams<{ name: string; issueId: string }>();
  const navigate = useNavigate();

  const issueQuery = useApiQuery<IssueDetail>(
    `/api/v1/issues/${issueId ?? ""}`,
    Boolean(issueId),
  );

  const [triageOverlay, setTriageOverlay] = useState<TriageResult | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [applying, setApplying] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editedJson, setEditedJson] = useState("");

  // Merge fetched data with triage overlay
  const issue: IssueDetail | null = useMemo(() => {
    const base = issueQuery.data;
    if (!base) return null;
    if (!triageOverlay) return base;
    return {
      ...base,
      severity: triageOverlay.severity ?? base.severity,
      category: triageOverlay.category ?? base.category,
      root_cause: triageOverlay.root_cause ?? base.root_cause,
      pattern_description: triageOverlay.pattern_description ?? base.pattern_description,
      suggested_fix: triageOverlay.suggested_fix ?? base.suggested_fix,
      status: "triaged",
    };
  }, [issueQuery.data, triageOverlay]);

  // Auto-triage on load if status is open
  const issueIdForTriage = issueQuery.data?.issue_id ?? issueQuery.data?.id ?? issueId;
  const shouldTriage = issueQuery.data?.status === "open" && !issueQuery.data?.root_cause && !triaging && !triageOverlay;
  const triggerTriage = useCallback(() => {
    if (!issueIdForTriage) return;
    setTriaging(true);
    apiPost<TriageResult>(`/api/v1/issues/${issueIdForTriage}/triage`)
      .then((result) => {
        if (result) setTriageOverlay(result);
      })
      .catch(() => { /* ignore */ })
      .finally(() => setTriaging(false));
  }, [issueIdForTriage]);

  const triageTriggeredRef = useRef(false);
  useEffect(() => {
    if (shouldTriage && !triageTriggeredRef.current) {
      triageTriggeredRef.current = true;
      triggerTriage();
    }
  }, [shouldTriage, triggerTriage]);

  const handleApplyFix = useCallback(async () => {
    if (!issueId || applying) return;
    setApplying(true);
    try {
      let body: unknown = undefined;
      if (editMode && editedJson) {
        body = { config_override: JSON.parse(editedJson) };
      }
      await apiPost(`/api/v1/issues/${issueId}/auto-fix`, body);
      navigate(`/agents/${agentName}/verify?eval_triggered=true`);
    } catch {
      setApplying(false);
    }
  }, [issueId, applying, editMode, editedJson, agentName, navigate]);

  const handleDismiss = useCallback(async () => {
    if (!issueId) return;
    try {
      await apiPost(`/api/v1/issues/${issueId}/resolve`, { resolution: "dismissed" });
      navigate(`/agents/${agentName}?tab=overview`);
    } catch { /* ignore */ }
  }, [issueId, agentName, navigate]);

  if (issueQuery.loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-text-muted text-[var(--text-sm)]">
        Loading issue...
      </div>
    );
  }

  if (!issue) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-text-muted text-[var(--text-sm)]">
        Issue not found
      </div>
    );
  }

  const badge = severityBadge(issue.severity);
  const suggestedFix = issue.suggested_fix;
  const changes = suggestedFix?.changes ?? [];
  const hasDiff = changes.length > 0 || suggestedFix?.before || suggestedFix?.after;

  return (
    <div>
      {/* Back nav */}
      <button
        onClick={() => navigate(`/agents/${agentName}?tab=overview`)}
        className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-text-muted hover:text-text-primary transition-colors mb-[var(--space-4)] min-h-[var(--touch-target-min)]"
      >
        <ArrowLeft size={16} />
        Back to {agentName}
      </button>

      {/* Issue Header */}
      <div className="flex items-start gap-[var(--space-3)] mb-[var(--space-6)]">
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wide border ${badge.bg} ${badge.text} ${badge.border}`}
        >
          <span className={`w-2 h-2 rounded-full ${badge.icon}`} />
          {badge.label}
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-[var(--text-lg)] font-bold text-text-primary">{issue.title}</h1>
          {issue.category && (
            <span className="text-[var(--text-xs)] text-text-muted">Category: {issue.category}</span>
          )}
        </div>
        {triaging && (
          <span className="text-[var(--text-xs)] text-status-warning animate-pulse">Triaging...</span>
        )}
      </div>

      {/* Root Cause Section */}
      <div className="card mb-[var(--space-4)]">
        <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Root Cause Analysis
        </h3>
        <div className="space-y-[var(--space-3)]">
          {issue.root_cause && (
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">Root Cause</label>
              <p className="text-[var(--text-sm)] text-text-primary mt-[var(--space-1)]">{issue.root_cause}</p>
            </div>
          )}
          {issue.pattern_description && (
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">Pattern</label>
              <p className="text-[var(--text-sm)] text-text-secondary mt-[var(--space-1)]">{issue.pattern_description}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-[var(--space-3)]">
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">First Seen</label>
              <p className="text-[var(--text-sm)] text-text-secondary font-mono mt-[var(--space-1)]">
                {formatTime(issue.first_occurrence)}
              </p>
            </div>
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">Last Seen</label>
              <p className="text-[var(--text-sm)] text-text-secondary font-mono mt-[var(--space-1)]">
                {formatTime(issue.last_occurrence)}
              </p>
            </div>
          </div>

          {/* Affected Sessions */}
          {issue.session_ids && issue.session_ids.length > 0 && (
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">
                Affected Sessions ({issue.session_ids.length})
              </label>
              <div className="flex flex-wrap gap-[var(--space-1)] mt-[var(--space-1)]">
                {issue.session_ids.slice(0, 10).map((sid) => (
                  <button
                    key={sid}
                    onClick={() => navigate(`/agents/${agentName}/sessions/${sid}`)}
                    className="text-[var(--text-xs)] font-mono text-accent hover:text-accent-hover transition-colors underline min-h-[var(--touch-target-min)] flex items-center"
                  >
                    {sid.slice(0, 12)}...
                    <ExternalLink size={10} className="ml-0.5" />
                  </button>
                ))}
                {issue.session_ids.length > 10 && (
                  <span className="text-[var(--text-xs)] text-text-muted self-center">
                    +{issue.session_ids.length - 10} more
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Suggested Fix Section */}
      {suggestedFix && (
        <div className="card mb-[var(--space-4)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Suggested Fix
          </h3>

          {suggestedFix.description && (
            <p className="text-[var(--text-sm)] text-text-primary mb-[var(--space-3)]">
              {suggestedFix.description}
            </p>
          )}

          {/* Diff viewer */}
          {hasDiff && !editMode && (
            <DiffViewer changes={changes} before={suggestedFix.before} after={suggestedFix.after} />
          )}

          {/* Edit mode */}
          {editMode && (
            <div className="mb-[var(--space-3)]">
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)] block">
                Edit Config JSON
              </label>
              <textarea
                value={editedJson}
                onChange={(e) => setEditedJson(e.target.value)}
                rows={12}
                className="w-full font-mono text-[var(--text-xs)] resize-y"
              />
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center gap-[var(--space-3)] flex-wrap">
        <button
          onClick={handleApplyFix}
          disabled={applying}
          className="btn btn-primary min-h-[var(--touch-target-min)]"
        >
          <Play size={14} />
          {applying ? "Applying..." : "Apply Fix & Run Eval"}
        </button>
        <button
          onClick={() => {
            if (!editMode) {
              const fixJson = suggestedFix?.after ?? suggestedFix?.config_diff ?? {};
              setEditedJson(JSON.stringify(fixJson, null, 2));
            }
            setEditMode(!editMode);
          }}
          className="btn btn-secondary min-h-[var(--touch-target-min)]"
        >
          <Pencil size={14} />
          {editMode ? "Cancel Edit" : "Edit Fix"}
        </button>
        <button
          onClick={handleDismiss}
          className="btn btn-ghost text-text-muted min-h-[var(--touch-target-min)]"
        >
          <X size={14} />
          Dismiss
        </button>
      </div>
    </div>
  );
}

/* ── Diff Viewer ─────────────────────────────────────────────────── */

function DiffViewer({
  changes,
  before,
  after,
}: {
  changes: FixChange[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}) {
  // If we have structured changes, render them
  if (changes.length > 0) {
    return (
      <div className="rounded-lg border border-border-default overflow-hidden font-mono text-[var(--text-xs)]">
        {changes.map((change, i) => (
          <div key={i} className="border-b border-border-subtle last:border-b-0">
            <div className="px-[var(--space-3)] py-[var(--space-1)] bg-surface-overlay text-text-muted text-[10px] uppercase tracking-wide">
              {change.field}
              {change.reason && <span className="ml-2 normal-case text-text-secondary">-- {change.reason}</span>}
            </div>
            <div className="px-[var(--space-3)] py-[var(--space-2)] bg-[rgba(239,68,68,0.06)]">
              <span className="text-status-error select-none mr-2">-</span>
              <span className="text-status-error">{stringifyValue(change.before)}</span>
            </div>
            <div className="px-[var(--space-3)] py-[var(--space-2)] bg-[rgba(34,197,94,0.06)]">
              <span className="text-status-live select-none mr-2">+</span>
              <span className="text-status-live">{stringifyValue(change.after)}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Fall back to before/after JSON diff
  if (before || after) {
    const beforeStr = JSON.stringify(before ?? {}, null, 2);
    const afterStr = JSON.stringify(after ?? {}, null, 2);
    return (
      <div className="grid grid-cols-2 gap-[var(--space-2)]">
        <div className="rounded-lg border border-border-default overflow-hidden">
          <div className="px-[var(--space-3)] py-[var(--space-1)] bg-surface-overlay text-[10px] text-text-muted uppercase tracking-wide">
            Before
          </div>
          <pre className="px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] font-mono text-status-error bg-[rgba(239,68,68,0.04)] overflow-x-auto whitespace-pre-wrap break-all">
            {beforeStr}
          </pre>
        </div>
        <div className="rounded-lg border border-border-default overflow-hidden">
          <div className="px-[var(--space-3)] py-[var(--space-1)] bg-surface-overlay text-[10px] text-text-muted uppercase tracking-wide">
            After
          </div>
          <pre className="px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] font-mono text-status-live bg-[rgba(34,197,94,0.04)] overflow-x-auto whitespace-pre-wrap break-all">
            {afterStr}
          </pre>
        </div>
      </div>
    );
  }

  return null;
}

function stringifyValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "string") return `"${val}"`;
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

export { IssueDetailPage as default };
