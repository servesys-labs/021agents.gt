import { useState, useCallback } from "react";
import {
  Send,
  ArrowRight,
  CheckCircle2,
  Circle,
  Loader2,
  Clock,
  Bot,
  FileJson,
  Copy,
  Check,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";

/* ── Types ──────────────────────────────────────────────────────── */

type TaskStatus = "idle" | "submitted" | "accepted" | "in-progress" | "completed" | "failed";

interface AgentOption {
  id: string;
  name: string;
  provider: string;
}

interface TaskResponse {
  taskId: string;
  status: TaskStatus;
  result?: Record<string, unknown>;
  error?: string;
  timestamps: {
    submitted?: string;
    accepted?: string;
    started?: string;
    completed?: string;
  };
}

/* ── Mock data ──────────────────────────────────────────────────── */

const AGENTS: AgentOption[] = [
  { id: "local_001", name: "MyAssistant", provider: "Local" },
  { id: "local_002", name: "DataProcessor", provider: "Local" },
  { id: "local_003", name: "ContentWriter", provider: "Local" },
  { id: "a2a_001", name: "ResearchBot", provider: "Acme AI" },
  { id: "a2a_002", name: "DataTransformer", provider: "DataCorp" },
  { id: "a2a_003", name: "CodeReviewer", provider: "DevTools Inc" },
  { id: "a2a_004", name: "TranslationHub", provider: "LinguaAI" },
  { id: "a2a_006", name: "ImageAnalyzer", provider: "VisionLabs" },
];

const MOCK_RESPONSE: Record<string, unknown> = {
  taskId: "task_abc123",
  status: "completed",
  output: {
    summary: "Analysis complete. Found 3 key insights from the provided data.",
    insights: [
      "Revenue growth of 23% quarter-over-quarter",
      "Customer churn reduced to 2.1%",
      "Top-performing region: North America",
    ],
    confidence: 0.94,
    processingTimeMs: 2340,
  },
};

/* ── Status step config ─────────────────────────────────────────── */

const STATUS_STEPS: { key: TaskStatus; label: string }[] = [
  { key: "submitted", label: "Submitted" },
  { key: "accepted", label: "Accepted" },
  { key: "in-progress", label: "In Progress" },
  { key: "completed", label: "Completed" },
];

const STATUS_ORDER: Record<string, number> = {
  idle: -1,
  submitted: 0,
  accepted: 1,
  "in-progress": 2,
  completed: 3,
  failed: 3,
};

/* ── Component ──────────────────────────────────────────────────── */

export function A2AComposePage() {
  const [sourceAgent, setSourceAgent] = useState("");
  const [targetAgent, setTargetAgent] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [inputData, setInputData] = useState('{\n  "query": "Analyze Q1 2026 revenue data",\n  "format": "summary"\n}');
  const [taskStatus, setTaskStatus] = useState<TaskStatus>("idle");
  const [taskResponse, setTaskResponse] = useState<TaskResponse | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const validateJson = useCallback((value: string): boolean => {
    try {
      JSON.parse(value);
      setJsonError(null);
      return true;
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : "Invalid JSON");
      return false;
    }
  }, []);

  const handleSendTask = useCallback(async () => {
    if (!sourceAgent || !targetAgent || !taskTitle) return;
    if (!validateJson(inputData)) return;

    const now = new Date().toISOString();

    // Simulate task progression
    setTaskStatus("submitted");
    setTaskResponse({
      taskId: `task_${Date.now()}`,
      status: "submitted",
      timestamps: { submitted: now },
    });

    await new Promise((r) => setTimeout(r, 800));

    setTaskStatus("accepted");
    setTaskResponse((prev) =>
      prev
        ? { ...prev, status: "accepted", timestamps: { ...prev.timestamps, accepted: new Date().toISOString() } }
        : null,
    );

    await new Promise((r) => setTimeout(r, 1200));

    setTaskStatus("in-progress");
    setTaskResponse((prev) =>
      prev
        ? { ...prev, status: "in-progress", timestamps: { ...prev.timestamps, started: new Date().toISOString() } }
        : null,
    );

    await new Promise((r) => setTimeout(r, 2000));

    setTaskStatus("completed");
    setTaskResponse((prev) =>
      prev
        ? {
            ...prev,
            status: "completed",
            result: MOCK_RESPONSE,
            timestamps: { ...prev.timestamps, completed: new Date().toISOString() },
          }
        : null,
    );
  }, [sourceAgent, targetAgent, taskTitle, inputData, validateJson]);

  const handleReset = useCallback(() => {
    setTaskStatus("idle");
    setTaskResponse(null);
  }, []);

  const handleCopyResponse = useCallback(() => {
    if (taskResponse?.result) {
      navigator.clipboard.writeText(JSON.stringify(taskResponse.result, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [taskResponse]);

  const canSend =
    sourceAgent && targetAgent && taskTitle.trim() && taskStatus === "idle";

  return (
    <div className="max-w-[1000px] mx-auto">
      <PageHeader
        title="Compose Task"
        subtitle="Send cross-agent tasks via the A2A protocol"
        icon={<Send size={20} />}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[var(--space-6)]">
        {/* Left: Task definition */}
        <div className="space-y-[var(--space-4)]">
          {/* Agent selection */}
          <div className="card glass-light">
            <h3 className="text-[var(--text-xs)] font-semibold text-text-muted uppercase tracking-wide mb-[var(--space-4)]">
              Agents
            </h3>

            <div className="flex items-center gap-[var(--space-3)]">
              <div className="flex-1">
                <label className="block text-[var(--text-xs)] text-text-muted mb-[var(--space-1)]">
                  Source Agent
                </label>
                <select
                  value={sourceAgent}
                  onChange={(e) => setSourceAgent(e.target.value)}
                  className="bg-surface-base min-h-[var(--touch-target-min)]"
                >
                  <option value="">Select source...</option>
                  {AGENTS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.provider})
                    </option>
                  ))}
                </select>
              </div>

              <ArrowRight
                size={16}
                className="text-text-muted flex-shrink-0 mt-5"
              />

              <div className="flex-1">
                <label className="block text-[var(--text-xs)] text-text-muted mb-[var(--space-1)]">
                  Target Agent
                </label>
                <select
                  value={targetAgent}
                  onChange={(e) => setTargetAgent(e.target.value)}
                  className="bg-surface-base min-h-[var(--touch-target-min)]"
                >
                  <option value="">Select target...</option>
                  {AGENTS.filter((a) => a.id !== sourceAgent).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.provider})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Task details */}
          <div className="card glass-light">
            <h3 className="text-[var(--text-xs)] font-semibold text-text-muted uppercase tracking-wide mb-[var(--space-4)]">
              Task Definition
            </h3>

            <div className="space-y-[var(--space-3)]">
              <div>
                <label className="block text-[var(--text-xs)] text-text-muted mb-[var(--space-1)]">
                  Title
                </label>
                <input
                  type="text"
                  placeholder="e.g. Analyze Q1 Revenue Data"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  className="bg-surface-base min-h-[var(--touch-target-min)]"
                />
              </div>

              <div>
                <label className="block text-[var(--text-xs)] text-text-muted mb-[var(--space-1)]">
                  Description
                </label>
                <textarea
                  placeholder="Describe what this task should accomplish..."
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  rows={3}
                  className="bg-surface-base resize-y"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-[var(--space-1)]">
                  <label className="text-[var(--text-xs)] text-text-muted flex items-center gap-[var(--space-1)]">
                    <FileJson size={10} />
                    Input Data (JSON)
                  </label>
                  {jsonError && (
                    <span className="text-[10px] text-status-error">
                      {jsonError}
                    </span>
                  )}
                </div>
                <textarea
                  value={inputData}
                  onChange={(e) => {
                    setInputData(e.target.value);
                    validateJson(e.target.value);
                  }}
                  rows={6}
                  className={`bg-surface-base font-mono text-[var(--text-sm)] resize-y ${
                    jsonError ? "border-status-error" : ""
                  }`}
                  spellCheck={false}
                />
              </div>
            </div>
          </div>

          {/* Send button */}
          <div className="flex gap-[var(--space-3)]">
            <button
              onClick={handleSendTask}
              disabled={!canSend}
              className="btn btn-primary flex-1 min-h-[var(--touch-target-min)]"
            >
              <Send size={14} />
              Send Task
            </button>
            {taskStatus !== "idle" && (
              <button
                onClick={handleReset}
                className="btn btn-secondary min-h-[var(--touch-target-min)]"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Right: Status tracker + response */}
        <div className="space-y-[var(--space-4)]">
          {/* Status tracker */}
          <div className="card glass-light">
            <h3 className="text-[var(--text-xs)] font-semibold text-text-muted uppercase tracking-wide mb-[var(--space-6)]">
              Task Status
            </h3>

            <div className="space-y-[var(--space-1)]">
              {STATUS_STEPS.map((step, i) => {
                const currentOrder = STATUS_ORDER[taskStatus] ?? -1;
                const stepOrder = STATUS_ORDER[step.key] ?? 0;
                const isActive = taskStatus === step.key;
                const isCompleted = currentOrder > stepOrder;
                const isPending = currentOrder < stepOrder;
                const isFailed = taskStatus === "failed" && step.key === "completed";

                return (
                  <div key={step.key} className="flex items-start gap-[var(--space-3)]">
                    {/* Step icon + connector line */}
                    <div className="flex flex-col items-center">
                      <div className="w-8 h-8 flex items-center justify-center">
                        {isCompleted ? (
                          <CheckCircle2
                            size={18}
                            className="text-status-live"
                          />
                        ) : isActive ? (
                          <Loader2
                            size={18}
                            className="text-accent animate-spin"
                          />
                        ) : isFailed ? (
                          <Circle
                            size={18}
                            className="text-status-error"
                          />
                        ) : (
                          <Circle
                            size={18}
                            className="text-text-muted/30"
                          />
                        )}
                      </div>
                      {i < STATUS_STEPS.length - 1 && (
                        <div
                          className={`w-0.5 h-6 rounded-full ${
                            isCompleted
                              ? "bg-status-live/40"
                              : "bg-border-default"
                          }`}
                        />
                      )}
                    </div>

                    {/* Label + timestamp */}
                    <div className="pt-1">
                      <p
                        className={`text-[var(--text-sm)] font-medium ${
                          isCompleted || isActive
                            ? "text-text-primary"
                            : "text-text-muted"
                        }`}
                      >
                        {step.label}
                      </p>
                      {taskResponse?.timestamps &&
                        (() => {
                          const tsMap: Record<string, string | undefined> = {
                            submitted: taskResponse.timestamps.submitted,
                            accepted: taskResponse.timestamps.accepted,
                            "in-progress": taskResponse.timestamps.started,
                            completed: taskResponse.timestamps.completed,
                          };
                          const ts = tsMap[step.key];
                          return ts ? (
                            <p className="text-[10px] text-text-muted font-mono flex items-center gap-[var(--space-1)]">
                              <Clock size={9} />
                              {new Date(ts).toLocaleTimeString()}
                            </p>
                          ) : null;
                        })()}
                    </div>
                  </div>
                );
              })}
            </div>

            {taskStatus === "idle" && (
              <div className="flex flex-col items-center py-[var(--space-8)] text-center">
                <Bot size={24} className="text-text-muted/30 mb-[var(--space-3)]" />
                <p className="text-[var(--text-sm)] text-text-muted">
                  Configure and send a task to see status updates
                </p>
              </div>
            )}
          </div>

          {/* Response viewer */}
          {taskResponse?.result && (
            <div className="card glass-light">
              <div className="flex items-center justify-between mb-[var(--space-3)]">
                <h3 className="text-[var(--text-xs)] font-semibold text-text-muted uppercase tracking-wide">
                  Response
                </h3>
                <button
                  onClick={handleCopyResponse}
                  className="btn btn-ghost text-[var(--text-xs)] min-h-[var(--touch-target-min)] px-[var(--space-2)]"
                  title="Copy response JSON"
                >
                  {copied ? (
                    <>
                      <Check size={12} className="text-status-live" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      Copy
                    </>
                  )}
                </button>
              </div>
              <pre className="text-[var(--text-xs)] text-text-secondary font-mono bg-surface-base rounded-lg p-[var(--space-4)] overflow-x-auto border border-border-default leading-relaxed max-h-[400px] overflow-y-auto">
                {JSON.stringify(taskResponse.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { A2AComposePage as default };
