import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import type { AgentInfo } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";

type Channel = { channel: string; version: string; promoted_at?: number };
type Canary = { primary_version?: string; canary_version?: string; canary_weight?: number };

export const ReleasesPage = () => {
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const [agentName, setAgentName] = useState("");
  const selectedAgent = agentName || agents[0]?.name || "";
  const channelsQuery = useApiQuery<{ channels: Channel[] }>(
    `/api/v1/releases/${encodeURIComponent(selectedAgent)}/channels`,
    Boolean(selectedAgent),
  );
  const canaryQuery = useApiQuery<{ canary: Canary | null }>(
    `/api/v1/releases/${encodeURIComponent(selectedAgent)}/canary`,
    Boolean(selectedAgent),
  );

  const [fromChannel, setFromChannel] = useState("draft");
  const [toChannel, setToChannel] = useState("staging");
  const [primaryVersion, setPrimaryVersion] = useState("0.1.0");
  const [canaryVersion, setCanaryVersion] = useState("0.1.1");
  const [canaryWeight, setCanaryWeight] = useState("0.1");
  const [message, setMessage] = useState("");

  const refresh = async () => {
    await channelsQuery.refetch();
    await canaryQuery.refetch();
  };

  const promote = async () => {
    try {
      const path = `/api/v1/releases/${encodeURIComponent(selectedAgent)}/promote?from_channel=${encodeURIComponent(fromChannel)}&to_channel=${encodeURIComponent(toChannel)}`;
      await apiRequest(path, "POST");
      setMessage(`Promoted from ${fromChannel} to ${toChannel}.`);
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Promotion failed");
    }
  };

  const setCanary = async () => {
    try {
      const path = `/api/v1/releases/${encodeURIComponent(selectedAgent)}/canary?primary_version=${encodeURIComponent(primaryVersion)}&canary_version=${encodeURIComponent(canaryVersion)}&canary_weight=${encodeURIComponent(canaryWeight)}`;
      await apiRequest(path, "POST");
      setMessage("Canary split updated.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to update canary");
    }
  };

  const removeCanary = async () => {
    if (!window.confirm("Disable canary split?")) {
      return;
    }
    try {
      await apiRequest(`/api/v1/releases/${encodeURIComponent(selectedAgent)}/canary`, "DELETE");
      setMessage("Canary removed.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to remove canary");
    }
  };

  return (
    <div>
      <PageHeader title="Releases & Canary" subtitle="Promote channels and manage canary traffic splits" />
      <div className="card mb-6">
        <span className="text-xs text-gray-500 mb-2">Agent</span>
        <input className="input-field" value={selectedAgent} onChange={(event) => setAgentName(event.target.value)} placeholder={agents[0]?.name ?? "agent-name"} />
        {message ? <span className="mt-2 text-emerald-600">{message}</span> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Promote Release Channel</p>
          <div className="grid gap-2 md:grid-cols-3">
            <input className="input-field" value={fromChannel} onChange={(event) => setFromChannel(event.target.value)} placeholder="from channel" />
            <input className="input-field" value={toChannel} onChange={(event) => setToChannel(event.target.value)} placeholder="to channel" />
            <button className="btn-primary" onClick={() => void promote()}>Promote</button>
          </div>
          <QueryState
            loading={channelsQuery.loading}
            error={channelsQuery.error}
            isEmpty={(channelsQuery.data?.channels ?? []).length === 0}
            emptyMessage="No channels yet."
          >
            <table className="os-table mt-4">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {(channelsQuery.data?.channels ?? []).map((channel, index) => (
                  <tr key={`${channel.channel}-${index}`}>
                    <td><span className="text-gray-400">{channel.channel}</span></td>
                    <td><span className="text-gray-400">{channel.version}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">Canary Split</p>
          <div className="grid gap-2 md:grid-cols-3">
            <input className="input-field" value={primaryVersion} onChange={(event) => setPrimaryVersion(event.target.value)} placeholder="primary version" />
            <input className="input-field" value={canaryVersion} onChange={(event) => setCanaryVersion(event.target.value)} placeholder="canary version" />
            <input className="input-field" value={canaryWeight} onChange={(event) => setCanaryWeight(event.target.value)} placeholder="0.1" />
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn-primary" onClick={() => void setCanary()}>Set Canary</button>
            <button className="btn-danger" onClick={() => void removeCanary()}>Remove</button>
          </div>
          <QueryState
            loading={canaryQuery.loading}
            error={canaryQuery.error}
            isEmpty={!canaryQuery.data?.canary}
            emptyMessage="No active canary."
          >
            <pre className="mt-3 max-h-64 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">
              {JSON.stringify(canaryQuery.data?.canary, null, 2)}
            </pre>
          </QueryState>
        </div>
      </div>
    </div>
  );
};
