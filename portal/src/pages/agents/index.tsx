import { Card, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, Text, Badge, Button } from "@tremor/react";
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
      <div className="mb-3 flex items-center gap-2">
        <Button size="xs" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <Button size="xs" variant="secondary" onClick={() => setOffset(offset + limit)}>
          Next
        </Button>
        <select
          className="rounded border border-gray-300 px-2 py-1 text-xs"
          value={limit}
          onChange={(event) => {
            setLimit(Number(event.target.value));
            setOffset(0);
          }}
        >
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>

      <QueryState
        loading={agentsQuery.loading}
        error={agentsQuery.error}
        isEmpty={agents.length === 0}
        emptyMessage="No agents found."
        onRetry={() => void agentsQuery.refetch()}
      >
        <Card>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Tools</TableHeaderCell>
                <TableHeaderCell>Tags</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.name}>
                  <TableCell>
                    <Text className="font-medium">{agent.name}</Text>
                    <Text className="text-xs text-gray-400">{agent.description?.slice(0, 60) ?? "No description"}</Text>
                  </TableCell>
                  <TableCell>
                    <Badge>{agent.model?.split("/").pop() || "n/a"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Text>{safeArray(agent.tools).length} tools</Text>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {safeArray<string>(agent.tags).map((tag) => (
                        <Badge key={tag} size="xs" color="gray">{tag}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button size="xs" onClick={() => setSelectedAgent(agent.name)}>
                      View Config
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </QueryState>

      {selectedAgent ? (
        <Card className="mt-6">
          <Text className="font-bold mb-2">Agent Config: {selectedAgent}</Text>
          {detailQuery.loading ? <Text>Loading config...</Text> : null}
          {detailQuery.error ? <Text className="text-red-600">{detailQuery.error}</Text> : null}
          {detailQuery.data ? (
            <pre className="max-h-96 overflow-auto rounded bg-gray-50 p-4 text-xs">
              {JSON.stringify(detailQuery.data, null, 2)}
            </pre>
          ) : null}
          <Button size="xs" className="mt-2" onClick={() => setSelectedAgent(null)}>Close</Button>
        </Card>
      ) : null}
    </div>
  );
};
