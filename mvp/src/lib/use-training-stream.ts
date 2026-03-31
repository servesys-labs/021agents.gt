/**
 * useTrainingStream — SSE streaming hook for training job progress.
 *
 * Connects to GET /training/jobs/{job_id}/stream and parses training events:
 * iteration_start, eval_task_start, eval_task_complete, eval_task_error,
 * eval_complete, optimizing, apo_gradient, safety_check, iteration_complete,
 * training_complete, stream_end.
 *
 * Returns structured state that TrainingStreamPanel renders in real-time.
 */
import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = (globalThis as any).__VITE_API_URL ?? "https://api.oneshots.co/api/v1";

// ── Event Types ──────────────────────────────────────────────

export interface TrainingEvent {
  type: string;
  ts: number;
  job_id: string;
  agent_name: string;
  iteration?: number;
  [key: string]: unknown;
}

export interface TrainingStreamState {
  /** All events received so far */
  events: TrainingEvent[];
  /** Whether the SSE connection is active */
  connected: boolean;
  /** Whether training has finished (completed/cancelled/failed) */
  done: boolean;
  /** Final status if done */
  finalStatus?: string;
  /** Current iteration number */
  currentIteration: number;
  /** Max iterations from the job */
  maxIterations: number;
  /** Best score seen so far */
  bestScore: number | null;
  /** Current phase label */
  phase: string;
  /** Per-iteration summaries */
  iterations: IterationSummary[];
  /** Error message if connection fails */
  error?: string;
}

export interface IterationSummary {
  iteration: number;
  passRate: number | null;
  rewardScore: number | null;
  isBest: boolean;
  evalTasks: { name: string; passed: boolean; latencyMs: number }[];
  gradient?: string;
}

// ── Hook ─────────────────────────────────────────────────────

