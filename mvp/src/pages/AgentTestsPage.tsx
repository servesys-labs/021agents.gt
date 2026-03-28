import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Play, CheckCircle, XCircle, Clock, Trash2, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";

interface AgentDetail {
  name: string;
  description: string;
  config_json: Record<string, any>;
  is_active: boolean;
  version: number;
}

interface EvalTask {
  id: string;
  input: string;
  expected: string;
  grader: string;
}

interface EvalTrial {
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  latency_ms?: number;
  reasoning?: string;
}

interface EvalRun {
  id: string;
  agent_name: string;
  created_at: string;
  status: string;
  pass_count: number;
  fail_count: number;
  total_count: number;
  trials?: EvalTrial[];
}

export default function AgentTestsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [scenarios, setScenarios] = useState<EvalTask[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newInput, setNewInput] = useState("");
  const [newExpected, setNewExpected] = useState("");
  const [running, setRunning] = useState(false);
  const [selectedRun, setSelectedRun] = useState<EvalRun | null>(null);
  const [selectedTrial, setSelectedTrial] = useState<EvalTrial | null>(null);
  const [tab, setTab] = useState<"scenarios" | "results">("scenarios");

  const fetchData = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const q = encodeURIComponent(id.trim());
    try {
      const [agentData, evalRuns] = await Promise.all([
        api.get<AgentDetail>(`/agents/${agentPathSegment(id)}`),
        api.get<EvalRun[]>(`/eval/runs?agent_name=${q}`),
      ]);
      setAgent(agentData);
      setRuns(evalRuns || []);
    } catch (err: any) {
      if (err.status === 404) {
        setAgent(null);
      } else {
        setError(err.message || "Failed to load data");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) fetchData();
  }, [id]);

  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;

  const addScenario = () => {
    if (!newInput.trim()) return;
    const task: EvalTask = {
      id: `task-${Date.now()}`,
      input: newInput.trim(),
      expected: newExpected.trim(),
      grader: "llm_match",
    };
    setScenarios((prev) => [...prev, task]);
    setNewName("");
    setNewInput("");
    setNewExpected("");
    setShowAdd(false);
    toast("Test scenario added");
  };

  const deleteScenario = (taskId: string) => {
    setScenarios((prev) => prev.filter((s) => s.id !== taskId));
    toast("Scenario removed");
  };

  const runTests = async () => {
    if (scenarios.length === 0) return;
    setRunning(true);
    setTab("results");
    try {
      const result = await api.post<EvalRun>("/eval/runs", {
        agent_name: id,
        tasks: scenarios.map((s) => ({
          input: s.input,
          expected: s.expected,
          grader: s.grader,
        })),
        trials: 1,
      });
      // Refresh runs list
      const updatedRuns = await api.get<EvalRun[]>(`/eval/runs?agent_name=${encodeURIComponent(id!.trim())}`);
      setRuns(updatedRuns || []);
      const passCount = result.pass_count ?? 0;
      const totalCount = result.total_count ?? scenarios.length;
      toast(`Eval complete: ${passCount}/${totalCount} passed`);
    } catch (err: any) {
      toast(err.message || "Eval run failed");
    } finally {
      setRunning(false);
    }
  };

  const viewRunDetail = async (run: EvalRun) => {
    try {
      const detail = await api.get<EvalRun>(`/eval/runs/${run.id}`);
      setSelectedRun(detail);
    } catch {
      setSelectedRun(run);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-text-secondary text-sm mb-4">{error}</p>
        <Button variant="secondary" onClick={fetchData}>
          <RefreshCw size={14} /> Retry
        </Button>
      </div>
    );
  }

  if (!agent) return <AgentNotFound />;

  return (
    <div>
      <AgentNav agentName={agent.name}>
        <Button size="sm" variant="secondary" onClick={() => setShowAdd(true)}>
          <Plus size={14} /> Add Test
        </Button>
        <Button size="sm" onClick={runTests} disabled={running || scenarios.length === 0}>
          <Play size={14} /> {running ? "Running..." : "Run All"}
        </Button>
      </AgentNav>

      {/* Summary card from latest run */}
      {latestRun && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <p className="text-xs text-text-secondary">Total Tests</p>
            <p className="text-xl font-semibold text-text">{latestRun.total_count ?? 0}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-1.5">
              <CheckCircle size={14} className="text-success" />
              <p className="text-xs text-text-secondary">Passed</p>
            </div>
            <p className="text-xl font-semibold text-success">{latestRun.pass_count ?? 0}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-1.5">
              <XCircle size={14} className="text-danger" />
              <p className="text-xs text-text-secondary">Failed</p>
            </div>
            <p className="text-xl font-semibold text-danger">{latestRun.fail_count ?? 0}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-secondary">Pass Rate</p>
            <p className="text-xl font-semibold text-text">
              {(latestRun.total_count ?? 0) > 0
                ? Math.round(((latestRun.pass_count ?? 0) / (latestRun.total_count ?? 1)) * 100)
                : 0}%
            </p>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        <button
          onClick={() => setTab("scenarios")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "scenarios" ? "border-primary text-primary" : "border-transparent text-text-secondary"
          }`}
        >
          Test Scenarios ({scenarios.length})
        </button>
        <button
          onClick={() => setTab("results")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "results" ? "border-primary text-primary" : "border-transparent text-text-secondary"
          }`}
        >
          Eval Runs ({runs.length})
        </button>
      </div>

      {/* Scenarios tab */}
      {tab === "scenarios" && (
        <div className="space-y-3">
          {scenarios.length === 0 && (
            <div className="text-center py-12">
              <p className="text-text-muted text-sm mb-4">No test scenarios yet. Add one to start evaluating your agent.</p>
              <Button variant="secondary" onClick={() => setShowAdd(true)}>
                <Plus size={14} /> Add first test
              </Button>
            </div>
          )}
          {scenarios.map((s) => (
            <Card key={s.id}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="mt-1 space-y-1.5">
                    <div>
                      <span className="text-xs font-medium text-text-secondary">Input: </span>
                      <span className="text-xs text-text">{s.input}</span>
                    </div>
                    {s.expected && (
                      <div>
                        <span className="text-xs font-medium text-text-secondary">Expected: </span>
                        <span className="text-xs text-text">{s.expected}</span>
                      </div>
                    )}
                  </div>
                </div>
                <button onClick={() => deleteScenario(s.id)} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-muted">
                  <Trash2 size={14} />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Results tab */}
      {tab === "results" && (
        <div className="space-y-3">
          {running && (
            <div className="flex items-center justify-center gap-3 py-12">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-text-secondary">Running evaluations...</span>
            </div>
          )}
          {!running && runs.length === 0 && (
            <div className="text-center py-12">
              <p className="text-text-muted text-sm">No evals yet -- create test scenarios and run them.</p>
            </div>
          )}
          {!running && runs.map((run) => (
            <Card key={run.id} hover onClick={() => viewRunDetail(run)}>
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-text font-mono">{run.id.slice(0, 8)}...</p>
                    <Badge variant={run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "info"}>
                      {run.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted mt-0.5">
                    {run.pass_count ?? 0} passed, {run.fail_count ?? 0} failed of {run.total_count ?? 0} &middot;{" "}
                    {run.created_at ? new Date(run.created_at).toLocaleString() : ""}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-lg font-semibold text-text">
                    {(run.total_count ?? 0) > 0
                      ? Math.round(((run.pass_count ?? 0) / (run.total_count ?? 1)) * 100)
                      : 0}%
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add scenario modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Test Scenario">
        <div className="space-y-4">
          <Textarea
            label="Input message"
            placeholder="The message the user would send..."
            value={newInput}
            onChange={(e) => setNewInput(e.target.value)}
            rows={3}
          />
          <Textarea
            label="Expected behavior"
            placeholder="What should the agent do? e.g. Apologize, offer replacement, escalate if angry"
            value={newExpected}
            onChange={(e) => setNewExpected(e.target.value)}
            rows={3}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={addScenario} disabled={!newInput.trim()}>Add Test</Button>
          </div>
        </div>
      </Modal>

      {/* Run detail modal */}
      <Modal open={!!selectedRun} onClose={() => { setSelectedRun(null); setSelectedTrial(null); }} title="Eval Run Detail" wide>
        {selectedRun && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium text-text font-mono text-sm">{selectedRun.id}</span>
              <Badge variant={selectedRun.status === "completed" ? "success" : "info"}>{selectedRun.status}</Badge>
            </div>
            <p className="text-xs text-text-muted">
              {selectedRun.pass_count ?? 0} passed, {selectedRun.fail_count ?? 0} failed of {selectedRun.total_count ?? 0}
            </p>

            {selectedRun.trials && selectedRun.trials.length > 0 ? (
              <div className="space-y-2 mt-4">
                {selectedRun.trials.map((trial, idx) => (
                  <Card key={idx} hover onClick={() => setSelectedTrial(trial)}>
                    <div className="flex items-center gap-3">
                      {trial.passed ? (
                        <CheckCircle size={18} className="text-success shrink-0" />
                      ) : (
                        <XCircle size={18} className="text-danger shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-text truncate">{trial.input}</p>
                      </div>
                      <Badge variant={trial.passed ? "success" : "danger"}>{trial.passed ? "Pass" : "Fail"}</Badge>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No trial details available.</p>
            )}
          </div>
        )}
      </Modal>

      {/* Trial detail modal */}
      <Modal open={!!selectedTrial} onClose={() => setSelectedTrial(null)} title="Trial Detail" wide>
        {selectedTrial && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              {selectedTrial.passed ? (
                <CheckCircle size={20} className="text-success" />
              ) : (
                <XCircle size={20} className="text-danger" />
              )}
              <Badge variant={selectedTrial.passed ? "success" : "danger"}>{selectedTrial.passed ? "Pass" : "Fail"}</Badge>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-text-secondary mb-1">Input</p>
                <div className="bg-surface-alt rounded-lg p-3 text-sm text-text">{selectedTrial.input}</div>
              </div>
              <div>
                <p className="text-xs font-medium text-text-secondary mb-1">Expected</p>
                <div className="bg-surface-alt rounded-lg p-3 text-sm text-text">{selectedTrial.expected}</div>
              </div>
              <div>
                <p className="text-xs font-medium text-text-secondary mb-1">Actual Response</p>
                <div className={`rounded-lg p-3 text-sm text-text ${selectedTrial.passed ? "bg-emerald-50" : "bg-red-50"}`}>
                  {selectedTrial.actual}
                </div>
              </div>
              {selectedTrial.reasoning && (
                <div>
                  <p className="text-xs font-medium text-text-secondary mb-1">Reasoning</p>
                  <div className="bg-amber-50 rounded-lg p-3 text-sm text-amber-800">{selectedTrial.reasoning}</div>
                </div>
              )}
              {selectedTrial.latency_ms && (
                <div className="flex items-center gap-1 text-xs text-text-muted">
                  <Clock size={12} /> Response time: {selectedTrial.latency_ms}ms
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
