import { useMemo, useState } from "react";
import { TrendingUp, BarChart3, GitCompare, RefreshCw } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { Tabs } from "../../components/common/Tabs";
import { useToast } from "../../components/common/ToastProvider";
import { useApiQuery, apiRequest } from "../../lib/api";

type EvolutionEntry = {
  version: string;
  agent_name: string;
  score?: number;
  latency_ms?: number;
  cost_usd?: number;
  created_at?: string;
  improvement_pct?: number;
};

type Proposal = {
  id?: string;
  title?: string;
  priority?: string;
  rationale?: string;
  status?: string;
};

export const EvolutionPage = () => {
  const { showToast } = useToast();
  const evoQuery = useApiQuery<{ entries: EvolutionEntry[] }>("/api/v1/evolution?limit=50");
  const agentsQuery = useApiQuery<Array<{ name: string }>>("/api/v1/agents");
  const entries = useMemo(() => evoQuery.data?.entries ?? [], [evoQuery.data]);

  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [operatorAgent, setOperatorAgent] = useState("");
  const proposalsQuery = useApiQuery<{ proposals?: Proposal[] }>(
    `/api/v1/evolve/${operatorAgent}/proposals`,
    Boolean(operatorAgent),
  );
  const ledgerQuery = useApiQuery<{ current_version?: string; entries?: Array<Record<string, unknown>> }>(
    `/api/v1/evolve/${operatorAgent}/ledger`,
    Boolean(operatorAgent),
  );

  const agents = [...new Set(entries.map((e) => e.agent_name))];
  const allAgentNames = Array.from(
    new Set([
      ...agents,
      ...(Array.isArray(agentsQuery.data) ? agentsQuery.data.map((a) => a.name) : []),
    ]),
  ).filter(Boolean);
  const entriesA = entries.filter((e) => e.agent_name === compareA);
  const entriesB = entries.filter((e) => e.agent_name === compareB);

  /* ── Sparkline bar ────────────────────────────────────────── */
  const SparkBar = ({ value, max, color }: { value: number; max: number; color: string }) => (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-surface-overlay rounded-full overflow-hidden max-w-[100px]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} />
      </div>
      <span className="text-xs font-mono text-text-muted">{value.toFixed(1)}</span>
    </div>
  );

  const maxScore = Math.max(...entries.map((e) => e.score ?? 0), 1);
  const maxLatency = Math.max(...entries.map((e) => e.latency_ms ?? 0), 1);

  /* ── Timeline tab ─────────────────────────────────────────── */
  const timelineTab = (
    <div>
      <QueryState loading={evoQuery.loading} error={evoQuery.error} isEmpty={entries.length === 0} emptyMessage="" onRetry={() => void evoQuery.refetch()}>
        {entries.length === 0 ? (
          <EmptyState icon={<TrendingUp size={40} />} title="No evolution data" description="Deploy agent versions to track evolution over time" />
        ) : (
          <div className="card p-0"><div className="overflow-x-auto">
            <table><thead><tr><th>Agent</th><th>Version</th><th>Score</th><th>Latency</th><th>Cost</th><th>Improvement</th><th>Date</th></tr></thead>
              <tbody>{entries.map((e, i) => (
                <tr key={`${e.agent_name}-${e.version}-${i}`}>
                  <td><span className="text-text-primary text-sm">{e.agent_name}</span></td>
                  <td><span className="font-mono text-xs text-text-muted">v{e.version}</span></td>
                  <td><SparkBar value={e.score ?? 0} max={maxScore} color="bg-chart-green" /></td>
                  <td><SparkBar value={e.latency_ms ?? 0} max={maxLatency} color="bg-chart-blue" /></td>
                  <td><span className="font-mono text-xs text-text-muted">${(e.cost_usd ?? 0).toFixed(3)}</span></td>
                  <td>
                    {e.improvement_pct !== undefined ? (
                      <span className={`text-xs font-mono ${e.improvement_pct >= 0 ? "text-chart-green" : "text-status-error"}`}>
                        {e.improvement_pct >= 0 ? "+" : ""}{e.improvement_pct.toFixed(1)}%
                      </span>
                    ) : <span className="text-xs text-text-muted">--</span>}
                  </td>
                  <td><span className="text-[10px] text-text-muted">{e.created_at ? new Date(e.created_at).toLocaleDateString() : "--"}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div></div>
        )}
      </QueryState>
    </div>
  );

  /* ── Compare tab ──────────────────────────────────────────── */
  const compareTab = (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <select value={compareA} onChange={(e) => setCompareA(e.target.value)} className="text-sm flex-1">
          <option value="">Select Agent A</option>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <GitCompare size={16} className="text-text-muted" />
        <select value={compareB} onChange={(e) => setCompareB(e.target.value)} className="text-sm flex-1">
          <option value="">Select Agent B</option>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      {compareA && compareB ? (
        <div className="grid grid-cols-2 gap-4">
          {[{ name: compareA, data: entriesA }, { name: compareB, data: entriesB }].map(({ name, data }) => {
            const avgScore = data.length > 0 ? data.reduce((s, e) => s + (e.score ?? 0), 0) / data.length : 0;
            const avgLatency = data.length > 0 ? data.reduce((s, e) => s + (e.latency_ms ?? 0), 0) / data.length : 0;
            const avgCost = data.length > 0 ? data.reduce((s, e) => s + (e.cost_usd ?? 0), 0) / data.length : 0;
            return (
              <div key={name} className="card">
                <h3 className="text-sm font-semibold text-text-primary mb-3">{name}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Versions</span>
                    <span className="font-mono text-sm text-text-primary">{data.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Avg Score</span>
                    <span className="font-mono text-sm text-chart-green">{avgScore.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Avg Latency</span>
                    <span className="font-mono text-sm text-chart-blue">{avgLatency.toFixed(0)}ms</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Avg Cost</span>
                    <span className="font-mono text-sm text-text-secondary">${avgCost.toFixed(3)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Latest</span>
                    <span className="font-mono text-xs text-text-muted">v{data[0]?.version ?? "--"}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={<GitCompare size={40} />} title="Select two agents" description="Choose agents above to compare their evolution" />
      )}
    </div>
  );

  const operatorTab = (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center gap-3">
          <select
            value={operatorAgent}
            onChange={(e) => setOperatorAgent(e.target.value)}
            className="text-sm flex-1"
          >
            <option value="">Select agent for evolution actions</option>
            {allAgentNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button
            className="btn btn-secondary text-xs"
            disabled={!operatorAgent}
            onClick={async () => {
              if (!operatorAgent) return;
              try {
                await apiRequest(`/api/v1/evolve/${operatorAgent}/run`, "POST", {
                  max_cycles: 1,
                  auto_approve: false,
                });
                showToast(`Evolution cycle started for ${operatorAgent}`, "success");
                void proposalsQuery.refetch();
                void ledgerQuery.refetch();
              } catch {
                showToast("Failed to start evolution cycle", "error");
              }
            }}
          >
            Run Evolution
          </button>
        </div>
      </div>

      <div className="card">
        <p className="text-sm font-semibold text-text-primary mb-3">Review Queue</p>
        {!operatorAgent ? (
          <p className="text-xs text-text-muted">Select an agent to load proposals.</p>
        ) : proposalsQuery.loading ? (
          <p className="text-xs text-text-muted">Loading proposals...</p>
        ) : proposalsQuery.error ? (
          <p className="text-xs text-status-error">{proposalsQuery.error}</p>
        ) : (proposalsQuery.data?.proposals ?? []).length === 0 ? (
          <p className="text-xs text-text-muted">No pending proposals.</p>
        ) : (
          <div className="space-y-2">
            {(proposalsQuery.data?.proposals ?? []).map((p, idx) => (
              <div key={`${p.id ?? "proposal"}-${idx}`} className="border border-border-default rounded-lg p-3 bg-surface-base">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-text-primary">{p.title ?? p.id ?? "Untitled proposal"}</p>
                    <p className="text-[11px] text-text-muted mt-1">{p.rationale ?? "No rationale provided."}</p>
                    <div className="mt-2">
                      <StatusBadge status={p.priority ?? "normal"} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn btn-secondary text-[11px] px-2 py-1"
                      onClick={async () => {
                        if (!operatorAgent || !p.id) return;
                        try {
                          await apiRequest(`/api/v1/evolve/${operatorAgent}/proposals/${p.id}/approve`, "POST");
                          showToast("Proposal approved", "success");
                          void proposalsQuery.refetch();
                          void ledgerQuery.refetch();
                        } catch {
                          showToast("Approve failed", "error");
                        }
                      }}
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn-secondary text-[11px] px-2 py-1"
                      onClick={async () => {
                        if (!operatorAgent || !p.id) return;
                        try {
                          await apiRequest(`/api/v1/evolve/${operatorAgent}/proposals/${p.id}/reject`, "POST");
                          showToast("Proposal rejected", "success");
                          void proposalsQuery.refetch();
                        } catch {
                          showToast("Reject failed", "error");
                        }
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <p className="text-sm font-semibold text-text-primary mb-2">Ledger</p>
        {!operatorAgent ? (
          <p className="text-xs text-text-muted">Select an agent to view version history.</p>
        ) : ledgerQuery.loading ? (
          <p className="text-xs text-text-muted">Loading ledger...</p>
        ) : ledgerQuery.error ? (
          <p className="text-xs text-status-error">{ledgerQuery.error}</p>
        ) : (
          <>
            <p className="text-xs text-text-secondary mb-2">Current Version: <span className="font-mono">{ledgerQuery.data?.current_version ?? "--"}</span></p>
            <p className="text-xs text-text-muted">
              Entries: {Array.isArray(ledgerQuery.data?.entries) ? ledgerQuery.data?.entries?.length : 0}
            </p>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader title="Evolution" subtitle="Track agent performance across versions and compare improvements" onRefresh={() => void evoQuery.refetch()} />
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10"><TrendingUp size={14} className="text-chart-green" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{entries.length}</p><p className="text-[10px] text-text-muted uppercase">Versions Tracked</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-blue/10"><BarChart3 size={14} className="text-chart-blue" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{agents.length}</p><p className="text-[10px] text-text-muted uppercase">Agents</p></div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10"><RefreshCw size={14} className="text-accent" /></div>
          <div><p className="text-lg font-bold text-text-primary font-mono">{entries.filter((e) => (e.improvement_pct ?? 0) > 0).length}</p><p className="text-[10px] text-text-muted uppercase">Improvements</p></div>
        </div>
      </div>
      <Tabs tabs={[
        { id: "timeline", label: "Timeline", count: entries.length, content: timelineTab },
        { id: "compare", label: "Compare", content: compareTab },
        { id: "operator", label: "Operator", content: operatorTab },
      ]} />
    </div>
  );
};
