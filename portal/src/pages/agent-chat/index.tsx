import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import type { AgentInfo } from "../../lib/adapters";
import { apiRequest, useApiQuery } from "../../lib/api";

type RunResponse = {
  success: boolean;
  output: string;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  latency_ms: number;
  session_id?: string;
  trace_id?: string;
};

type ChatResponse = {
  response: string;
  turns: number;
  cost_usd: number;
};

export const AgentChatPage = () => {
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);

  const [agentName, setAgentName] = useState("");
  const [task, setTask] = useState("Give me a quick summary of this repository.");
  const [message, setMessage] = useState("What should I improve first?");
  const [sessionId, setSessionId] = useState("");
  const [loadingRun, setLoadingRun] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [error, setError] = useState("");
  const [runResult, setRunResult] = useState<RunResponse | null>(null);
  const [chatResult, setChatResult] = useState<ChatResponse | null>(null);

  const selectedAgent = agentName || agents[0]?.name || "";

  const runAgent = async () => {
    if (!selectedAgent || !task.trim()) {
      setError("Select an agent and provide a task.");
      return;
    }
    setError("");
    setLoadingRun(true);
    try {
      const result = await apiRequest<RunResponse>(`/api/v1/agents/${encodeURIComponent(selectedAgent)}/run`, "POST", {
        task,
      });
      setRunResult(result);
      if (result.session_id) {
        setSessionId(result.session_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run agent");
    } finally {
      setLoadingRun(false);
    }
  };

  const sendChatTurn = async () => {
    if (!selectedAgent || !message.trim()) {
      setError("Select an agent and provide a message.");
      return;
    }
    setError("");
    setLoadingChat(true);
    try {
      const url = `/api/v1/agents/${encodeURIComponent(selectedAgent)}/chat?message=${encodeURIComponent(message)}&session_id=${encodeURIComponent(sessionId)}`;
      const result = await apiRequest<ChatResponse>(url, "POST");
      setChatResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send chat turn");
    } finally {
      setLoadingChat(false);
    }
  };

  return (
    <div>
      <PageHeader title="Agent Chat" subtitle="Run and chat with agents directly from the portal" />

      <QueryState
        loading={agentsQuery.loading}
        error={agentsQuery.error}
        isEmpty={agents.length === 0}
        emptyMessage="No agents available."
        onRetry={() => void agentsQuery.refetch()}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card">
            <p className="font-semibold text-white mb-3">Run Agent Task</p>
            <span className="text-xs text-gray-500 mb-2">Agent</span>
            <select className="input-field" value={selectedAgent} onChange={(e) => setAgentName(e.target.value)}>
              {agents.map((agent) => (
                <option key={agent.name} value={agent.name}>
                  {agent.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-500 mt-3 mb-2">Task</span>
            <textarea className="input-field" value={task} onChange={(event) => setTask(event.target.value)} rows={5} />
            <button className="btn-primary mt-4" disabled={loadingRun} onClick={() => void runAgent()}>
              Run Task
            </button>
            {runResult ? (
              <div className="mt-4 space-y-2">
                <div className="flex gap-2">
                  <span className="badge">
                    {runResult.success ? "success" : "failed"}
                  </span>
                  <span className="badge">{runResult.turns} turns</span>
                  <span className="badge">{runResult.tool_calls} tools</span>
                  <span className="badge">${runResult.cost_usd.toFixed(6)}</span>
                </div>
                <pre className="max-h-80 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">{runResult.output || "(no output)"}</pre>
              </div>
            ) : null}
          </div>

          <div className="card">
            <p className="font-semibold text-white mb-3">Chat Turn</p>
            <span className="text-xs text-gray-500 mb-2">Session ID (optional)</span>
            <input
              className="w-full rounded-md border border-[#2a2a2a] px-2 py-1 text-sm"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="reuse session id to maintain continuity"
            />
            <span className="text-xs text-gray-500 mt-3 mb-2">Message</span>
            <textarea className="input-field" value={message} onChange={(event) => setMessage(event.target.value)} rows={5} />
            <button className="btn-primary mt-4" disabled={loadingChat} onClick={() => void sendChatTurn()}>
              Send Turn
            </button>
            {chatResult ? (
              <div className="mt-4 space-y-2">
                <div className="flex gap-2">
                  <span className="badge">{chatResult.turns} turns</span>
                  <span className="badge">${chatResult.cost_usd.toFixed(6)}</span>
                </div>
                <pre className="max-h-80 overflow-auto rounded bg-[#111] border border-[#2a2a2a] p-3 text-xs">{chatResult.response || "(no response)"}</pre>
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="card mt-6">
            <p className="text-red-500">{error}</p>
          </div>
        ) : null}
      </QueryState>
    </div>
  );
};
