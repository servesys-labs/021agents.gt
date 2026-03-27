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
import { apiPost, apiPut, apiGet } from "../../lib/api";
import { CollapsibleSection } from "../../components/common/CollapsibleSection";

/* ── Types ──────────────────────────────────────────────────────── */

type AgentGraph = {
  id: string;
  nodes: Array<{ id: string; kind: string; async?: boolean; breakpoint?: boolean; tools?: string[]; agent_name?: string }>;
  edges: Array<{ source: string; target: string }>;
};
type SubAgent = { name: string; description: string; system_prompt: string; model: string; tools: string[]; max_turns?: number };
type Skill = { name: string; description: string; category: string; content: string };
type CodemodeSnippet = { name: string; description: string; code: string; scope?: string };
type Guardrail = { name: string; type: string; rule: string; action: string };
type EvalConfig = { scenarios: string[]; metrics?: string[]; thresholds?: Record<string, number> };
type ReleaseStrategy = { initial_channel: string; canary_percent: number; promote_after: string };
type McpConnector = { app: string; reason: string; recommended_tools: string[] };

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
    require_confirmation_for?: string[];
  };
  reasoning_strategy?: string;
  graph?: GraphNode[];
  gate_pack?: GatePackResult;
  // Full package fields from meta-agent
  agent_graph?: AgentGraph;
  sub_agents?: SubAgent[];
  skills?: Skill[];
  codemode_snippets?: CodemodeSnippet[];
  guardrails?: Guardrail[];
  eval_config?: EvalConfig;
  release_strategy?: ReleaseStrategy;
  mcp_connectors?: McpConnector[];
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
  rollout: string | { decision?: string; reason?: string; [key: string]: unknown };
};

type GenerationStep = {
  label: string;
  status: "pending" | "running" | "done" | "error";
};

/* ── Models ─────────────────────────────────────────────────────── */

const MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "google/gemini-2.5-flash",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  "openai/gpt-4o",
  "@cf/moonshotai/kimi-k2.5",
];

const TOOL_CATEGORIES: Record<string, string[]> = {
  "Search & Research": ["web-search", "browse", "web-crawl", "browser-render", "knowledge-search", "store-knowledge", "autoresearch"],
  "Code & Execution": ["bash", "python-exec", "sandbox-exec", "dynamic-exec"],
  "File Operations": ["read-file", "write-file", "edit-file", "view-file", "search-file", "find-file", "grep", "glob"],
  "Communication": ["send-email", "a2a-send", "route-to-agent", "submit-feedback"],
  "Data & APIs": ["http-request", "db-query", "db-batch", "db-report", "query-pipeline", "send-to-pipeline"],
  "Media": ["image-generate", "text-to-speech"],
  "Platform Ops": ["create-agent", "run-agent", "eval-agent", "evolve-agent", "list-agents", "list-tools", "security-scan", "conversation-intel", "manage-issues", "compliance", "view-costs", "view-traces", "manage-releases"],
  "DevOps": ["git-init", "git-status", "git-diff", "git-commit", "git-log", "git-branch", "git-stash"],
  "Scheduling": ["create-schedule", "list-schedules", "manage-workflows", "todo"],
  "Advanced": ["run-codemode", "manage-rag", "manage-mcp", "manage-secrets", "discover-api"],
};

const ALL_TOOLS = Object.values(TOOL_CATEGORIES).flat();

/* ── Stage enum ─────────────────────────────────────────────────── */

type Stage = "description" | "generating" | "review";

/* ── Component ──────────────────────────────────────────────────── */

