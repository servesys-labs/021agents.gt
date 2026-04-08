import { useState, useRef, useEffect } from "react";
import { Send, Loader2, Settings, MessageSquare, Eye, LocateFixed, Rocket } from "lucide-react";

type Props = {
  onSubmit: (prompt: string) => void;
  isProcessing: boolean;
  lastResult?: string;
  latestDraft?: {
    agentName: string;
    model: string;
    tools: string[];
    resources: Array<{ type: string; name: string }>;
    createdAt: number;
    gateDecision?: string;
    gateReason?: string;
  } | null;
  maintenance?: {
    running: boolean;
    lastRunAt?: number;
    rolloutDecision?: string;
    readyForApproval?: boolean;
    blockingReasons?: string[];
    proposalsGenerated?: number;
    proposalCount?: number;
    gatePackRanAt?: number;
    promoting?: boolean;
    lastPromotion?: string;
  } | null;
  onReviewDraft?: () => void;
  onCenterDraft?: () => void;
  onDeployDraft?: (overrideHold?: boolean, overrideReason?: string) => void;
  onRunMaintenance?: () => void;
  onOpenProposals?: () => void;
  onRunGatePack?: () => void;
  onPromoteCandidate?: () => void;
  playbookAgentName?: string | null;
  playbookLoading?: boolean;
  playbookError?: string | null;
  playbook?: {
    control_plane_entrypoints?: Record<string, Record<string, string>>;
    langchain_equivalent_runtime?: {
      runnable_composition?: { primitives?: string[]; module?: string };
      graph_execution?: Record<string, string>;
      observability_eval?: Record<string, string>;
    };
    multi_agent_blueprint?: {
      pattern?: string;
      roles?: Array<{ role?: string; responsibility?: string }>;
      workflow?: string[];
    };
  } | null;
};

/* ── Quick-action suggestion chips (like Railway) ──────────────── */
const SUGGESTIONS = [
  { icon: "?", label: "How can I configure my agent?" },
  { icon: "🚀", label: "Deploy to production" },
  { icon: "⚙", label: "Manage environment variables" },
  { icon: "⏰", label: "Set up a cron schedule" },
  { icon: "❓", label: "Why is my agent failing?" },
  { icon: "📦", label: "Deploy Knowledge Base" },
];

