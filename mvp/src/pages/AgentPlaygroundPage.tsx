import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Info, RefreshCw } from "lucide-react";
import { ChatInterface, type Message } from "../components/ChatInterface";
import { InfoBox } from "../components/ui/InfoBox";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";

interface AgentDetail {
  name: string;
  description: string;
  config_json: Record<string, any>;
  is_active: boolean;
  version: number;
}

let msgId = 0;

export default function AgentPlaygroundPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAgent = async () => {
    setPageLoading(true);
    setPageError(null);
    try {
      if (!id) throw new Error("Missing agent");
      const data = await api.get<AgentDetail>(`/agents/${agentPathSegment(id)}`);
      setAgent(data);
    } catch (err: any) {
      if (err.status === 404) {
        setAgent(null);
      } else {
        setPageError(err.message || "Failed to load agent");
      }
    } finally {
      setPageLoading(false);
    }
  };

  useEffect(() => {
    if (id) fetchAgent();
  }, [id]);

  const handleSend = useCallback(async (text: string) => {
    if (!id) return;
    const userMsg: Message = { id: String(++msgId), role: "user", content: text, timestamp: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      // Try runtime-proxy first, fall back to public endpoint
      let response: string;
      try {
        const result = await api.post<{ output?: string; result?: string; response?: string }>(`/runtime-proxy/agent/run`, {
          agent_name: id,
          task: text,
        });
        response = result.output || result.result || result.response || JSON.stringify(result);
      } catch {
        // Fallback: public API
        const res = await fetch(`https://agentos-control-plane.servesys.workers.dev/v1/agents/${agentPathSegment(id)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: text }),
        });
        const result = await res.json();
        response = result.output || result.result || result.response || JSON.stringify(result);
      }

      const assistantMsg: Message = {
        id: String(++msgId),
        role: "assistant",
        content: response,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: Message = {
        id: String(++msgId),
        role: "assistant",
        content: `Error: ${err.message || "Failed to get response"}. Please try again.`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }, [id]);

  if (pageLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (pageError) {
    return (
      <div className="text-center py-20">
        <p className="text-text-secondary text-sm mb-4">{pageError}</p>
        <Button variant="secondary" onClick={fetchAgent}>
          <RefreshCw size={14} /> Retry
        </Button>
      </div>
    );
  }

  if (!agent) return <AgentNotFound />;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <AgentNav agentName={agent.name} />

      {/* Info bar */}
      <InfoBox variant="info" icon={<Info size={14} />} className="mt-3">
        This is a test environment. Messages here are not visible to your customers.
      </InfoBox>

      {/* Chat */}
      <div className="flex-1 min-h-0 mt-2">
        <ChatInterface
          messages={messages}
          onSend={handleSend}
          loading={loading}
          placeholder={`Message ${agent.name}...`}
        />
      </div>
    </div>
  );
}
