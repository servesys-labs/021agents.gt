import { Button, Card, Select, SelectItem, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
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
      <Card className="mb-6">
        <div className="grid gap-2 md:grid-cols-4">
          <Select value={selectedAgent} onValueChange={setAgentName}>
            {agents.map((agent) => (
              <SelectItem key={agent.name} value={agent.name}>{agent.name}</SelectItem>
            ))}
          </Select>
          <TextInput value={evalFile} onChange={(event) => setEvalFile(event.target.value)} placeholder="eval/smoke-test.json" />
          <input
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
            type="number"
            min={1}
            max={10}
            value={cycles}
            onChange={(event) => setCycles(Number(event.target.value) || 1)}
          />
          <Button onClick={() => void runEvolution()}>Run Evolution</Button>
        </div>
        {actionMessage ? <Text className="mt-3 text-emerald-600 break-all">{actionMessage}</Text> : null}
        {actionError ? <Text className="mt-3 text-red-600">{actionError}</Text> : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Proposal Queue</Text>
          <QueryState
            loading={proposalsQuery.loading}
            error={proposalsQuery.error}
            isEmpty={(proposalsQuery.data?.proposals ?? []).length === 0}
            emptyMessage="No proposals yet."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Title</TableHeaderCell>
                  <TableHeaderCell>Priority</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(proposalsQuery.data?.proposals ?? []).map((proposal) => (
                  <TableRow key={proposal.id}>
                    <TableCell><Text>{proposal.title ?? proposal.id}</Text></TableCell>
                    <TableCell><Text>{proposal.priority ?? 0}</Text></TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {proposal.id ? (
                          <>
                            <Button size="xs" onClick={() => void decideProposal(proposal.id ?? "", "approve")}>Approve</Button>
                            <Button size="xs" color="red" onClick={() => void decideProposal(proposal.id ?? "", "reject")}>Reject</Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
        <Card>
          <Text className="font-semibold mb-3">Version Ledger</Text>
          <QueryState
            loading={ledgerQuery.loading}
            error={ledgerQuery.error}
            isEmpty={(ledgerQuery.data?.entries ?? []).length === 0}
            emptyMessage="No ledger entries."
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Version</TableHeaderCell>
                  <TableHeaderCell>Proposal</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(ledgerQuery.data?.entries ?? []).map((entry, index) => (
                  <TableRow key={`${entry.version}-${index}`}>
                    <TableCell><Text>{entry.version ?? "-"}</Text></TableCell>
                    <TableCell><Text>{entry.proposal_title ?? "-"}</Text></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
      </div>
    </div>
  );
};
