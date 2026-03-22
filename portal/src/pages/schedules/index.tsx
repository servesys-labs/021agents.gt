import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput, Textarea } from "@tremor/react";
import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import type { AgentInfo } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";

type Schedule = {
  schedule_id: string;
  agent_name: string;
  cron: string;
  task: string;
  is_enabled: boolean;
  run_count: number;
  last_run_at?: number | null;
};

export const SchedulesPage = () => {
  const schedulesQuery = useApiQuery<Schedule[]>("/api/v1/schedules");
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");

  const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);

  const [agentName, setAgentName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [task, setTask] = useState("Run scheduled health check");
  const [actionError, setActionError] = useState("");
  const [history, setHistory] = useState<Record<string, unknown> | null>(null);

  const refresh = async () => {
    await schedulesQuery.refetch();
  };

  const createSchedule = async () => {
    const selectedAgent = agentName || agents[0]?.name;
    if (!selectedAgent || !cron.trim() || !task.trim()) {
      setActionError("Agent, cron, and task are required.");
      return;
    }
    setActionError("");
    try {
      await apiRequest("/api/v1/schedules", "POST", { agent_name: selectedAgent, cron, task });
      await refresh();
      setTask("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create schedule");
    }
  };

  const toggleSchedule = async (schedule: Schedule) => {
    const action = schedule.is_enabled ? "disable" : "enable";
    try {
      await apiRequest(`/api/v1/schedules/${encodeURIComponent(schedule.schedule_id)}/${action}`, "POST");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to toggle schedule");
    }
  };

  const updateSchedule = async (schedule: Schedule) => {
    const nextCron = window.prompt("Cron expression", schedule.cron);
    const nextTask = window.prompt("Task", schedule.task);
    if (nextCron === null && nextTask === null) {
      return;
    }
    const params = new URLSearchParams();
    if (nextCron && nextCron !== schedule.cron) {
      params.set("cron", nextCron);
    }
    if (nextTask && nextTask !== schedule.task) {
      params.set("task", nextTask);
    }
    if (!params.toString()) {
      return;
    }
    try {
      await apiRequest(`/api/v1/schedules/${encodeURIComponent(schedule.schedule_id)}?${params.toString()}`, "PUT");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update schedule");
    }
  };

  const deleteSchedule = async (schedule: Schedule) => {
    if (!window.confirm(`Delete schedule ${schedule.schedule_id}?`)) {
      return;
    }
    try {
      await apiRequest(`/api/v1/schedules/${encodeURIComponent(schedule.schedule_id)}`, "DELETE");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete schedule");
    }
  };

  const loadHistory = async (schedule: Schedule) => {
    try {
      const data = await apiRequest<Record<string, unknown>>(`/api/v1/schedules/${encodeURIComponent(schedule.schedule_id)}/history`);
      setHistory(data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to fetch history");
    }
  };

  return (
    <div>
      <PageHeader title="Schedules" subtitle="Create and manage cron-based agent runs" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Create Schedule</Text>
          <Text className="text-xs text-gray-500 mb-1">Agent</Text>
          <TextInput value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder={agents[0]?.name ?? "agent-name"} />
          <Text className="text-xs text-gray-500 mt-3 mb-1">Cron</Text>
          <TextInput value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 * * * *" />
          <Text className="text-xs text-gray-500 mt-3 mb-1">Task</Text>
          <Textarea value={task} onChange={(event) => setTask(event.target.value)} rows={4} />
          <Button className="mt-4" onClick={() => void createSchedule()}>
            Create
          </Button>
          {actionError ? <Text className="mt-3 text-red-600">{actionError}</Text> : null}
        </Card>

        {history ? (
          <Card>
            <Text className="font-semibold mb-2">Schedule History</Text>
            <pre className="max-h-80 overflow-auto rounded bg-gray-50 p-3 text-xs">{JSON.stringify(history, null, 2)}</pre>
          </Card>
        ) : (
          <Card>
            <Text className="text-gray-500">Select a schedule and click History to inspect run metadata.</Text>
          </Card>
        )}
      </div>

      <Card className="mt-6">
        <Text className="font-semibold mb-3">Existing Schedules</Text>
        <QueryState
          loading={schedulesQuery.loading}
          error={schedulesQuery.error}
          isEmpty={schedules.length === 0}
          emptyMessage="No schedules configured."
          onRetry={() => void schedulesQuery.refetch()}
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableHeaderCell>Cron</TableHeaderCell>
                <TableHeaderCell>Task</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Runs</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {schedules.map((schedule) => (
                <TableRow key={schedule.schedule_id}>
                  <TableCell><Text>{schedule.agent_name}</Text></TableCell>
                  <TableCell><Text className="font-mono text-xs">{schedule.cron}</Text></TableCell>
                  <TableCell><Text>{schedule.task}</Text></TableCell>
                  <TableCell>
                    <Badge color={schedule.is_enabled ? "green" : "gray"}>
                      {schedule.is_enabled ? "enabled" : "disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell><Text>{schedule.run_count}</Text></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button size="xs" onClick={() => void toggleSchedule(schedule)}>
                        {schedule.is_enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button size="xs" variant="secondary" onClick={() => void updateSchedule(schedule)}>
                        Edit
                      </Button>
                      <Button size="xs" variant="secondary" onClick={() => void loadHistory(schedule)}>
                        History
                      </Button>
                      <Button size="xs" color="red" onClick={() => void deleteSchedule(schedule)}>
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryState>
      </Card>
    </div>
  );
};
