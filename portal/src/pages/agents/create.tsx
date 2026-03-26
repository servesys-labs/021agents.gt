import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  Loader2,
  Play,
  Rocket,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { apiPost, apiPut } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type GeneratedConfig = {
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  tools: string[];
  governance: {
    budget_limit_usd: number;
    blocked_tools: string[];
    require_confirmation_for_destructive: boolean;
  };
  graph?: GraphNode[];
  gate_pack?: GatePackResult;
};

type GraphNode = {
  id: string;
  label: string;
  type: string;
  next?: string[];
};

type GatePackResult = {
  lint: "pass" | "fail" | "pending";
  eval: "pass" | "fail" | "warning" | "pending";
  contracts: "pass" | "fail" | "pending";
  rollout: "approve" | "reject" | "pending";
};

type GenerationStep = {
  label: string;
  status: "pending" | "running" | "done" | "error";
};

/* ── Models ─────────────────────────────────────────────────────── */

const MODELS = [
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-4-20250514",
  "claude-3.5-haiku",
  "gemini-2.5-flash",
];

const AVAILABLE_TOOLS = [
  "web_search",
  "sandbox_exec",
  "file_read",
  "file_write",
  "slack_send_message",
  "search_docs",
  "create_ticket",
  "query_database",
  "send_email",
  "http_request",
];

/* ── Stage enum ─────────────────────────────────────────────────── */

type Stage = "description" | "generating" | "review";

/* ── Component ──────────────────────────────────────────────────── */

