import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import type { AgentInfo } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";

type Proposal = { id?: string; title?: string; rationale?: string; priority?: number };
type LedgerEntry = { version?: string; proposal_title?: string; created_at?: number };

export const EvolutionPage = () => {
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const [agentName, setAgentName] = useState("");
  const [evalFile, setEvalFile] = useState("eval/smoke-test.json");
  const [cycles, setCycles] = useState(1);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  const selectedAgent = agentName || agents[0]?.name || "";
  const proposalsQuery = useApiQuery<{ proposals: Proposal[] }>(
    `/api/v1/evolve/${encodeURIComponent(selectedAgent)}/proposals`,
    Boolean(selectedAgent),
  );
  const ledgerQuery = useApiQuery<{ entries: LedgerEntry[]; current_version?: string }>(
    `/api/v1/evolve/${encodeURIComponent(selectedAgent)}/ledger`,
    Boolean(selectedAgent),
  );

  const runEvolution = async () => {
    if (!selectedAgent) {
      setActionError("Select an agent first.");
      return;
    }
    setActionError("");
    try {
      const path = `/api/v1/evolve/${encodeURIComponent(selectedAgent)}/run?eval_file=${encodeURIComponent(evalFile)}&max_cycles=${cycles}`;
      const response = await apiRequest<Record<string, unknown>>(path, "POST");
      setActionMessage(`Evolution run completed: ${JSON.stringify(response)}`);
      await proposalsQuery.refetch();
      await ledgerQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Evolution run failed");
    }
  };

  const decideProposal = async (proposalId: string, decision: "approve" | "reject") => {
    try {
      await apiRequest(
        `/api/v1/evolve/${encodeURIComponent(selectedAgent)}/proposals/${encodeURIComponent(proposalId)}/${decision}?note=${encodeURIComponent("approved from portal")}`,
        "POST",
      );
      await proposalsQuery.refetch();
      await ledgerQuery.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update proposal");
    }
  };

  return (
    <div>
      <PageHeader title="Evolve & Proposals" subtitle="Run evolution cycles and review proposal queue" />
      <div className="card mb-6">
        <div className="grid gap-2 md:grid-cols-4">
          <select className="input-field" value={selectedAgent} onChange={(e) => setAgentName(e.target.value)}>
            {agents.map((agent) => (
              <option key={agent.name} value={agent.name}>{agent.name}</option>
            ))}
          </select>
          <input className="input-field" value={evalFile} onChange={(event) => setEvalFile(event.target.value)} placeholder="eval/smoke-test.json" />
          <input
            className="rounded-md border border-[#2a2a2a] px-2 py-1 text-sm"
            type="number"
            min={1}
            max={10}
            value={cycles}
            onChange={(event) => setCycles(Number(event.target.value) || 1)}
          />
          <button className="btn-primary" onClick={() => void runEvolution()}>Run Evolution</button>
        </div>
        {actionMessage ? <span className="mt-3 text-emerald-600 break-all">{actionMessage}</span> : null}
        {actionError ? <span className="mt-3 text-red-600">{actionError}</span> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Proposal Queue</p>
          <QueryState
            loading={proposalsQuery.loading}
            error={proposalsQuery.error}
            isEmpty={(proposalsQuery.data?.proposals ?? []).length === 0}
            emptyMessage="No proposals yet."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Priority</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(proposalsQuery.data?.proposals ?? []).map((proposal) => (
                  <tr key={proposal.id}>
                    <td><span className="text-gray-400">{proposal.title ?? proposal.id}</span></td>
                    <td><span className="text-gray-400">{proposal.priority ?? 0}</span></td>
                    <td>
                      <div className="flex gap-2">
                        {proposal.id ? (
                          <>
                            <button className="btn-primary text-xs" onClick={() => void decideProposal(proposal.id ?? "", "approve")}>Approve</button>
                            <button className="btn-danger text-xs" onClick={() => void decideProposal(proposal.id ?? "", "reject")}>Reject</button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">Version Ledger</p>
          <QueryState
            loading={ledgerQuery.loading}
            error={ledgerQuery.error}
            isEmpty={(ledgerQuery.data?.entries ?? []).length === 0}
            emptyMessage="No ledger entries."
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Proposal</th>
                </tr>
              </thead>
              <tbody>
                {(ledgerQuery.data?.entries ?? []).map((entry, index) => (
                  <tr key={`${entry.version}-${index}`}>
                    <td><span className="text-gray-400">{entry.version ?? "-"}</span></td>
                    <td><span className="text-gray-400">{entry.proposal_title ?? "-"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
      </div>
    </div>
  );
};
