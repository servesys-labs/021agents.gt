import { useState, useEffect, useCallback } from "react";
import { Bot, Trash2, Wifi, WifiOff, Settings2, Plus, Sparkles, History, ChevronDown, X } from "lucide-react";
import { MetaAgentPanel } from "../components/MetaAgentPanel";
import { ChatInterface } from "../components/ChatInterface";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { api } from "../lib/api";
import { useAgentStream, loadSessionList, deleteSession, type StoredSession } from "../lib/use-agent-stream";
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
  const { messages, streaming, sessionMeta, send, stop, clear, loadHistory } = useAgentStream();
  const [metaOpen, setMetaOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<StoredSession[]>([]);

  useEffect(() => {
    api.get<AgentInfo>(`/agents/${AGENT_NAME}`)
      .then((a) => {
        setAgent(a);
        loadHistory(AGENT_NAME);
        setSessions(loadSessionList(AGENT_NAME));
      })
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { clear(); setSessions(loadSessionList(AGENT_NAME)); }}
            title="New conversation"
            className="flex items-center gap-1"
          >
            <Plus size={14} /> New
          </Button>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setSessions(loadSessionList(AGENT_NAME)); setSessionsOpen(!sessionsOpen); }}
              title="Session history"
            >
              <History size={14} />
            </Button>
            {sessionsOpen && sessions.length > 0 && (
              <div className="absolute right-0 top-full mt-1 w-72 max-h-80 overflow-y-auto bg-surface border border-border rounded-xl shadow-lg z-50">
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-xs font-medium text-text-secondary">Recent conversations</p>
                </div>
                {sessions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => {
                      loadHistory(AGENT_NAME, s.id);
                      setSessionsOpen(false);
                    }}
                    className="w-full px-3 py-2 text-left hover:bg-surface-alt transition-colors border-b border-border/30 last:border-0 group"
                  >
                    <p className="text-xs font-medium text-text truncate">{s.title}</p>
                    <p className="text-[10px] text-text-muted mt-0.5">
                      {s.messageCount} messages · {new Date(s.updatedAt).toLocaleDateString()}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMetaOpen(true)}
            title="Improve this assistant"
          >
            <Sparkles size={14} />
          </Button>
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
          suggestedPrompts={[
            "Search the web for today's top AI news",
            "Write a Python script to analyze my CSV data",
            "Find the best deals on a laptop under $1000",
            "Draft a professional email to a client",
          ]}
        />
      </div>

      {/* Meta-agent panel */}
      <MetaAgentPanel agentName={AGENT_NAME} open={metaOpen} onClose={() => setMetaOpen(false)} context="test" />
    </div>
  );
}
