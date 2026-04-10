/**
 * Test run store — drives the pipeline overlay, step inspector, and live stats.
 *
 * Maps live streamAgent() events to six abstract pipeline steps that reflect
 * the edge runtime execution:
 *
 *   Setup → Governance → LLM → Tools → Result → Record
 *
 * These aren't literal stages in the backend code — they're a narrative view
 * of what the durable Workflow is doing, driven by the event stream.
 */

import { streamAgent, type ChatEvent } from "$lib/services/chat";
import { listSessions, getSessionTurns, type Session } from "$lib/services/sessions";

export type RunStatus =
  | "idle"
  | "composing"
  | "running"
  | "complete"
  | "failed"
  | "resumed";

export type StepId =
  | "setup"
  | "governance"
  | "llm"
  | "tools"
  | "result"
  | "record";

export type StepStatus = "pending" | "running" | "done" | "failed" | "resumed";

export interface StepState {
  id: StepId;
  label: string;
  status: StepStatus;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  detail: string | null;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  argsPreview: string;
  result: string | null;
  latencyMs: number | null;
  status: "running" | "done" | "failed";
  startedAt: number;
}

export interface RunTotals {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
}

const STEP_ORDER: StepId[] = [
  "setup",
  "governance",
  "llm",
  "tools",
  "result",
  "record",
];

const STEP_LABELS: Record<StepId, string> = {
  setup: "Setup",
  governance: "Governance",
  llm: "LLM",
  tools: "Tools",
  result: "Result",
  record: "Record",
};

function newSteps(): StepState[] {
  return STEP_ORDER.map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    detail: null,
  }));
}