export function useTrainingStream(jobId: string | null) {
  const [state, setState] = useState<TrainingStreamState>({
    events: [],
    connected: false,
    done: false,
    currentIteration: 0,
    maxIterations: 0,
    bestScore: null,
    phase: "Waiting...",
    iterations: [],
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const currentIterRef = useRef<IterationSummary | null>(null);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState(s => ({ ...s, connected: false }));
  }, []);

  useEffect(() => {
    if (!jobId) {
      disconnect();
      return;
    }

    // Reset state for new job
    setState({
      events: [],
      connected: false,
      done: false,
      currentIteration: 0,
      maxIterations: 0,
      bestScore: null,
      phase: "Connecting...",
      iterations: [],
    });
    currentIterRef.current = null;

    const token = localStorage.getItem("agentos_token") || localStorage.getItem("token");
    const baseUrl = `${API_BASE}/training/jobs/${jobId}/stream`;

    let cancelled = false;
    const abortController = new AbortController();
    let lastTs = 0;

    async function connect(retryCount = 0) {
      if (cancelled) return;
      const MAX_RETRIES = 3;

      try {
        const url = lastTs ? `${baseUrl}?since=${lastTs}` : baseUrl;
        const resp = await fetch(url, {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            Accept: "text/event-stream",
          },
          signal: abortController.signal,
        });

        if (!resp.ok || !resp.body) {
          setState(s => ({ ...s, error: `HTTP ${resp.status}`, phase: "Connection failed" }));
          return;
        }

        setState(s => ({ ...s, connected: true, phase: "Connected", error: undefined }));

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (!cancelled) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const evt = JSON.parse(line.slice(6)) as TrainingEvent;
                  if (typeof evt.ts === "number" && evt.ts > lastTs) lastTs = evt.ts;
                  // Handle stream_timeout — reconnect with ?since=
                  if (evt.type === "stream_timeout") {
                    reader.releaseLock();
                    if (!cancelled) await connect(0);
                    return;
                  }
                  processEvent(evt);
                } catch { /* skip malformed */ }
              }
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* already released */ }
        }

        setState(s => ({ ...s, connected: false, done: true }));
      } catch (err: any) {
        if (err.name === "AbortError" || cancelled) return;
        // Retry on transient errors
        if (retryCount < MAX_RETRIES && !cancelled) {
          setState(s => ({ ...s, phase: `Reconnecting (${retryCount + 1}/${MAX_RETRIES})...` }));
          await new Promise(r => setTimeout(r, 2000 * (retryCount + 1)));
          return connect(retryCount + 1);
        }
        setState(s => ({ ...s, error: err.message, connected: false, phase: "Disconnected" }));
      }
    }

    function processEvent(evt: TrainingEvent) {
      setState(prev => {
        const MAX_EVENTS = 500;
        const events = [...prev.events, evt].slice(-MAX_EVENTS);
        let { currentIteration, maxIterations, bestScore, phase, iterations, done, finalStatus } = prev;

        switch (evt.type) {
          case "iteration_start":
            currentIteration = evt.iteration ?? currentIteration;
            maxIterations = (evt.max_iterations as number) ?? maxIterations;
            phase = `Iteration ${currentIteration}/${maxIterations} — Starting`;
            currentIterRef.current = {
              iteration: currentIteration,
              passRate: null,
              rewardScore: null,
              isBest: false,
              evalTasks: [],
            };
            break;

          case "eval_task_start":
            phase = `Iteration ${currentIteration}/${maxIterations} — Eval: ${evt.task_name} (${(evt.task_index as number) + 1}/${evt.task_total})`;
            break;

          case "eval_task_complete":
            phase = `Iteration ${currentIteration}/${maxIterations} — Eval: ${evt.task_name} ${evt.passed ? "PASS" : "FAIL"}`;
            if (currentIterRef.current) {
              currentIterRef.current.evalTasks.push({
                name: String(evt.task_name),
                passed: evt.passed as boolean,
                latencyMs: evt.latency_ms as number,
              });
            }
            break;

          case "eval_task_error":
            phase = `Iteration ${currentIteration}/${maxIterations} — Eval: ${evt.task_name} ERROR`;
            if (currentIterRef.current) {
              currentIterRef.current.evalTasks.push({
                name: String(evt.task_name),
                passed: false,
                latencyMs: evt.latency_ms as number,
              });
            }
            break;

          case "eval_complete":
            phase = `Iteration ${currentIteration}/${maxIterations} — Eval done: ${evt.passed}/${evt.total} passed (${((evt.pass_rate as number) * 100).toFixed(0)}%)`;
            if (currentIterRef.current) {
              currentIterRef.current.passRate = evt.pass_rate as number;
            }
            break;

          case "optimizing":
            phase = `Iteration ${currentIteration}/${maxIterations} — Optimizing (${evt.algorithm})`;
            break;

          case "apo_gradient":
            phase = `Iteration ${currentIteration}/${maxIterations} — APO: generating improved prompt`;
            if (currentIterRef.current) {
              currentIterRef.current.gradient = evt.gradient_preview as string;
            }
            break;

          case "safety_check":
            phase = `Iteration ${currentIteration}/${maxIterations} — Safety check`;
            break;

          case "iteration_complete":
            phase = `Iteration ${currentIteration}/${maxIterations} — Done (reward: ${((evt.reward_score as number) * 100).toFixed(0)}%)`;
            if (currentIterRef.current) {
              currentIterRef.current.rewardScore = evt.reward_score as number;
              currentIterRef.current.isBest = evt.is_best as boolean;
              iterations = [...iterations, { ...currentIterRef.current }];
            }
            if (evt.is_best) bestScore = evt.reward_score as number;
            break;

          case "training_complete":
            phase = `Training complete — best: ${((evt.best_score as number) * 100).toFixed(0)}% (iteration ${evt.best_iteration})`;
            bestScore = evt.best_score as number;
            if (currentIterRef.current) {
              currentIterRef.current.rewardScore = evt.reward_score as number;
              currentIterRef.current.isBest = evt.is_best as boolean;
              iterations = [...iterations, { ...currentIterRef.current }];
            }
            done = true;
            finalStatus = "completed";
            break;

          case "stream_end":
            done = true;
            finalStatus = evt.status as string;
            if (finalStatus === "cancelled") phase = "Training cancelled";
            else if (finalStatus === "failed") phase = "Training failed";
            break;
        }

        return { ...prev, events, currentIteration, maxIterations, bestScore, phase, iterations, done, finalStatus };
      });
    }

    connect();

    return () => {
      cancelled = true;
      abortController.abort();
      disconnect();
    };
  }, [jobId, disconnect]);

  return { ...state, disconnect };
}
