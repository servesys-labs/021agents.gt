import { useState, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Wrench,
  Play,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Clock,
  Cpu,
  Database,
  Globe,
  Server,
  Puzzle,
  Loader2,
} from "lucide-react";

/* -- Types --------------------------------------------------------- */

type ToolCategory = "LLM" | "Data" | "API" | "System" | "Custom";

interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean" | "json";
  description: string;
  required?: boolean;
  default?: unknown;
}

interface ToolSchema {
  input: ToolParam[];
  output: ToolParam[];
}

interface ToolDetail {
  name: string;
  description: string;
  category: ToolCategory;
  version: string;
  usage_count: number;
  schema: ToolSchema;
}

interface ExecutionRun {
  id: string;
  timestamp: string;
  duration_ms: number;
  status: "success" | "error";
  input: Record<string, unknown>;
  output: unknown;
}

/* -- Category helpers ---------------------------------------------- */

const categoryIcons: Record<ToolCategory, typeof Cpu> = {
  LLM: Cpu,
  Data: Database,
  API: Globe,
  System: Server,
  Custom: Puzzle,
};

const categoryColors: Record<ToolCategory, string> = {
  LLM: "bg-chart-purple/15 text-chart-purple border-chart-purple/20",
  Data: "bg-chart-blue/15 text-chart-blue border-chart-blue/20",
  API: "bg-chart-cyan/15 text-chart-cyan border-chart-cyan/20",
  System: "bg-chart-orange/15 text-chart-orange border-chart-orange/20",
  Custom: "bg-chart-green/15 text-chart-green border-chart-green/20",
};

/* -- Mock data ----------------------------------------------------- */

const MOCK_TOOL: ToolDetail = {
  name: "openai-chat",
  description:
    "Send chat completions to OpenAI models with streaming support. Supports function calling, JSON mode, and vision inputs.",
  category: "LLM",
  version: "1.4.0",
  usage_count: 12_843,
  schema: {
    input: [
      {
        name: "model",
        type: "string",
        description: "OpenAI model ID (e.g. gpt-4o, gpt-4o-mini).",
        required: true,
        default: "gpt-4o",
      },
      {
        name: "messages",
        type: "json",
        description: "Array of chat messages in OpenAI format.",
        required: true,
      },
      {
        name: "temperature",
        type: "number",
        description: "Sampling temperature between 0 and 2.",
        required: false,
        default: 0.7,
      },
      {
        name: "stream",
        type: "boolean",
        description: "Enable streaming response.",
        required: false,
        default: false,
      },
    ],
    output: [
      {
        name: "content",
        type: "string",
        description: "The assistant response text.",
      },
      {
        name: "usage",
        type: "json",
        description: "Token usage object with prompt/completion counts.",
      },
    ],
  },
};

/* -- Collapsible Section ------------------------------------------- */

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border-default rounded-lg overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-4 py-3 text-left text-sm font-medium text-text-primary bg-surface-raised hover:bg-surface-overlay transition-colors"
        onClick={() => setOpen(!open)}
        style={{ minHeight: "var(--touch-target-min)" }}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && (
        <div className="border-t border-border-default bg-surface-base p-4">
          {children}
        </div>
      )}
    </div>
  );
}

/* -- JSON display -------------------------------------------------- */

function JsonBlock({ data, label }: { data: unknown; label?: string }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(data, null, 2);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <div className="relative">
      {label && (
        <span className="text-2xs text-text-muted uppercase tracking-wide font-semibold mb-1 block">
          {label}
        </span>
      )}
      <div className="relative rounded-md bg-surface-base border border-border-default overflow-hidden">
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
          title="Copy"
          style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <pre className="p-3 text-xs font-mono text-text-secondary overflow-x-auto leading-relaxed whitespace-pre-wrap">
          {text}
        </pre>
      </div>
    </div>
  );
}

/* -- Dynamic form field -------------------------------------------- */

