import { Card, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, Text, Badge, Button } from "@tremor/react";
import { useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { safeArray, toNumber, type SessionInfo } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

type SessionTurn = {
  turn_number?: number;
  model_used?: string;
  latency_ms?: number;
  cost_total_usd?: number;
  content?: string;
  tool_calls?: Array<{ name?: string; function?: { name?: string } }>;
};
type ToolCall = { name?: string; function?: { name?: string } };

export const SessionsPage = () => {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const sessionsQuery = useApiQuery<SessionInfo[]>(`/api/v1/sessions?limit=${limit}&offset=${offset}`);
  const turnsQuery = useApiQuery<SessionTurn[]>(
    `/api/v1/sessions/${selectedSession ?? ""}/turns`,
    Boolean(selectedSession),
  );
  const sessions = safeArray<SessionInfo>(sessionsQuery.data);

  const statusColor = (status: string) => {
    if (status === "success") return "green";
    if (status === "error") return "red";
    return "gray";
  };

  return (
    <div>
      <PageHeader title="Sessions" subtitle="Recent session runs and turn-level traces" />
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
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
        </select>
      </div>

      <QueryState
        loading={sessionsQuery.loading}
        error={sessionsQuery.error}
        isEmpty={sessions.length === 0}
        emptyMessage="No sessions found."
        onRetry={() => void sessionsQuery.refetch()}
      >
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
              {sessions.map((s) => (
                <TableRow key={s.session_id}>
                  <TableCell>
                    <Text className="font-mono text-xs">{s.session_id.slice(0, 12)}</Text>
                  </TableCell>
                  <TableCell><Text>{s.agent_name ?? "unknown"}</Text></TableCell>
                  <TableCell>
                    <Badge color={statusColor(s.status ?? "")}>{s.status ?? "unknown"}</Badge>
                  </TableCell>
                  <TableCell><Text>{toNumber(s.step_count)}</Text></TableCell>
                  <TableCell><Text>${toNumber(s.cost_total_usd).toFixed(4)}</Text></TableCell>
                  <TableCell><Text>{toNumber(s.wall_clock_seconds).toFixed(1)}s</Text></TableCell>
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
      </QueryState>

      {selectedSession ? (
        <Card className="mt-6">
          <Text className="font-bold mb-4">Turns for {selectedSession.slice(0, 12)}</Text>
          {turnsQuery.loading ? <Text>Loading turns...</Text> : null}
          {turnsQuery.error ? <Text className="text-red-600">{turnsQuery.error}</Text> : null}
          {safeArray<SessionTurn>(turnsQuery.data).map((turn) => (
            <div key={turn.turn_number} className="border-b pb-3 mb-3">
              <div className="flex justify-between mb-1">
                <Badge>Turn {turn.turn_number}</Badge>
                <Text className="text-xs text-gray-400">
                  {turn.model_used?.split("/").pop()} · {toNumber(turn.latency_ms).toFixed(0)}ms · ${toNumber(turn.cost_total_usd).toFixed(6)}
                </Text>
              </div>
              <Text className="text-sm whitespace-pre-wrap">{turn.content?.slice(0, 500) ?? ""}</Text>
              {safeArray<ToolCall>(turn.tool_calls).length > 0 && (
                <div className="mt-1">
                  {safeArray<ToolCall>(turn.tool_calls).map((tc, index) => (
                    <Badge key={`${tc.name ?? tc.function?.name ?? "tool"}-${index}`} size="xs" color="blue" className="mr-1">
                      {tc.name || tc.function?.name || "tool"}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
          <Button size="xs" onClick={() => setSelectedSession(null)}>Close</Button>
        </Card>
      ) : null}
    </div>
  );
};
