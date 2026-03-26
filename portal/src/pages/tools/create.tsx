import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Play,
  Loader2,
  AlertCircle,
  Wrench,
} from "lucide-react";

/* -- Types --------------------------------------------------------- */

type ToolCategory = "LLM" | "Data" | "API" | "System" | "Custom";

interface FormData {
  name: string;
  description: string;
  category: ToolCategory;
  version: string;
  inputSchema: string;
  outputSchema: string;
  testInput: string;
}

/* -- Constants ----------------------------------------------------- */

const CATEGORIES: ToolCategory[] = ["LLM", "Data", "API", "System", "Custom"];

const STEPS = [
  { label: "Basic Info", number: 1 },
  { label: "Schema", number: 2 },
  { label: "Test", number: 3 },
  { label: "Confirm", number: 4 },
] as const;

const DEFAULT_INPUT_SCHEMA = JSON.stringify(
  {
    prompt: {
      type: "string",
      description: "The input prompt.",
      required: true,
    },
  },
  null,
  2,
);

const DEFAULT_OUTPUT_SCHEMA = JSON.stringify(
  {
    result: {
      type: "string",
      description: "The tool output.",
    },
  },
  null,
  2,
);

/* -- Helpers ------------------------------------------------------- */

function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/* -- Step Indicator ------------------------------------------------ */

