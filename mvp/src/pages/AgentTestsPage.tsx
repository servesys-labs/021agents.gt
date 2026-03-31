import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import {
  Plus, Play, CheckCircle, XCircle, Clock, Trash2, RefreshCw, Loader2,
  Zap, RotateCcw, Shield, TrendingUp, ChevronDown, ChevronRight,
} from "lucide-react";
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
import { ensureArray } from "../lib/ensure-array";

// ── Types ────────────────────────────────────────────────────

interface AgentDetail { name: string; description: string; config_json: Record<string, any>; is_active: boolean; version: number }
interface EvalTask { id: string; name?: string; input: string; expected: string; grader: string; rubric?: string; auto_generated?: boolean }
interface EvalTrial { input: string; expected: string; actual: string; passed: boolean; latency_ms?: number; reasoning?: string }
interface EvalRun { id: string; agent_name: string; created_at: string; status: string; pass_count: number; fail_count: number; total_count: number; trials?: EvalTrial[] }
interface TrainingJob { id: string; job_id?: string; status: string; algorithm: string; current_iteration: number; max_iterations: number; best_score: number; auto_activate: boolean; created_at: string; iterations?: TrainingIteration[] }
interface TrainingIteration { iteration: number; eval_pass_rate: number; reward_score: number; changes: Record<string, unknown>; created_at: string }
interface CircuitBreakerStatus { armed: boolean; minutes_since_activation: number; error_rate_pct: number; rollback_threshold_pct: number; would_rollback: boolean; sessions_since_activation: number }
interface EvolutionSuggestion { area: string; severity: string; suggestion: string; auto_applicable: boolean }

type Tab = "test" | "improve" | "history";

// ── Component ────────────────────────────────────────────────

