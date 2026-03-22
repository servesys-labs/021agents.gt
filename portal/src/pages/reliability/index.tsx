import { useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { apiRequest, useApiQuery } from "../../lib/api";

type Slo = { slo_id?: string; metric?: string; threshold?: number; operator?: string; current_value?: number; breached?: boolean };

export const ReliabilityPage = () => {
  const [metric, setMetric] = useState("success_rate");
  const [threshold, setThreshold] = useState("0.95");
  const [operator, setOperator] = useState("gte");
  const [windowHours, setWindowHours] = useState("24");
  const [agentName, setAgentName] = useState("");
  const [compareAgent, setCompareAgent] = useState("");
  const [versionA, setVersionA] = useState("current");
  const [versionB, setVersionB] = useState("current");
  const [compareResult, setCompareResult] = useState("");
  const [message, setMessage] = useState("");

  const slosQuery = useApiQuery<{ slos: Slo[] }>(
    `/api/v1/slos?agent_name=${encodeURIComponent(agentName)}`,
  );
  const statusQuery = useApiQuery<{ slos: Slo[]; breached_count: number }>("/api/v1/slos/status");

  const refresh = async () => {
    await slosQuery.refetch();
    await statusQuery.refetch();
  };

  const createSlo = async () => {
    try {
      const path = `/api/v1/slos?metric=${encodeURIComponent(metric)}&threshold=${encodeURIComponent(threshold)}&operator=${encodeURIComponent(operator)}&window_hours=${encodeURIComponent(windowHours)}&agent_name=${encodeURIComponent(agentName)}`;
      await apiRequest(path, "POST");
      setMessage("SLO created.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to create SLO");
    }
  };

  const deleteSlo = async (sloId: string) => {
    if (!window.confirm(`Delete SLO ${sloId}?`)) {
      return;
    }
    try {
      await apiRequest(`/api/v1/slos/${encodeURIComponent(sloId)}`, "DELETE");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to delete SLO");
    }
  };

  const runCompare = async () => {
    try {
      const payload = await apiRequest<Record<string, unknown>>("/api/v1/compare", "POST", {
        agent_name: compareAgent,
        version_a: versionA,
        version_b: versionB,
      });
      setCompareResult(JSON.stringify(payload, null, 2));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Compare run failed");
    }
  };

  return (
    <div>
      <PageHeader title="Reliability (SLO + Compare)" subtitle="Define reliability targets and run A/B comparisons" />
      <div className="card mb-6">
        <div className="grid gap-2 md:grid-cols-6">
          <input className="input-field" value={metric} onChange={(event) => setMetric(event.target.value)} placeholder="success_rate" />
          <input className="input-field" value={threshold} onChange={(event) => setThreshold(event.target.value)} placeholder="0.95" />
          <input className="input-field" value={operator} onChange={(event) => setOperator(event.target.value)} placeholder="gte" />
          <input className="input-field" value={windowHours} onChange={(event) => setWindowHours(event.target.value)} placeholder="24" />
          <input className="input-field" value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="optional agent name" />
          <button className="btn-primary" onClick={() => void createSlo()}>Create SLO</button>
        </div>
        {message ? <span className="mt-2">{message}</span> : null}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">SLO Definitions</p>
          <QueryState loading={slosQuery.loading} error={slosQuery.error} isEmpty={(slosQuery.data?.slos ?? []).length === 0}>
            <table className="os-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(statusQuery.data?.slos ?? []).map((slo) => (
                  <tr key={slo.slo_id}>
                    <td><span className="text-gray-400">{slo.metric}</span></td>
                    <td><span className="text-gray-400">{slo.operator} {slo.threshold}</span></td>
                    <td><span className="text-gray-400">{slo.breached ? "Breached" : "Healthy"}</span></td>
                    <td>
                      {slo.slo_id ? (
                        <button className="btn-danger text-xs" onClick={() => void deleteSlo(slo.slo_id ?? "")}>Delete</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">A/B Compare</p>
          <div className="grid gap-2 md:grid-cols-4">
            <input className="input-field" value={compareAgent} onChange={(event) => setCompareAgent(event.target.value)} placeholder="agent name" />
            <input className="input-field" value={versionA} onChange={(event) => setVersionA(event.target.value)} placeholder="version A" />
            <input className="input-field" value={versionB} onChange={(event) => setVersionB(event.target.value)} placeholder="version B" />
            <button className="btn-primary" onClick={() => void runCompare()}>Run Compare</button>
          </div>
          {compareResult ? (
            <pre className="mt-3 max-h-72 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">{compareResult}</pre>
          ) : null}
        </div>
      </div>
    </div>
  );
};
