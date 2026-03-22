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
        <div className="card">
          <p className="font-semibold text-white mb-3">Create Schedule</p>
          <span className="text-xs text-gray-500 mb-1">Agent</span>
          <input className="input-field" value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder={agents[0]?.name ?? "agent-name"} />
          <span className="text-xs text-gray-500 mt-3 mb-1">Cron</span>
          <input className="input-field" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 * * * *" />
          <span className="text-xs text-gray-500 mt-3 mb-1">Task</span>
          <textarea className="input-field" value={task} onChange={(event) => setTask(event.target.value)} rows={4} />
          <button className="btn-primary mt-4" onClick={() => void createSchedule()}>
            Create
          </button>
          {actionError ? <span className="mt-3 text-red-600">{actionError}</span> : null}
        </div>

        {history ? (
          <div className="card">
            <p className="font-semibold text-white mb-2">Schedule History</p>
            <pre className="max-h-80 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">{JSON.stringify(history, null, 2)}</pre>
          </div>
        ) : (
          <div className="card">
            <span className="text-gray-500">Select a schedule and click History to inspect run metadata.</span>
          </div>
        )}
      </div>

      <div className="card mt-6">
        <p className="font-semibold text-white mb-3">Existing Schedules</p>
        <QueryState
          loading={schedulesQuery.loading}
          error={schedulesQuery.error}
          isEmpty={schedules.length === 0}
          emptyMessage="No schedules configured."
          onRetry={() => void schedulesQuery.refetch()}
        >
          <table className="os-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Cron</th>
                <th>Task</th>
                <th>Status</th>
                <th>Runs</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.schedule_id}>
                  <td><span className="text-gray-400">{schedule.agent_name}</span></td>
                  <td><span className="font-mono text-xs text-gray-300">{schedule.cron}</span></td>
                  <td><span className="text-gray-400">{schedule.task}</span></td>
                  <td>
                    <span className="badge">
                      {schedule.is_enabled ? "enabled" : "disabled"}
                    </span>
                  </td>
                  <td><span className="text-gray-400">{schedule.run_count}</span></td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-primary text-xs" onClick={() => void toggleSchedule(schedule)}>
                        {schedule.is_enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="btn-secondary text-xs" onClick={() => void updateSchedule(schedule)}>
                        Edit
                      </button>
                      <button className="btn-secondary text-xs" onClick={() => void loadHistory(schedule)}>
                        History
                      </button>
                      <button className="btn-danger text-xs" onClick={() => void deleteSchedule(schedule)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </QueryState>
      </div>
    </div>
  );
};
