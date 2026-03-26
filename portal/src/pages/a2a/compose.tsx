import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Send,
  Network,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { FormField } from "../../components/common/FormField";
import { useApiQuery, useApiMutation } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type A2AAgent = {
  agent_id: string;
  name: string;
  description?: string;
  url?: string;
  status?: string;
  skills?: Array<{ name: string; description?: string }>;
};

type TaskSubmission = {
  target_agent_id: string;
  message: string;
  skill?: string;
  metadata?: Record<string, unknown>;
};

type TaskResponse = {
  task_id: string;
  status: string;
  result?: unknown;
  error?: string;
};

/* ── Compose Task Page ──────────────────────────────────────────── */

export function A2AComposePage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const { data: agentsData, loading: agentsLoading, error: agentsError } = useApiQuery<A2AAgent[]>(
    "/api/v1/a2a/agents",
  );

  const agents = useMemo(() => agentsData ?? [], [agentsData]);

  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [message, setMessage] = useState("");
  const [selectedSkill, setSelectedSkill] = useState("");

  const submitMutation = useApiMutation<TaskResponse, TaskSubmission>(
    "/api/v1/a2a/tasks",
    "POST",
  );

  const selectedAgent = useMemo(
    () => agents.find((a) => a.agent_id === selectedAgentId),
    [agents, selectedAgentId],
  );

  const handleSubmit = async () => {
    if (!selectedAgentId || !message.trim()) {
      showToast("Please select an agent and enter a message", "error");
      return;
    }

    try {
      const body: TaskSubmission = {
        target_agent_id: selectedAgentId,
        message: message.trim(),
        ...(selectedSkill ? { skill: selectedSkill } : {}),
      };
      await submitMutation.mutate(body);
      showToast("Task submitted successfully", "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to submit task",
        "error",
      );
    }
  };

  return (
    <div>
      <div className="mb-4">
        <button
          className="btn btn-secondary text-xs"
          onClick={() => navigate("/a2a")}
        >
          <ArrowLeft size={14} />
          Back to A2A
        </button>
      </div>

      <PageHeader
        title="Compose Task"
        subtitle="Send a task to an A2A agent"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Task form */}
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-4">
            Task Details
          </h3>

          <QueryState
            loading={agentsLoading}
            error={agentsError}
            isEmpty={agents.length === 0}
            emptyMessage="No A2A agents available"
            onRetry={() => {}}
          >
            <div className="space-y-4">
              <FormField label="Target Agent" htmlFor="target-agent" required>
                <select
                  id="target-agent"
                  value={selectedAgentId}
                  onChange={(e) => {
                    setSelectedAgentId(e.target.value);
                    setSelectedSkill("");
                  }}
                  className="text-sm"
                >
                  <option value="">Select an agent...</option>
                  {agents.map((agent) => (
                    <option key={agent.agent_id} value={agent.agent_id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </FormField>

              {selectedAgent?.skills && selectedAgent.skills.length > 0 && (
                <FormField label="Skill (optional)" htmlFor="skill">
                  <select
                    id="skill"
                    value={selectedSkill}
                    onChange={(e) => setSelectedSkill(e.target.value)}
                    className="text-sm"
                  >
                    <option value="">Auto-detect</option>
                    {selectedAgent.skills.map((skill) => (
                      <option key={skill.name} value={skill.name}>
                        {skill.name}
                      </option>
                    ))}
                  </select>
                </FormField>
              )}

              <FormField label="Message" htmlFor="task-message" required>
                <textarea
                  id="task-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  className="text-sm"
                  placeholder="Describe the task you want the agent to perform..."
                />
              </FormField>

              <button
                className="btn btn-primary text-xs w-full"
                onClick={() => void handleSubmit()}
                disabled={submitMutation.loading || !selectedAgentId || !message.trim()}
              >
                {submitMutation.loading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send size={14} />
                    Submit Task
                  </>
                )}
              </button>
            </div>
          </QueryState>
        </div>

        {/* Result panel */}
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-4">
            Response
          </h3>

          {!submitMutation.data && !submitMutation.error && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Network size={32} className="text-text-muted mb-3" />
              <p className="text-xs text-text-muted">
                Submit a task to see the response here
              </p>
            </div>
          )}

          {submitMutation.error && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-status-error/10 border border-status-error/20">
              <AlertCircle size={14} className="text-status-error flex-shrink-0" />
              <span className="text-xs text-status-error">
                {submitMutation.error}
              </span>
            </div>
          )}

          {submitMutation.data && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 rounded-md bg-status-live/10 border border-status-live/20">
                <CheckCircle2 size={14} className="text-status-live flex-shrink-0" />
                <div>
                  <p className="text-xs text-text-primary font-medium">
                    Task ID: {submitMutation.data.task_id}
                  </p>
                  <p className="text-[10px] text-text-muted">
                    Status: {submitMutation.data.status}
                  </p>
                </div>
              </div>

              {submitMutation.data.result != null && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Result
                  </label>
                  <pre className="text-xs font-mono bg-surface-base border border-border-default rounded-md p-4 overflow-x-auto max-h-60">
                    {typeof submitMutation.data.result === "string"
                      ? submitMutation.data.result
                      : JSON.stringify(submitMutation.data.result, null, 2) as string}
                  </pre>
                </div>
              )}

              {submitMutation.data.error && (
                <div className="flex items-center gap-2 p-3 rounded-md bg-status-error/10 border border-status-error/20">
                  <AlertCircle size={14} className="text-status-error flex-shrink-0" />
                  <span className="text-xs text-status-error">
                    {submitMutation.data.error}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { A2AComposePage as default };
