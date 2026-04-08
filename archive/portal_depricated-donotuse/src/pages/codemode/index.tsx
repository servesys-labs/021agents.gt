import { useCallback, useMemo, useState } from "react";
import {
  Code,
  Copy,
  Filter,
  Loader2,
  Play,
  Plus,
  Search,
  Trash2,
  X,
  Zap,
  Shield,
  GitBranch,
  BarChart3,
  Clock,
  FlaskConical,
  Layers,
  FileCode,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useApiQuery, apiPost, apiDelete, apiGet } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type SnippetScope =
  | "transform"
  | "validator"
  | "middleware"
  | "pre_llm"
  | "post_llm"
  | "post_tool"
  | "observability"
  | "custom";

type ComponentItem = {
  id: string;
  name: string;
  type: string;
  config_json: {
    code?: string;
    scope?: SnippetScope;
    language?: string;
    description?: string;
    tags?: string[];
  };
  version?: number;
  updated_at?: string;
  created_at?: string;
};

type ExecuteResult = {
  output?: string;
  logs?: string[];
  latency_ms?: number;
  cost?: number;
  error?: string;
};

/* ── Scope badge colors ─────────────────────────────────────────── */

const SCOPE_STYLES: Record<string, string> = {
  transform: "bg-accent/15 text-accent border-accent/25",
  validator: "bg-chart-blue/15 text-chart-blue border-chart-blue/25",
  middleware: "bg-chart-purple/15 text-chart-purple border-chart-purple/25",
  pre_llm: "bg-chart-green/15 text-chart-green border-chart-green/25",
  post_llm: "bg-status-warning/15 text-status-warning border-status-warning/25",
  post_tool: "bg-chart-cyan/15 text-chart-cyan border-chart-cyan/25",
  observability: "bg-chart-orange/15 text-chart-orange border-chart-orange/25",
  custom: "bg-text-muted/15 text-text-muted border-text-muted/25",
};

function ScopeBadge({ scope }: { scope: string }) {
  const cls = SCOPE_STYLES[scope] ?? SCOPE_STYLES.custom;
  return (
    <span
      className={`inline-flex items-center px-[var(--space-2)] py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border ${cls}`}
    >
      {scope.replace("_", " ")}
    </span>
  );
}

/* ── Templates ──────────────────────────────────────────────────── */

type TemplateDefinition = {
  name: string;
  scope: SnippetScope;
  description: string;
  icon: React.ReactNode;
  code: string;
};

