import { useState, useEffect, useCallback } from "react";
import { Bot, Trash2, Wifi, WifiOff, Settings2 } from "lucide-react";
import { ChatInterface } from "../components/ChatInterface";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { api } from "../lib/api";
import { useAgentStream } from "../lib/use-agent-stream";
import { useNavigate } from "react-router-dom";

const AGENT_NAME = "my-assistant";

interface AgentInfo {
  name: string;
  description: string;
  config_json: Record<string, any>;
}

export default function MyAssistantPage() {
  const navigate = useNavigate();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const { messages, streaming, sessionMeta, send, stop, clear } = useAgentStream();

  useEffect(() => {
    api.get<AgentInfo>(`/agents/${AGENT_NAME}`)
      .then(setAgent)
      .catch(() => setAgent(null))
      .finally(() => setLoading(false));
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      if (!agent) return;
      send(agent.name, text);
    },
    [agent, send],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-4rem)] text-center px-4">
        <Bot size={48} className="text-text-muted mb-4" />
        <h2 className="text-lg font-semibold text-text mb-2">No personal assistant yet</h2>
        <p className="text-sm text-text-secondary mb-6 max-w-md">
          Your personal assistant is created automatically when you sign up.
          If you don't have one, you can create it manually.
        </p>
        <Button onClick={() => navigate("/agents/new?kind=personal")}>
          Create personal assistant
        </Button>
      </div>
    );
  }

  const toolCount = (agent.config_json?.tools || []).length;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary-light flex items-center justify-center">
            <Bot size={20} className="text-primary" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-text flex items-center gap-2">
              My Assistant
              <Badge variant="info">{toolCount} tools</Badge>
            </h1>
            <p className="text-xs text-text-secondary">
              Web search, code execution, file ops, marketplace delegation
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sessionMeta && (
            <span className="text-xs text-text-muted flex items-center gap-1">
              {streaming ? <Wifi size={12} className="text-success" /> : <WifiOff size={12} />}
              {sessionMeta.total_cost_usd !== undefined && `$${sessionMeta.total_cost_usd.toFixed(4)}`}
            </span>
          )}
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear} title="New conversation">
              <Trash2 size={14} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/agents/${AGENT_NAME}/settings`)}
            title="Agent settings"
          >
            <Settings2 size={14} />
          </Button>
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 min-h-0">
        <ChatInterface
          messages={messages}
          onSend={handleSend}
          onStop={stop}
          streaming={streaming}
          sessionMeta={sessionMeta}
          placeholder="Ask anything — search the web, run code, analyze data, hire specialists..."
        />
      </div>
    </div>
  );
}
