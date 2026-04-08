/**
 * TrainingStreamPanel — Real-time training output viewer.
 *
 * Renders like a terminal/Claude Code output — events scroll by as they happen,
 * with color-coded phases, progress bars, and iteration summaries.
 */
import { useEffect, useRef } from "react";
import { X, Loader2, CheckCircle2, XCircle, AlertTriangle, Zap, Shield, Brain, FlaskConical } from "lucide-react";
import { useTrainingStream, type TrainingEvent } from "../lib/use-training-stream";

interface TrainingStreamPanelProps {
  jobId: string | null;
  onClose: () => void;
  /** Called when training finishes with a summary string the meta-agent can review */
  onComplete?: (summary: string) => void;
}

export function TrainingStreamPanel({ jobId, onClose, onComplete }: TrainingStreamPanelProps) {
  const stream = useTrainingStream(jobId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const completeFiredRef = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stream.events.length]);

  // When training finishes, fire onComplete with a summary
  useEffect(() => {
    if (!stream.done || completeFiredRef.current || !onComplete || !jobId) return;
    completeFiredRef.current = true;

    const iterSummaries = stream.iterations.map((iter) =>
      `Iteration ${iter.iteration}: ${iter.passRate !== null ? `${(iter.passRate * 100).toFixed(0)}% pass rate` : "no eval"}, reward ${iter.rewardScore !== null ? `${(iter.rewardScore * 100).toFixed(0)}%` : "—"}${iter.isBest ? " (BEST)" : ""}`
    ).join("\n");

    const summary = `Training job ${jobId.slice(0, 8)} ${stream.finalStatus || "finished"}.\n` +
      `Best score: ${stream.bestScore !== null ? `${(stream.bestScore * 100).toFixed(0)}%` : "—"}\n` +
      `Iterations completed: ${stream.currentIteration}/${stream.maxIterations}\n` +
      (iterSummaries ? `\n${iterSummaries}\n` : "") +
      `\nPlease review these results and tell me what you recommend — should I activate the best version, adjust test cases, or run more iterations?`;

    onComplete(summary);
  }, [stream.done, stream.finalStatus, onComplete, jobId]);

  // Reset the fired ref when jobId changes
  useEffect(() => {
    completeFiredRef.current = false;
  }, [jobId]);

  if (!jobId) return null;

  return (
    <div className="flex flex-col h-full bg-[#0d1117] text-[#e6edf3] font-mono text-xs rounded-lg border border-[#30363d] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#161b22] border-b border-[#30363d]">
        <div className="flex items-center gap-2">
          <FlaskConical size={14} className="text-purple-400" />
          <span className="font-semibold text-[11px]">Training Stream</span>
          <span className="text-[10px] text-[#8b949e]">({jobId.slice(0, 8)})</span>
          {stream.connected && (
            <span className="flex items-center gap-1 text-[10px] text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              Live
            </span>
          )}
          {stream.done && (
            <span className="text-[10px] text-[#8b949e]">
              {stream.finalStatus === "completed" ? "Completed" : stream.finalStatus === "cancelled" ? "Cancelled" : "Done"}
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-[#30363d] transition-colors">
          <X size={14} className="text-[#8b949e]" />
        </button>
      </div>

      {/* Progress Bar */}
      {stream.maxIterations > 0 && (
        <div className="px-3 py-1.5 bg-[#161b22] border-b border-[#30363d]">
          <div className="flex items-center justify-between text-[10px] text-[#8b949e] mb-1">
            <span>{stream.phase}</span>
            <span>{stream.currentIteration}/{stream.maxIterations}</span>
          </div>
          <div className="w-full h-1.5 bg-[#30363d] rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full transition-all duration-500"
              style={{ width: `${(stream.currentIteration / stream.maxIterations) * 100}%` }}
            />
          </div>
          {stream.bestScore !== null && (
            <div className="text-[10px] text-[#8b949e] mt-1">
              Best score: <span className="text-green-400 font-semibold">{(stream.bestScore * 100).toFixed(0)}%</span>
            </div>
          )}
        </div>
      )}

      {/* Event Log */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
        {stream.events.length === 0 && !stream.error && (
          <div className="flex items-center gap-2 text-[#8b949e] py-4">
            <Loader2 size={12} className="animate-spin" />
            <span>Waiting for training events...</span>
          </div>
        )}

        {stream.error && (
          <div className="flex items-center gap-2 text-red-400 py-2">
            <XCircle size={12} />
            <span>Error: {stream.error}</span>
          </div>
        )}

        {stream.events.map((evt, i) => (
          <EventLine key={i} event={evt} />
        ))}

        {/* Iteration Summaries */}
        {stream.iterations.length > 0 && stream.done && (
          <div className="mt-3 pt-3 border-t border-[#30363d]">
            <div className="text-[10px] text-[#8b949e] uppercase tracking-wider mb-2">Iteration Summary</div>
            <div className="space-y-1.5">
              {stream.iterations.map((iter, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="w-5 text-[#8b949e] text-right">#{iter.iteration}</span>
                  <span className={iter.isBest ? "text-green-400 font-semibold" : "text-[#e6edf3]"}>
                    {iter.rewardScore !== null ? `${(iter.rewardScore * 100).toFixed(0)}%` : "—"}
                  </span>
                  <span className="text-[#8b949e]">
                    ({iter.evalTasks.filter(t => t.passed).length}/{iter.evalTasks.length} passed)
                  </span>
                  {iter.isBest && <span className="text-[10px] text-yellow-400">BEST</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Event Line Renderer ────────────────────────────────────────

function n(v: unknown): number { return Number(v ?? 0); }
function s(v: unknown): string { return String(v ?? ""); }

function EventLine({ event: e }: { event: TrainingEvent }) {
  const ts = new Date(e.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  switch (e.type) {
    case "iteration_start":
      return (
        <div className="flex items-center gap-2 text-blue-400 pt-2">
          <span className="text-[#484f58]">{ts}</span>
          <Zap size={11} />
          <span className="font-semibold">Iteration {n(e.iteration)}/{n(e.max_iterations)}</span>
          <span className="text-[#8b949e]">({s(e.algorithm)})</span>
        </div>
      );

    case "eval_task_start":
      return (
        <div className="flex items-center gap-2 text-[#8b949e]">
          <span className="text-[#484f58]">{ts}</span>
          <Loader2 size={10} className="animate-spin text-yellow-400" />
          <span>Eval: {s(e.task_name)}</span>
          <span className="text-[#484f58]">({n(e.task_index) + 1}/{n(e.task_total)})</span>
        </div>
      );

    case "eval_task_complete": {
      const passed = Boolean(e.passed);
      return (
        <div className="flex items-center gap-2">
          <span className="text-[#484f58]">{ts}</span>
          {passed ? (
            <CheckCircle2 size={10} className="text-green-400" />
          ) : (
            <XCircle size={10} className="text-red-400" />
          )}
          <span className={passed ? "text-green-400" : "text-red-400"}>
            {s(e.task_name)}: {passed ? "PASS" : "FAIL"}
          </span>
          <span className="text-[#484f58]">{n(e.latency_ms)}ms</span>
          {e.cost_usd ? <span className="text-[#484f58]">${n(e.cost_usd).toFixed(4)}</span> : null}
        </div>
      );
    }

    case "eval_task_error":
      return (
        <div className="flex items-center gap-2 text-red-400">
          <span className="text-[#484f58]">{ts}</span>
          <XCircle size={10} />
          <span>{s(e.task_name)}: ERROR</span>
          <span className="text-[#484f58] truncate max-w-[200px]">{s(e.error)}</span>
        </div>
      );

    case "eval_complete":
      return (
        <div className="flex items-center gap-2 text-cyan-400 font-semibold">
          <span className="text-[#484f58]">{ts}</span>
          <FlaskConical size={10} />
          <span>Eval: {n(e.passed)}/{n(e.total)} passed ({(n(e.pass_rate) * 100).toFixed(0)}%)</span>
          {e.total_cost_usd ? <span className="text-[#484f58] font-normal">${n(e.total_cost_usd).toFixed(4)}</span> : null}
        </div>
      );

    case "optimizing":
      return (
        <div className="flex items-center gap-2 text-purple-400">
          <span className="text-[#484f58]">{ts}</span>
          <Brain size={10} />
          <span>Optimizing ({s(e.algorithm)})...</span>
          <span className="text-[#484f58]">reward: {(n(e.reward_score) * 100).toFixed(0)}%</span>
        </div>
      );

    case "apo_gradient":
      return (
        <div className="pl-6">
          <div className="flex items-center gap-2 text-purple-300">
            <span className="text-[#484f58]">{ts}</span>
            <span>Gradient critique:</span>
          </div>
          <div className="text-[10px] text-[#8b949e] pl-14 mt-0.5 italic leading-relaxed">
            {s(e.gradient_preview)}
          </div>
        </div>
      );

    case "safety_check":
      return (
        <div className="flex items-center gap-2 text-yellow-400">
          <span className="text-[#484f58]">{ts}</span>
          <Shield size={10} />
          <span>Safety gate: checking {n(e.resources_to_check)} resource(s)</span>
        </div>
      );

    case "iteration_complete":
      return (
        <div className="flex flex-col gap-0.5 pb-1">
          <div className="flex items-center gap-2 text-green-400 font-semibold">
            <span className="text-[#484f58]">{ts}</span>
            <CheckCircle2 size={10} />
            <span>Iteration {n(e.iteration)} done</span>
            <span className="text-[#8b949e] font-normal">reward: {(n(e.reward_score) * 100).toFixed(0)}%</span>
            {Boolean(e.is_best) && <span className="text-yellow-400 text-[10px]">NEW BEST</span>}
          </div>
          {/* Phase 7.6: Multi-dimension optimization indicators */}
          {e.multi_dimension ? (
            <div className="flex items-center gap-2 text-[#58a6ff] text-[10px] ml-[72px]">
              <FlaskConical size={9} />
              <span>Optimizing: {String(e.multi_dimension)}</span>
              {e.temperature_candidate !== undefined && <span>temp={n(e.temperature_candidate)}</span>}
              {e.reasoning_strategy_candidate ? <span>strategy={String(e.reasoning_strategy_candidate)}</span> : null}
            </div>
          ) : null}
          {/* Phase 7.6: Convergence detection */}
          {e.converged ? (
            <div className="flex items-center gap-2 text-yellow-400 text-[10px] ml-[72px]">
              <AlertTriangle size={9} />
              <span>Converged — improvement &lt;1% for 3 iterations. Auto-stopping.</span>
            </div>
          ) : null}
        </div>
      );

    case "training_complete":
      return (
        <div className="flex items-center gap-2 text-green-400 font-bold pt-2">
          <span className="text-[#484f58]">{ts}</span>
          <CheckCircle2 size={12} />
          <span>Training complete!</span>
          <span className="font-normal">Best: {(n(e.best_score) * 100).toFixed(0)}% (iter {n(e.best_iteration)})</span>
        </div>
      );

    case "stream_end":
      return (
        <div className="flex items-center gap-2 text-[#8b949e] pt-1">
          <span className="text-[#484f58]">{ts}</span>
          <AlertTriangle size={10} />
          <span>Stream ended ({s(e.status)})</span>
        </div>
      );

    default:
      return (
        <div className="flex items-center gap-2 text-[#484f58]">
          <span>{ts}</span>
          <span>{e.type}</span>
        </div>
      );
  }
}