export function MetaAgentAssist({
  onSubmit,
  isProcessing,
  lastResult,
  latestDraft,
  maintenance,
  onReviewDraft,
  onCenterDraft,
  onDeployDraft,
  onRunMaintenance,
  onOpenProposals,
  onRunGatePack,
  onPromoteCandidate,
  playbookAgentName,
  playbookLoading,
  playbookError,
  playbook,
}: Props) {
  const rollout = String(maintenance?.rolloutDecision || "").toLowerCase();
  const readyForApproval = Boolean(maintenance?.readyForApproval);

  const [input, setInput] = useState("");
  const [overrideHoldArmed, setOverrideHoldArmed] = useState(false);
  const [overridePhrase, setOverridePhrase] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  type ChatMessage = { role: "user" | "assistant"; text: string };
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll history
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history]);

  // Add result to history
  useEffect(() => {
    if (lastResult) {
      setHistory((prev) => [...prev, { role: "assistant" as const, text: lastResult }].slice(-100));
    }
  }, [lastResult]);

  const playbookPromptTemplates = (() => {
    const agent = playbookAgentName || "my-agent";
    const steps = playbook?.multi_agent_blueprint?.pattern || "supervisor_specialists";
    return [
      {
        id: "create-agent",
        label: "Create Agent",
        prompt: `Create a new agent for this project with strict graph linting and include an async telemetry branch with idempotency_key.`,
      },
      {
        id: "run-eval",
        label: "Run Eval Loop",
        prompt: `For ${agent}, run an eval loop: pick tasks, run trials, summarize failures, and propose top 3 improvements.`,
      },
      {
        id: "multi-agent",
        label: "Design Multi-Agent",
        prompt: `Design a ${steps} architecture for ${agent} with supervisor routing, specialist delegation, and non-blocking background telemetry/eval lanes.`,
      },
      {
        id: "autofix-gates",
        label: "Auto-Fix + Gate Pack",
        prompt: `For ${agent}, run graph autofix, then gate-pack checks (strict lint + eval thresholds), summarize rollout decision, and list exact next API calls.`,
      },
      {
        id: "maintenance-cycle",
        label: "Run Maintenance Cycle",
        prompt: `Run autonomous maintenance cycle for ${agent}: telemetry review, proposal generation, graph checks (lint/contracts/autofix), eval gate check, and return approval packet.`,
      },
    ];
  })();

  const handleSubmit = (text?: string) => {
    const trimmed = (text || input).trim();
    if (!trimmed || isProcessing) return;
    setHistory((prev) => [...prev, { role: "user" as const, text: trimmed }].slice(-100));
    onSubmit(trimmed);
    setInput("");
  };

  useEffect(() => {
    setOverrideHoldArmed(false);
    setOverridePhrase("");
    setOverrideReason("");
  }, [latestDraft?.createdAt, latestDraft?.agentName]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col border-l flex-shrink-0 min-h-0 overflow-hidden glass-heavy relative h-full">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare size={14} className="text-accent" />
          <span className="text-sm font-semibold text-text-primary">Meta-Agent</span>
        </div>
        <button className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors">
          <Settings size={13} />
        </button>
      </div>

      {/* ── Chat history ────────────────────────────────────── */}
      <div ref={historyRef} className="flex-1 overflow-y-auto min-h-0">
        {(playbookLoading || playbook || playbookError) && (
          <div className="p-4 border-b border-border-default">
            <div className="rounded-xl border border-border-default bg-surface-base p-3">
              <p className="text-[11px] font-semibold text-text-primary mb-2">
                Meta Agent Playbook{playbookAgentName ? ` - ${playbookAgentName}` : ""}
              </p>
              {playbookLoading ? (
                <p className="text-[11px] text-text-muted">Loading control-plane playbook...</p>
              ) : playbookError ? (
                <p className="text-[11px] text-text-muted">
                  Playbook unavailable: {playbookError}
                </p>
              ) : (
                <div className="space-y-3 text-[11px] text-text-secondary">
                  <div>
                    <p className="text-text-muted mb-1">Control Plane APIs</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(playbook?.control_plane_entrypoints || {}).map(([group, entries]) => (
                        <span
                          key={group}
                          title={Object.values(entries || {}).slice(0, 4).join("\n")}
                          className="px-2 py-1 rounded-md bg-surface-overlay border border-border-default text-[10px]"
                        >
                          {group}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-text-muted mb-1">Use In Prompt</p>
                    <div className="flex flex-wrap gap-1">
                      {playbookPromptTemplates.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            setInput(item.prompt);
                            setTimeout(() => inputRef.current?.focus(), 0);
                          }}
                          className="px-2 py-1 rounded-md bg-surface-overlay border border-border-default text-[10px] text-text-secondary hover:text-text-primary hover:border-accent/40"
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-text-muted mb-1">Maintenance</p>
                    <button
                      onClick={() => onRunMaintenance?.()}
                      disabled={Boolean(maintenance?.running) || !playbookAgentName}
                      className="px-2 py-1 rounded-md bg-surface-overlay border border-border-default text-[10px] text-text-secondary hover:text-text-primary hover:border-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {maintenance?.running ? "Running..." : "Run Maintenance Cycle"}
                    </button>
                    {maintenance?.rolloutDecision && (
                      <div className="mt-2 text-[10px] text-text-secondary space-y-1">
                        <p>
                          <span className="text-text-muted">Rollout:</span>{" "}
                          <span className={maintenance.rolloutDecision === "hold" ? "text-status-danger" : "text-status-live"}>
                            {maintenance.rolloutDecision}
                          </span>
                        </p>
                        <p><span className="text-text-muted">Ready:</span> {maintenance.readyForApproval ? "yes" : "no"}</p>
                        <p><span className="text-text-muted">Proposals:</span> {maintenance.proposalsGenerated ?? 0}</p>
                        {(maintenance.blockingReasons || []).slice(0, 2).map((r) => (
                          <p key={r} className="text-text-muted">- {r}</p>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-text-muted mb-1">Approval Packet</p>
                    <div className="rounded-md border border-border-default bg-surface-base p-2">
                      <div className="text-[10px] text-text-secondary space-y-1">
                        <p>
                          <span className="text-text-muted">Status:</span>{" "}
                          <span className={readyForApproval ? "text-status-live" : "text-status-danger"}>
                            {readyForApproval ? "ready" : "blocked"}
                          </span>
                        </p>
                        <p>
                          <span className="text-text-muted">Rollout:</span>{" "}
                          <span className={rollout === "hold" ? "text-status-danger" : "text-status-live"}>
                            {maintenance?.rolloutDecision || "n/a"}
                          </span>
                        </p>
                        <p>
                          <span className="text-text-muted">Proposals:</span>{" "}
                          {maintenance?.proposalCount ?? maintenance?.proposalsGenerated ?? 0}
                        </p>
                        {(maintenance?.blockingReasons || []).slice(0, 2).map((reason) => (
                          <p key={reason} className="text-text-muted">- {reason}</p>
                        ))}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-1">
                        <button
                          onClick={() => onOpenProposals?.()}
                          disabled={!playbookAgentName || Boolean(maintenance?.running)}
                          className="px-2 py-1 rounded-md border border-border-default text-[10px] text-text-secondary hover:text-text-primary hover:border-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Open proposals
                        </button>
                        <button
                          onClick={() => onRunGatePack?.()}
                          disabled={!playbookAgentName || Boolean(maintenance?.running)}
                          className="px-2 py-1 rounded-md border border-border-default text-[10px] text-text-secondary hover:text-text-primary hover:border-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Run gate-pack
                        </button>
                        <button
                          onClick={() => onPromoteCandidate?.()}
                          disabled={!playbookAgentName || rollout !== "promote_candidate" || !readyForApproval || Boolean(maintenance?.promoting)}
                          className="px-2 py-1 rounded-md bg-accent text-[10px] text-text-inverse hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {maintenance?.promoting ? "Promoting..." : "Promote candidate"}
                        </button>
                      </div>
                      {maintenance?.lastPromotion && (
                        <p className="mt-2 text-[10px] text-text-muted">{maintenance.lastPromotion}</p>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-text-muted mb-1">LangChain-Equivalent Runtime</p>
                    <div className="flex flex-wrap gap-1">
                      {(playbook?.langchain_equivalent_runtime?.runnable_composition?.primitives || []).map((p) => (
                        <span
                          key={p}
                          className="px-2 py-1 rounded-md bg-accent/10 border border-accent/20 text-[10px] text-accent"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-text-muted mb-1">Multi-Agent Pattern</p>
                    <p className="text-[11px]">
                      {playbook?.multi_agent_blueprint?.pattern || "n/a"}
                    </p>
                    {(playbook?.multi_agent_blueprint?.workflow || []).length > 0 && (
                      <ul className="mt-1 space-y-1">
                        {(playbook?.multi_agent_blueprint?.workflow || []).slice(0, 3).map((step) => (
                          <li key={step} className="text-[10px] text-text-muted">
                            {step}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {latestDraft && (
          <div className="p-4 border-b border-border-default">
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
              <p className="text-[11px] font-semibold text-accent mb-2">Draft Ready</p>
              <div className="space-y-1 text-[11px] text-text-secondary">
                <p><span className="text-text-muted">Agent:</span> {latestDraft.agentName}</p>
                <p><span className="text-text-muted">Model:</span> {latestDraft.model}</p>
                <p><span className="text-text-muted">Tools:</span> {latestDraft.tools.length}</p>
                <p><span className="text-text-muted">Resources:</span> {latestDraft.resources.length}</p>
                <p>
                  <span className="text-text-muted">Gate Decision:</span>{" "}
                  <span
                    className={
                      String(latestDraft.gateDecision || "").toLowerCase() === "hold"
                        ? "text-status-danger"
                        : "text-status-live"
                    }
                  >
                    {latestDraft.gateDecision || "n/a"}
                  </span>
                </p>
                {latestDraft.gateReason && (
                  <p className="text-[10px] text-text-muted">{latestDraft.gateReason}</p>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {latestDraft.resources.slice(0, 6).map((r, idx) => (
                  <span key={`${r.type}-${r.name}-${idx}`} className="text-[10px] px-2 py-1 rounded-md bg-surface-base border border-border-default text-text-muted">
                    {r.type}: {r.name}
                  </span>
                ))}
              </div>
              {String(latestDraft.gateDecision || "").toLowerCase() === "hold" && (
                <div className="mt-3 space-y-2">
                  <label className="flex items-center gap-2 text-[10px] text-text-secondary">
                    <input
                      type="checkbox"
                      checked={overrideHoldArmed}
                      onChange={(e) => setOverrideHoldArmed(e.target.checked)}
                      className="rounded border-border-default bg-surface-base"
                    />
                    I understand gate decision is hold, and I want to override.
                  </label>
                  <div>
                    <p className="text-[10px] text-text-muted mb-1">Type OVERRIDE to confirm</p>
                    <input
                      value={overridePhrase}
                      onChange={(e) => setOverridePhrase(e.target.value)}
                      placeholder="OVERRIDE"
                      className="w-full text-[10px] px-2 py-1 rounded-md bg-surface-base border border-border-default text-text-primary"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] text-text-muted mb-1">Override reason (required)</p>
                    <input
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Why are you overriding this hold gate?"
                      className="w-full text-[10px] px-2 py-1 rounded-md bg-surface-base border border-border-default text-text-primary"
                    />
                  </div>
                </div>
              )}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button
                  onClick={onReviewDraft}
                  className="flex items-center justify-center gap-1 text-[11px] py-1.5 rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:border-accent/40"
                >
                  <Eye size={11} /> Review
                </button>
                <button
                  onClick={onCenterDraft}
                  className="flex items-center justify-center gap-1 text-[11px] py-1.5 rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:border-accent/40"
                >
                  <LocateFixed size={11} /> Focus
                </button>
                <button
                  onClick={() =>
                    onDeployDraft?.(
                      overrideHoldArmed && String(overridePhrase || "").trim().toUpperCase() === "OVERRIDE",
                      String(overrideReason || "").trim(),
                    )
                  }
                  disabled={
                    String(latestDraft.gateDecision || "").toLowerCase() === "hold"
                    && !(
                      overrideHoldArmed
                      && String(overridePhrase || "").trim().toUpperCase() === "OVERRIDE"
                      && String(overrideReason || "").trim().length > 0
                    )
                  }
                  className="flex items-center justify-center gap-1 text-[11px] py-1.5 rounded-md bg-accent text-text-inverse hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Rocket size={11} />{" "}
                  {String(latestDraft.gateDecision || "").toLowerCase() === "hold"
                    ? "Override & Create"
                    : "Approve & Create"}
                </button>
              </div>
            </div>
          </div>
        )}
        {history.length === 0 ? (
          /* Empty state: show suggestion chips like Railway */
          <div className="p-5">
            <div className="flex flex-col gap-2">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => handleSubmit(s.label)}
                  className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-text-secondary bg-surface-base border border-border-default rounded-xl hover:bg-surface-hover hover:border-border-hover transition-colors text-left leading-normal"
                >
                  <span className="text-[13px] flex-shrink-0">{s.icon}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Chat messages */
          <div className="p-4 space-y-3">
            {history.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[90%] px-3 py-2 rounded-lg text-[13px] leading-relaxed ${
                    msg.role === "user"
                      ? "bg-accent/15 text-text-primary rounded-br-sm"
                      : "bg-surface-base text-text-secondary rounded-bl-sm border border-border-default"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isProcessing && (
              <div className="flex justify-start">
                <div className="bg-surface-base px-3 py-2 rounded-lg rounded-bl-sm border border-border-default">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Input area (Railway-style: full-width, tall, accent border on focus) ───── */}
      <div className="border-t border-border-default px-5 py-4 flex-shrink-0">
        <div className="relative bg-surface-base border-2 border-border-default rounded-2xl focus-within:border-accent/60 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Develop, debug, deploy anything..."
            rows={3}
            className="w-full bg-transparent border-none outline-none text-[14px] leading-relaxed text-text-primary placeholder:text-text-muted resize-none px-4 pt-3.5 pb-10"
            style={{ minHeight: "88px" }}
            disabled={isProcessing}
          />
          <button
            onClick={() => handleSubmit()}
            disabled={!input.trim() || isProcessing}
            className="absolute bottom-2.5 right-3 w-7 h-7 rounded-full flex items-center justify-center transition-all disabled:opacity-20 disabled:cursor-not-allowed text-text-muted hover:text-accent hover:bg-surface-hover border border-border-default hover:border-accent/40"
          >
            {isProcessing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
