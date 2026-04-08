import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Search } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { AssistPanel } from "../../components/common/AssistPanel";
import { useApiQuery } from "../../lib/api";

type IntegrityBreachEntry = {
  trace_id: string;
  created_at?: string;
  user_id?: string;
  strict?: boolean;
  missing_turns?: number;
  missing_runtime_events?: number;
  missing_billing_records?: number;
  lifecycle_mismatch?: number;
  warnings?: string[];
};

type IntegrityBreachesResponse = {
  total_breaches?: number;
  strict_breaches?: number;
  non_strict_breaches?: number;
  hottest_traces?: Array<{ trace_id: string; breaches: number }>;
  entries?: IntegrityBreachEntry[];
};

function formatWhen(iso?: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

export function TraceIntegrityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const traceFilter = (searchParams.get("trace_id") ?? "").trim();
  const [draftTrace, setDraftTrace] = useState(traceFilter);

  useEffect(() => {
    setDraftTrace(traceFilter);
  }, [traceFilter]);

  const queryUrl = useMemo(() => {
    const q = new URLSearchParams();
    q.set("limit", "100");
    if (traceFilter) q.set("trace_id", traceFilter);
    return `/api/v1/observability/integrity/breaches?${q.toString()}`;
  }, [traceFilter]);

  const breachesQuery = useApiQuery<IntegrityBreachesResponse>(queryUrl);

  const applyTraceFilter = useCallback(() => {
    const v = draftTrace.trim();
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v) next.set("trace_id", v);
        else next.delete("trace_id");
        return next;
      },
      { replace: true },
    );
  }, [draftTrace, setSearchParams]);

  const clearTraceFilter = useCallback(() => {
    setDraftTrace("");
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("trace_id");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const data = breachesQuery.data;
  const entries = Array.isArray(data?.entries) ? data!.entries! : [];
  const hottest = Array.isArray(data?.hottest_traces) ? data!.hottest_traces! : [];

  return (
    <div>
      <PageHeader
        title="Trace integrity"
        subtitle="Audit log breaches from trace consistency checks (missing turns, events, billing, lifecycle)"
        onRefresh={() => void breachesQuery.refetch()}
      />

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-status-warning/10">
            <AlertTriangle size={14} className="text-status-warning" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {data?.total_breaches ?? "—"}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Total breaches</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-status-error/10">
            <AlertTriangle size={14} className="text-status-error" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {data?.strict_breaches ?? "—"}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Strict mode</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-surface-overlay">
            <AlertTriangle size={14} className="text-text-muted" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {data?.non_strict_breaches ?? "—"}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Non-strict</p>
          </div>
        </div>
      </div>

      <div className="mb-4">
        <AssistPanel compact />
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[10px] uppercase text-text-muted mb-1">Filter by trace id</label>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              type="text"
              className="pl-8 text-xs w-full"
              placeholder="trace id…"
              value={draftTrace}
              onChange={(e) => setDraftTrace(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyTraceFilter();
              }}
            />
          </div>
        </div>
        <button type="button" className="btn btn-primary text-xs" onClick={() => applyTraceFilter()}>
          Apply
        </button>
        {traceFilter ? (
          <button type="button" className="btn btn-secondary text-xs" onClick={() => clearTraceFilter()}>
            Clear
          </button>
        ) : null}
      </div>

      {hottest.length > 0 && !traceFilter ? (
        <div className="card p-3 mb-4">
          <p className="text-[10px] uppercase text-text-muted mb-2">Traces with most breaches (in this window)</p>
          <ul className="flex flex-wrap gap-2">
            {hottest.map((h) => (
              <li key={h.trace_id}>
                <button
                  type="button"
                  className="text-xs font-mono px-2 py-1 rounded-md bg-surface-overlay hover:bg-accent-muted transition-colors"
                  onClick={() => {
                    setDraftTrace(h.trace_id);
                    setSearchParams({ trace_id: h.trace_id }, { replace: true });
                  }}
                >
                  {h.trace_id.slice(0, 14)}… ×{h.breaches}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <QueryState
        loading={breachesQuery.loading}
        error={breachesQuery.error}
        onRetry={() => void breachesQuery.refetch()}
      >
        {entries.length === 0 ? (
          <EmptyState
            icon={<AlertTriangle size={40} />}
            title="No integrity breaches"
            description={
              traceFilter
                ? "No audit entries for this trace id in the current limit window."
                : "Breaches appear when integrity checks run with alert_on_breach or equivalent auditing."
            }
          />
        ) : (
          <div className="card p-0 overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Trace</th>
                  <th>When</th>
                  <th>Mode</th>
                  <th>Missing</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((row, i) => (
                  <tr key={`${row.trace_id}-${row.created_at ?? i}`} className="stagger-item" style={{ "--stagger-index": i } as CSSProperties}>
                    <td className="font-mono text-xs">{row.trace_id || "—"}</td>
                    <td className="text-xs text-text-secondary whitespace-nowrap">
                      {formatWhen(row.created_at)}
                    </td>
                    <td>
                      {row.strict ? (
                        <span className="text-[10px] uppercase font-medium px-2 py-0.5 rounded-full border border-status-error/25 bg-status-error/10 text-status-error">
                          Strict
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase font-medium px-2 py-0.5 rounded-full border border-border-default bg-surface-overlay text-text-muted">
                          Standard
                        </span>
                      )}
                    </td>
                    <td className="text-xs text-text-secondary">
                      <span className="font-mono">
                        T{row.missing_turns ?? 0} E{row.missing_runtime_events ?? 0} B
                        {row.missing_billing_records ?? 0} L{row.lifecycle_mismatch ?? 0}
                      </span>
                    </td>
                    <td className="text-xs text-text-secondary max-w-md">
                      {(row.warnings ?? []).length ? (
                        <ul className="list-disc pl-4 space-y-0.5">
                          {(row.warnings ?? []).map((w, j) => (
                            <li key={j}>{w}</li>
                          ))}
                        </ul>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>

      <p className="mt-4 text-[10px] text-text-muted">
        Data from{" "}
        <code className="text-text-secondary">GET /api/v1/observability/integrity/breaches</code>
        . Open a run from{" "}
        <Link to="/sessions" className="text-accent hover:underline">
          Sessions
        </Link>
        .
      </p>
    </div>
  );
}
