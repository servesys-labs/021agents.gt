import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Plus, Play, CheckCircle, XCircle, Clock, Trash2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { MOCK_AGENTS, MOCK_EVAL_SCENARIOS, MOCK_EVAL_RUNS, type EvalScenario, type EvalResult } from "../lib/mock-data";

export default function AgentTestsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const agent = MOCK_AGENTS.find((a) => a.id === id);

  const [scenarios, setScenarios] = useState<EvalScenario[]>(MOCK_EVAL_SCENARIOS.filter((s) => s.agent_id === id));
  const [runs] = useState(MOCK_EVAL_RUNS.filter((r) => r.agent_id === id));
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newInput, setNewInput] = useState("");
  const [newExpected, setNewExpected] = useState("");
  const [running, setRunning] = useState(false);
  const [selectedResult, setSelectedResult] = useState<EvalResult | null>(null);
  const [tab, setTab] = useState<"scenarios" | "results">("scenarios");

  const latestRun = runs[runs.length - 1];

  const addScenario = () => {
    if (!newName.trim() || !newInput.trim()) return;
    const scenario: EvalScenario = {
      id: `eval-${Date.now()}`,
      name: newName.trim(),
      input: newInput.trim(),
      expected: newExpected.trim(),
      agent_id: id!,
    };
    setScenarios((prev) => [...prev, scenario]);
    setNewName("");
    setNewInput("");
    setNewExpected("");
    setShowAdd(false);
    toast("Test scenario added");
  };

  const deleteScenario = (scenarioId: string) => {
    setScenarios((prev) => prev.filter((s) => s.id !== scenarioId));
    toast("Scenario removed");
  };

  const runTests = () => {
    setRunning(true);
    setTab("results");
    // Simulate running
    setTimeout(() => {
      setRunning(false);
      toast(`Eval complete: ${latestRun?.scenarios_passed || 0}/${latestRun?.scenarios_total || 0} passed`);
    }, 2000);
  };

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

      {/* Summary card */}
      {latestRun && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <p className="text-xs text-text-secondary">Total Tests</p>
            <p className="text-xl font-semibold text-text">{latestRun.scenarios_total}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-1.5">
              <CheckCircle size={14} className="text-success" />
              <p className="text-xs text-text-secondary">Passed</p>
            </div>
            <p className="text-xl font-semibold text-success">{latestRun.scenarios_passed}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-1.5">
              <XCircle size={14} className="text-danger" />
              <p className="text-xs text-text-secondary">Failed</p>
            </div>
            <p className="text-xl font-semibold text-danger">{latestRun.scenarios_total - latestRun.scenarios_passed}</p>
          </Card>
          <Card>
            <p className="text-xs text-text-secondary">Pass Rate</p>
            <p className="text-xl font-semibold text-text">
              {Math.round((latestRun.scenarios_passed / latestRun.scenarios_total) * 100)}%
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
          Latest Results
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
                  <p className="text-sm font-medium text-text">{s.name}</p>
                  <div className="mt-2 space-y-1.5">
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
          {!running && latestRun && latestRun.results.map((r) => (
            <Card key={r.scenario_id} hover onClick={() => setSelectedResult(r)}>
              <div className="flex items-center gap-3">
                {r.passed ? (
                  <CheckCircle size={18} className="text-success shrink-0" />
                ) : (
                  <XCircle size={18} className="text-danger shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-text">{r.scenario_name}</p>
                    <Badge variant={r.passed ? "success" : "danger"}>{r.passed ? "Pass" : "Fail"}</Badge>
                  </div>
                  <p className="text-xs text-text-muted mt-0.5 truncate">{r.input}</p>
                </div>
                <div className="flex items-center gap-1 text-xs text-text-muted shrink-0">
                  <Clock size={12} />
                  {r.latency_ms}ms
                </div>
              </div>
            </Card>
          ))}
          {!running && !latestRun && (
            <p className="text-center text-text-muted text-sm py-12">No results yet. Run the tests to see results.</p>
          )}
        </div>
      )}

      {/* Add scenario modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Test Scenario">
        <div className="space-y-4">
          <Input label="Test name" placeholder="e.g. Handles refund request" value={newName} onChange={(e) => setNewName(e.target.value)} />
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
            <Button onClick={addScenario} disabled={!newName.trim() || !newInput.trim()}>Add Test</Button>
          </div>
        </div>
      </Modal>

      {/* Result detail modal */}
      <Modal open={!!selectedResult} onClose={() => setSelectedResult(null)} title="Eval Result Detail" wide>
        {selectedResult && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              {selectedResult.passed ? (
                <CheckCircle size={20} className="text-success" />
              ) : (
                <XCircle size={20} className="text-danger" />
              )}
              <span className="text-lg font-medium text-text">{selectedResult.scenario_name}</span>
              <Badge variant={selectedResult.passed ? "success" : "danger"}>{selectedResult.passed ? "Pass" : "Fail"}</Badge>
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-text-secondary mb-1">Input</p>
                <div className="bg-surface-alt rounded-lg p-3 text-sm text-text">{selectedResult.input}</div>
              </div>
              <div>
                <p className="text-xs font-medium text-text-secondary mb-1">Expected</p>
                <div className="bg-surface-alt rounded-lg p-3 text-sm text-text">{selectedResult.expected}</div>
              </div>
              <div>
                <p className="text-xs font-medium text-text-secondary mb-1">Actual Response</p>
                <div className={`rounded-lg p-3 text-sm text-text ${selectedResult.passed ? "bg-emerald-50" : "bg-red-50"}`}>
                  {selectedResult.actual}
                </div>
              </div>
              {selectedResult.reasoning && (
                <div>
                  <p className="text-xs font-medium text-text-secondary mb-1">Reasoning (why it failed)</p>
                  <div className="bg-amber-50 rounded-lg p-3 text-sm text-amber-800">{selectedResult.reasoning}</div>
                </div>
              )}
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Clock size={12} /> Response time: {selectedResult.latency_ms}ms
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
