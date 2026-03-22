import { Badge, Button, Card, Select, SelectItem, Text, Textarea } from "@tremor/react";
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
          <Card>
            <Text className="font-semibold mb-3">Run Agent Task</Text>
            <Text className="text-xs text-gray-500 mb-2">Agent</Text>
            <Select value={selectedAgent} onValueChange={setAgentName}>
              {agents.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  {agent.name}
                </SelectItem>
              ))}
            </Select>
            <Text className="text-xs text-gray-500 mt-3 mb-2">Task</Text>
            <Textarea value={task} onChange={(event) => setTask(event.target.value)} rows={5} />
            <Button className="mt-4" loading={loadingRun} onClick={() => void runAgent()}>
              Run Task
            </Button>
            {runResult ? (
              <div className="mt-4 space-y-2">
                <div className="flex gap-2">
                  <Badge color={runResult.success ? "green" : "red"}>
                    {runResult.success ? "success" : "failed"}
                  </Badge>
                  <Badge>{runResult.turns} turns</Badge>
                  <Badge>{runResult.tool_calls} tools</Badge>
                  <Badge>${runResult.cost_usd.toFixed(6)}</Badge>
                </div>
                <pre className="max-h-80 overflow-auto rounded bg-gray-50 p-3 text-xs">{runResult.output || "(no output)"}</pre>
              </div>
            ) : null}
          </Card>

          <Card>
            <Text className="font-semibold mb-3">Chat Turn</Text>
            <Text className="text-xs text-gray-500 mb-2">Session ID (optional)</Text>
            <input
              className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="reuse session id to maintain continuity"
            />
            <Text className="text-xs text-gray-500 mt-3 mb-2">Message</Text>
            <Textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={5} />
            <Button className="mt-4" loading={loadingChat} onClick={() => void sendChatTurn()}>
              Send Turn
            </Button>
            {chatResult ? (
              <div className="mt-4 space-y-2">
                <div className="flex gap-2">
                  <Badge>{chatResult.turns} turns</Badge>
                  <Badge>${chatResult.cost_usd.toFixed(6)}</Badge>
                </div>
                <pre className="max-h-80 overflow-auto rounded bg-gray-50 p-3 text-xs">{chatResult.response || "(no response)"}</pre>
              </div>
            ) : null}
          </Card>
        </div>

        {error ? (
          <Card className="mt-6">
            <Text className="text-red-600">{error}</Text>
          </Card>
        ) : null}
      </QueryState>
    </div>
  );
};