const TEMPLATES: TemplateDefinition[] = [
  {
    name: "Data Transform",
    scope: "transform",
    description: "Transform tool outputs before passing to LLM",
    icon: <GitBranch size={20} />,
    code: `export default async function transform(input, context) {
  // input.tool_result contains the raw tool output
  const data = JSON.parse(input.tool_result);

  // Transform: extract key fields, summarize
  const summary = {
    count: data.length,
    highlights: data.slice(0, 3).map(d => d.title || d.name),
  };

  return JSON.stringify(summary);
}`,
  },
  {
    name: "Input Validator",
    scope: "validator",
    description: "Validate and sanitize user input before processing",
    icon: <Shield size={20} />,
    code: `export default async function validate(input, context) {
  const text = input.user_message || "";

  // Length check
  if (text.length > 4000) {
    return { valid: false, error: "Message too long (max 4000 chars)" };
  }

  // Sanitize: strip control characters
  const sanitized = text.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g, "");

  // Check for injection patterns
  const blocked = /(<script|javascript:|data:text\\/html)/i;
  if (blocked.test(sanitized)) {
    return { valid: false, error: "Blocked content detected" };
  }

  return { valid: true, sanitized };
}`,
  },
  {
    name: "Output Formatter",
    scope: "post_llm",
    description: "Format agent responses (markdown, JSON, structured)",
    icon: <FileCode size={20} />,
    code: `export default async function format(output, context) {
  const text = output.content || "";

  // Wrap code blocks with syntax highlighting hints
  const formatted = text.replace(
    /\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g,
    (_, lang, code) => \`\\\`\\\`\\\`\${lang || "text"}\\n\${code.trim()}\\n\\\`\\\`\\\`\`
  );

  // Add structured metadata footer
  return {
    content: formatted,
    metadata: {
      word_count: text.split(/\\s+/).length,
      has_code: text.includes("\`\`\`"),
      timestamp: new Date().toISOString(),
    },
  };
}`,
  },
  {
    name: "PII Redactor",
    scope: "pre_llm",
    description: "Scan and redact personally identifiable information from I/O",
    icon: <Shield size={20} />,
    code: `export default async function redactPII(input, context) {
  let text = input.user_message || "";

  // Email addresses
  text = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g,
    "[EMAIL_REDACTED]"
  );

  // Phone numbers (US format)
  text = text.replace(
    /(?:\\+?1[-.]?)?\\(?\\d{3}\\)?[-.]?\\d{3}[-.]?\\d{4}/g,
    "[PHONE_REDACTED]"
  );

  // SSN
  text = text.replace(/\\d{3}-\\d{2}-\\d{4}/g, "[SSN_REDACTED]");

  // Credit card numbers (basic)
  text = text.replace(/\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}/g, "[CC_REDACTED]");

  return { ...input, user_message: text, pii_detected: text !== input.user_message };
}`,
  },
  {
    name: "Cost Calculator",
    scope: "observability",
    description: "Track and log per-turn token costs to external analytics",
    icon: <BarChart3 size={20} />,
    code: `export default async function trackCost(event, context) {
  const { model, tokens_in, tokens_out } = event;

  // Pricing per 1K tokens (adjust for your models)
  const PRICING = {
    "gpt-4o": { input: 0.005, output: 0.015 },
    "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
    "llama-3.1-70b": { input: 0.0007, output: 0.0008 },
  };

  const rates = PRICING[model] || { input: 0.001, output: 0.002 };
  const cost = (tokens_in / 1000) * rates.input + (tokens_out / 1000) * rates.output;

  console.log(JSON.stringify({
    type: "cost_event",
    model,
    tokens_in,
    tokens_out,
    cost_usd: cost.toFixed(6),
    session_id: context.session_id,
    timestamp: Date.now(),
  }));

  return { ...event, cost_usd: cost };
}`,
  },
  {
    name: "Rate Limiter",
    scope: "middleware",
    description: "Throttle tool calls per session to prevent runaway loops",
    icon: <Clock size={20} />,
    code: `// In-memory rate limiter (per-session)
const counters = new Map();

export default async function rateLimit(input, context) {
  const key = context.session_id || "global";
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window
  const maxCalls = 20;     // max 20 tool calls per minute

  let entry = counters.get(key);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    counters.set(key, entry);
  }

  entry.count++;

  if (entry.count > maxCalls) {
    return {
      blocked: true,
      error: \`Rate limit exceeded: \${maxCalls} calls/min. Try again in \${
        Math.ceil((entry.start + windowMs - now) / 1000)
      }s\`,
    };
  }

  return { ...input, rate_limit_remaining: maxCalls - entry.count };
}`,
  },
  {
    name: "A/B Test Router",
    scope: "pre_llm",
    description: "Route to different prompts or models based on experiment groups",
    icon: <FlaskConical size={20} />,
    code: `export default async function abTestRouter(input, context) {
  // Deterministic bucket based on session ID
  const hash = (context.session_id || "")
    .split("")
    .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const bucket = Math.abs(hash) % 100;

  // Experiment config
  const experiments = {
    prompt_v2: { threshold: 50, control: "v1", variant: "v2" },
    model_upgrade: { threshold: 20, control: "gpt-4o-mini", variant: "gpt-4o" },
  };

  const assignments = {};
  for (const [name, exp] of Object.entries(experiments)) {
    assignments[name] = bucket < exp.threshold ? exp.variant : exp.control;
  }

  console.log(JSON.stringify({
    type: "ab_assignment",
    session_id: context.session_id,
    bucket,
    assignments,
  }));

  return { ...input, experiments: assignments };
}`,
  },
  {
    name: "Custom Logger",
    scope: "observability",
    description: "Log agent events to an external service (webhook, Datadog, etc.)",
    icon: <Layers size={20} />,
    code: `export default async function customLogger(event, context) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: event.error ? "error" : "info",
    agent: context.agent_name,
    session: context.session_id,
    event_type: event.type,
    model: event.model,
    latency_ms: event.latency_ms,
    tokens: event.tokens,
    tool: event.tool_name,
    error: event.error || null,
  };

  // Send to your logging endpoint (fire-and-forget)
  try {
    await fetch("https://your-logging-service.example.com/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(logEntry),
    });
  } catch (err) {
    console.error("Logger failed:", err.message);
  }

  return event; // Pass through unchanged
}`,
  },
];

/* ── Scope options for dropdown ─────────────────────────────────── */

const SCOPE_OPTIONS: SnippetScope[] = [
  "transform",
  "validator",
  "middleware",
  "pre_llm",
  "post_llm",
  "post_tool",
  "observability",
  "custom",
];