function ParamField({
  param,
  value,
  onChange,
}: {
  param: ToolParam;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `param-${param.name}`;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {param.name}
        {param.required && (
          <span className="text-status-error ml-0.5">*</span>
        )}
      </label>
      <span className="text-2xs text-text-muted mb-1">
        {param.description}
      </span>

      {param.type === "boolean" ? (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          onClick={() => onChange(!value)}
          className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors self-start"
          style={{
            backgroundColor: value
              ? "var(--color-accent)"
              : "var(--color-surface-overlay)",
            minHeight: "var(--touch-target-min)",
            minWidth: "var(--touch-target-min)",
          }}
        >
          <span
            className="inline-block h-4 w-4 rounded-full bg-text-primary transition-transform"
            style={{
              transform: value ? "translateX(22px)" : "translateX(4px)",
            }}
          />
        </button>
      ) : param.type === "json" ? (
        <textarea
          id={id}
          rows={4}
          value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs"
          placeholder={`Enter ${param.name} as JSON...`}
          style={{ minHeight: "var(--touch-target-min)" }}
        />
      ) : param.type === "number" ? (
        <input
          id={id}
          type="number"
          value={value as number ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? "" : Number(e.target.value))
          }
          placeholder={
            param.default !== undefined ? String(param.default) : undefined
          }
          style={{ minHeight: "var(--touch-target-min)" }}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            param.default !== undefined ? String(param.default) : undefined
          }
          style={{ minHeight: "var(--touch-target-min)" }}
        />
      )}
    </div>
  );
}

/* -- Component ----------------------------------------------------- */

