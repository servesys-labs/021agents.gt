import type { ReactNode } from "react";

/* ═══════════════════════════════════════════════════════════════════
   SHARED CANVAS PRIMITIVES
   Unified form components used by NodeDetailPanel and OverlayPanels.
   "compact" mode = OverlayPanels style (smaller text, tighter spacing)
   "comfortable" (default) = NodeDetailPanel style
   ═══════════════════════════════════════════════════════════════════ */

/* ── SectionTitle ──────────────────────────────────────────────── */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold text-text-primary mb-3 uppercase tracking-wider">{children}</h3>;
}

/* ── InlineInput ───────────────────────────────────────────────── */
export function InlineInput({ label, value, onChange, placeholder, type = "text", compact }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; compact?: boolean;
}) {
  return (
    <div className={compact ? "mb-3" : "mb-4"}>
      <label className={`block font-medium text-text-muted uppercase tracking-wider ${compact ? "text-[10px] mb-1" : "text-xs mb-1.5"}`}>{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full px-3 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors ${
          compact ? "py-2 text-xs bg-white-alpha-5" : "py-2.5 text-sm bg-white-alpha-5"
        }`} />
    </div>
  );
}

/* ── InlineTextarea ────────────────────────────────────────────── */
export function InlineTextarea({ label, value, onChange, placeholder, rows, compact }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; compact?: boolean;
}) {
  return (
    <div className={compact ? "mb-3" : "mb-4"}>
      <label className={`block font-medium text-text-muted uppercase tracking-wider ${compact ? "text-[10px] mb-1" : "text-xs mb-1.5"}`}>{label}</label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows ?? (compact ? 3 : 4)}
        className={`w-full px-3 border border-border-default rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50 transition-colors font-mono resize-none ${
          compact ? "py-2 text-xs bg-white-alpha-5" : "py-2.5 text-sm bg-white-alpha-5"
        }`} />
    </div>
  );
}

/* ── InlineSelect ──────────────────────────────────────────────── */
export function InlineSelect({ label, value, onChange, options, compact }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; compact?: boolean;
}) {
  return (
    <div className={compact ? "mb-3" : "mb-4"}>
      <label className={`block font-medium text-text-muted uppercase tracking-wider ${compact ? "text-[10px] mb-1" : "text-xs mb-1.5"}`}>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`w-full px-3 border border-border-default rounded-lg text-text-primary focus:outline-none focus:border-accent/50 transition-colors ${
          compact ? "py-2 text-xs bg-white-alpha-5" : "py-2.5 text-sm bg-white-alpha-5"
        }`}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/* ── ToggleRow ─────────────────────────────────────────────────── */
export function ToggleRow({ label, description, checked, onChange, compact }: {
  label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; compact?: boolean;
}) {
  return (
    <div className="flex items-start justify-between py-3 border-b border-border-default last:border-0">
      <div>
        <p className={compact ? "text-xs text-text-primary" : "text-sm text-text-primary"}>{label}</p>
        {description && <p className={compact ? "text-[10px] text-text-muted mt-0.5" : "text-xs text-text-muted mt-0.5"}>{description}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative rounded-full transition-colors flex-shrink-0 ${checked ? "bg-accent" : "bg-white-alpha-8"}`}
        style={compact ? { minWidth: 32, height: 18 } : { minWidth: 36, height: 20 }}
      >
        <span
          className={`absolute top-0.5 left-0.5 rounded-full bg-white transition-transform ${checked ? (compact ? "translate-x-3.5" : "translate-x-4") : ""}`}
          style={compact ? { width: 14, height: 14 } : { width: 16, height: 16 }}
        />
      </button>
    </div>
  );
}

/* ── StatusPill ─────────────────────────────────────────────────── */
export function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-status-live/10 text-status-live",
    running: "bg-status-warning/10 text-status-warning",
    completed: "bg-status-live/10 text-status-live",
    failed: "bg-status-error/10 text-status-error",
    cancelled: "bg-surface-overlay text-text-muted",
    enabled: "bg-status-live/10 text-status-live",
    disabled: "bg-surface-overlay text-text-muted",
    pending: "bg-status-warning/10 text-status-warning",
    healthy: "bg-status-live/10 text-status-live",
    degraded: "bg-status-warning/10 text-status-warning",
    provisioning: "bg-status-warning/10 text-status-warning",
    terminated: "bg-status-error/10 text-status-error",
    live: "bg-status-live/10 text-status-live",
    passed: "bg-status-live/10 text-status-live",
    in_progress: "bg-status-warning/10 text-status-warning",
    error: "bg-status-error/10 text-status-error",
    superseded: "bg-surface-overlay text-text-muted",
  };
  const dotColors: Record<string, string> = {
    active: "bg-status-live", running: "bg-status-warning", completed: "bg-status-live",
    failed: "bg-status-error", cancelled: "bg-text-muted", enabled: "bg-status-live",
    disabled: "bg-text-muted", pending: "bg-status-warning", healthy: "bg-status-live",
    degraded: "bg-status-warning", provisioning: "bg-status-warning", terminated: "bg-status-error",
    live: "bg-status-live", passed: "bg-status-live", in_progress: "bg-status-warning",
    error: "bg-status-error", superseded: "bg-text-muted",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${colors[status] || "bg-surface-overlay text-text-muted"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColors[status] || "bg-text-muted"}`} />
      {status}
    </span>
  );
}

/* ── ReadOnlyNotice ────────────────────────────────────────────── */
export function ReadOnlyNotice({ editable }: { editable: boolean }) {
  if (editable) return null;
  return (
    <div className="mb-3 text-[10px] text-status-warning bg-status-warning/10 border border-status-warning/20 rounded px-2 py-1">
      View mode: editing actions are disabled for this panel.
    </div>
  );
}

/* ── InfoRow ───────────────────────────────────────────────────── */
export function InfoRow({ label, value, mono }: { label: string; value: string | ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between py-2.5 border-b border-border-default last:border-0">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-xs text-text-primary text-right max-w-[60%] ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

/* ── EmptyTab ──────────────────────────────────────────────────── */
export function EmptyTab({ message }: { message: string }) {
  return <div className="flex items-center justify-center h-32 text-sm text-text-muted">{message}</div>;
}
