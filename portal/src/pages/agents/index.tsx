import { useCustom } from "@refinedev/core";
import { Card, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, Text, Badge, Button } from "@tremor/react";
import { useState } from "react";

const API_URL = "/api/v1";
const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const AgentsPage = () => {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const { data: agentsData } = useCustom({
    url: `${API_URL}/agents`,
    method: "get",
    config: { headers: authHeaders() },
  });

  const agents = (agentsData?.data || []) as any[];

  const { data: agentDetail } = useCustom({
    url: `${API_URL}/agents/${selectedAgent}/config`,
    method: "get",
    config: { headers: authHeaders() },
    queryOptions: { enabled: !!selectedAgent },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
        <Text className="text-gray-500">{agents.length} agent(s)</Text>
      </div>

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
            {agents.map((agent: any) => (
              <TableRow key={agent.name}>
                <TableCell>
                  <Text className="font-medium">{agent.name}</Text>
                  <Text className="text-xs text-gray-400">{agent.description?.slice(0, 60)}</Text>
                </TableCell>
                <TableCell>
                  <Badge>{agent.model?.split("/").pop() || agent.model}</Badge>
                </TableCell>
                <TableCell>
                  <Text>{agent.tools?.length || 0} tools</Text>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {(agent.tags || []).map((tag: string) => (
                      <Badge key={tag} size="xs" color="gray">{tag}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Button size="xs" onClick={() => setSelectedAgent(agent.name)}>
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {selectedAgent && agentDetail?.data && (
        <Card className="mt-6">
          <Text className="font-bold mb-2">Agent Config: {selectedAgent}</Text>
          <pre className="bg-gray-50 p-4 rounded text-xs overflow-auto max-h-96">
            {JSON.stringify(agentDetail.data, null, 2)}
          </pre>
          <Button size="xs" className="mt-2" onClick={() => setSelectedAgent(null)}>Close</Button>
        </Card>
      )}
    </div>
  );
};