export function ToolDetailPage() {
  const { toolName } = useParams<{ toolName: string }>();
  const navigate = useNavigate();

  /* In production: useApiQuery<ToolDetail>(`/api/v1/tools/${toolName}`) */
  const tool: ToolDetail = { ...MOCK_TOOL, name: toolName ?? MOCK_TOOL.name };

  const CatIcon = categoryIcons[tool.category];

  /* Execution playground state */
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const p of tool.schema.input) {
      initial[p.name] = p.default ?? (p.type === "boolean" ? false : "");
    }
    return initial;
  });
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<unknown>(null);
  const [history, setHistory] = useState<ExecutionRun[]>([]);

  const setFieldValue = useCallback((name: string, value: unknown) => {
    setFormValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleExecute = useCallback(async () => {
    setExecuting(true);
    setExecutionResult(null);

    /* In production: apiPost(`/api/v1/tools/${toolName}/execute`, formValues) */
    await new Promise((r) => setTimeout(r, 800));

    const mockResult = {
      content:
        "This is a simulated response from the tool execution playground.",
      usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
    };

    setExecutionResult(mockResult);

    const run: ExecutionRun = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      duration_ms: 800 + Math.floor(Math.random() * 400),
      status: "success",
      input: { ...formValues },
      output: mockResult,
    };

    setHistory((prev) => [run, ...prev].slice(0, 5));
    setExecuting(false);
  }, [formValues]);

  const schemaJson = useMemo(
    () => ({
      input: Object.fromEntries(
        tool.schema.input.map((p) => [
          p.name,
          {
            type: p.type,
            description: p.description,
            required: p.required ?? false,
            ...(p.default !== undefined ? { default: p.default } : {}),
          },
        ]),
      ),
      output: Object.fromEntries(
        tool.schema.output.map((p) => [
          p.name,
          { type: p.type, description: p.description },
        ]),
      ),
    }),
    [tool.schema],
  );

  return (
    <div className="p-6 bg-surface-base min-h-screen">
      {/* Back button */}
      <button
        onClick={() => navigate("/tools")}
        className="btn btn-ghost text-xs mb-4"
        style={{ minHeight: "var(--touch-target-min)" }}
      >
        <ArrowLeft size={14} />
        Back to Tools
      </button>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-surface-overlay flex items-center justify-center text-text-muted">
            <CatIcon size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-text-primary font-mono">
                {tool.name}
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-mono font-medium bg-surface-overlay text-text-secondary border border-border-default">
                v{tool.version}
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium border ${categoryColors[tool.category]}`}
              >
                {tool.category}
              </span>
            </div>
            <p className="mt-1 text-sm text-text-muted">{tool.description}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column: Schema */}
        <div className="flex flex-col gap-4">
          <CollapsibleSection title="JSON Schema" defaultOpen>
            <JsonBlock data={schemaJson} />
          </CollapsibleSection>

          <CollapsibleSection title="Input Parameters" defaultOpen>
            <div className="space-y-1">
              {tool.schema.input.map((p) => (
                <div
                  key={p.name}
                  className="flex items-start gap-3 p-2 rounded-md hover:bg-surface-overlay/50 transition-colors"
                >
                  <code className="text-xs font-mono text-accent mt-0.5 shrink-0">
                    {p.name}
                  </code>
                  <div className="flex-1 min-w-0">
                    <span className="text-2xs text-text-muted font-mono">
                      {p.type}
                      {p.required && (
                        <span className="text-status-error ml-1">required</span>
                      )}
                    </span>
                    <p className="text-xs text-text-secondary mt-0.5">
                      {p.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Output Parameters">
            <div className="space-y-1">
              {tool.schema.output.map((p) => (
                <div
                  key={p.name}
                  className="flex items-start gap-3 p-2 rounded-md hover:bg-surface-overlay/50 transition-colors"
                >
                  <code className="text-xs font-mono text-accent mt-0.5 shrink-0">
                    {p.name}
                  </code>
                  <div className="flex-1 min-w-0">
                    <span className="text-2xs text-text-muted font-mono">
                      {p.type}
                    </span>
                    <p className="text-xs text-text-secondary mt-0.5">
                      {p.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        </div>

        {/* Right column: Playground */}
        <div className="flex flex-col gap-4">
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <Wrench size={14} className="text-text-muted" />
              <h2 className="text-sm font-semibold text-text-primary">
                Execution Playground
              </h2>
            </div>

            <div className="flex flex-col gap-4">
              {tool.schema.input.map((param) => (
                <ParamField
                  key={param.name}
                  param={param}
                  value={formValues[param.name]}
                  onChange={(v) => setFieldValue(param.name, v)}
                />
              ))}

              <button
                className="btn btn-primary text-xs self-start"
                onClick={handleExecute}
                disabled={executing}
                style={{ minHeight: "var(--touch-target-min)" }}
              >
                {executing ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
                {executing ? "Executing..." : "Execute"}
              </button>
            </div>

            {/* Result panel */}
            {executionResult && (
              <div className="mt-4 pt-4 border-t border-border-default">
                <JsonBlock data={executionResult} label="Response" />
              </div>
            )}
          </div>

          {/* Execution History */}
          {history.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-3">
                <Clock size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text-primary">
                  Recent Executions
                </h2>
                <span className="text-2xs text-text-muted">
                  (last {history.length})
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {history.map((run) => (
                  <HistoryRow key={run.id} run={run} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -- History row --------------------------------------------------- */

function HistoryRow({ run }: { run: ExecutionRun }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border-default rounded-md overflow-hidden">
      <button
        className="flex items-center gap-3 w-full px-3 py-2 text-left text-xs hover:bg-surface-overlay/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
        style={{ minHeight: "var(--touch-target-min)" }}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span
          className={`inline-flex w-1.5 h-1.5 rounded-full ${
            run.status === "success" ? "bg-status-live" : "bg-status-error"
          }`}
        />
        <span className="text-text-muted font-mono flex-1 truncate">
          {new Date(run.timestamp).toLocaleTimeString()}
        </span>
        <span className="text-text-muted font-mono">{run.duration_ms}ms</span>
      </button>
      {expanded && (
        <div className="border-t border-border-default p-3 space-y-3">
          <JsonBlock data={run.input} label="Input" />
          <JsonBlock data={run.output} label="Output" />
        </div>
      )}
    </div>
  );
}
