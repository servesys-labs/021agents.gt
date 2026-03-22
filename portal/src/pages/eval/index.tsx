import { Button, Card, Select, SelectItem, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text } from "@tremor/react";
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
        <Card>
          <Text className="font-semibold mb-3">Run Evaluation</Text>
          <Text className="text-xs text-gray-500 mb-2">Agent</Text>
          <Select value={agentName || agents[0]?.name || ""} onValueChange={setAgentName}>
            {agents.map((agent) => (
              <SelectItem key={agent.name} value={agent.name}>
                {agent.name}
              </SelectItem>
            ))}
          </Select>
          <Text className="text-xs text-gray-500 mt-3 mb-2">Eval Task File</Text>
          <Select value={evalFile || tasks[0]?.file || ""} onValueChange={setEvalFile}>
            {tasks.map((task) => (
              <SelectItem key={task.file} value={task.file}>
                {task.name} ({task.task_count} tasks)
              </SelectItem>
            ))}
          </Select>
          <Text className="text-xs text-gray-500 mt-3 mb-2">Trials</Text>
          <input
            className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm"
            type="number"
            min={1}
            max={20}
            value={trials}
            onChange={(event) => setTrials(Number(event.target.value) || 1)}
          />
          <div className="mt-4">
            <Button loading={running} onClick={() => void runEval()}>
              Run Eval
            </Button>
          </div>
          {error ? <Text className="mt-3 text-red-600">{error}</Text> : null}
          {lastRun ? (
            <pre className="mt-3 max-h-64 overflow-auto rounded bg-gray-50 p-3 text-xs">
              {JSON.stringify(lastRun, null, 2)}
            </pre>
          ) : null}
        </Card>

        <QueryState
          loading={tasksQuery.loading}
          error={tasksQuery.error}
          isEmpty={tasks.length === 0}
          emptyMessage="No eval task files found in /eval."
          onRetry={() => void tasksQuery.refetch()}
        >
          <Card>
            <Text className="font-semibold mb-3">Available Task Suites</Text>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>File</TableHeaderCell>
                  <TableHeaderCell>Tasks</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.file}>
                    <TableCell><Text>{task.name}</Text></TableCell>
                    <TableCell><Text className="font-mono text-xs">{task.file}</Text></TableCell>
                    <TableCell><Text>{task.task_count}</Text></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </QueryState>
      </div>

      <Card className="mt-6">
        <Text className="font-semibold mb-3">Recent Eval Runs</Text>
        <QueryState
          loading={runsQuery.loading}
          error={runsQuery.error}
          isEmpty={runs.length === 0}
          emptyMessage="No eval runs yet."
          onRetry={() => void runsQuery.refetch()}
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Run</TableHeaderCell>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableHeaderCell>Pass Rate</TableHeaderCell>
                <TableHeaderCell>Score</TableHeaderCell>
                <TableHeaderCell>Cost</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.run_id}>
                  <TableCell><Text>{run.run_id}</Text></TableCell>
                  <TableCell><Text>{run.agent_name}</Text></TableCell>
                  <TableCell><Text>{(run.pass_rate * 100).toFixed(1)}%</Text></TableCell>
                  <TableCell><Text>{run.avg_score.toFixed(3)}</Text></TableCell>
                  <TableCell><Text>${run.total_cost_usd.toFixed(4)}</Text></TableCell>
                  <TableCell>
                    <Button size="xs" onClick={() => setSelectedRunId(run.run_id)}>
                      Detail
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryState>
      </Card>

      {selectedRunId !== null ? (
        <Card className="mt-6">
          <Text className="font-semibold mb-2">Run Detail: {selectedRunId}</Text>
          {runDetailQuery.loading ? <Text>Loading detail...</Text> : null}
          {runDetailQuery.error ? <Text className="text-red-600">{runDetailQuery.error}</Text> : null}
          {runDetailQuery.data ? (
            <pre className="max-h-80 overflow-auto rounded bg-gray-50 p-3 text-xs">
              {JSON.stringify(runDetailQuery.data, null, 2)}
            </pre>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
};
