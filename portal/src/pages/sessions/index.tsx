import { useCustom } from "@refinedev/core";
import { Card, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, Text, Badge, Button } from "@tremor/react";
import { useState } from "react";

const API_URL = "/api/v1";
const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const SessionsPage = () => {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const { data: sessionsData } = useCustom({
    url: `${API_URL}/sessions?limit=50`,
    method: "get",
    config: { headers: authHeaders() },
  });

  const sessions = (sessionsData?.data || []) as any[];

  const { data: turnsData } = useCustom({
    url: `${API_URL}/sessions/${selectedSession}/turns`,
    method: "get",
    config: { headers: authHeaders() },
    queryOptions: { enabled: !!selectedSession },
  });

  const statusColor = (status: string) => {
    if (status === "success") return "green";
    if (status === "error") return "red";
    return "gray";
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Sessions</h1>

      <Card>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Session</TableHeaderCell>
              <TableHeaderCell>Agent</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Turns</TableHeaderCell>
              <TableHeaderCell>Cost</TableHeaderCell>
              <TableHeaderCell>Duration</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sessions.map((s: any) => (
              <TableRow key={s.session_id}>
                <TableCell>
                  <Text className="font-mono text-xs">{s.session_id?.slice(0, 12)}</Text>
                </TableCell>
                <TableCell><Text>{s.agent_name}</Text></TableCell>
                <TableCell>
                  <Badge color={statusColor(s.status)}>{s.status}</Badge>
                </TableCell>
                <TableCell><Text>{s.step_count}</Text></TableCell>
                <TableCell><Text>${(s.cost_total_usd || 0).toFixed(4)}</Text></TableCell>
                <TableCell><Text>{(s.wall_clock_seconds || 0).toFixed(1)}s</Text></TableCell>
                <TableCell>
                  <Button size="xs" onClick={() => setSelectedSession(s.session_id)}>
                    Turns
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {selectedSession && turnsData?.data && (
        <Card className="mt-6">
          <Text className="font-bold mb-4">Turns for {selectedSession.slice(0, 12)}</Text>
          {(Array.isArray(turnsData.data) ? turnsData.data : []).map((turn: any) => (
            <div key={turn.turn_number} className="border-b pb-3 mb-3">
              <div className="flex justify-between mb-1">
                <Badge>Turn {turn.turn_number}</Badge>
                <Text className="text-xs text-gray-400">
                  {turn.model_used?.split("/").pop()} · {turn.latency_ms?.toFixed(0)}ms · ${turn.cost_total_usd?.toFixed(6)}
                </Text>
              </div>
              <Text className="text-sm whitespace-pre-wrap">{turn.content?.slice(0, 500)}</Text>
              {turn.tool_calls?.length > 0 && (
                <div className="mt-1">
                  {turn.tool_calls.map((tc: any, i: number) => (
                    <Badge key={i} size="xs" color="blue" className="mr-1">
                      {tc.name || tc.function?.name || "tool"}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
          <Button size="xs" onClick={() => setSelectedSession(null)}>Close</Button>
        </Card>
      )}
    </div>
  );
};