export default function AgentTestsPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("test");

  // Test scenarios + eval runs
  const [scenarios, setScenarios] = useState<EvalTask[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [running, setRunning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newInput, setNewInput] = useState("");
  const [newExpected, setNewExpected] = useState("");
  const [selectedRun, setSelectedRun] = useState<EvalRun | null>(null);
  const [selectedTrial, setSelectedTrial] = useState<EvalTrial | null>(null);

  // Improve (training + suggestions combined)
  const [improving, setImproving] = useState(false);
  const [trainingJob, setTrainingJob] = useState<TrainingJob | null>(null);
  const [suggestions, setSuggestions] = useState<EvolutionSuggestion[]>([]);

  // History
  const [circuitBreaker, setCircuitBreaker] = useState<CircuitBreakerStatus | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const autoEvalFired = useRef(false); // prevent auto-eval from firing on every page load

  // ── Data Loading ─────────────────────────────────────────

  const fetchData = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [agentData, evalRuns] = await Promise.all([
        api.get<AgentDetail>(`/agents/${agentPathSegment(id)}`),
        api.get<EvalRun[]>(`/eval/runs?agent_name=${encodeURIComponent(id)}`),
      ]);
      setAgent(agentData);
      setRuns(ensureArray<EvalRun>(evalRuns));

      // Load test cases from agent's eval_config
      const evalConfig = agentData.config_json?.eval_config;
      if (evalConfig?.test_cases && Array.isArray(evalConfig.test_cases)) {
        const autoTests: EvalTask[] = evalConfig.test_cases
          .map((tc: any, i: number) => ({
            id: `auto-${i}`, name: tc.name || `test_${i + 1}`,
            input: String(tc.input || ""), expected: String(tc.expected || ""),
            grader: String(tc.grader || "llm_rubric"), rubric: tc.rubric ? String(tc.rubric) : undefined,
            auto_generated: true,
          }))
          .filter((t: EvalTask) => t.input.trim());
        setScenarios((prev) => {
          const existing = new Set(prev.map((s) => s.input));
          return [...autoTests.filter((t) => !existing.has(t.input)), ...prev];
        });
      }

      // Auto-run first eval if agent has auto-generated tests but no eval runs (once per mount)
      const hasAutoTests = evalConfig?.test_cases?.length > 0 && evalConfig?.auto_generated;
      const noRuns = ensureArray<EvalRun>(evalRuns).length === 0;
      if (hasAutoTests && noRuns && !autoEvalFired.current) {
        autoEvalFired.current = true;
        // Fire-and-forget first eval — will show results on next load
        const autoTasks = evalConfig.test_cases
          .filter((tc: any) => String(tc.input || "").trim())
          .map((tc: any) => ({ input: String(tc.input), expected: String(tc.expected || ""), grader: String(tc.grader || "llm_rubric") }));
        if (autoTasks.length > 0) {
          setRunning(true);
          api.post<EvalRun>("/eval/run", { agent_name: id, tasks: autoTasks, trials: 1 })
            .then((result) => {
              setRuns([result]);
              toast(`First eval: ${result.pass_count}/${result.total_count} passed`);
              // Auto-switch to improve tab if score is below 80%
              const rate = result.pass_count / Math.max(result.total_count, 1);
              if (rate < 0.8) setTab("improve");
            })
            .catch(() => {})
            .finally(() => setRunning(false));
        }
      }

      // Load training status
      try {
        const job = await api.get<TrainingJob>(`/training/jobs?agent_name=${encodeURIComponent(id)}&include_iterations=true`);
        setTrainingJob(job);
      } catch { setTrainingJob(null); }

      try {
        const cb = await api.get<CircuitBreakerStatus>(`/training/resources/${encodeURIComponent(id)}/circuit-breaker`);
        setCircuitBreaker(cb);
      } catch { setCircuitBreaker(null); }

    } catch (err: any) {
      if (err.status === 404) setAgent(null);
      else setError(err.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (id) fetchData(); }, [id]);

  const latestRun = runs[0] || null;
  const passRate = latestRun ? Math.round((latestRun.pass_count / Math.max(latestRun.total_count, 1)) * 100) : null;

  // ── Actions ──────────────────────────────────────────────

  const addScenario = () => {
    if (!newInput.trim()) return;
    setScenarios((prev) => [...prev, { id: `task-${Date.now()}`, input: newInput.trim(), expected: newExpected.trim(), grader: "llm_rubric" }]);
    setNewInput(""); setNewExpected(""); setShowAdd(false);
    toast("Test added");
  };

  const runTests = async () => {
    if (scenarios.length === 0 || !id) return;
    setRunning(true);
    try {
      const result = await api.post<EvalRun>("/eval/run", {
        agent_name: id,
        tasks: scenarios.map((s) => ({ input: s.input, expected: s.expected, grader: s.grader })),
        trials: 1,
      });
      const updatedRuns = await api.get<unknown>(`/eval/runs?agent_name=${encodeURIComponent(id)}`);
      setRuns(ensureArray<EvalRun>(updatedRuns));
      toast(`${result.pass_count}/${result.total_count} passed`);
    } catch (err: any) {
      toast(err.message || "Eval failed");
    } finally { setRunning(false); }
  };

  const viewRunDetail = async (run: EvalRun) => {
    try { setSelectedRun(await api.get<EvalRun>(`/eval/runs/${run.id}`)); }
    catch { setSelectedRun(run); }
  };

  /** One-click improve: runs eval → gets suggestions → starts APO training → auto-activates */
  const improveAgent = async () => {
    if (!id || scenarios.length === 0) return;
    setImproving(true);
    setTab("improve");

    // Step 1: Run eval to get baseline
    toast("Step 1/3: Running eval baseline...");
    try {
      const evalResult = await api.post<EvalRun>("/eval/run", {
        agent_name: id,
        tasks: scenarios.map((s) => ({ input: s.input, expected: s.expected, grader: s.grader })),
        trials: 1,
      });
      const updatedRuns = await api.get<unknown>(`/eval/runs?agent_name=${encodeURIComponent(id)}`).catch(() => []);
      setRuns(ensureArray<EvalRun>(updatedRuns));
      toast(`Baseline: ${evalResult.pass_count}/${evalResult.total_count} passed`);
    } catch (err: any) {
      toast(`Eval failed: ${err.message || "Unknown error"}. Fix test scenarios and try again.`);
      setImproving(false);
      return;
    }

    // Step 2: Get suggestions (non-blocking — continue even if this fails)
    toast("Step 2/3: Analyzing results...");
    try {
      const sugRes = await api.post<{ suggestions: EvolutionSuggestion[] }>(`/agents/${agentPathSegment(id)}/evolve`, { auto_apply: false });
      setSuggestions(sugRes.suggestions || []);
    } catch {
      // Analysis is optional — training can proceed without suggestions
    }

    // Step 3: Start training with auto-activate
    toast("Step 3/3: Starting AI training...");
    try {
      const job = await api.post<TrainingJob>("/training/jobs", {
        agent_name: id,
        algorithm: "apo",
        max_iterations: 10,
        auto_activate: true,
      });
      const jobId = job.job_id || job.id;
      if (jobId) {
        await api.post(`/training/jobs/${jobId}/auto-step`, {}).catch(() => {});
      }
      setTrainingJob({ ...job, status: "running" });
      toast("Training started. Your agent will improve automatically.");
    } catch (err: any) {
      toast(`Training unavailable: ${err.message || "Unknown error"}. Eval results and suggestions are still available.`);
    }

    setImproving(false);
  };

  const rollback = async () => {
    if (!id || !window.confirm("Revert to the config before the last improvement?")) return;
    setRollingBack(true);
    try {
      await api.post(`/training/resources/${encodeURIComponent(id)}/rollback`, {});
      toast("Rolled back.");
      fetchData();
    } catch (err: any) { toast(err.message || "Rollback failed"); }
    finally { setRollingBack(false); }
  };

  // ── Render ───────────────────────────────────────────────

  if (loading) return <div className="flex items-center justify-center py-20"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (error) return <div className="text-center py-20"><p className="text-text-secondary text-sm mb-4">{error}</p><Button variant="secondary" onClick={fetchData}><RefreshCw size={14} /> Retry</Button></div>;
  if (!agent) return <AgentNotFound />;

  return (
    <div>
      <AgentNav agentName={agent.name} />

      {/* Score summary banner */}
      {passRate !== null && (
        <div className={`flex items-center gap-4 p-4 rounded-xl mb-6 ${passRate >= 80 ? "bg-success-light border border-success" : passRate >= 50 ? "bg-warning-light border border-warning" : "bg-danger-light border border-danger"}`}>
          <div className={`text-3xl font-bold ${passRate >= 80 ? "text-success" : passRate >= 50 ? "text-warning-dark" : "text-danger"}`}>{passRate}%</div>
          <div className="flex-1">
            <p className="text-sm font-medium text-text">Last eval: {latestRun!.pass_count}/{latestRun!.total_count} passed</p>
            <p className="text-xs text-text-muted">{new Date(latestRun!.created_at).toLocaleString()}</p>
          </div>
          <Button size="sm" onClick={() => improveAgent()} disabled={improving || scenarios.length === 0}>
            {improving ? <><Loader2 size={14} className="animate-spin" /> Improving...</> : <><Zap size={14} /> Improve Agent</>}
          </Button>
        </div>
      )}

      {/* 3 tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        {([
          { key: "test" as Tab, label: "Test", count: scenarios.length },
          { key: "improve" as Tab, label: "Improve" },
          { key: "history" as Tab, label: "History", count: runs.length },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t.key ? "border-primary text-primary" : "border-transparent text-text-secondary"}`}
          >
            {t.label}
            {t.count !== undefined && <span className="ml-1.5 text-xs text-text-muted">({t.count})</span>}
            {t.key === "improve" && trainingJob?.status === "running" && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-success-light text-success animate-pulse">live</span>
            )}
          </button>
        ))}
      </div>

      {/* ═══════════════ TAB: TEST ═══════════════ */}
      {tab === "test" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-secondary">Test scenarios define what your agent should handle. Run them to measure quality.</p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add Test</Button>
              <Button size="sm" onClick={runTests} disabled={running || scenarios.length === 0}>
                {running ? <><Loader2 size={14} className="animate-spin" /> Running...</> : <><Play size={14} /> Run All</>}
              </Button>
            </div>
          </div>

          {scenarios.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-sm text-text-secondary mb-3">No test scenarios yet.</p>
              <p className="text-xs text-text-muted mb-4">Add tests to measure and improve your agent's quality.</p>
              <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} /> Add First Test</Button>
            </Card>
          ) : (
            <div className="space-y-2">
              {scenarios.map((s) => (
                <Card key={s.id} className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text font-medium truncate">{s.input}</p>
                      {s.expected && <p className="text-xs text-text-muted mt-0.5 truncate">Expected: {s.expected}</p>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {s.auto_generated && <Badge variant="default" className="text-[10px]">auto</Badge>}
                      <button onClick={() => setScenarios((prev) => prev.filter((x) => x.id !== s.id))} className="p-1 text-text-muted hover:text-danger"><Trash2 size={12} /></button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: IMPROVE ═══════════════ */}
      {tab === "improve" && (
        <div className="space-y-6">
          {/* Training status */}
          {trainingJob ? (
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Zap size={16} className={trainingJob.status === "running" ? "text-primary animate-pulse" : "text-text-muted"} />
                  <h3 className="text-sm font-semibold text-text">
                    {trainingJob.status === "running" ? "Improving your agent..." : trainingJob.status === "completed" ? "Improvement complete" : `Training ${trainingJob.status}`}
                  </h3>
                  <Badge variant={trainingJob.status === "running" ? "info" : trainingJob.status === "completed" ? "success" : "default"}>
                    {trainingJob.status}
                  </Badge>
                </div>
                <Button size="sm" variant="secondary" onClick={fetchData}><RefreshCw size={12} /></Button>
              </div>

              {/* Progress bar */}
              <div className="mb-4">
                <div className="flex justify-between text-xs text-text-muted mb-1">
                  <span>Iteration {trainingJob.current_iteration}/{trainingJob.max_iterations}</span>
                  <span>Best: {(trainingJob.best_score * 100).toFixed(1)}%</span>
                </div>
                <div className="h-3 bg-surface-alt rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${trainingJob.status === "running" ? "bg-primary animate-pulse" : "bg-success"}`}
                    style={{ width: `${Math.round((trainingJob.current_iteration / Math.max(trainingJob.max_iterations, 1)) * 100)}%` }}
                  />
                </div>
              </div>

              {/* Iteration scores */}
              {trainingJob.iterations && trainingJob.iterations.length > 0 && (
                <div className="space-y-1.5">
                  {trainingJob.iterations.map((it) => (
                    <div key={it.iteration} className="flex items-center gap-3 text-xs">
                      <span className="w-5 text-text-muted text-right">#{it.iteration}</span>
                      <div className="flex-1 h-2 bg-surface-alt rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${it.reward_score > 0.7 ? "bg-success" : it.reward_score > 0.4 ? "bg-warning-dark" : "bg-danger"}`} style={{ width: `${Math.round(it.reward_score * 100)}%` }} />
                      </div>
                      <span className="w-10 text-right font-medium text-text">{(it.reward_score * 100).toFixed(0)}%</span>
                      <span className="text-text-muted">eval {(it.eval_pass_rate * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Completed message */}
              {trainingJob.status === "completed" && (
                <div className="mt-4 p-3 bg-success-light rounded-lg text-sm text-success">
                  <CheckCircle size={14} className="inline mr-1.5" />
                  Training complete. {trainingJob.auto_activate
                    ? "Best config has been automatically activated."
                    : "Review the results and activate when ready."}
                </div>
              )}
            </Card>
          ) : (
            /* No training — show the one-click improve CTA */
            <Card className="p-8 text-center">
              <Zap size={24} className="text-primary mx-auto mb-3" />
              <h3 className="text-lg font-semibold text-text mb-1">Improve your agent with AI</h3>
              <p className="text-sm text-text-secondary mb-4 max-w-md mx-auto">
                One click runs your test suite, analyzes failures, and uses AI to optimize your agent's prompt,
                reasoning strategy, and tool selection. Changes are auto-applied with a safety net.
              </p>
              <Button onClick={improveAgent} disabled={improving || scenarios.length === 0} className="mx-auto">
                {improving ? <><Loader2 size={14} className="animate-spin" /> Improving...</> : <><Zap size={14} /> Improve Agent</>}
              </Button>
              {scenarios.length === 0 && (
                <p className="text-xs text-warning-dark mt-3">Add test scenarios first in the Test tab.</p>
              )}

              <div className="flex items-center justify-center gap-6 mt-6 text-xs text-text-muted">
                <span className="flex items-center gap-1"><Shield size={10} /> Safety gates</span>
                <span className="flex items-center gap-1"><RotateCcw size={10} /> Auto-rollback</span>
                <span className="flex items-center gap-1"><TrendingUp size={10} /> 10 iterations</span>
              </div>
            </Card>
          )}

          {/* Suggestions from evolution analyzer */}
          {suggestions.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-text mb-2">Analysis Findings</h4>
              <div className="space-y-2">
                {suggestions.map((sug, i) => (
                  <Card key={i} className="p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={sug.severity === "high" ? "danger" : sug.severity === "medium" ? "warning" : "default"} className="text-[10px]">{sug.severity}</Badge>
                      <span className="text-xs font-medium text-text capitalize">{sug.area}</span>
                      {sug.auto_applicable && <Badge variant="success" className="text-[10px]">auto-fixable</Badge>}
                    </div>
                    <p className="text-sm text-text-secondary">{sug.suggestion}</p>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: HISTORY ═══════════════ */}
      {tab === "history" && (
        <div className="space-y-4">
          {/* Circuit breaker */}
          {circuitBreaker?.armed && (
            <Card className="p-3 border-warning bg-warning-light">
              <div className="flex items-center gap-2 text-xs">
                <Shield size={14} className="text-warning-dark" />
                <span className="font-medium">Circuit breaker armed</span>
                <span className="text-text-secondary">
                  {circuitBreaker.minutes_since_activation}min since activation |
                  {circuitBreaker.error_rate_pct}% errors |
                  {circuitBreaker.sessions_since_activation} sessions
                </span>
                {circuitBreaker.would_rollback && <Badge variant="danger">ROLLBACK TRIGGERED</Badge>}
                <Button size="sm" variant="danger" onClick={rollback} disabled={rollingBack} className="ml-auto">
                  {rollingBack ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Rollback
                </Button>
              </div>
            </Card>
          )}

          {/* Past eval runs */}
          {runs.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-sm text-text-secondary">No eval history yet. Run tests to start building history.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => {
                const rate = Math.round((run.pass_count / Math.max(run.total_count, 1)) * 100);
                return (
                  <Card key={run.id} className="p-3 cursor-pointer hover:border-border transition-colors" onClick={() => viewRunDetail(run)}>
                    <div className="flex items-center gap-4">
                      <div className={`text-lg font-bold w-12 text-center ${rate >= 80 ? "text-success" : rate >= 50 ? "text-warning-dark" : "text-danger"}`}>{rate}%</div>
                      <div className="flex-1">
                        <p className="text-sm text-text">{run.pass_count}/{run.total_count} passed</p>
                        <p className="text-xs text-text-muted">{new Date(run.created_at).toLocaleString()}</p>
                      </div>
                      <Badge variant={run.status === "completed" ? "success" : "info"}>{run.status}</Badge>
                      <ChevronRight size={14} className="text-text-muted" />
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Rollback button (always available) */}
          <Button variant="secondary" size="sm" onClick={rollback} disabled={rollingBack}>
            <RotateCcw size={12} /> Revert to Previous Config
          </Button>
        </div>
      )}

      {/* ═══════════════ MODALS ═══════════════ */}

      {/* Add test modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Test Scenario">
        <div className="space-y-4 p-1">
          <Textarea label="User input" placeholder="What would a user ask?" value={newInput} onChange={(e) => setNewInput(e.target.value)} rows={3} />
          <Textarea label="Expected behavior (optional)" placeholder="What should the agent do or say?" value={newExpected} onChange={(e) => setNewExpected(e.target.value)} rows={2} />
          <Button onClick={addScenario} disabled={!newInput.trim()}>Add Test</Button>
        </div>
      </Modal>

      {/* Run detail modal */}
      <Modal open={!!selectedRun} onClose={() => { setSelectedRun(null); setSelectedTrial(null); }} title="Eval Run Detail" wide>
        {selectedRun && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-text">{Math.round((selectedRun.pass_count / Math.max(selectedRun.total_count, 1)) * 100)}%</span>
              <div>
                <p className="text-sm text-text">{selectedRun.pass_count} passed, {selectedRun.fail_count} failed</p>
                <p className="text-xs text-text-muted">{new Date(selectedRun.created_at).toLocaleString()}</p>
              </div>
            </div>

            {selectedRun.trials && (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {selectedRun.trials.map((trial, i) => (
                  <button key={i} onClick={() => setSelectedTrial(trial)} className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors hover:border-border ${trial.passed ? "border-success bg-success-light/50" : "border-danger bg-danger-light/50"}`}>
                    {trial.passed ? <CheckCircle size={14} className="text-success shrink-0" /> : <XCircle size={14} className="text-danger shrink-0" />}
                    <span className="text-sm text-text truncate flex-1">{trial.input}</span>
                    {trial.latency_ms && <span className="text-xs text-text-muted shrink-0"><Clock size={10} className="inline mr-0.5" />{trial.latency_ms}ms</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Trial detail modal */}
      <Modal open={!!selectedTrial} onClose={() => setSelectedTrial(null)} title={selectedTrial?.passed ? "Passed" : "Failed"}>
        {selectedTrial && (
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
              <p className="text-xs font-medium text-text-secondary mb-1">Actual</p>
              <div className={`rounded-lg p-3 text-sm ${selectedTrial.passed ? "bg-success-light text-text" : "bg-danger-light text-text"}`}>{selectedTrial.actual}</div>
            </div>
            {selectedTrial.reasoning && (
              <div>
                <p className="text-xs font-medium text-text-secondary mb-1">Reasoning</p>
                <div className="bg-warning-light rounded-lg p-3 text-sm text-warning-dark">{selectedTrial.reasoning}</div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