/* ── Main Page ──────────────────────────────────────────────────── */

const TAB_OPTIONS = ["Snippets", "Templates"] as const;
type Tab = (typeof TAB_OPTIONS)[number];

export function CodemodePage() {
  const [activeTab, setActiveTab] = useState<Tab>("Snippets");

  return (
    <div>
      <PageHeader
        title="Codemode"
        subtitle="Snippet library and reusable code components for your agent pipelines"
        icon={<Code size={18} />}
        actions={
          <div className="flex items-center gap-[var(--space-1)] rounded-lg border border-border-default overflow-hidden">
            {TAB_OPTIONS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] font-medium min-h-[var(--touch-target-min)] transition-colors ${
                  activeTab === tab
                    ? "bg-accent text-text-inverse"
                    : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        }
      />

      {activeTab === "Snippets" && <SnippetsTab />}
      {activeTab === "Templates" && <TemplatesTab />}
    </div>
  );
}

/* ── Snippets Tab ───────────────────────────────────────────────── */

function SnippetsTab() {
  const [scopeFilter, setScopeFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<ComponentItem | null>(null);
  const [prefillTemplate, setPrefillTemplate] = useState<TemplateDefinition | null>(null);

  const componentsQuery = useApiQuery<ComponentItem[] | { components: ComponentItem[] }>(
    "/api/v1/components?type=snippet",
  );

  const snippets = useMemo(() => {
    const raw = componentsQuery.data;
    let list: ComponentItem[] = [];
    if (Array.isArray(raw)) {
      list = raw;
    } else if (raw && typeof raw === "object" && "components" in raw) {
      list = (raw as { components: ComponentItem[] }).components ?? [];
    }
    // Filter by type=snippet client-side as fallback
    list = list.filter((c) => c.type === "snippet");

    if (scopeFilter) {
      list = list.filter((c) => c.config_json?.scope === scopeFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.config_json?.description ?? "").toLowerCase().includes(q) ||
          (c.config_json?.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [componentsQuery.data, scopeFilter, searchQuery]);

  const handleDelete = async (id: string) => {
    try {
      await apiDelete(`/api/v1/components/${id}`);
      void componentsQuery.refetch();
    } catch {
      /* swallow */
    }
  };

  const openEditor = (snippet?: ComponentItem, template?: TemplateDefinition) => {
    setEditingSnippet(snippet ?? null);
    setPrefillTemplate(template ?? null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingSnippet(null);
    setPrefillTemplate(null);
  };

  return (
    <>
      {/* Filters + Create */}
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="relative flex-1 max-w-sm">
          <Search
            size={14}
            className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search snippets..."
            className="pl-[var(--space-8)] text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
          />
        </div>

        <div className="flex items-center gap-[var(--space-2)]">
          <Filter size={14} className="text-text-muted" />
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            className="text-[var(--text-xs)] bg-surface-base border border-border-default rounded-lg px-[var(--space-2)] py-[var(--space-1)] min-h-[var(--touch-target-min)] text-text-primary"
          >
            <option value="">All scopes</option>
            {SCOPE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={() => openEditor()}
          className="btn btn-primary min-h-[var(--touch-target-min)]"
        >
          <Plus size={14} />
          Create Snippet
        </button>
      </div>

      {/* Snippet list */}
      <QueryState
        loading={componentsQuery.loading}
        error={componentsQuery.error}
        isEmpty={snippets.length === 0}
        emptyMessage="No snippets yet. Create your first snippet or start from a template."
        onRetry={componentsQuery.refetch}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[var(--space-3)]">
          {snippets.map((s) => (
            <div
              key={s.id}
              className="card card-hover cursor-pointer group"
              onClick={() => openEditor(s)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") openEditor(s);
              }}
            >
              <div className="flex items-start justify-between mb-[var(--space-2)]">
                <h3 className="text-[var(--text-md)] font-semibold text-text-primary truncate flex-1">
                  {s.name}
                </h3>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(s.id);
                  }}
                  className="p-[var(--space-1)] rounded hover:bg-status-error/10 transition-colors opacity-0 group-hover:opacity-100 min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center"
                  title="Delete snippet"
                >
                  <Trash2 size={14} className="text-status-error" />
                </button>
              </div>

              <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
                <ScopeBadge scope={s.config_json?.scope ?? "custom"} />
                <span className="text-[10px] font-mono text-text-muted uppercase">
                  {s.config_json?.language ?? "js"}
                </span>
              </div>

              <p className="text-[var(--text-xs)] text-text-muted line-clamp-2 mb-[var(--space-2)]">
                {s.config_json?.description || "No description"}
              </p>

              <div className="flex items-center justify-between text-[10px] text-text-muted font-mono">
                <span>v{s.version ?? 1}</span>
                <span>
                  {s.updated_at
                    ? new Date(s.updated_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                    : "--"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </QueryState>

      {/* Editor modal */}
      {editorOpen && (
        <SnippetEditorModal
          snippet={editingSnippet}
          template={prefillTemplate}
          onClose={closeEditor}
          onSaved={() => {
            closeEditor();
            void componentsQuery.refetch();
          }}
        />
      )}
    </>
  );
}

/* ── Snippet Editor Modal ───────────────────────────────────────── */

function SnippetEditorModal({
  snippet,
  template,
  onClose,
  onSaved,
}: {
  snippet: ComponentItem | null;
  template: TemplateDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!snippet;

  const [name, setName] = useState(snippet?.name ?? template?.name ?? "");
  const [scope, setScope] = useState<SnippetScope>(
    snippet?.config_json?.scope ?? template?.scope ?? "custom",
  );
  const [description, setDescription] = useState(
    snippet?.config_json?.description ?? template?.description ?? "",
  );
  const [tags, setTags] = useState(
    (snippet?.config_json?.tags ?? []).join(", "),
  );
  const [code, setCode] = useState(
    snippet?.config_json?.code ??
      template?.code ??
      `// Write your snippet here\nexport default async function(input, context) {\n  // transform, validate, or process\n  return input;\n}`,
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lineCount = code.split("\n").length;

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        type: "snippet",
        config_json: {
          code,
          scope,
          language: "js",
          description: description.trim(),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        },
      };
      if (isEdit && snippet) {
        await apiPost(`/api/v1/components/${snippet.id}`, body);
      } else {
        await apiPost("/api/v1/components", body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Try codemode/execute first, fall back to runtime-proxy
      let result: ExecuteResult;
      try {
        result = await apiPost<ExecuteResult>("/api/v1/codemode/execute", {
          code,
          scope,
          language: "js",
        });
      } catch {
        result = await apiPost<ExecuteResult>("/api/v1/runtime-proxy/tool/call", {
          tool: "execute-code",
          arguments: { code, language: "js" },
        });
      }
      setTestResult(result);
    } catch (err) {
      setTestResult({
        error: err instanceof Error ? err.message : "Execution failed",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 glass-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="fixed inset-4 z-50 flex items-center justify-center pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-4xl max-h-[90vh] rounded-xl overflow-hidden flex flex-col glass-medium border border-border-default shadow-panel"
          role="dialog"
          aria-modal="true"
          aria-label={isEdit ? `Edit snippet: ${name}` : "Create snippet"}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-[var(--space-4)] border-b border-border-default">
            <h2 className="text-[var(--text-md)] font-bold text-text-primary">
              {isEdit ? "Edit Snippet" : "Create Snippet"}
            </h2>
            <button
              onClick={onClose}
              className="min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] flex items-center justify-center rounded-lg hover:bg-surface-overlay transition-colors"
              aria-label="Close"
            >
              <X size={18} className="text-text-muted" />
            </button>
          </div>

          {/* Body (scrollable) */}
          <div className="flex-1 overflow-y-auto p-[var(--space-4)] space-y-[var(--space-4)]">
            {/* Name + Scope row */}
            <div className="grid grid-cols-2 gap-[var(--space-3)]">
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-snippet"
                  className="text-[var(--text-sm)] min-h-[var(--touch-target-min)]"
                />
              </div>
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                  Scope
                </label>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as SnippetScope)}
                  className="text-[var(--text-sm)] min-h-[var(--touch-target-min)]"
                >
                  {SCOPE_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this snippet do?"
                rows={2}
                className="text-[var(--text-sm)] min-h-[var(--touch-target-min)]"
              />
            </div>

            {/* Tags */}
            <div>
              <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="transform, utility, pii"
                className="text-[var(--text-sm)] min-h-[var(--touch-target-min)]"
              />
            </div>

            {/* Code editor */}
            <div>
              <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                Code
              </label>
              <div className="relative rounded-lg border border-border-default bg-surface-base overflow-hidden focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
                {/* Line numbers gutter */}
                <div className="flex">
                  <div
                    className="select-none py-[var(--space-3)] px-[var(--space-2)] text-right border-r border-border-default bg-surface-raised"
                    aria-hidden="true"
                  >
                    {Array.from({ length: Math.max(lineCount, 40) }, (_, i) => (
                      <div
                        key={i}
                        className="text-[var(--text-xs)] font-mono text-text-muted leading-[1.6]"
                      >
                        {i + 1}
                      </div>
                    ))}
                  </div>
                  <textarea
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="flex-1 font-mono text-[14px] leading-[1.6] p-[var(--space-3)] bg-transparent border-none resize-none focus:outline-none focus:ring-0 focus:border-transparent text-text-primary"
                    rows={Math.max(lineCount + 2, 40)}
                    spellCheck={false}
                    style={{ tabSize: 2 }}
                  />
                </div>
              </div>
            </div>

            {/* Test result */}
            {testResult && (
              <div className="rounded-lg border border-border-default bg-surface-base p-[var(--space-3)] space-y-[var(--space-2)]">
                <h4 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
                  Test Result
                </h4>
                {testResult.error && (
                  <p className="text-[var(--text-xs)] text-status-error font-mono">
                    {testResult.error}
                  </p>
                )}
                {testResult.output && (
                  <pre className="text-[var(--text-xs)] font-mono text-text-secondary bg-surface-overlay rounded p-[var(--space-2)] overflow-x-auto max-h-32 whitespace-pre-wrap">
                    {testResult.output}
                  </pre>
                )}
                {testResult.logs && testResult.logs.length > 0 && (
                  <div>
                    <p className="text-[10px] text-text-muted uppercase mb-[var(--space-1)]">
                      Logs
                    </p>
                    <pre className="text-[10px] font-mono text-text-muted bg-surface-overlay rounded p-[var(--space-2)] overflow-x-auto max-h-24 whitespace-pre-wrap">
                      {testResult.logs.join("\n")}
                    </pre>
                  </div>
                )}
                <div className="flex items-center gap-[var(--space-4)] text-[10px] text-text-muted font-mono">
                  {testResult.latency_ms != null && (
                    <span>Latency: {testResult.latency_ms}ms</span>
                  )}
                  {testResult.cost != null && (
                    <span>Cost: ${testResult.cost.toFixed(6)}</span>
                  )}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-[var(--text-xs)] text-status-error">{error}</p>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between p-[var(--space-4)] border-t border-border-default">
            <button
              onClick={handleTest}
              disabled={testing || !code.trim()}
              className="btn btn-secondary min-h-[var(--touch-target-min)]"
            >
              {testing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              Test
            </button>

            <div className="flex items-center gap-[var(--space-2)]">
              <button
                onClick={onClose}
                className="btn btn-ghost min-h-[var(--touch-target-min)]"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="btn btn-primary min-h-[var(--touch-target-min)]"
              >
                {saving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Zap size={14} />
                )}
                {isEdit ? "Update" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Templates Tab ──────────────────────────────────────────────── */

function TemplatesTab() {
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDefinition | null>(null);

  const useTemplate = (tpl: TemplateDefinition) => {
    setSelectedTemplate(tpl);
    setEditorOpen(true);
  };

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)]">
        {TEMPLATES.map((tpl) => (
          <div
            key={tpl.name}
            className="group relative rounded-xl p-[var(--space-4)] border border-border-default bg-surface-raised hover:border-border-strong transition-all cursor-pointer overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, var(--color-surface-raised) 0%, var(--color-glass-medium) 100%)",
            }}
            onClick={() => useTemplate(tpl)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") useTemplate(tpl);
            }}
          >
            {/* Hover glow */}
            <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" style={{
              background: "radial-gradient(circle at 50% 50%, var(--color-accent-muted) 0%, transparent 70%)",
            }} />

            <div className="relative z-10">
              <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
                <div className="p-[var(--space-2)] rounded-lg bg-accent/10 text-accent">
                  {tpl.icon}
                </div>
                <ScopeBadge scope={tpl.scope} />
              </div>

              <h3 className="text-[var(--text-md)] font-semibold text-text-primary mb-[var(--space-1)]">
                {tpl.name}
              </h3>
              <p className="text-[var(--text-xs)] text-text-muted line-clamp-2 mb-[var(--space-3)]">
                {tpl.description}
              </p>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  useTemplate(tpl);
                }}
                className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)] w-full"
              >
                <Copy size={12} />
                Use Template
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Editor modal (pre-filled from template) */}
      {editorOpen && selectedTemplate && (
        <SnippetEditorModal
          snippet={null}
          template={selectedTemplate}
          onClose={() => {
            setEditorOpen(false);
            setSelectedTemplate(null);
          }}
          onSaved={() => {
            setEditorOpen(false);
            setSelectedTemplate(null);
          }}
        />
      )}
    </>
  );
}

export { CodemodePage as default };