function StepIndicator({
  current,
  steps,
}: {
  current: number;
  steps: readonly { label: string; number: number }[];
}) {
  return (
    <nav
      className="flex items-center gap-2 mb-8"
      aria-label="Form progress"
    >
      {steps.map((step, i) => {
        const isActive = step.number === current;
        const isComplete = step.number < current;
        return (
          <div key={step.number} className="flex items-center gap-2">
            {i > 0 && (
              <ChevronRight size={12} className="text-text-muted" />
            )}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? "bg-accent-muted text-accent border border-accent/30"
                  : isComplete
                    ? "bg-node-glow-green text-status-live border border-node-glow-green-border"
                    : "bg-surface-overlay text-text-muted border border-border-default"
              }`}
            >
              {isComplete ? (
                <Check size={12} />
              ) : (
                <span className="font-mono">{step.number}</span>
              )}
              <span className="hidden sm:inline">{step.label}</span>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/* -- Component ----------------------------------------------------- */

export function CreateToolPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>({
    name: "",
    description: "",
    category: "Custom",
    version: "1.0.0",
    inputSchema: DEFAULT_INPUT_SCHEMA,
    outputSchema: DEFAULT_OUTPUT_SCHEMA,
    testInput: '{\n  "prompt": "Hello, world!"\n}',
  });
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<unknown>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const updateField = useCallback(
    <K extends keyof FormData>(key: K, value: FormData[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  /* Validation */
  const step1Valid = useMemo(
    () => form.name.trim().length > 0 && form.description.trim().length > 0,
    [form.name, form.description],
  );

  const step2Valid = useMemo(
    () => isValidJson(form.inputSchema) && isValidJson(form.outputSchema),
    [form.inputSchema, form.outputSchema],
  );

  const inputSchemaError = form.inputSchema && !isValidJson(form.inputSchema);
  const outputSchemaError =
    form.outputSchema && !isValidJson(form.outputSchema);

  const canAdvance =
    (step === 1 && step1Valid) ||
    (step === 2 && step2Valid) ||
    step === 3 ||
    step === 4;

  /* Test execution */
  const handleTest = useCallback(async () => {
    setTestRunning(true);
    setTestResult(null);
    setTestError(null);

    if (!isValidJson(form.testInput)) {
      setTestError("Test input is not valid JSON.");
      setTestRunning(false);
      return;
    }

    /* In production: apiPost(`/api/v1/tools/${form.name}/execute`, JSON.parse(form.testInput)) */
    await new Promise((r) => setTimeout(r, 1000));

    setTestResult({
      result: "Test execution completed successfully.",
      duration_ms: 342,
    });
    setTestRunning(false);
  }, [form.testInput]);

  /* Create */
  const handleCreate = useCallback(async () => {
    setCreating(true);

    /* In production: apiPost("/api/v1/tools", { ...form, inputSchema: JSON.parse(form.inputSchema), outputSchema: JSON.parse(form.outputSchema) }) */
    await new Promise((r) => setTimeout(r, 800));

    navigate("/tools");
  }, [form, navigate]);

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

      <h1 className="text-lg font-bold text-text-primary mb-1 flex items-center gap-2">
        <Wrench size={18} className="text-text-muted" />
        Create Tool
      </h1>
      <p className="text-sm text-text-muted mb-6">
        Define a new tool that agents can use during execution.
      </p>

      <StepIndicator current={step} steps={STEPS} />

      <div className="max-w-2xl">
        {/* Step 1: Basic Info */}
        {step === 1 && (
          <div className="card flex flex-col gap-5">
            <h2 className="text-sm font-semibold text-text-primary">
              Basic Information
            </h2>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="tool-name"
                className="text-xs font-medium text-text-secondary"
              >
                Name <span className="text-status-error">*</span>
              </label>
              <input
                id="tool-name"
                type="text"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="my-tool-name"
                className="font-mono"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
              <span className="text-2xs text-text-muted">
                Lowercase, hyphens allowed. This is the tool identifier.
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="tool-desc"
                className="text-xs font-medium text-text-secondary"
              >
                Description <span className="text-status-error">*</span>
              </label>
              <textarea
                id="tool-desc"
                rows={3}
                value={form.description}
                onChange={(e) => updateField("description", e.target.value)}
                placeholder="What does this tool do?"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="tool-category"
                  className="text-xs font-medium text-text-secondary"
                >
                  Category
                </label>
                <select
                  id="tool-category"
                  value={form.category}
                  onChange={(e) =>
                    updateField("category", e.target.value as ToolCategory)
                  }
                  style={{ minHeight: "var(--touch-target-min)" }}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="tool-version"
                  className="text-xs font-medium text-text-secondary"
                >
                  Version
                </label>
                <input
                  id="tool-version"
                  type="text"
                  value={form.version}
                  onChange={(e) => updateField("version", e.target.value)}
                  placeholder="1.0.0"
                  className="font-mono"
                  style={{ minHeight: "var(--touch-target-min)" }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Schema Definition */}
        {step === 2 && (
          <div className="card flex flex-col gap-5">
            <h2 className="text-sm font-semibold text-text-primary">
              Schema Definition
            </h2>
            <p className="text-xs text-text-muted -mt-2">
              Define the input and output schema as JSON objects.
            </p>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="input-schema"
                className="text-xs font-medium text-text-secondary"
              >
                Input Schema
              </label>
              <textarea
                id="input-schema"
                rows={10}
                value={form.inputSchema}
                onChange={(e) => updateField("inputSchema", e.target.value)}
                className="font-mono text-xs"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
              {inputSchemaError && (
                <span className="flex items-center gap-1 text-2xs text-status-error">
                  <AlertCircle size={10} />
                  Invalid JSON
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="output-schema"
                className="text-xs font-medium text-text-secondary"
              >
                Output Schema
              </label>
              <textarea
                id="output-schema"
                rows={8}
                value={form.outputSchema}
                onChange={(e) => updateField("outputSchema", e.target.value)}
                className="font-mono text-xs"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
              {outputSchemaError && (
                <span className="flex items-center gap-1 text-2xs text-status-error">
                  <AlertCircle size={10} />
                  Invalid JSON
                </span>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Test */}
        {step === 3 && (
          <div className="card flex flex-col gap-5">
            <h2 className="text-sm font-semibold text-text-primary">
              Test Execution
            </h2>
            <p className="text-xs text-text-muted -mt-2">
              Provide sample input and test the tool before creating.
            </p>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="test-input"
                className="text-xs font-medium text-text-secondary"
              >
                Sample Input (JSON)
              </label>
              <textarea
                id="test-input"
                rows={6}
                value={form.testInput}
                onChange={(e) => updateField("testInput", e.target.value)}
                className="font-mono text-xs"
                style={{ minHeight: "var(--touch-target-min)" }}
              />
            </div>

            <button
              className="btn btn-secondary text-xs self-start"
              onClick={handleTest}
              disabled={testRunning}
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              {testRunning ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              {testRunning ? "Running..." : "Run Test"}
            </button>

            {testError && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-status-error/10 border border-status-error/20 text-status-error text-xs">
                <AlertCircle size={14} />
                {testError}
              </div>
            )}

            {testResult && (
              <div className="rounded-md bg-surface-base border border-border-default overflow-hidden">
                <div className="px-3 py-2 bg-surface-raised text-2xs text-text-muted uppercase tracking-wide font-semibold border-b border-border-default">
                  Test Result
                </div>
                <pre className="p-3 text-xs font-mono text-text-secondary overflow-x-auto leading-relaxed whitespace-pre-wrap">
                  {JSON.stringify(testResult, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Confirm */}
        {step === 4 && (
          <div className="card flex flex-col gap-5">
            <h2 className="text-sm font-semibold text-text-primary">
              Review & Create
            </h2>

            <div className="space-y-3">
              <SummaryRow label="Name" value={form.name} mono />
              <SummaryRow label="Description" value={form.description} />
              <SummaryRow label="Category" value={form.category} />
              <SummaryRow label="Version" value={form.version} mono />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-2xs text-text-muted uppercase tracking-wide font-semibold">
                Input Schema
              </span>
              <pre className="p-3 rounded-md bg-surface-base border border-border-default text-xs font-mono text-text-secondary overflow-x-auto leading-relaxed whitespace-pre-wrap">
                {form.inputSchema}
              </pre>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-2xs text-text-muted uppercase tracking-wide font-semibold">
                Output Schema
              </span>
              <pre className="p-3 rounded-md bg-surface-base border border-border-default text-xs font-mono text-text-secondary overflow-x-auto leading-relaxed whitespace-pre-wrap">
                {form.outputSchema}
              </pre>
            </div>
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex items-center justify-between mt-6">
          <button
            className="btn btn-ghost text-xs"
            onClick={() => (step === 1 ? navigate("/tools") : setStep(step - 1))}
            style={{ minHeight: "var(--touch-target-min)" }}
          >
            <ArrowLeft size={14} />
            {step === 1 ? "Cancel" : "Back"}
          </button>

          {step < 4 ? (
            <button
              className="btn btn-primary text-xs"
              onClick={() => setStep(step + 1)}
              disabled={!canAdvance}
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              Next
              <ArrowRight size={14} />
            </button>
          ) : (
            <button
              className="btn btn-primary text-xs"
              onClick={handleCreate}
              disabled={creating}
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              {creating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              {creating ? "Creating..." : "Create Tool"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* -- Summary row helper -------------------------------------------- */

function SummaryRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-text-muted w-24 shrink-0">{label}</span>
      <span
        className={`text-sm text-text-primary ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
