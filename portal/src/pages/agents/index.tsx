import { useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { safeArray, type AgentInfo } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

export const AgentsPage = () => {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  const agentsQuery = useApiQuery<AgentInfo[]>(`/api/v1/agents?limit=${limit}&offset=${offset}`);
  const detailQuery = useApiQuery<Record<string, unknown>>(
    `/api/v1/agents/${selectedAgent ?? ""}/config`,
    Boolean(selectedAgent),
  );
  const agents = safeArray<AgentInfo>(agentsQuery.data);

  return (
    <div>
      <PageHeader title="Agents" subtitle={`${agents.length} configured agents`} />
      <div className="mb-4 flex items-center gap-2">
        <button className="btn-secondary text-xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
        <button className="btn-secondary text-xs" onClick={() => setOffset(offset + limit)}>Next</button>
        <select className="input-field w-auto text-xs" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }}>
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>

      <QueryState loading={agentsQuery.loading} error={agentsQuery.error} isEmpty={agents.length === 0} emptyMessage="No agents found." onRetry={() => void agentsQuery.refetch()}>
        <div className="card">
          <div className="overflow-x-auto">
            <table className="os-table">
              <thead><tr><th>Name</th><th>Model</th><th>Tools</th><th>Tags</th><th>Actions</th></tr></thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.name}>
                    <td>
                      <span className="font-medium text-white">{agent.name}</span>
                      <span className="block text-xs text-gray-500">{agent.description?.slice(0, 60) ?? "No description"}</span>
                    </td>
                    <td><span className="badge">{agent.model?.split("/").pop() || "n/a"}</span></td>
                    <td>{safeArray(agent.tools).length} tools</td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        {safeArray<string>(agent.tags).map((tag) => (<span key={tag} className="badge badge-muted">{tag}</span>))}
                      </div>
                    </td>
                    <td><button className="btn-primary text-xs" onClick={() => setSelectedAgent(agent.name)}>View Config</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </QueryState>

      {selectedAgent ? (
        <div className="card mt-6">
          <p className="font-bold text-white mb-2">Agent Config: {selectedAgent}</p>
          {detailQuery.loading ? <p className="text-gray-400">Loading config...</p> : null}
          {detailQuery.error ? <p className="text-red-500">{detailQuery.error}</p> : null}
          {detailQuery.data ? <pre className="code-block">{JSON.stringify(detailQuery.data, null, 2)}</pre> : null}
          <button className="btn-secondary text-xs mt-2" onClick={() => setSelectedAgent(null)}>Close</button>
        </div>
      ) : null}
    </div>
  );
};
