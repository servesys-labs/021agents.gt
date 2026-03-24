import { useMemo, useState } from "react";
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneOff,
  Clock,
  DollarSign,
  RefreshCw,
  FileText,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { Tabs } from "../../components/common/Tabs";
import { EmptyState } from "../../components/common/EmptyState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery } from "../../lib/api";

/* ── Types ─────────────────────────────────────────────────────── */

type VapiCall = {
  call_id: string;
  agent_name: string;
  phone_number: string;
  direction: string;
  status: string;
  duration_seconds: number;
  transcript: string;
  cost_usd: number;
  vapi_assistant_id: string;
  created_at: number;
};

type CallSummary = {
  total_calls: number;
  by_status: Record<string, number>;
  total_cost_usd: number;
  total_duration_seconds: number;
};

type VapiEvent = {
  id: number;
  call_id: string;
  event_type: string;
  created_at: number;
};

/* ── Main Page ─────────────────────────────────────────────────── */

export const VoicePage = () => {
  const [activeTab, setActiveTab] = useState(0);
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const callsQuery = useApiQuery<{ calls: VapiCall[] }>("/api/v1/voice/vapi/calls?limit=100");
  const summaryQuery = useApiQuery<CallSummary>("/api/v1/voice/vapi/calls/summary");
  const eventsQuery = useApiQuery<{ events: VapiEvent[] }>(
    `/api/v1/voice/vapi/calls/${selectedCall ?? ""}/events`,
    Boolean(selectedCall),
  );
  const callDetailQuery = useApiQuery<VapiCall>(
    `/api/v1/voice/vapi/calls/${selectedCall ?? ""}`,
    Boolean(selectedCall),
  );

  const calls = useMemo(() => callsQuery.data?.calls ?? [], [callsQuery.data]);
  const summary = summaryQuery.data;
  const events = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);

  const handleRefresh = () => {
    callsQuery.refetch();
    summaryQuery.refetch();
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Voice"
        subtitle="Vapi voice platform — calls, transcripts, and events"
        actions={
          <button onClick={handleRefresh} className="btn btn-secondary">
            <RefreshCw size={14} />
          </button>
        }
      />

      {/* Summary KPIs */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-chart-blue/10"><Phone size={16} className="text-chart-blue" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{summary.total_calls}</p>
              <p className="text-[10px] text-text-muted uppercase">Total Calls</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-status-live/10"><PhoneIncoming size={16} className="text-status-live" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{summary.by_status?.connected ?? 0}</p>
              <p className="text-[10px] text-text-muted uppercase">Connected</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent/10"><Clock size={16} className="text-accent" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">{Math.round(summary.total_duration_seconds / 60)}m</p>
              <p className="text-[10px] text-text-muted uppercase">Total Duration</p>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="p-2 rounded-lg bg-chart-green/10"><DollarSign size={16} className="text-chart-green" /></div>
            <div>
              <p className="text-lg font-semibold text-text-primary">${summary.total_cost_usd.toFixed(2)}</p>
              <p className="text-[10px] text-text-muted uppercase">Total Cost</p>
            </div>
          </div>
        </div>
      )}

      <Tabs tabs={["Calls", "Events"]} activeIndex={activeTab} onChange={setActiveTab} />

      {/* Tab: Calls */}
      {activeTab === 0 && (
        <QueryState loading={callsQuery.loading} error={callsQuery.error}>
          {calls.length > 0 ? (
            <div className="card mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted">
                      <th className="text-left py-2 pr-4">Call ID</th>
                      <th className="text-center py-2 px-3">Direction</th>
                      <th className="text-center py-2 px-3">Status</th>
                      <th className="text-left py-2 px-3">Agent</th>
                      <th className="text-left py-2 px-3">Phone</th>
                      <th className="text-right py-2 px-3">Duration</th>
                      <th className="text-right py-2 px-3">Cost</th>
                      <th className="text-center py-2 px-3">Transcript</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((c) => (
                      <tr
                        key={c.call_id}
                        className="border-b border-border-default/50 hover:bg-surface-overlay/30 cursor-pointer"
                        onClick={() => { setSelectedCall(c.call_id); setDrawerOpen(true); }}
                      >
                        <td className="py-2 pr-4 font-mono text-text-secondary text-[10px]">{c.call_id}</td>
                        <td className="py-2 px-3 text-center">
                          {c.direction === "inbound"
                            ? <PhoneIncoming size={12} className="text-chart-blue mx-auto" />
                            : <PhoneOutgoing size={12} className="text-chart-orange mx-auto" />}
                        </td>
                        <td className="py-2 px-3 text-center"><StatusBadge status={c.status} /></td>
                        <td className="py-2 px-3 text-text-muted">{c.agent_name || "—"}</td>
                        <td className="py-2 px-3 text-text-muted">{c.phone_number || "—"}</td>
                        <td className="py-2 px-3 text-right text-text-muted">{c.duration_seconds.toFixed(1)}s</td>
                        <td className="py-2 px-3 text-right text-text-muted">${c.cost_usd.toFixed(4)}</td>
                        <td className="py-2 px-3 text-center">
                          {c.transcript ? <FileText size={12} className="text-chart-purple mx-auto" /> : <span className="text-text-muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState message="No Vapi calls yet. Configure your Vapi webhook to start receiving calls." />
          )}
        </QueryState>
      )}

      {/* Tab: Events */}
      {activeTab === 1 && (
        <div className="mt-4">
          {selectedCall ? (
            <QueryState loading={eventsQuery.loading} error={eventsQuery.error}>
              {events.length > 0 ? (
                <div className="card">
                  <h3 className="text-sm font-medium text-text-primary mb-3">Events — {selectedCall.slice(0, 12)}</h3>
                  <div className="space-y-2">
                    {events.map((e) => (
                      <div key={e.id} className="flex items-center gap-3 py-2 border-b border-border-default/30">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-surface-overlay text-text-secondary font-mono">
                          {e.event_type}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState message="No events for this call." />
              )}
            </QueryState>
          ) : (
            <EmptyState message="Select a call from the Calls tab to view events." />
          )}
        </div>
      )}

      {/* Drawer */}
      <SlidePanel
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedCall(null); }}
        title={`Call — ${selectedCall?.slice(0, 12) ?? ""}`}
      >
        {selectedCall && (
          <QueryState loading={callDetailQuery.loading} error={callDetailQuery.error}>
            {callDetailQuery.data && (() => {
              const call = callDetailQuery.data;
              return (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Call ID</span>
                      <span className="font-mono text-text-secondary">{call.call_id}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Direction</span>
                      <span className="text-text-secondary">{call.direction}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Status</span>
                      <StatusBadge status={call.status} />
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Agent</span>
                      <span className="text-text-secondary">{call.agent_name || "—"}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Phone</span>
                      <span className="text-text-secondary">{call.phone_number || "—"}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Duration</span>
                      <span className="text-text-secondary">{call.duration_seconds.toFixed(1)}s</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Cost</span>
                      <span className="text-text-secondary">${call.cost_usd.toFixed(4)}</span>
                    </div>
                  </div>
                  {call.transcript && (
                    <div>
                      <p className="text-xs text-text-muted mb-1">Transcript</p>
                      <pre className="text-[10px] text-text-secondary bg-surface-base rounded-lg p-3 border border-border-default whitespace-pre-wrap max-h-60 overflow-y-auto">
                        {call.transcript}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })()}
          </QueryState>
        )}
      </SlidePanel>
    </div>
  );
};
