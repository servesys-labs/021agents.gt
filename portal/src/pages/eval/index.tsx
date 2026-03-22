import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import type { AgentInfo } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";

type EvalTaskInfo = { file: string; name: string; task_count: number };
type EvalTasksResponse = { tasks: EvalTaskInfo[] };
type EvalRun = {
  run_id: number;
  agent_name: string;
  pass_rate: number;
  avg_score: number;
  avg_latency_ms: number;
  total_cost_usd: number;
  total_tasks: number;
  total_trials: number;
};

export const EvalPage = () => {
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const tasksQuery = useApiQuery<EvalTasksResponse>("/api/v1/eval/tasks");
  const runsQuery = useApiQuery<EvalRun[]>("/api/v1/eval/runs?limit=25");

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const tasks = useMemo(() => tasksQuery.data?.tasks ?? [], [tasksQuery.data]);
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);

  const [agentName, setAgentName] = useState("");
  const [evalFile, setEvalFile] = useState("");
  const [trials, setTrials] = useState(3);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [lastRun, setLastRun] = useState<Record<string, unknown> | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const runDetailQuery = useApiQuery<Record<string, unknown>>(
    `/api/v1/eval/runs/${selectedRunId ?? 0}`,
    selectedRunId !== null,
  );

  const runEval = async () => {
    const selectedAgent = agentName || agents[0]?.name;
    const selectedFile = evalFile || tasks[0]?.file;
    if (!selectedAgent || !selectedFile) {
      setError("Select an agent and eval task file.");
      return;
    }
    setError("");
    setRunning(true);
    try {
      const path = `/api/v1/eval/run?agent_name=${encodeURIComponent(selectedAgent)}&eval_file=${encodeURIComponent(selectedFile)}&trials=${trials}`;
      const result = await apiRequest<Record<string, unknown>>(path, "POST");
      setLastRun(result);
      await runsQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run eval");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <PageHeader title="Eval Runner" subtitle="Run evaluation suites and inspect benchmark outcomes" />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Run Evaluation</p>
          <span className="text-xs text-gray-500 mb-2">Agent</span>
          <select className="input-field" value={agentName || agents[0]?.name || ""} onChange={(e) => setAgentName(e.target.value)}>
            {agents.map((agent) => (
              <option key={agent.name} value={agent.name}>
                {agent.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-500 mt-3 mb-2">Eval Task File</span>
          <select className="input-field" value={evalFile || tasks[0]?.file || ""} onChange={(e) => setEvalFile(e.target.value)}>
            {tasks.map((task) => (
              <option key={task.file} value={task.file}>
                {task.name} ({task.task_count} tasks)
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-500 mt-3 mb-2">Trials</span>
          <input
            className="w-24 rounded-md border border-[#2a2a2a] px-2 py-1 text-sm"
            type="number"
            min={1}
            max={20}
            value={trials}
            onChange={(event) => setTrials(Number(event.target.value) || 1)}
          />
          <div className="mt-4">
            <button className="btn-primary" disabled={running} onClick={() => void runEval()}>
              Run Eval
            </button>
          </div>
          {error ? <span className="mt-3 text-red-600">{error}</span> : null}
          {lastRun ? (
            <pre className="mt-3 max-h-64 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">
              {JSON.stringify(lastRun, null, 2)}
            </pre>
          ) : null}
        </div>

        <QueryState
          loading={tasksQuery.loading}
          error={tasksQuery.error}
          isEmpty={tasks.length === 0}
          emptyMessage="No eval task files found in /eval."
          onRetry={() => void tasksQuery.refetch()}
        >
          <div className="card">
            <p className="font-semibold text-white mb-3">Available Task Suites</p>
            <table className="os-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>File</th>
                  <th>Tasks</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.file}>
                    <td><span className="text-gray-400">{task.name}</span></td>
                    <td><span className="font-mono text-xs text-gray-300">{task.file}</span></td>
                    <td><span className="text-gray-400">{task.task_count}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </div>

      <div className="card mt-6">
        <p className="font-semibold text-white mb-3">Recent Eval Runs</p>
        <QueryState
          loading={runsQuery.loading}
          error={runsQuery.error}
          isEmpty={runs.length === 0}
          emptyMessage="No eval runs yet."
          onRetry={() => void runsQuery.refetch()}
        >
          <table className="os-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Agent</th>
                <th>Pass Rate</th>
                <th>Score</th>
                <th>Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id}>
                  <td><span className="text-gray-400">{run.run_id}</span></td>
                  <td><span className="text-gray-400">{run.agent_name}</span></td>
                  <td><span className="text-gray-400">{(run.pass_rate * 100).toFixed(1)}%</span></td>
                  <td><span className="text-gray-400">{run.avg_score.toFixed(3)}</span></td>
                  <td><span className="text-gray-400">${run.total_cost_usd.toFixed(4)}</span></td>
                  <td>
                    <button className="btn-primary text-xs" onClick={() => setSelectedRunId(run.run_id)}>
                      Detail
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </QueryState>
      </div>

      {selectedRunId !== null ? (
        <div className="card mt-6">
          <p className="font-semibold text-white mb-2">Run Detail: {selectedRunId}</p>
          {runDetailQuery.loading ? <span className="text-gray-400">Loading detail...</span> : null}
          {runDetailQuery.error ? <p className="text-red-500">{runDetailQuery.error}</p> : null}
          {runDetailQuery.data ? (
            <pre className="max-h-80 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">
              {JSON.stringify(runDetailQuery.data, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
