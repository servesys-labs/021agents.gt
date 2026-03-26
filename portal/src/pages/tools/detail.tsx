import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Play,
  Wrench,
  AlertCircle,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { useApiQuery, apiFetch } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type Tool = {
  name: string;
  description?: string;
  type?: string;
  category?: string;
  status?: string;
  version?: string;
  schema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

type ExecuteResponse = {
  result?: unknown;
  error?: string;
  duration_ms?: number;
};

/* ── Tool Detail Page ───────────────────────────────────────────── */

export function ToolDetailPage() {
  const { toolName } = useParams<{ toolName: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const { data: tool, loading, error, refetch } = useApiQuery<Tool>(
    `/api/v1/tools/${encodeURIComponent(toolName ?? "")}`,
    Boolean(toolName),
  );

  /* ── Execute state ─────────────────────────────────────────── */
  const [executeInput, setExecuteInput] = useState("{}");
  const [executing, setExecuting] = useState(false);
  const [executeResult, setExecuteResult] = useState<ExecuteResponse | null>(null);

  const handleExecute = async () => {
    if (!toolName) return;
    setExecuting(true);
    setExecuteResult(null);
    try {
      const body = JSON.parse(executeInput);
      const result = await apiFetch<ExecuteResponse>(
        `/api/v1/tools/${encodeURIComponent(toolName)}/execute`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      setExecuteResult(result);
      showToast("Tool executed successfully", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Execution failed";
      setExecuteResult({ error: message });
      showToast(message, "error");
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div>
      <div className="mb-4">
        <button
          className="btn btn-secondary text-xs"
          onClick={() => navigate("/tools")}
        >
          <ArrowLeft size={14} />
          Back to Tools
        </button>
      </div>

      <QueryState
        loading={loading}
        error={error}
        isEmpty={!tool}
        emptyMessage=""
        onRetry={() => void refetch()}
      >
        {!tool ? (
          <EmptyState
            icon={<Wrench size={40} />}
            title="Tool not found"
            description={`No tool found with name "${toolName}".`}
          />
        ) : (
          <>
            <PageHeader
              title={tool.name}
              subtitle={tool.description || "No description"}
              onRefresh={() => void refetch()}
            />

            {/* Tool info */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <div className="card">
                <h3 className="text-sm font-semibold text-text-primary mb-3">
                  Details
                </h3>
                <dl className="space-y-2">
                  {[
                    ["Type", tool.type || "function"],
                    ["Category", tool.category || "--"],
                    ["Status", tool.status || "active"],
                    ["Version", tool.version || "--"],
                    ["Created", tool.created_at ? new Date(tool.created_at).toLocaleString() : "--"],
                    ["Updated", tool.updated_at ? new Date(tool.updated_at).toLocaleString() : "--"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between">
                      <dt className="text-xs text-text-muted">{label}</dt>
                      <dd className="text-xs text-text-primary font-mono">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              {/* Schema */}
              <div className="card">
                <h3 className="text-sm font-semibold text-text-primary mb-3">
                  Schema
                </h3>
                <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-60">
                  {JSON.stringify(tool.schema ?? tool.parameters ?? {}, null, 2)}
                </pre>
              </div>
            </div>

            {/* Execute section */}
            <div className="card">
              <h3 className="text-sm font-semibold text-text-primary mb-3">
                Execute Tool
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Input (JSON)
                  </label>
                  <textarea
                    value={executeInput}
                    onChange={(e) => setExecuteInput(e.target.value)}
                    rows={4}
                    className="w-full text-xs font-mono"
                    placeholder='{"key": "value"}'
                  />
                </div>
                <button
                  className="btn btn-primary text-xs"
                  onClick={() => void handleExecute()}
                  disabled={executing}
                >
                  {executing ? (
                    "Executing..."
                  ) : (
                    <>
                      <Play size={14} />
                      Execute
                    </>
                  )}
                </button>

                {/* Result */}
                {executeResult && (
                  <div className="mt-3">
                    <label className="block text-xs text-text-muted mb-1">
                      Result
                    </label>
                    {executeResult.error ? (
                      <div className="flex items-center gap-2 p-3 rounded-md bg-status-error/10 border border-status-error/20">
                        <AlertCircle size={14} className="text-status-error" />
                        <span className="text-xs text-status-error">
                          {executeResult.error}
                        </span>
                      </div>
                    ) : (
                      <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-60">
                        {JSON.stringify(executeResult.result ?? executeResult, null, 2)}
                      </pre>
                    )}
                    {executeResult.duration_ms != null && (
                      <p className="text-[10px] text-text-muted mt-1">
                        Duration: {executeResult.duration_ms}ms
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}

export { ToolDetailPage as default };