export function CreateAgentPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialPrompt = searchParams.get("prompt") ?? searchParams.get("description") ?? "";

  const [stage, setStage] = useState<Stage>(initialPrompt ? "description" : "description");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [config, setConfig] = useState<GeneratedConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deployMenuOpen, setDeployMenuOpen] = useState(false);

  /* Generation steps */
  const [steps, setSteps] = useState<GenerationStep[]>([
    { label: "Generating config", status: "pending" },
    { label: "Detecting tools", status: "pending" },
    { label: "Building graph", status: "pending" },
    { label: "Linting", status: "pending" },
    { label: "Checking compliance", status: "pending" },
  ]);

  /* ── Generate handler ──────────────────────────────────────────── */

  const handleCreate = useCallback(async () => {
    if (!prompt.trim()) return;
    setStage("generating");
    setError(null);

    const newSteps: GenerationStep[] = [
      { label: "Generating config", status: "running" },
      { label: "Detecting tools", status: "pending" },
      { label: "Building graph", status: "pending" },
      { label: "Linting", status: "pending" },
      { label: "Checking compliance", status: "pending" },
    ];
    setSteps([...newSteps]);

    const stepTimers: ReturnType<typeof setTimeout>[] = [];
    try {
      /* Simulate step progression while the API call is in flight */
      const advanceStep = (index: number, delay: number) => {
        stepTimers.push(
          setTimeout(() => {
            setSteps((prev) => {
              const next = [...prev];
              if (index > 0) next[index - 1] = { ...next[index - 1], status: "done" };
              if (index < next.length) next[index] = { ...next[index], status: "running" };
              return next;
            });
          }, delay),
        );
      };

      advanceStep(1, 600);
      advanceStep(2, 1400);
      advanceStep(3, 2200);
      advanceStep(4, 3000);

      const result = await apiPost<GeneratedConfig>(
        "/api/v1/agents/create-from-description",
        { description: prompt.trim(), draft_only: true },
      );

      /* Clear timers and mark all done */
      setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as const })));

      /* Apply defaults for missing fields */
      const finalConfig: GeneratedConfig = {
        name: result.name || prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30),
        description: result.description || prompt.trim(),
        system_prompt: result.system_prompt || `You are a helpful assistant. ${prompt.trim()}`,
        model: result.model || "gpt-4.1-mini",
        tools: result.tools || ["web_search"],
        governance: result.governance || {
          budget_limit_usd: 10,
          blocked_tools: [],
          require_confirmation_for_destructive: true,
        },
        graph: result.graph || [
          { id: "entry", label: "Entry", type: "input", next: ["router"] },
          { id: "router", label: "Router", type: "router", next: ["agent"] },
          { id: "agent", label: "Agent", type: "agent", next: ["tools"] },
          { id: "tools", label: "Tools", type: "tools", next: ["output"] },
          { id: "output", label: "Output", type: "output" },
        ],
        gate_pack: result.gate_pack || {
          lint: "pass",
          eval: "warning",
          contracts: "pass",
          rollout: "approve",
        },
      };

      setConfig(finalConfig);

      /* Brief pause to show all green, then go to review */
      setTimeout(() => setStage("review"), 500);
    } catch (err) {
      setConfig(null);
      setSteps((prev) =>
        prev.map((step, idx) => ({
          ...step,
          status: idx === 0 ? "error" : "pending",
        })),
      );
      setStage("description");
      setError(
        err instanceof Error
          ? `${err.message}. Generation did not complete; please retry.`
          : "Generation failed. Generation did not complete; please retry.",
      );
    } finally {
      stepTimers.forEach(clearTimeout);
    }
  }, [prompt]);

  /* ── Save handler ──────────────────────────────────────────────── */

  const handleSaveAndTest = async () => {
    if (!config) return;
    try {
      await apiPost("/api/v1/agents", { ...config, draft_only: false });
      navigate(`/agents/${config.name}/playground`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const handleDeploy = async () => {
    if (!config) return;
    try {
      await apiPost("/api/v1/agents", { ...config, draft_only: false });
      navigate(`/agents/${config.name}/deploy`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const handleSaveConfig = async () => {
    if (!config) return;
    try {
      await apiPut(`/api/v1/agents/${config.name}`, config);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  /* ── Render ────────────────────────────────────────────────────── */

  return (
    <div className="max-w-6xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => navigate("/")}
        className="flex items-center gap-[var(--space-2)] text-[var(--text-sm)] text-text-muted hover:text-text-primary transition-colors mb-[var(--space-6)] min-h-[var(--touch-target-min)]"
      >
        <ArrowLeft size={16} />
        Back to Dashboard
      </button>

      {/* Error banner */}
      {error && (
        <div className="mb-[var(--space-4)] p-[var(--space-3)] rounded-lg bg-status-warning/10 border border-status-warning/20 text-[var(--text-sm)] text-status-warning flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-surface-overlay rounded">
            <X size={14} />
          </button>
        </div>
      )}

      {stage === "description" && (
        <DescriptionStage
          prompt={prompt}
          setPrompt={setPrompt}
          onSubmit={handleCreate}
        />
      )}

      {stage === "generating" && (
        <GeneratingStage steps={steps} config={config} />
      )}

      {stage === "review" && config && (
        <ReviewStage
          config={config}
          setConfig={setConfig}
          onSaveAndTest={handleSaveAndTest}
          onDeploy={handleDeploy}
          onSaveConfig={handleSaveConfig}
          deployMenuOpen={deployMenuOpen}
          setDeployMenuOpen={setDeployMenuOpen}
        />
      )}
    </div>
  );
}

/* ── Stage 1: Description ────────────────────────────────────────── */

function DescriptionStage({
  prompt,
  setPrompt,
  onSubmit,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] max-w-2xl mx-auto">
      <div className="text-center mb-[var(--space-8)]">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-muted mb-[var(--space-4)]">
          <Sparkles size={28} className="text-accent" />
        </div>
        <h1 className="text-[var(--text-xl)] font-bold text-text-primary">
          Describe your agent
        </h1>
        <p className="mt-[var(--space-2)] text-[var(--text-md)] text-text-secondary leading-relaxed">
          Tell us what your agent should do. We will generate the config, tools, and guardrails.
        </p>
      </div>

      <div className="w-full">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A customer support agent that can look up orders, answer product questions, and escalate to humans when needed..."
          rows={5}
          className="w-full resize-none text-[var(--text-md)] leading-relaxed"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              onSubmit();
            }
          }}
        />
        <div className="flex items-center justify-between mt-[var(--space-3)]">
          <span className="text-[var(--text-xs)] text-text-muted">
            Press Cmd+Enter to submit
          </span>
          <button
            onClick={onSubmit}
            disabled={!prompt.trim()}
            className="btn btn-primary min-h-[var(--touch-target-min)] px-[var(--space-6)]"
          >
            <Sparkles size={16} />
            Create Agent
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Stage 2: Generating ─────────────────────────────────────────── */

function GeneratingStage({
  steps,
  config,
}: {
  steps: GenerationStep[];
  config: GeneratedConfig | null;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] max-w-lg mx-auto">
      <div className="text-center mb-[var(--space-8)]">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-muted mb-[var(--space-4)]">
          <Loader2 size={28} className="text-accent animate-spin" />
        </div>
        <h2 className="text-[var(--text-lg)] font-bold text-text-primary">
          Generating your agent
        </h2>
      </div>

      {/* Step list */}
      <div className="w-full space-y-[var(--space-3)]">
        {steps.map((step) => (
          <div
            key={step.label}
            className="flex items-center gap-[var(--space-3)] p-[var(--space-3)] rounded-lg border border-border-default bg-surface-raised"
          >
            {step.status === "done" && (
              <Check size={16} className="text-status-live flex-shrink-0" />
            )}
            {step.status === "running" && (
              <Loader2 size={16} className="text-accent animate-spin flex-shrink-0" />
            )}
            {step.status === "pending" && (
              <Circle size={16} className="text-text-muted flex-shrink-0" />
            )}
            {step.status === "error" && (
              <X size={16} className="text-status-error flex-shrink-0" />
            )}
            <span
              className={`text-[var(--text-sm)] ${
                step.status === "done"
                  ? "text-text-primary"
                  : step.status === "running"
                    ? "text-accent"
                    : "text-text-muted"
              }`}
            >
              {step.label}
              {step.status === "done" && " ...done"}
            </span>
          </div>
        ))}
      </div>

      {/* Preview card (shows if config starts arriving) */}
      {config && (
        <div className="mt-[var(--space-6)] w-full card">
          <p className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
            Preview
          </p>
          <p className="text-[var(--text-sm)] font-semibold text-text-primary">{config.name}</p>
          <p className="text-[var(--text-xs)] text-text-secondary mt-[var(--space-1)]">
            {config.description}
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Stage 3: Review + Configure ─────────────────────────────────── */

function ReviewStage({
  config,
  setConfig,
  onSaveAndTest,
  onDeploy,
  onSaveConfig,
  deployMenuOpen,
  setDeployMenuOpen,
}: {
  config: GeneratedConfig;
  setConfig: (c: GeneratedConfig) => void;
  onSaveAndTest: () => void;
  onDeploy: () => void;
  onSaveConfig: () => void;
  deployMenuOpen: boolean;
  setDeployMenuOpen: (v: boolean) => void;
}) {
  const deployRef = useRef<HTMLDivElement>(null);

  /* Close deploy menu on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (deployRef.current && !deployRef.current.contains(e.target as Node)) {
        setDeployMenuOpen(false);
      }
    };
    if (deployMenuOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [deployMenuOpen, setDeployMenuOpen]);

  const updateField = <K extends keyof GeneratedConfig>(key: K, value: GeneratedConfig[K]) => {
    setConfig({ ...config, [key]: value });
  };

  const toggleTool = (tool: string) => {
    const tools = config.tools.includes(tool)
      ? config.tools.filter((t) => t !== tool)
      : [...config.tools, tool];
    updateField("tools", tools);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--space-6)]">
        <div>
          <h1 className="text-[var(--text-lg)] font-bold text-text-primary">
            Review: {config.name}
          </h1>
          <p className="text-[var(--text-sm)] text-text-muted mt-[var(--space-1)]">
            Review and configure before testing or deploying
          </p>
        </div>
        <div className="flex items-center gap-[var(--space-3)]">
          <button
            onClick={onSaveConfig}
            className="btn btn-secondary min-h-[var(--touch-target-min)]"
          >
            <Save size={16} />
            Save
          </button>
          <button
            onClick={onSaveAndTest}
            className="btn btn-primary min-h-[var(--touch-target-min)]"
          >
            <Play size={16} />
            Save & Test
          </button>

          {/* Deploy dropdown */}
          <div className="relative" ref={deployRef}>
            <button
              onClick={() => setDeployMenuOpen(!deployMenuOpen)}
              className="btn btn-primary min-h-[var(--touch-target-min)] bg-status-live hover:bg-status-live/90"
            >
              <Rocket size={16} />
              Deploy
              <ChevronDown size={14} />
            </button>
            {deployMenuOpen && (
              <div className="absolute right-0 top-full mt-[var(--space-1)] w-48 rounded-lg glass-dropdown border border-border-default shadow-dropdown z-50">
                <button
                  onClick={() => {
                    setDeployMenuOpen(false);
                    onDeploy();
                  }}
                  className="w-full text-left px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-sm)] text-text-primary hover:bg-surface-overlay transition-colors min-h-[var(--touch-target-min)]"
                >
                  Deploy to Production
                </button>
                <button
                  onClick={() => {
                    setDeployMenuOpen(false);
                    onDeploy();
                  }}
                  className="w-full text-left px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-sm)] text-text-secondary hover:bg-surface-overlay transition-colors min-h-[var(--touch-target-min)]"
                >
                  Deploy as Canary
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[var(--space-6)]">
        {/* Left: Editable config */}
        <div className="space-y-[var(--space-4)]">
          {/* Name */}
          <div className="card">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
              Name
            </label>
            <input
              type="text"
              value={config.name}
              onChange={(e) => updateField("name", e.target.value)}
              className="text-[var(--text-sm)]"
            />
          </div>

          {/* System prompt */}
          <div className="card">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
              System Prompt
            </label>
            <textarea
              value={config.system_prompt}
              onChange={(e) => updateField("system_prompt", e.target.value)}
              rows={6}
              className="text-[var(--text-sm)] font-mono"
            />
          </div>

          {/* Model */}
          <div className="card">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-2)]">
              Model
            </label>
            <select
              value={config.model}
              onChange={(e) => updateField("model", e.target.value)}
              className="text-[var(--text-sm)]"
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* Tools checklist */}
          <div className="card">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
              Tools
            </label>
            <div className="grid grid-cols-2 gap-[var(--space-2)]">
              {AVAILABLE_TOOLS.map((tool) => (
                <label
                  key={tool}
                  className="flex items-center gap-[var(--space-2)] p-[var(--space-2)] rounded-lg hover:bg-surface-overlay transition-colors cursor-pointer min-h-[var(--touch-target-min)]"
                >
                  <input
                    type="checkbox"
                    checked={config.tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                    className="w-4 h-4 rounded border-border-default bg-surface-base accent-accent"
                  />
                  <span className="text-[var(--text-xs)] text-text-secondary font-mono">
                    {tool}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Governance */}
          <div className="card">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
              Governance
            </label>
            <div className="space-y-[var(--space-3)]">
              <div>
                <label className="block text-[var(--text-xs)] text-text-secondary mb-[var(--space-1)]">
                  Budget Limit (USD)
                </label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={config.governance.budget_limit_usd}
                  onChange={(e) =>
                    updateField("governance", {
                      ...config.governance,
                      budget_limit_usd: parseFloat(e.target.value),
                    })
                  }
                  className="text-[var(--text-sm)]"
                />
              </div>
              <label className="flex items-center gap-[var(--space-2)] cursor-pointer min-h-[var(--touch-target-min)]">
                <input
                  type="checkbox"
                  checked={config.governance.require_confirmation_for_destructive}
                  onChange={(e) =>
                    updateField("governance", {
                      ...config.governance,
                      require_confirmation_for_destructive: e.target.checked,
                    })
                  }
                  className="w-4 h-4 rounded border-border-default bg-surface-base accent-accent"
                />
                <span className="text-[var(--text-xs)] text-text-secondary">
                  Require confirmation for destructive actions
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* Right: Graph + Gate Pack */}
        <div className="space-y-[var(--space-4)]">
          {/* Graph visualization */}
          <div className="card">
            <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-4)]">
              Agent Graph
            </label>
            <GraphVisualization nodes={config.graph || []} />
          </div>

          {/* Gate pack status */}
          {config.gate_pack && (
            <div className="card">
              <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
                Gate Pack Status
              </label>
              <GatePackDisplay gatePack={config.gate_pack} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Graph Visualization (vertical chain) ────────────────────────── */

function GraphVisualization({ nodes }: { nodes: GraphNode[] }) {
  if (nodes.length === 0) {
    return (
      <p className="text-[var(--text-sm)] text-text-muted">No graph nodes defined</p>
    );
  }

  const nodeColors: Record<string, string> = {
    input: "border-status-info bg-status-info/10 text-status-info",
    router: "border-chart-purple bg-chart-purple/10 text-chart-purple",
    agent: "border-accent bg-accent-muted text-accent",
    tools: "border-chart-cyan bg-chart-cyan/10 text-chart-cyan",
    output: "border-status-live bg-status-live/10 text-status-live",
  };

  return (
    <div className="flex flex-col items-center gap-0">
      {nodes.map((node, idx) => (
        <div key={node.id} className="flex flex-col items-center">
          {/* Connector line */}
          {idx > 0 && (
            <div className="w-px h-6 bg-border-strong" />
          )}
          {/* Node box */}
          <div
            className={`px-[var(--space-4)] py-[var(--space-3)] rounded-lg border text-center min-w-[140px] ${
              nodeColors[node.type] || "border-border-default bg-surface-overlay text-text-secondary"
            }`}
          >
            <p className="text-[var(--text-sm)] font-semibold">{node.label}</p>
            <p className="text-[10px] uppercase tracking-wide opacity-70 mt-[var(--space-1)]">
              {node.type}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Gate Pack Display ───────────────────────────────────────────── */

function GatePackDisplay({ gatePack }: { gatePack: GatePackResult }) {
  const items: { label: string; status: string }[] = [
    { label: "Lint", status: gatePack.lint },
    { label: "Eval", status: gatePack.eval },
    { label: "Contracts", status: gatePack.contracts },
    { label: "Rollout Decision", status: gatePack.rollout },
  ];

  const statusIcon = (status: string) => {
    switch (status) {
      case "pass":
      case "approve":
        return <Check size={16} className="text-status-live" />;
      case "fail":
      case "reject":
        return <X size={16} className="text-status-error" />;
      case "warning":
        return (
          <span className="inline-flex items-center justify-center w-4 h-4 text-status-warning font-bold text-[var(--text-xs)]">
            !
          </span>
        );
      default:
        return <Circle size={16} className="text-text-muted" />;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "pass":
      case "approve":
        return "text-status-live bg-status-live/10 border-status-live/20";
      case "fail":
      case "reject":
        return "text-status-error bg-status-error/10 border-status-error/20";
      case "warning":
        return "text-status-warning bg-status-warning/10 border-status-warning/20";
      default:
        return "text-text-muted bg-surface-overlay border-border-default";
    }
  };

  return (
    <div className="space-y-[var(--space-2)]">
      {items.map((item) => (
        <div
          key={item.label}
          className={`flex items-center justify-between p-[var(--space-3)] rounded-lg border ${statusColor(item.status)}`}
        >
          <span className="text-[var(--text-sm)] font-medium">{item.label}</span>
          <div className="flex items-center gap-[var(--space-2)]">
            {statusIcon(item.status)}
            <span className="text-[var(--text-xs)] uppercase tracking-wide font-semibold">
              {item.status}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export { CreateAgentPage as default };
