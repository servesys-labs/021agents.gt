import { useCallback, useMemo, useState } from "react";
import {
  ShieldAlert,
  Scan,
  ShieldOff,
  Eye,
  AlertTriangle,
  Plus,
  Trash2,
  Pencil,
  Download,
  ChevronDown,
  ChevronRight,
  X,
  Search,
  Filter,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { Tabs } from "../../components/common/Tabs";
import { EmptyState } from "../../components/common/EmptyState";
import { QueryState } from "../../components/common/QueryState";
import { useApiQuery, apiPost, apiDelete, apiRequest } from "../../lib/api";
import { extractList } from "../../lib/normalize";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type GuardrailEvent = {
  id: string;
  timestamp: string;
  agent_name: string;
  event_type: string;
  action: "allow" | "warn" | "block";
  text_preview: string;
  full_text?: string;
  match_count: number;
  matches?: PiiMatch[];
  policy_name?: string;
};

type PiiMatch = {
  category: string;
  start: number;
  end: number;
  text: string;
};

type ScanResult = {
  pii_matches: PiiMatch[];
  injection_score: number;
  safety_issues: string[];
  action: "allow" | "warn" | "block";
};

type GuardrailStats = {
  total_scans_today: number;
  blocked_count: number;
  warnings_count: number;
  pii_detections: number;
};

type GuardrailPolicy = {
  id: string;
  name: string;
  agent_scope: string | null;
  pii_detection: boolean;
  pii_redaction: boolean;
  injection_check: boolean;
  output_safety: boolean;
  system_prompt_leak_prevention: boolean;
  max_input_length: number;
  blocked_topics: string[];
  pii_categories: string[];
  enabled: boolean;
};

type DataClassification = {
  id: string;
  name: string;
  level: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  description: string;
  patterns: string[];
};

type AgentDlpPolicy = {
  agent_name: string;
  allowed_levels: string[];
  pii_handling: "block" | "redact" | "allow";
  audit_all_access: boolean;
};

type PiiExposureReport = {
  total_exposures: number;
  by_category: Record<string, number>;
  by_agent: { agent_name: string; exposures: number; categories: Record<string, number> }[];
  trend: { date: string; count: number }[];
};

type Agent = {
  name: string;
};

/* ── Constants ──────────────────────────────────────────────────── */

const PII_CATEGORIES = [
  "SSN",
  "Credit Card",
  "Email",
  "Phone",
  "IP",
  "API Key",
  "Address",
] as const;

const EVENT_TYPES = [
  "pii_detected",
  "injection_blocked",
  "output_filtered",
  "secret_leaked",
] as const;

const LEVEL_COLORS: Record<string, string> = {
  PUBLIC: "bg-status-live/15 text-status-live border-status-live/20",
  INTERNAL: "bg-chart-blue/15 text-chart-blue border-chart-blue/20",
  CONFIDENTIAL: "bg-status-warning/15 text-status-warning border-status-warning/20",
  RESTRICTED: "bg-status-error/15 text-status-error border-status-error/20",
};

const ACTION_COLORS: Record<string, string> = {
  allow: "bg-status-live/15 text-status-live border-status-live/20",
  warn: "bg-status-warning/15 text-status-warning border-status-warning/20",
  block: "bg-status-error/15 text-status-error border-status-error/20",
};

const PII_HANDLING_COLORS: Record<string, string> = {
  block: "bg-status-error/15 text-status-error border-status-error/20",
  redact: "bg-status-warning/15 text-status-warning border-status-warning/20",
  allow: "bg-status-live/15 text-status-live border-status-live/20",
};

/* ── Helpers ─────────────────────────────────────────────────────── */

function formatTimestamp(ts: string): string {
  if (!ts) return "--";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/* ── Injection Score Gauge (SVG arc) ──────────────────────────── */

function InjectionGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(1, score));
  const angle = clamped * 180;
  const r = 40;
  const cx = 50;
  const cy = 50;

  const startX = cx - r;
  const startY = cy;
  const rad = (angle * Math.PI) / 180;
  const endX = cx - r * Math.cos(rad);
  const endY = cy - r * Math.sin(rad);
  const largeArc = angle > 180 ? 1 : 0;

  const color =
    clamped >= 0.7
      ? "var(--color-status-error)"
      : clamped >= 0.4
        ? "var(--color-status-warning)"
        : "var(--color-status-live)";

  const label =
    clamped >= 0.7 ? "High" : clamped >= 0.4 ? "Medium" : "Low";

  return (
    <div className="flex flex-col items-center gap-[var(--space-1)]">
      <svg viewBox="0 0 100 55" width="120" height="66" aria-label={`Injection score: ${(clamped * 100).toFixed(0)}%`}>
        {/* Background arc */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="var(--color-surface-overlay)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {/* Score arc */}
        {clamped > 0 && (
          <path
            d={`M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY}`}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
          />
        )}
        <text
          x={cx}
          y={cy - 8}
          textAnchor="middle"
          fill="var(--color-text-primary)"
          fontSize="14"
          fontWeight="700"
          fontFamily="monospace"
        >
          {(clamped * 100).toFixed(0)}%
        </text>
      </svg>
      <span
        className="text-[10px] font-semibold uppercase tracking-wide"
        style={{ color }}
      >
        {label} Risk
      </span>
    </div>
  );
}

/* ── Toggle Switch ────────────────────────────────────────────── */

function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="inline-flex items-center gap-[var(--space-3)] cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex items-center h-[28px] w-[52px] rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
          disabled ? "opacity-50 cursor-not-allowed" : ""
        } ${checked ? "bg-accent" : "bg-surface-overlay"}`}
      >
        <span
          className={`absolute left-[3px] h-[22px] w-[22px] rounded-full bg-text-primary transition-transform shadow-sm ${
            checked ? "translate-x-[24px]" : "translate-x-0"
          }`}
        />
      </button>
      {label && <span className="text-[var(--text-sm)] text-text-secondary">{label}</span>}
    </label>
  );
}

/* ── Modal Backdrop ───────────────────────────────────────────── */

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="glass-backdrop fixed inset-0" onClick={onClose} />
      <div className="relative z-10 glass-medium border border-border-default rounded-xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-overlay">
        <div className="flex items-center justify-between p-[var(--space-4)] border-b border-border-default">
          <h3 className="text-[var(--text-md)] font-semibold text-text-primary">{title}</h3>
          <button
            onClick={onClose}
            className="p-[var(--space-1)] rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-[var(--space-4)]">{children}</div>
      </div>
    </div>
  );
}

/* ── Trend Sparkline (simple SVG) ─────────────────────────────── */

function TrendSparkline({ data }: { data: { date: string; count: number }[] }) {
  if (!data || data.length < 2) return <span className="text-[10px] text-text-muted">No data</span>;

  const max = Math.max(...data.map((d) => d.count), 1);
  const w = 120;
  const h = 24;
  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (d.count / max) * h;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-label="Exposure trend">
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-status-error)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ── Signal Card ──────────────────────────────────────────────── */

function SignalCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="card flex items-center gap-[var(--space-4)]">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-[var(--text-xl)] font-bold font-mono text-text-primary">{value.toLocaleString()}</p>
        <p className="text-[10px] text-text-muted uppercase tracking-wide">{label}</p>
      </div>
    </div>
  );
}

/* ================================================================
   Tab 1: Overview
   ================================================================ */

function OverviewTab() {
  const { showToast } = useToast();

  const statsQuery = useApiQuery<GuardrailStats>("/api/v1/guardrails/stats");
  const eventsQuery = useApiQuery<{ events: GuardrailEvent[] } | GuardrailEvent[]>(
    "/api/v1/guardrails/events?limit=10",
  );

  const stats = statsQuery.data;
  const events: GuardrailEvent[] = useMemo(() => {
    const raw = eventsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.events ?? [];
  }, [eventsQuery.data]);

  /* Live test panel state */
  const [scanText, setScanText] = useState("");
  const [scanDirection, setScanDirection] = useState<"input" | "output">("input");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  const handleScan = useCallback(async () => {
    if (!scanText.trim()) return;
    setScanning(true);
    setScanResult(null);
    try {
      const result = await apiPost<ScanResult>("/api/v1/guardrails/scan", {
        text: scanText,
        direction: scanDirection,
      });
      setScanResult(result);
    } catch {
      showToast("Scan failed", "error");
    } finally {
      setScanning(false);
    }
  }, [scanText, scanDirection, showToast]);

  /* Render text with PII highlights */
  function renderHighlightedText(text: string, matches: PiiMatch[]) {
    if (!matches.length) return <span>{text}</span>;

    const sorted = [...matches].sort((a, b) => a.start - b.start);
    const parts: React.ReactNode[] = [];
    let cursor = 0;

    sorted.forEach((match, idx) => {
      if (match.start > cursor) {
        parts.push(<span key={`t-${idx}`}>{text.slice(cursor, match.start)}</span>);
      }
      parts.push(
        <span
          key={`m-${idx}`}
          className="border-b-2 border-status-error text-status-error cursor-help relative group"
          title={match.category}
        >
          {text.slice(match.start, match.end)}
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-[var(--space-2)] py-[var(--space-1)] rounded bg-surface-overlay text-[10px] text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-border-default shadow-dropdown z-10">
            {match.category}
          </span>
        </span>,
      );
      cursor = match.end;
    });

    if (cursor < text.length) {
      parts.push(<span key="tail">{text.slice(cursor)}</span>);
    }

    return <>{parts}</>;
  }

  return (
    <div className="space-y-[var(--space-6)]">
      {/* Signal Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-[var(--space-3)]">
        <SignalCard
          label="Scans Today"
          value={stats?.total_scans_today ?? 0}
          icon={<Scan size={18} className="text-chart-blue" />}
          color="bg-chart-blue/10"
        />
        <SignalCard
          label="Blocked"
          value={stats?.blocked_count ?? 0}
          icon={<ShieldOff size={18} className="text-status-error" />}
          color="bg-status-error/10"
        />
        <SignalCard
          label="Warnings"
          value={stats?.warnings_count ?? 0}
          icon={<AlertTriangle size={18} className="text-status-warning" />}
          color="bg-status-warning/10"
        />
        <SignalCard
          label="PII Detections"
          value={stats?.pii_detections ?? 0}
          icon={<Eye size={18} className="text-chart-purple" />}
          color="bg-chart-purple/10"
        />
      </div>

      {/* Live Test Panel — Hero */}
      <section>
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Live Test Panel
        </h2>
        <div className="card border-accent/20">
          <div className="flex items-center gap-[var(--space-4)] mb-[var(--space-3)]">
            <span className="text-[var(--text-sm)] text-text-secondary font-medium">
              Scan direction:
            </span>
            <div className="flex items-center rounded-lg bg-surface-overlay p-[var(--space-1)] gap-[var(--space-1)]">
              <button
                onClick={() => setScanDirection("input")}
                className={`px-[var(--space-3)] py-[var(--space-1)] rounded-md text-[var(--text-xs)] font-medium transition-colors min-h-[var(--touch-target-min)] ${
                  scanDirection === "input"
                    ? "bg-accent text-text-inverse"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                Input
              </button>
              <button
                onClick={() => setScanDirection("output")}
                className={`px-[var(--space-3)] py-[var(--space-1)] rounded-md text-[var(--text-xs)] font-medium transition-colors min-h-[var(--touch-target-min)] ${
                  scanDirection === "output"
                    ? "bg-accent text-text-inverse"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                Output
              </button>
            </div>
          </div>

          <textarea
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
            placeholder="Paste text to test against guardrails... e.g. My SSN is 123-45-6789 and credit card is 4111-1111-1111-1111"
            rows={4}
            className="w-full mb-[var(--space-3)] font-mono text-[var(--text-sm)]"
          />

          <button
            onClick={handleScan}
            disabled={scanning || !scanText.trim()}
            className="btn btn-primary min-h-[var(--touch-target-min)]"
          >
            <Scan size={14} />
            {scanning ? "Scanning..." : "Scan"}
          </button>

          {/* Scan results */}
          {scanResult && (
            <div className="mt-[var(--space-4)] p-[var(--space-4)] rounded-lg bg-surface-overlay space-y-[var(--space-4)]">
              <div className="flex items-center gap-[var(--space-2)]">
                <span className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
                  Action:
                </span>
                <span
                  className={`inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-semibold uppercase border ${ACTION_COLORS[scanResult.action]}`}
                >
                  {scanResult.action}
                </span>
              </div>

              {/* PII matches */}
              {scanResult.pii_matches.length > 0 && (
                <div>
                  <p className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
                    PII Detected ({scanResult.pii_matches.length})
                  </p>
                  <div className="p-[var(--space-3)] rounded-lg bg-surface-base text-[var(--text-sm)] font-mono leading-relaxed">
                    {renderHighlightedText(scanText, scanResult.pii_matches)}
                  </div>
                  <div className="flex flex-wrap gap-[var(--space-2)] mt-[var(--space-2)]">
                    {scanResult.pii_matches.map((m, i) => (
                      <span
                        key={i}
                        className="inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-medium bg-status-error/10 text-status-error border border-status-error/20"
                      >
                        {m.category}: {truncate(m.text, 20)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Injection score gauge */}
              <div className="flex items-start gap-[var(--space-8)]">
                <div>
                  <p className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
                    Injection Score
                  </p>
                  <InjectionGauge score={scanResult.injection_score} />
                </div>

                {/* Safety issues */}
                {scanResult.safety_issues.length > 0 && (
                  <div className="flex-1">
                    <p className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
                      Safety Issues
                    </p>
                    <ul className="space-y-[var(--space-1)]">
                      {scanResult.safety_issues.map((issue, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-status-warning"
                        >
                          <AlertTriangle size={12} />
                          {issue}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {scanResult.pii_matches.length === 0 &&
                scanResult.safety_issues.length === 0 &&
                scanResult.injection_score < 0.3 && (
                  <p className="text-[var(--text-sm)] text-status-live flex items-center gap-[var(--space-2)]">
                    <ShieldAlert size={14} /> All clear. No guardrail issues detected.
                  </p>
                )}
            </div>
          )}
        </div>
      </section>

      {/* Recent Events */}
      <section>
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Recent Events
        </h2>
        <QueryState loading={eventsQuery.loading} error={eventsQuery.error}>
          {events.length > 0 ? (
            <div className="card">
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Agent</th>
                      <th>Type</th>
                      <th>Action</th>
                      <th>Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((evt) => (
                      <tr key={evt.id}>
                        <td className="text-text-muted whitespace-nowrap">{formatTimestamp(evt.timestamp)}</td>
                        <td className="text-text-primary font-medium">{evt.agent_name}</td>
                        <td>
                          <span className="text-[var(--text-xs)] text-text-secondary font-mono">
                            {evt.event_type}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-semibold uppercase border ${ACTION_COLORS[evt.action]}`}
                          >
                            {evt.action}
                          </span>
                        </td>
                        <td className="text-text-muted max-w-[200px] truncate" title={evt.text_preview}>
                          {truncate(evt.text_preview, 50)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<ShieldAlert size={24} />}
              message="No guardrail events recorded yet."
            />
          )}
        </QueryState>
      </section>
    </div>
  );
}