export function createTestRunStore() {
  let status = $state<RunStatus>("idle");
  let sessionId = $state<string | null>(null);
  let currentStepId = $state<StepId | null>(null);
  let steps = $state<StepState[]>(newSteps());
  let events = $state<ChatEvent[]>([]);
  let toolCalls = $state<ToolCallRecord[]>([]);
  let totals = $state<RunTotals>({
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    durationMs: 0,
  });
  let tokenBuffer = $state<string>("");
  let modelUsed = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  let resumed = $state(false); // true if any step got resumed from checkpoint
  let runStartedAt = $state<number | null>(null);
  let recentSessions = $state<Session[]>([]);
  let inspectorStepId = $state<StepId | null>(null);

  // Composing drawer
  let composing = $state(false);
  let draftMessage = $state("");
  let selectedSessionIdForRun = $state<string | null>(null); // null = new session

  // Active stream abort handle
  let abortHandle: { abort: () => void } | null = null;

  function setStep(id: StepId, patch: Partial<StepState>) {
    steps = steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  function startStep(id: StepId, detail: string | null = null) {
    const now = Date.now();
    currentStepId = id;
    setStep(id, { status: "running", startedAt: now, detail });
  }

  function completeStep(id: StepId, detail: string | null = null) {
    const now = Date.now();
    const s = steps.find((x) => x.id === id);
    if (!s) return;
    const durationMs = s.startedAt ? now - s.startedAt : null;
    setStep(id, {
      status: "done",
      endedAt: now,
      durationMs,
      detail: detail ?? s.detail,
    });
  }

  function failStep(id: StepId, message: string) {
    const now = Date.now();
    const s = steps.find((x) => x.id === id);
    const durationMs = s?.startedAt ? now - s.startedAt : null;
    setStep(id, {
      status: "failed",
      endedAt: now,
      durationMs,
      detail: message,
    });
  }

  function reset() {
    steps = newSteps();
    events = [];
    toolCalls = [];
    totals = {
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 0,
    };
    tokenBuffer = "";
    modelUsed = null;
    errorMessage = null;
    resumed = false;
    currentStepId = null;
    runStartedAt = null;
    inspectorStepId = null;
  }

  function stop() {
    if (abortHandle) {
      abortHandle.abort();
      abortHandle = null;
    }
    if (status === "running") {
      status = "failed";
      if (currentStepId) {
        failStep(currentStepId, "Cancelled by user");
      }
    }
  }

  async function start(agentName: string, message: string, plan?: string) {
    reset();
    status = "running";
    runStartedAt = Date.now();
    composing = false;
    draftMessage = "";

    // Kick off Setup immediately. The real setup_done event from the backend
    // will overwrite this with the true timing + detail. If the backend is
    // old and never sends setup_done, we'll still look correct because the
    // step will stay in "running" until the first turn_start arrives.
    startStep("setup", "Loading config, memory, tools");

    const handleEvent = (ev: ChatEvent) => {
      events = [...events, ev];

      switch (ev.type) {
        case "session_start": {
          // Captures the real session ID as early as possible so the UI
          // can show it in the header before the first turn begins.
          const d = ev.data as { session_id?: string };
          if (d.session_id) sessionId = d.session_id;
          break;
        }
        case "setup_done": {
          // Backend signals Setup phase complete. Completing the step with
          // the real duration is a small but visible win — the UI pipeline
          // now shows an accurate "setup: 840ms" instead of "0ms".
          const d = ev.data as {
            duration_ms?: number;
            model?: string;
            plan?: string;
            tool_count?: number;
            system_prompt_tokens?: number;
            rls_enforced?: boolean;
          };
          if (d.model) modelUsed = d.model;
          const detailBits: string[] = [];
          if (d.model) detailBits.push(d.model);
          if (d.tool_count != null) detailBits.push(`${d.tool_count} tools`);
          if (d.rls_enforced) detailBits.push("RLS on");
          // Override startedAt so the real duration is used, not the client-side time
          setStep("setup", {
            startedAt: runStartedAt ?? Date.now(),
            status: "done",
            endedAt: Date.now(),
            durationMs: d.duration_ms ?? null,
            detail: detailBits.join(" · "),
          });
          // Governance becomes the active step — will complete on governance_pass
          if (!steps.find((s) => s.id === "governance" || s.status === "running")) {
            startStep("governance", "Running guards");
          } else {
            startStep("governance", "Running guards");
          }
          break;
        }
        case "governance_pass": {
          // Backend reports which guards ran and the duration. Completing
          // the Governance step with real guard data powers the StepInspector.
          const d = ev.data as {
            duration_ms?: number;
            guards?: Array<{ name: string; passed: boolean; detail?: string }>;
          };
          const passed = (d.guards || []).filter((g) => g.passed).length;
          const total = (d.guards || []).length;
          setStep("governance", {
            status: "done",
            endedAt: Date.now(),
            durationMs: d.duration_ms ?? null,
            detail: `${passed}/${total} guards passed`,
          });
          // LLM now becomes the active step
          startStep("llm", "Waiting for model");
          break;
        }
        case "checkpoint_resumed": {
          // Durability flex: Worker restarted, Workflow resumed from its
          // last checkpoint. Mark the affected step with the amber resumed
          // state so the UI highlights it, and flip the top-level status.
          const d = ev.data as {
            resumed_at?: string;
            turn?: number;
            recovered_cost_usd?: number;
          };
          resumed = true;
          const targetId = (d.resumed_at as StepId) || "llm";
          setStep(targetId, {
            status: "resumed",
            detail: `Recovered from turn ${d.turn ?? "?"} · ${
              d.recovered_cost_usd != null
                ? `$${d.recovered_cost_usd.toFixed(4)}`
                : "checkpoint"
            }`,
          });
          if (d.recovered_cost_usd != null) {
            totals = { ...totals, costUsd: d.recovered_cost_usd };
          }
          if (d.turn != null) {
            totals = { ...totals, turns: d.turn };
          }
          break;
        }
        case "turn_start": {
          const d = ev.data as { turn?: number; model?: string };
          totals = { ...totals, turns: Math.max(totals.turns, d.turn ?? 1) };
          if (d.model) {
            modelUsed = d.model;
            setStep("llm", { detail: d.model });
          }
          // If we get here without seeing setup_done/governance_pass (old
          // backend), complete them now so the pipeline still makes sense.
          for (const id of ["setup", "governance"] as StepId[]) {
            const s = steps.find((x) => x.id === id);
            if (s && s.status === "running") {
              completeStep(id);
            }
          }
          // Ensure LLM is the running step
          if (steps.find((s) => s.id === "llm")?.status !== "running") {
            startStep("llm", d.model ?? "thinking");
          }
          break;
        }
        case "thinking": {
          // Model is reasoning — keep LLM in running state
          if (currentStepId !== "llm") {
            startStep("llm", modelUsed ?? "thinking");
          }
          break;
        }
        case "token": {
          const d = ev.data as { content?: string };
          if (d.content) {
            tokenBuffer = tokenBuffer + d.content;
          }
          break;
        }
        case "tool_call": {
          // LLM finished for this turn, Tools step now runs
          if (steps.find((s) => s.id === "llm")?.status === "running") {
            completeStep("llm", modelUsed ?? undefined);
          }
          if (steps.find((s) => s.id === "tools")?.status !== "running") {
            startStep("tools", "Calling tools");
          }
          const d = ev.data as {
            name?: string;
            tool_call_id?: string;
            args_preview?: string;
          };
          const rec: ToolCallRecord = {
            id: d.tool_call_id ?? `tc-${toolCalls.length + 1}`,
            name: d.name ?? "tool",
            argsPreview: d.args_preview ?? "",
            result: null,
            latencyMs: null,
            status: "running",
            startedAt: Date.now(),
          };
          toolCalls = [...toolCalls, rec];
          // Compute the new count once, use it for both the totals update
          // and the step detail string. The previous version read
          // totals.toolCalls AFTER incrementing it AND added another +1,
          // producing an off-by-two count in the step detail.
          const newToolCount = totals.toolCalls + 1;
          totals = { ...totals, toolCalls: newToolCount };
          setStep("tools", {
            detail: `${newToolCount} call${newToolCount === 1 ? "" : "s"} · ${rec.name}`,
          });
          break;
        }
        case "tool_result": {
          const d = ev.data as {
            name?: string;
            tool_call_id?: string;
            result?: string;
            latency_ms?: number;
          };
          toolCalls = toolCalls.map((t) =>
            t.id === d.tool_call_id || (t.status === "running" && t.name === d.name)
              ? {
                  ...t,
                  result: d.result ?? null,
                  latencyMs: d.latency_ms ?? null,
                  status: "done",
                }
              : t,
          );
          break;
        }
        case "turn_end": {
          // One turn finished. If there are more turns, LLM will start again
          // via next turn_start. If this was the last turn, "done" will fire.
          const d = ev.data as {
            tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
            cost_usd?: number;
          };
          // Per-turn token accumulation — new fields from the updated protocol.
          // Older backends only send `tokens` (total); we split evenly as a
          // conservative fallback so the UI still shows non-zero counts.
          if (d.input_tokens != null || d.output_tokens != null) {
            totals = {
              ...totals,
              tokensIn: totals.tokensIn + (d.input_tokens ?? 0),
              tokensOut: totals.tokensOut + (d.output_tokens ?? 0),
            };
          } else if (d.tokens != null) {
            const half = Math.floor(d.tokens / 2);
            totals = {
              ...totals,
              tokensIn: totals.tokensIn + half,
              tokensOut: totals.tokensOut + (d.tokens - half),
            };
          }
          if (d.cost_usd != null) {
            totals = { ...totals, costUsd: totals.costUsd + d.cost_usd };
          }
          if (steps.find((s) => s.id === "tools")?.status === "running") {
            completeStep("tools", `${totals.toolCalls} calls`);
          }
          break;
        }
        case "done": {
          const d = ev.data as {
            output?: string;
            cost_usd?: number;
            session_id?: string;
            turns?: number;
            tool_calls?: number;
            input_tokens?: number;
            output_tokens?: number;
          };
          if (d.session_id) sessionId = d.session_id;
          if (d.cost_usd != null) totals = { ...totals, costUsd: d.cost_usd };
          if (d.turns != null) totals = { ...totals, turns: d.turns };
          if (d.tool_calls != null)
            totals = { ...totals, toolCalls: d.tool_calls };
          // Token counts from done — patch if streaming events didn't deliver them.
          // Some runtimes only emit totals at the end (KV poll race or workflow restart)
          // so we trust the done values when our running totals are zero.
          if (d.input_tokens != null && totals.tokensIn === 0) {
            totals = { ...totals, tokensIn: d.input_tokens };
          }
          if (d.output_tokens != null && totals.tokensOut === 0) {
            totals = { ...totals, tokensOut: d.output_tokens };
          }

          // ── Defensive reconciliation: synthesize missing tool call records ──
          // Per-call tool_call/tool_result events sometimes don't reach the
          // frontend (KV consistency lag, SSE chunk drops, workflow buffer
          // resets on retry). The done event reports an authoritative
          // tool_calls count from the workflow's accumulator. If our local
          // toolCalls array is shorter than that count, fill in placeholder
          // records so the inspector and Tools step reflect what actually
          // happened — even if we lost the per-call detail.
          const reportedToolCalls = d.tool_calls ?? 0;
          if (reportedToolCalls > toolCalls.length) {
            const missing = reportedToolCalls - toolCalls.length;
            console.warn(
              `[test-run] Reconciling ${missing} tool call(s) — per-call events were not delivered. ` +
              `Will attempt to fetch detail from /sessions/${sessionId}/turns.`,
            );
            const synthesized: ToolCallRecord[] = [];
            for (let i = 0; i < missing; i++) {
              synthesized.push({
                id: `synth-${toolCalls.length + i + 1}`,
                name: "tool",
                argsPreview: "(detail not delivered via stream)",
                result: null,
                latencyMs: null,
                status: "done",
                startedAt: Date.now(),
              });
            }
            toolCalls = [...toolCalls, ...synthesized];
          }

          // Mark the Tools step as done if any tool calls happened, even
          // if we never saw the per-call events to start it.
          if (reportedToolCalls > 0) {
            const toolsStep = steps.find((s) => s.id === "tools");
            if (toolsStep && toolsStep.status !== "done") {
              setStep("tools", {
                status: "done",
                startedAt: toolsStep.startedAt ?? Date.now(),
                endedAt: Date.now(),
                durationMs:
                  toolsStep.startedAt != null
                    ? Date.now() - toolsStep.startedAt
                    : null,
                detail: `${reportedToolCalls} call${reportedToolCalls === 1 ? "" : "s"}`,
              });
            }
          }

          // Complete whatever's still running
          for (const s of steps) {
            if (s.status === "running") completeStep(s.id);
          }

          // Result step — assembles final output
          startStep("result", d.output ? "Output assembled" : "");
          completeStep("result", d.output ? "Output assembled" : "");

          // Record step — durability close-out
          startStep("record", "Writing billing_records, events, telemetry");
          completeStep("record", "Persisted to Supabase + KV");

          const endedAt = Date.now();
          totals = {
            ...totals,
            durationMs: runStartedAt ? endedAt - runStartedAt : 0,
          };
          status = resumed ? "resumed" : "complete";
          currentStepId = null;
          abortHandle = null;

          // Best-effort: pull authoritative turn detail from the persisted
          // session record. This populates the Tools inspector with real
          // tool names and results when per-call streaming was lossy.
          // Runs in background — failures are silent.
          if (sessionId && reportedToolCalls > toolCalls.length - reportedToolCalls) {
            void hydrateFromSessionTurns(sessionId);
          }
          break;
        }
        case "error": {
          const d = ev.data as { message?: string };
          errorMessage = d.message ?? "Unknown error";
          if (currentStepId) failStep(currentStepId, errorMessage);
          status = "failed";
          abortHandle = null;
          break;
        }
      }
    };

    try {
      abortHandle = streamAgent(
        agentName,
        message,
        handleEvent,
        selectedSessionIdForRun ?? undefined,
        plan,
      );
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : "Failed to start stream";
      if (currentStepId) failStep(currentStepId, errorMessage);
      status = "failed";
      abortHandle = null;
    }
  }

  async function loadRecentSessions(agentName: string) {
    try {
      recentSessions = await listSessions({ agent_name: agentName, limit: 10 });
    } catch {
      // Non-fatal — dropdown just won't show recent sessions
      recentSessions = [];
    }
  }

  /**
   * Background reconciliation: fetch persisted turn data from the session
   * record and replace synthesized tool call placeholders with real names,
   * results, and latencies. Used when streaming lost per-call events.
   *
   * Failures are silent — synthesized placeholders remain in place so the
   * UI is still useful.
   */
  async function hydrateFromSessionTurns(sid: string): Promise<void> {
    try {
      const turns = await getSessionTurns(sid);
      if (!turns || turns.length === 0) return;

      // Aggregate tool calls and results across every persisted turn.
      // The persisted shape is { tool_calls: unknown[], tool_results: unknown[] }
      // — flatten into ToolCallRecord shape.
      const real: ToolCallRecord[] = [];
      for (const t of turns) {
        const calls = (t.tool_calls || []) as Array<Record<string, unknown>>;
        const results = (t.tool_results || []) as Array<Record<string, unknown>>;
        for (let i = 0; i < calls.length; i++) {
          const tc = calls[i] || {};
          const tr = results[i] || {};
          real.push({
            id: String(tc.id ?? tc.tool_call_id ?? `t${t.turn_number}-${i}`),
            name: String(tc.name ?? "tool"),
            argsPreview:
              typeof tc.arguments === "string"
                ? tc.arguments.slice(0, 200)
                : JSON.stringify(tc.arguments ?? {}).slice(0, 200),
            result:
              typeof tr.result === "string"
                ? tr.result.slice(0, 4000)
                : tr.result != null
                  ? JSON.stringify(tr.result).slice(0, 4000)
                  : null,
            latencyMs: typeof tr.latency_ms === "number" ? tr.latency_ms : null,
            status: tr.error ? "failed" : "done",
            startedAt: Date.now(),
          });
        }
      }

      if (real.length > 0) {
        // Replace synthesized placeholders entirely — real data is better
        toolCalls = real;
        // Update totals and Tools step detail to reflect the canonical count
        totals = { ...totals, toolCalls: real.length };
        const toolsStep = steps.find((s) => s.id === "tools");
        if (toolsStep && toolsStep.status === "done") {
          setStep("tools", {
            detail: `${real.length} call${real.length === 1 ? "" : "s"}`,
          });
        }
      }
    } catch (err) {
      // Non-fatal — synthesized placeholders stay in place
      console.warn("[test-run] hydrateFromSessionTurns failed:", err);
    }
  }

  function openComposer() {
    composing = true;
  }
  function closeComposer() {
    composing = false;
    draftMessage = "";
  }

  function openInspector(id: StepId) {
    inspectorStepId = id;
  }
  function closeInspector() {
    inspectorStepId = null;
  }
  function stepInInspector(delta: 1 | -1) {
    if (!inspectorStepId) return;
    const i = STEP_ORDER.indexOf(inspectorStepId);
    const next = i + delta;
    if (next >= 0 && next < STEP_ORDER.length) {
      inspectorStepId = STEP_ORDER[next];
    }
  }

  // Derived: the most recent still-running tool call name, if any.
  // Used by the canvas to pulse the matching tool category node.
  function activeToolName(): string | null {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      if (toolCalls[i].status === "running") return toolCalls[i].name;
    }
    // Fall back to the most recent completed one during the Tools step
    return toolCalls.length > 0 ? toolCalls[toolCalls.length - 1].name : null;
  }

  return {
    get status() { return status; },
    get sessionId() { return sessionId; },
    get currentStepId() { return currentStepId; },
    get steps() { return steps; },
    get events() { return events; },
    get toolCalls() { return toolCalls; },
    get activeToolName() { return activeToolName(); },
    get totals() { return totals; },
    get tokenBuffer() { return tokenBuffer; },
    get modelUsed() { return modelUsed; },
    get errorMessage() { return errorMessage; },
    get resumed() { return resumed; },
    get recentSessions() { return recentSessions; },
    get inspectorStepId() { return inspectorStepId; },

    get composing() { return composing; },
    set composing(v: boolean) { composing = v; },
    get draftMessage() { return draftMessage; },
    set draftMessage(v: string) { draftMessage = v; },
    get selectedSessionIdForRun() { return selectedSessionIdForRun; },
    set selectedSessionIdForRun(v: string | null) {
      selectedSessionIdForRun = v;
    },

    // Actions
    start,
    stop,
    reset,
    loadRecentSessions,
    openComposer,
    closeComposer,
    openInspector,
    closeInspector,
    stepInInspector,
  };
}

export type TestRunStore = ReturnType<typeof createTestRunStore>;