export function CreateAgentPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialPrompt = searchParams.get("prompt") ?? searchParams.get("description") ?? "";

  const templateId = searchParams.get("template");
  const [stage, setStage] = useState<Stage>("description");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [config, setConfig] = useState<GeneratedConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templateLoaded, setTemplateLoaded] = useState(false);

  // Load template if ?template= query param is set
  useEffect(() => {
    if (!templateId || templateLoaded) return;
    setTemplateLoaded(true);
    apiGet<GeneratedConfig>(`/api/v1/agents/templates/${templateId}`)
      .then((template) => {
        setConfig({
          ...template,
          governance: template.governance ?? { budget_limit_usd: 10, blocked_tools: [], require_confirmation_for_destructive: true },
          gate_pack: { lint: "pending", eval: "pending", contracts: "pending", rollout: "pending" },
        });
        setStage("review");
      })
      .catch(() => {
        setError(`Template "${templateId}" not found`);
      });
  }, [templateId, templateLoaded]);
  const [deployMenuOpen, setDeployMenuOpen] = useState(false);

  /* Generation steps */
  const [steps, setSteps] = useState<GenerationStep[]>([
    { label: "Analyzing requirements", status: "pending" },
    { label: "Designing agent & graph", status: "pending" },
    { label: "Selecting tools & connectors", status: "pending" },
    { label: "Generating skills & codemode", status: "pending" },
    { label: "Running lint & compliance", status: "pending" },
  ]);

  /* ── Generate handler ──────────────────────────────────────────── */

  const handleCreate = useCallback(async () => {
    if (!prompt.trim()) return;
    setStage("generating");
    setError(null);

    const newSteps: GenerationStep[] = [
      { label: "Analyzing requirements", status: "running" },
      { label: "Designing agent & graph", status: "pending" },
      { label: "Selecting tools & connectors", status: "pending" },
      { label: "Generating skills & codemode", status: "pending" },
      { label: "Running lint & compliance", status: "pending" },
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

      advanceStep(1, 1500);
      advanceStep(2, 3500);
      advanceStep(3, 5500);
      advanceStep(4, 7500);

      const result = await apiPost<GeneratedConfig>(
        "/api/v1/agents/create-from-description",
        {
          description: prompt.trim(),
          draft_only: true,
          tools: "auto",
          include_gate_pack: true,
          include_contracts_validate: true,
        },
      );

      /* Clear timers and mark all done */
      setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as const })));

      /* Use the API response directly — no client-side fallbacks.
         If the API failed, the catch block below handles it. */
      const finalConfig: GeneratedConfig = {
        name: result.name,
        description: result.description,
        system_prompt: result.system_prompt,
        model: result.model,
        tools: result.tools ?? [],
        governance: result.governance ?? {
          budget_limit_usd: 10,
          blocked_tools: [],
          require_confirmation_for_destructive: true,
        },
        graph: result.graph ?? [
          { id: "entry", label: "Entry", type: "input", next: ["router"] },
          { id: "router", label: "Router", type: "router", next: ["agent"] },
          { id: "agent", label: "Agent", type: "agent", next: ["tools"] },
          { id: "tools", label: "Tools", type: "tools", next: ["output"] },
          { id: "output", label: "Output", type: "output" },
        ],
        gate_pack: result.gate_pack ?? {
          lint: "pending",
          eval: "pending",
          contracts: "pending",
          rollout: "pending",
        },
        reasoning_strategy: result.reasoning_strategy ?? undefined,
        // Package fields
        agent_graph: result.agent_graph ?? undefined,
        sub_agents: result.sub_agents ?? [],
        skills: result.skills ?? [],
        codemode_snippets: result.codemode_snippets ?? [],
        guardrails: result.guardrails ?? [],
        eval_config: result.eval_config ?? undefined,
        release_strategy: result.release_strategy ?? undefined,
        mcp_connectors: result.mcp_connectors ?? [],
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
          onDiscard={() => {
            setConfig(null);
            setStage("description");
            setPrompt("");
            setError(null);
          }}
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
  onDiscard,
  deployMenuOpen,
  setDeployMenuOpen,
}: {
  config: GeneratedConfig;
  setConfig: (c: GeneratedConfig) => void;
  onSaveAndTest: () => void;
  onDeploy: () => void;
  onSaveConfig: () => void;
  onDiscard: () => void;
  deployMenuOpen: boolean;
  setDeployMenuOpen: (v: boolean) => void;
}) {
  const deployRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!deployMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (deployRef.current && !deployRef.current.contains(e.target as Node)) {
        setDeployMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-text-primary">
            Review: {config.name}
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Review and configure before testing or deploying
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={onDiscard} className="btn btn-ghost min-h-[var(--touch-target-min)] text-text-muted hover:text-status-error">
            <X size={16} /> Discard
          </button>
          <button onClick={onSaveConfig} className="btn btn-secondary min-h-[var(--touch-target-min)]">
            <Save size={16} /> Save
          </button>
          <button onClick={onSaveAndTest} className="btn btn-primary min-h-[var(--touch-target-min)]">
            <Play size={16} /> Save & Test
          </button>
          <div className="relative" ref={deployRef}>
            <button
              onClick={() => setDeployMenuOpen(!deployMenuOpen)}
              className="btn btn-primary min-h-[var(--touch-target-min)] bg-status-live hover:bg-status-live/90"
            >
              <Rocket size={16} /> Deploy
              <ChevronDown size={12} className={`transition-transform ${deployMenuOpen ? "rotate-180" : ""}`} />
            </button>
            {deployMenuOpen && (
              <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border-default shadow-dropdown glass-dropdown z-50">
                <button onClick={onDeploy} className="w-full text-left px-4 py-2 text-xs hover:bg-surface-overlay transition-colors rounded-lg">
                  Deploy to staging
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-4">
        {/* Agent Config */}
        <CollapsibleSection title="Agent Config" defaultOpen>
          <div className="space-y-4">
            <div>
              <label className="text-label text-text-muted mb-1 block">Name</label>
              <input type="text" value={config.name} onChange={(e) => updateField("name", e.target.value)} />
            </div>
            <div>
              <label className="text-label text-text-muted mb-1 block">System Prompt</label>
              <textarea value={config.system_prompt} onChange={(e) => updateField("system_prompt", e.target.value)} rows={8} className="font-mono text-xs" />
            </div>
            <div>
              <label className="text-label text-text-muted mb-1 block">Model</label>
              <select value={config.model} onChange={(e) => updateField("model", e.target.value)}>
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                {!MODELS.includes(config.model) && <option value={config.model}>{config.model}</option>}
              </select>
            </div>
            <div>
              <label className="text-label text-text-muted mb-1 block">Reasoning Strategy</label>
              <select value={config.reasoning_strategy ?? ""} onChange={(e) => updateField("reasoning_strategy", e.target.value || undefined)}>
                <option value="">Auto-detect</option>
                <option value="chain-of-thought">Chain of Thought — step-by-step reasoning</option>
                <option value="plan-then-execute">Plan then Execute — outline before acting</option>
                <option value="step-back">Step Back — zoom out before diving in</option>
                <option value="verify-then-respond">Verify then Respond — check facts first</option>
                <option value="decompose">Decompose — break complex tasks into subtasks</option>
              </select>
              <p className="text-hint mt-1">How the agent approaches complex tasks. Auto-detect infers from the description.</p>
            </div>
          </div>
        </CollapsibleSection>

        {/* Tools — categorized */}
        <CollapsibleSection title="Tools" count={config.tools.length} defaultOpen>
          <div className="space-y-4">
            {Object.entries(TOOL_CATEGORIES).map(([category, tools]) => (
              <div key={category}>
                <p className="text-xs font-semibold text-text-muted mb-2">{category}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {tools.map((tool) => (
                    <label key={tool} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-overlay cursor-pointer text-xs">
                      <input type="checkbox" checked={config.tools.includes(tool)} onChange={() => toggleTool(tool)} />
                      <span className={config.tools.includes(tool) ? "text-text-primary" : "text-text-muted"}>{tool}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* Execution Graph */}
        {config.agent_graph && (
          <CollapsibleSection title="Execution Graph" count={config.agent_graph.nodes.length}>
            <div className="space-y-2">
              {config.agent_graph.nodes.map((node) => (
                <div key={node.id} className="flex items-center gap-3 px-3 py-2 bg-surface-base rounded-lg border border-border-default">
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-accent/10 text-accent">{node.kind}</span>
                  <span className="text-xs text-text-primary font-mono">{node.id}</span>
                  {node.async && <span className="px-1.5 py-0.5 text-[9px] bg-chart-blue/10 text-chart-blue rounded">async</span>}
                  {node.breakpoint && <span className="px-1.5 py-0.5 text-[9px] bg-status-error/10 text-status-error rounded">breakpoint</span>}
                  {node.agent_name && <span className="text-[10px] text-text-muted">{"\u2192"} {node.agent_name}</span>}
                </div>
              ))}
              <div className="mt-3">
                <p className="text-xs text-text-muted mb-2">Edges</p>
                <div className="flex flex-wrap gap-2">
                  {config.agent_graph.edges.map((edge, i) => (
                    <span key={i} className="px-2 py-1 text-[10px] bg-surface-overlay rounded border border-border-default font-mono">
                      {edge.source} {"\u2192"} {edge.target}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Sub-Agents */}
        {(config.sub_agents?.length ?? 0) > 0 && (
          <CollapsibleSection title="Sub-Agents" count={config.sub_agents!.length}>
            <div className="space-y-3">
              {config.sub_agents!.map((sa) => (
                <div key={sa.name} className="p-3 bg-surface-base rounded-lg border border-border-default">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-text-primary">{sa.name}</span>
                    <span className="text-[10px] text-text-muted">max {sa.max_turns ?? 15} turns</span>
                  </div>
                  <p className="text-xs text-text-muted mb-2">{sa.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {sa.tools.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 text-[10px] bg-accent/10 text-accent rounded">{t}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Skills */}
        {(config.skills?.length ?? 0) > 0 && (
          <CollapsibleSection title="Skills" count={config.skills!.length}>
            <div className="space-y-3">
              {config.skills!.map((sk) => (
                <div key={sk.name} className="p-3 bg-surface-base rounded-lg border border-border-default">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-text-primary">{sk.name}</span>
                    <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-chart-blue/10 text-chart-blue">{sk.category}</span>
                  </div>
                  <p className="text-xs text-text-muted mb-2">{sk.description}</p>
                  <pre className="text-[10px] text-text-muted bg-surface-overlay rounded p-2 overflow-x-auto max-h-32">{sk.content.slice(0, 500)}</pre>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Codemode Snippets */}
        {(config.codemode_snippets?.length ?? 0) > 0 && (
          <CollapsibleSection title="Codemode Snippets" count={config.codemode_snippets!.length}>
            <div className="space-y-3">
              {config.codemode_snippets!.map((sn) => (
                <div key={sn.name} className="p-3 bg-surface-base rounded-lg border border-border-default">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-text-primary">{sn.name}</span>
                    <span className="px-1.5 py-0.5 text-[9px] bg-chart-purple/10 text-chart-purple rounded">{sn.scope ?? "agent"}</span>
                  </div>
                  <p className="text-xs text-text-muted mb-2">{sn.description}</p>
                  <pre className="text-[10px] font-mono text-text-muted bg-surface-overlay rounded p-2 overflow-x-auto max-h-40">{sn.code.slice(0, 600)}</pre>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Governance */}
        <CollapsibleSection title="Governance" defaultOpen>
          <div className="space-y-3">
            <div>
              <label className="text-label text-text-muted mb-1 block">Budget Limit (USD)</label>
              <input
                type="number" min={0} step={1}
                value={config.governance?.budget_limit_usd ?? 10}
                onChange={(e) => updateField("governance", { ...config.governance, budget_limit_usd: Number(e.target.value) })}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={config.governance?.require_confirmation_for_destructive ?? true}
                onChange={(e) => updateField("governance", { ...config.governance, require_confirmation_for_destructive: e.target.checked })}
              />
              Require confirmation for destructive actions
            </label>
            {config.governance?.require_confirmation_for && (
              <div>
                <p className="text-xs text-text-muted mb-1">Requires confirmation for:</p>
                <div className="flex flex-wrap gap-1">
                  {config.governance.require_confirmation_for.map((r) => (
                    <span key={r} className="px-2 py-1 text-[10px] bg-status-warning/10 text-status-warning rounded">{r}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* Guardrails */}
        {(config.guardrails?.length ?? 0) > 0 && (
          <CollapsibleSection title="Guardrails" count={config.guardrails!.length}>
            <div className="space-y-2">
              {config.guardrails!.map((gr, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 bg-surface-base rounded-lg border border-border-default">
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-status-warning/10 text-status-warning">{gr.type}</span>
                  <span className="text-xs text-text-secondary flex-1">{gr.rule}</span>
                  <span className="px-2 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted">{gr.action}</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* MCP Connectors */}
        {(config.mcp_connectors?.length ?? 0) > 0 && (
          <CollapsibleSection title="MCP Connectors" count={config.mcp_connectors!.length} defaultOpen>
            <p className="text-xs text-text-muted mb-3">These integrations will be available after you connect them in Settings {"\u2192"} Connectors.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {config.mcp_connectors!.map((mc) => (
                <div key={mc.app} className="p-3 bg-surface-base rounded-lg border border-border-default">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-text-primary capitalize">{mc.app.replace(/-/g, " ")}</span>
                    <span className="px-1.5 py-0.5 text-[9px] bg-chart-green/10 text-chart-green rounded">connect later</span>
                  </div>
                  <p className="text-xs text-text-muted mb-2">{mc.reason}</p>
                  <div className="flex flex-wrap gap-1">
                    {mc.recommended_tools.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded">{t}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Eval Config */}
        {config.eval_config && (
          <CollapsibleSection title="Eval Config">
            <div className="space-y-2">
              <div>
                <p className="text-xs text-text-muted mb-1">Test Scenarios</p>
                {config.eval_config.scenarios.map((s, i) => (
                  <div key={i} className="px-3 py-2 bg-surface-base rounded-lg border border-border-default mb-1 text-xs text-text-secondary">{s}</div>
                ))}
              </div>
              {config.eval_config.thresholds && (
                <div>
                  <p className="text-xs text-text-muted mb-1">Thresholds</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(config.eval_config.thresholds).map(([k, v]) => (
                      <span key={k} className="px-2 py-1 text-[10px] bg-surface-overlay rounded font-mono">{k}: {v}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* Release Strategy */}
        {config.release_strategy && (
          <CollapsibleSection title="Release Strategy">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-label text-text-muted mb-1 block">Channel</label>
                <input type="text" value={config.release_strategy.initial_channel} readOnly className="text-xs" />
              </div>
              <div>
                <label className="text-label text-text-muted mb-1 block">Canary %</label>
                <input type="number" value={config.release_strategy.canary_percent} readOnly className="text-xs" />
              </div>
              <div>
                <label className="text-label text-text-muted mb-1 block">Promote After</label>
                <input type="text" value={config.release_strategy.promote_after} readOnly className="text-xs" />
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Gate Pack */}
        {config.gate_pack && (
          <CollapsibleSection title="Gate Pack Status" defaultOpen>
            <GatePackDisplay gatePack={config.gate_pack} />
          </CollapsibleSection>
        )}
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
  // rollout may be a string or an object with a decision field
  const rolloutStatus = typeof gatePack.rollout === "string"
    ? gatePack.rollout
    : (gatePack.rollout as { decision?: string })?.decision ?? "pending";

  const items: { label: string; status: string }[] = [
    { label: "Lint", status: String(gatePack.lint ?? "pending") },
    { label: "Eval", status: String(gatePack.eval ?? "pending") },
    { label: "Contracts", status: String(gatePack.contracts ?? "pending") },
    { label: "Rollout Decision", status: rolloutStatus },
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