/* ================================================================
   Tab 2: Policies
   ================================================================ */

function PoliciesTab() {
  const { showToast } = useToast();

  const policiesQuery = useApiQuery<{ policies: GuardrailPolicy[] } | GuardrailPolicy[]>(
    "/api/v1/guardrails/policies",
  );
  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents");

  const policies: GuardrailPolicy[] = useMemo(() => {
    const raw = policiesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.policies ?? [];
  }, [policiesQuery.data]);

  const agents: Agent[] = useMemo(() => {
    return extractList<Agent>(agentsQuery.data, "agents");
  }, [agentsQuery.data]);

  const [showCreate, setShowCreate] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<GuardrailPolicy | null>(null);

  /* Form state */
  const emptyForm = {
    name: "",
    agent_scope: "" as string,
    pii_detection: true,
    pii_redaction: false,
    injection_check: true,
    output_safety: false,
    system_prompt_leak_prevention: false,
    max_input_length: 100000,
    blocked_topics: "",
    pii_categories: ["SSN", "Credit Card", "Email"] as string[],
  };

  const [form, setForm] = useState(emptyForm);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setForm(emptyForm);
    setEditingPolicy(null);
    setShowAdvanced(false);
    setShowCreate(true);
  };

  const openEdit = (p: GuardrailPolicy) => {
    setForm({
      name: p.name,
      agent_scope: p.agent_scope ?? "",
      pii_detection: p.pii_detection,
      pii_redaction: p.pii_redaction,
      injection_check: p.injection_check,
      output_safety: p.output_safety,
      system_prompt_leak_prevention: p.system_prompt_leak_prevention,
      max_input_length: p.max_input_length,
      blocked_topics: p.blocked_topics.join(", "),
      pii_categories: p.pii_categories,
    });
    setEditingPolicy(p);
    setShowAdvanced(false);
    setShowCreate(true);
  };

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      showToast("Policy name is required", "error");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name,
        agent_scope: form.agent_scope || null,
        pii_detection: form.pii_detection,
        pii_redaction: form.pii_redaction,
        injection_check: form.injection_check,
        output_safety: form.output_safety,
        system_prompt_leak_prevention: form.system_prompt_leak_prevention,
        max_input_length: form.max_input_length,
        blocked_topics: form.blocked_topics
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        pii_categories: form.pii_categories,
      };

      if (editingPolicy) {
        await apiRequest(
          `/api/v1/guardrails/policies/${editingPolicy.id}`,
          "PUT",
          body,
        );
        showToast("Policy updated", "success");
      } else {
        await apiPost("/api/v1/guardrails/policies", body);
        showToast("Policy created", "success");
      }
      setShowCreate(false);
      policiesQuery.refetch();
    } catch {
      showToast("Failed to save policy", "error");
    } finally {
      setSaving(false);
    }
  }, [form, editingPolicy, showToast, policiesQuery]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiDelete(`/api/v1/guardrails/policies/${id}`);
        showToast("Policy deleted", "success");
        policiesQuery.refetch();
      } catch {
        showToast("Failed to delete policy", "error");
      }
    },
    [showToast, policiesQuery],
  );

  const togglePiiCategory = (cat: string) => {
    setForm((prev) => ({
      ...prev,
      pii_categories: prev.pii_categories.includes(cat)
        ? prev.pii_categories.filter((c) => c !== cat)
        : [...prev.pii_categories, cat],
    }));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-[var(--space-4)]">
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
          Guardrail Policies
        </h2>
        <button onClick={openCreate} className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]">
          <Plus size={14} /> Create Policy
        </button>
      </div>

      <QueryState loading={policiesQuery.loading} error={policiesQuery.error}>
        {policies.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-3)]">
            {policies.map((policy) => (
              <div key={policy.id} className="card card-hover">
                <div className="flex items-start justify-between mb-[var(--space-3)]">
                  <div>
                    <h3 className="text-[var(--text-md)] font-semibold text-text-primary">
                      {policy.name}
                    </h3>
                    <p className="text-[10px] text-text-muted mt-[var(--space-1)]">
                      {policy.agent_scope ? policy.agent_scope : "All agents"}
                    </p>
                  </div>
                  <div className="flex items-center gap-[var(--space-1)]">
                    <button
                      onClick={() => openEdit(policy)}
                      className="p-[var(--space-2)] rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                      aria-label={`Edit ${policy.name}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(policy.id)}
                      className="p-[var(--space-2)] rounded-md text-text-muted hover:bg-status-error/10 hover:text-status-error transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                      aria-label={`Delete ${policy.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-[var(--space-2)]">
                  {policy.pii_detection && (
                    <FeatureBadge label="PII Detection" active />
                  )}
                  {policy.pii_redaction && (
                    <FeatureBadge label="PII Redaction" active />
                  )}
                  {policy.injection_check && (
                    <FeatureBadge label="Injection Check" active />
                  )}
                  {policy.output_safety && (
                    <FeatureBadge label="Output Safety" active />
                  )}
                  {policy.system_prompt_leak_prevention && (
                    <FeatureBadge label="Leak Prevention" active />
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ShieldAlert size={24} />}
            message="No guardrail policies yet. Create one to get started."
            action={
              <button onClick={openCreate} className="btn btn-primary text-[var(--text-xs)] mt-[var(--space-2)] min-h-[var(--touch-target-min)]">
                <Plus size={14} /> Create Policy
              </button>
            }
          />
        )}
      </QueryState>

      {/* Create / Edit Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={editingPolicy ? "Edit Policy" : "Create Policy"}
      >
        <div className="space-y-[var(--space-4)]">
          {/* Name */}
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Policy Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="e.g. Default PII Policy"
            />
          </div>

          {/* Agent scope */}
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Agent Scope
            </label>
            <select
              value={form.agent_scope}
              onChange={(e) => setForm((p) => ({ ...p, agent_scope: e.target.value }))}
              className="min-h-[var(--touch-target-min)]"
            >
              <option value="">All Agents</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {/* Feature toggles */}
          <div className="space-y-[var(--space-3)]">
            <p className="text-[10px] text-text-muted uppercase tracking-wide">Features</p>
            <Toggle
              checked={form.pii_detection}
              onChange={(v) => setForm((p) => ({ ...p, pii_detection: v, pii_redaction: v ? p.pii_redaction : false }))}
              label="PII Detection"
            />
            <Toggle
              checked={form.pii_redaction}
              onChange={(v) => setForm((p) => ({ ...p, pii_redaction: v }))}
              disabled={!form.pii_detection}
              label="PII Redaction"
            />
            <Toggle
              checked={form.injection_check}
              onChange={(v) => setForm((p) => ({ ...p, injection_check: v }))}
              label="Prompt Injection Check"
            />
            <Toggle
              checked={form.output_safety}
              onChange={(v) => setForm((p) => ({ ...p, output_safety: v }))}
              label="Output Safety Scanning"
            />
            <Toggle
              checked={form.system_prompt_leak_prevention}
              onChange={(v) => setForm((p) => ({ ...p, system_prompt_leak_prevention: v }))}
              label="System Prompt Leak Prevention"
            />
          </div>

          {/* Advanced settings */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-[var(--space-2)] text-[var(--text-xs)] text-text-muted hover:text-text-secondary transition-colors min-h-[var(--touch-target-min)]"
            >
              {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Advanced Settings
            </button>

            {showAdvanced && (
              <div className="mt-[var(--space-3)] space-y-[var(--space-3)] pl-[var(--space-4)] border-l border-border-default">
                <div>
                  <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Max Input Length
                  </label>
                  <input
                    type="number"
                    value={form.max_input_length}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, max_input_length: parseInt(e.target.value, 10) || 100000 }))
                    }
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Blocked Topics (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={form.blocked_topics}
                    onChange={(e) => setForm((p) => ({ ...p, blocked_topics: e.target.value }))}
                    placeholder="violence, hate-speech, self-harm"
                  />
                </div>

                <div>
                  <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
                    PII Categories to Redact
                  </p>
                  <div className="flex flex-wrap gap-[var(--space-2)]">
                    {PII_CATEGORIES.map((cat) => (
                      <label
                        key={cat}
                        className="inline-flex items-center gap-[var(--space-1)] cursor-pointer select-none"
                      >
                        <input
                          type="checkbox"
                          checked={form.pii_categories.includes(cat)}
                          onChange={() => togglePiiCategory(cat)}
                          className="accent-accent w-4 h-4"
                        />
                        <span className="text-[var(--text-xs)] text-text-secondary">{cat}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-[var(--space-3)] pt-[var(--space-3)] border-t border-border-default">
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary min-h-[var(--touch-target-min)]"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="btn btn-secondary min-h-[var(--touch-target-min)]"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* Feature badge helper */
function FeatureBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-[var(--space-1)] px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-medium border ${
        active
          ? "bg-status-live/10 text-status-live border-status-live/20"
          : "bg-surface-overlay text-text-muted border-border-default"
      }`}
    >
      {active ? "\u2713" : "\u2717"} {label}
    </span>
  );
}

/* ================================================================
   Tab 3: DLP
   ================================================================ */

function DlpTab() {
  const { showToast } = useToast();

  const classificationsQuery = useApiQuery<
    { classifications: DataClassification[] } | DataClassification[]
  >("/api/v1/guardrails/classifications");
  const dlpPoliciesQuery = useApiQuery<{ policies: AgentDlpPolicy[] } | AgentDlpPolicy[]>(
    "/api/v1/guardrails/dlp-policies",
  );
  const exposureQuery = useApiQuery<PiiExposureReport>("/api/v1/guardrails/pii-exposure");

  const classifications: DataClassification[] = useMemo(() => {
    const raw = classificationsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.classifications ?? [];
  }, [classificationsQuery.data]);

  const dlpPolicies: AgentDlpPolicy[] = useMemo(() => {
    const raw = dlpPoliciesQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.policies ?? [];
  }, [dlpPoliciesQuery.data]);

  const exposure = exposureQuery.data;

  /* Create classification modal */
  const [showCreateClass, setShowCreateClass] = useState(false);
  const [classForm, setClassForm] = useState({
    name: "",
    level: "INTERNAL" as DataClassification["level"],
    description: "",
    patterns: "",
  });
  const [savingClass, setSavingClass] = useState(false);

  const handleCreateClass = useCallback(async () => {
    if (!classForm.name.trim()) {
      showToast("Name is required", "error");
      return;
    }
    setSavingClass(true);
    try {
      await apiPost("/api/v1/guardrails/classifications", {
        name: classForm.name,
        level: classForm.level,
        description: classForm.description,
        patterns: classForm.patterns
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean),
      });
      showToast("Classification created", "success");
      setShowCreateClass(false);
      setClassForm({ name: "", level: "INTERNAL", description: "", patterns: "" });
      classificationsQuery.refetch();
    } catch {
      showToast("Failed to create classification", "error");
    } finally {
      setSavingClass(false);
    }
  }, [classForm, showToast, classificationsQuery]);

  const handleDeleteClass = useCallback(
    async (id: string) => {
      try {
        await apiDelete(`/api/v1/guardrails/classifications/${id}`);
        showToast("Classification deleted", "success");
        classificationsQuery.refetch();
      } catch {
        showToast("Failed to delete", "error");
      }
    },
    [showToast, classificationsQuery],
  );

  /* Inline DLP policy editing */
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [dlpEdit, setDlpEdit] = useState<AgentDlpPolicy | null>(null);

  const startEditDlp = (p: AgentDlpPolicy) => {
    setEditingAgent(p.agent_name);
    setDlpEdit({ ...p });
  };

  const saveDlpEdit = useCallback(async () => {
    if (!dlpEdit) return;
    try {
      await apiRequest(
        `/api/v1/guardrails/dlp-policies/${encodeURIComponent(dlpEdit.agent_name)}`,
        "PUT",
        dlpEdit,
      );
      showToast("DLP policy updated", "success");
      setEditingAgent(null);
      dlpPoliciesQuery.refetch();
    } catch {
      showToast("Failed to update DLP policy", "error");
    }
  }, [dlpEdit, showToast, dlpPoliciesQuery]);

  /* Date range (simplified) */
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  return (
    <div className="space-y-[var(--space-8)]">
      {/* Section A: Data Classifications */}
      <section>
        <div className="flex items-center justify-between mb-[var(--space-3)]">
          <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
            Data Classifications
          </h2>
          <button
            onClick={() => setShowCreateClass(true)}
            className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          >
            <Plus size={14} /> Create Classification
          </button>
        </div>

        <QueryState loading={classificationsQuery.loading} error={classificationsQuery.error}>
          {classifications.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[var(--space-3)]">
              {classifications.map((cls) => (
                <div key={cls.id} className="card card-hover">
                  <div className="flex items-start justify-between mb-[var(--space-2)]">
                    <h3 className="text-[var(--text-sm)] font-semibold text-text-primary">
                      {cls.name}
                    </h3>
                    <div className="flex items-center gap-[var(--space-2)]">
                      <span
                        className={`inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-semibold uppercase border ${LEVEL_COLORS[cls.level]}`}
                      >
                        {cls.level}
                      </span>
                      <button
                        onClick={() => handleDeleteClass(cls.id)}
                        className="p-[var(--space-1)] rounded-md text-text-muted hover:bg-status-error/10 hover:text-status-error transition-colors min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                        aria-label={`Delete ${cls.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <p className="text-[var(--text-xs)] text-text-muted mb-[var(--space-2)]">
                    {cls.description}
                  </p>
                  <p className="text-[10px] text-text-muted">
                    {cls.patterns.length} pattern{cls.patterns.length !== 1 ? "s" : ""}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message="No data classifications defined yet." />
          )}
        </QueryState>

        {/* Create Classification Modal */}
        <Modal
          open={showCreateClass}
          onClose={() => setShowCreateClass(false)}
          title="Create Classification"
        >
          <div className="space-y-[var(--space-4)]">
            <div>
              <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Name
              </label>
              <input
                type="text"
                value={classForm.name}
                onChange={(e) => setClassForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Customer PII"
              />
            </div>
            <div>
              <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Level
              </label>
              <select
                value={classForm.level}
                onChange={(e) =>
                  setClassForm((p) => ({ ...p, level: e.target.value as DataClassification["level"] }))
                }
                className="min-h-[var(--touch-target-min)]"
              >
                <option value="PUBLIC">Public</option>
                <option value="INTERNAL">Internal</option>
                <option value="CONFIDENTIAL">Confidential</option>
                <option value="RESTRICTED">Restricted</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Description
              </label>
              <input
                type="text"
                value={classForm.description}
                onChange={(e) => setClassForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Describe this classification..."
              />
            </div>
            <div>
              <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Patterns (one per line)
              </label>
              <textarea
                value={classForm.patterns}
                onChange={(e) => setClassForm((p) => ({ ...p, patterns: e.target.value }))}
                rows={4}
                placeholder={"\\b\\d{3}-\\d{2}-\\d{4}\\b\n\\b4\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b"}
                className="font-mono text-[var(--text-xs)]"
              />
            </div>
            <div className="flex items-center gap-[var(--space-3)] pt-[var(--space-3)] border-t border-border-default">
              <button
                onClick={handleCreateClass}
                disabled={savingClass}
                className="btn btn-primary min-h-[var(--touch-target-min)]"
              >
                {savingClass ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => setShowCreateClass(false)}
                className="btn btn-secondary min-h-[var(--touch-target-min)]"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      </section>

      {/* Section B: Agent DLP Policies */}
      <section>
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Agent DLP Policies
        </h2>

        <QueryState loading={dlpPoliciesQuery.loading} error={dlpPoliciesQuery.error}>
          {dlpPolicies.length > 0 ? (
            <div className="card">
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Allowed Levels</th>
                      <th>PII Handling</th>
                      <th>Audit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dlpPolicies.map((policy) => (
                      <tr
                        key={policy.agent_name}
                        onClick={() => editingAgent !== policy.agent_name && startEditDlp(policy)}
                        className="cursor-pointer"
                      >
                        <td className="text-text-primary font-medium">{policy.agent_name}</td>
                        <td>
                          {editingAgent === policy.agent_name && dlpEdit ? (
                            <div className="flex flex-wrap gap-[var(--space-2)]">
                              {(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const).map(
                                (lvl) => (
                                  <label
                                    key={lvl}
                                    className="inline-flex items-center gap-[var(--space-1)] cursor-pointer"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={dlpEdit.allowed_levels.includes(lvl)}
                                      onChange={() => {
                                        setDlpEdit((prev) =>
                                          prev
                                            ? {
                                                ...prev,
                                                allowed_levels: prev.allowed_levels.includes(lvl)
                                                  ? prev.allowed_levels.filter((l) => l !== lvl)
                                                  : [...prev.allowed_levels, lvl],
                                              }
                                            : prev,
                                        );
                                      }}
                                      className="accent-accent w-4 h-4"
                                    />
                                    <span className="text-[10px] text-text-secondary">{lvl}</span>
                                  </label>
                                ),
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-[var(--space-1)]">
                              {policy.allowed_levels.map((lvl) => (
                                <span
                                  key={lvl}
                                  className={`inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-semibold uppercase border ${LEVEL_COLORS[lvl] ?? "bg-surface-overlay text-text-muted border-border-default"}`}
                                >
                                  {lvl}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          {editingAgent === policy.agent_name && dlpEdit ? (
                            <div
                              className="flex items-center gap-[var(--space-3)]"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {(["block", "redact", "allow"] as const).map((h) => (
                                <label key={h} className="inline-flex items-center gap-[var(--space-1)] cursor-pointer">
                                  <input
                                    type="radio"
                                    name={`pii-handling-${policy.agent_name}`}
                                    checked={dlpEdit.pii_handling === h}
                                    onChange={() =>
                                      setDlpEdit((prev) => (prev ? { ...prev, pii_handling: h } : prev))
                                    }
                                    className="accent-accent"
                                  />
                                  <span className="text-[10px] text-text-secondary capitalize">{h}</span>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <span
                              className={`inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-semibold uppercase border ${PII_HANDLING_COLORS[policy.pii_handling]}`}
                            >
                              {policy.pii_handling}
                            </span>
                          )}
                        </td>
                        <td>
                          {editingAgent === policy.agent_name && dlpEdit ? (
                            <div onClick={(e) => e.stopPropagation()}>
                              <Toggle
                                checked={dlpEdit.audit_all_access}
                                onChange={(v) =>
                                  setDlpEdit((prev) =>
                                    prev ? { ...prev, audit_all_access: v } : prev,
                                  )
                                }
                              />
                            </div>
                          ) : (
                            <span
                              className={`text-[10px] font-semibold ${
                                policy.audit_all_access ? "text-status-live" : "text-text-muted"
                              }`}
                            >
                              {policy.audit_all_access ? "ON" : "OFF"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {editingAgent && (
                <div className="flex items-center gap-[var(--space-3)] p-[var(--space-3)] border-t border-border-default">
                  <button
                    onClick={saveDlpEdit}
                    className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                  >
                    Apply Changes
                  </button>
                  <button
                    onClick={() => setEditingAgent(null)}
                    className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ) : (
            <EmptyState message="No agent DLP policies configured." />
          )}
        </QueryState>
      </section>

      {/* Section C: PII Exposure Report */}
      <section>
        <h2 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          PII Exposure Report
        </h2>

        <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-3)]">
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              From
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            />
          </div>
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              To
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            />
          </div>
        </div>

        <QueryState loading={exposureQuery.loading} error={exposureQuery.error}>
          {exposure ? (
            <div className="space-y-[var(--space-4)]">
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-[var(--space-3)]">
                <div className="card">
                  <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                    Total Exposures
                  </p>
                  <p className="text-[var(--text-xl)] font-bold font-mono text-status-error">
                    {exposure.total_exposures.toLocaleString()}
                  </p>
                </div>
                {Object.entries(exposure.by_category).map(([cat, count]) => (
                  <div key={cat} className="card">
                    <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                      {cat}
                    </p>
                    <p className="text-[var(--text-lg)] font-bold font-mono text-text-primary">
                      {count.toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>

              {/* By-agent breakdown */}
              {exposure.by_agent.length > 0 && (
                <div className="card">
                  <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
                    By Agent
                  </h3>
                  <div className="overflow-x-auto">
                    <table>
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th className="text-right">Exposures</th>
                          <th>Categories</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exposure.by_agent.map((row) => (
                          <tr key={row.agent_name}>
                            <td className="text-text-primary font-medium">{row.agent_name}</td>
                            <td className="text-right font-mono text-status-error">{row.exposures}</td>
                            <td>
                              <div className="flex flex-wrap gap-[var(--space-1)]">
                                {Object.entries(row.categories).map(([cat, cnt]) => (
                                  <span
                                    key={cat}
                                    className="inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] bg-surface-overlay text-text-muted border border-border-default"
                                  >
                                    {cat}: {cnt}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Trend sparkline */}
              {exposure.trend && exposure.trend.length > 1 && (
                <div className="card">
                  <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
                    Exposures Trend
                  </h3>
                  <TrendSparkline data={exposure.trend} />
                </div>
              )}
            </div>
          ) : (
            <EmptyState message="No PII exposure data available for the selected period." />
          )}
        </QueryState>
      </section>
    </div>
  );
}

/* ================================================================
   Tab 4: Event Log
   ================================================================ */

function EventLogTab() {
  const { showToast } = useToast();

  const agentsQuery = useApiQuery<{ agents: Agent[] } | Agent[]>("/api/v1/agents");
  const agents: Agent[] = useMemo(() => {
    return extractList<Agent>(agentsQuery.data, "agents");
  }, [agentsQuery.data]);

  /* Filters */
  const [filterAgent, setFilterAgent] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", "100");
    if (filterAgent) params.set("agent_name", filterAgent);
    if (filterType) params.set("event_type", filterType);
    if (filterAction) params.set("action", filterAction);
    if (filterDateFrom) params.set("date_from", filterDateFrom);
    if (filterDateTo) params.set("date_to", filterDateTo);
    return params.toString();
  }, [filterAgent, filterType, filterAction, filterDateFrom, filterDateTo]);

  const eventsQuery = useApiQuery<{ events: GuardrailEvent[] } | GuardrailEvent[]>(
    `/api/v1/guardrails/events?${queryParams}`,
  );

  const events: GuardrailEvent[] = useMemo(() => {
    const raw = eventsQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return raw.events ?? [];
  }, [eventsQuery.data]);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleExport = useCallback(() => {
    const header = "timestamp,agent,event_type,action,match_count,text_preview\n";
    const rows = events
      .map(
        (e) =>
          `"${e.timestamp}","${e.agent_name}","${e.event_type}","${e.action}",${e.match_count},"${e.text_preview.replace(/"/g, '""')}"`,
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `guardrail-events-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV exported", "success");
  }, [events, showToast]);

  return (
    <div className="space-y-[var(--space-4)]">
      {/* Filters */}
      <div className="card">
        <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
          <Filter size={14} className="text-text-muted" />
          <span className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
            Filters
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-[var(--space-3)]">
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Agent
            </label>
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <option value="">All</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Event Type
            </label>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <option value="">All</option>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              Action
            </label>
            <select
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value)}
              className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <option value="">All</option>
              <option value="allow">Allow</option>
              <option value="warn">Warn</option>
              <option value="block">Block</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              From
            </label>
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            />
          </div>
          <div>
            <label className="block text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
              To
            </label>
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            />
          </div>
        </div>
      </div>

      {/* Export button */}
      <div className="flex justify-end">
        <button
          onClick={handleExport}
          disabled={events.length === 0}
          className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Event table */}
      <QueryState loading={eventsQuery.loading} error={eventsQuery.error}>
        {events.length > 0 ? (
          <div className="card">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Agent</th>
                    <th>Event Type</th>
                    <th>Action</th>
                    <th>Preview</th>
                    <th className="text-right">Matches</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((evt) => (
                    <>
                      <tr
                        key={evt.id}
                        onClick={() => setExpandedId(expandedId === evt.id ? null : evt.id)}
                        className="cursor-pointer"
                      >
                        <td className="text-text-muted whitespace-nowrap font-mono text-[var(--text-xs)]">
                          {formatTimestamp(evt.timestamp)}
                        </td>
                        <td className="text-text-primary font-medium">{evt.agent_name}</td>
                        <td>
                          <span className="text-[var(--text-xs)] text-text-secondary font-mono">
                            {evt.event_type}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-semibold uppercase border ${ACTION_COLORS[evt.action]}`}
                          >
                            {evt.action}
                          </span>
                        </td>
                        <td
                          className="text-text-muted max-w-[200px] truncate"
                          title={evt.text_preview}
                        >
                          {truncate(evt.text_preview, 50)}
                        </td>
                        <td className="text-right font-mono text-text-muted">
                          {evt.match_count}
                        </td>
                      </tr>

                      {/* Expanded detail */}
                      {expandedId === evt.id && (
                        <tr key={`${evt.id}-detail`}>
                          <td colSpan={6} className="!bg-surface-base !p-0">
                            <div className="p-[var(--space-4)] space-y-[var(--space-3)] border-t border-border-default">
                              {/* Full text with highlights */}
                              <div>
                                <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                                  Full Text
                                </p>
                                <div className="p-[var(--space-3)] rounded-lg bg-surface-raised text-[var(--text-sm)] font-mono leading-relaxed max-h-40 overflow-y-auto">
                                  {evt.matches && evt.matches.length > 0 ? (
                                    <HighlightedEventText
                                      text={evt.full_text ?? evt.text_preview}
                                      matches={evt.matches}
                                    />
                                  ) : (
                                    <span>{evt.full_text ?? evt.text_preview}</span>
                                  )}
                                </div>
                              </div>

                              {/* Matches list */}
                              {evt.matches && evt.matches.length > 0 && (
                                <div>
                                  <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                                    Matches ({evt.matches.length})
                                  </p>
                                  <div className="flex flex-wrap gap-[var(--space-2)]">
                                    {evt.matches.map((m, i) => (
                                      <span
                                        key={i}
                                        className="inline-block px-[var(--space-2)] py-[var(--space-1)] rounded-full text-[10px] font-medium bg-status-error/10 text-status-error border border-status-error/20"
                                      >
                                        {m.category}: {truncate(m.text, 20)}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Triggering policy */}
                              {evt.policy_name && (
                                <div>
                                  <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                                    Triggered Policy
                                  </p>
                                  <span className="text-[var(--text-xs)] text-accent font-medium">
                                    {evt.policy_name}
                                  </span>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<Search size={24} />}
            message="No events match the current filters."
          />
        )}
      </QueryState>
    </div>
  );
}

/* Highlighted text for event detail */
function HighlightedEventText({ text, matches }: { text: string; matches: PiiMatch[] }) {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  sorted.forEach((match, idx) => {
    if (match.start > cursor) {
      parts.push(<span key={`t-${idx}`}>{text.slice(cursor, match.start)}</span>);
    }
    parts.push(
      <span
        key={`m-${idx}`}
        className="border-b-2 border-status-error text-status-error"
        title={match.category}
      >
        {text.slice(match.start, match.end)}
      </span>,
    );
    cursor = match.end;
  });

  if (cursor < text.length) {
    parts.push(<span key="tail">{text.slice(cursor)}</span>);
  }

  return <>{parts}</>;
}

/* ================================================================
   Main Page
   ================================================================ */

export function GuardrailsPage() {
  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Guardrails & DLP"
        subtitle="PII detection, prompt injection defense, output safety scanning, and data loss prevention"
        icon={<ShieldAlert size={20} />}
      />

      <Tabs
        tabs={[
          { id: "overview", label: "Overview", content: <OverviewTab /> },
          { id: "policies", label: "Policies", content: <PoliciesTab /> },
          { id: "dlp", label: "DLP", content: <DlpTab /> },
          { id: "event-log", label: "Event Log", content: <EventLogTab /> },
        ]}
        defaultTab="overview"
      />
    </div>
  );
}

export default GuardrailsPage;
