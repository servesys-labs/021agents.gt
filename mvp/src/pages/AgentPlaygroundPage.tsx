import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Info, RefreshCw, Trash2, Sparkles, Plus, History } from "lucide-react";
import { MetaAgentPanel } from "../components/MetaAgentPanel";
import { ChatInterface } from "../components/ChatInterface";
import { InfoBox } from "../components/ui/InfoBox";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";
import { useAgentStream, loadSessionList, type StoredSession } from "../lib/use-agent-stream";
import { agentPathSegment } from "../lib/agent-path";

interface AgentDetail {
  name: string;
  description: string;
  config_json: Record<string, any>;
  is_active: boolean;
  version: number;
}

export default function AgentPlaygroundPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const { messages, streaming, sessionMeta, send, stop, clear, loadHistory } = useAgentStream();
  const [metaOpen, setMetaOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<StoredSession[]>([]);

  const handleNewSession = useCallback(() => {
    // Clear frontend + generate new session ID → next message goes to a NEW DO instance
    clear();
    if (agent) {
      setSessions(loadSessionList(agent.name));
    }
  }, [agent, clear]);

  const fetchAgent = async () => {
    setPageLoading(true);
    setPageError(null);
    try {
      if (!id) throw new Error("Missing agent");
      const data = await api.get<AgentDetail>(`/agents/${agentPathSegment(id)}`);
      setAgent(data);
      loadHistory(data.name);
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

  const handleSend = useCallback(
    (text: string) => {
      if (!agent) return;
      send(agent.name, text);
    },
    [agent, send],
  );

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

  const model = agent.config_json?.model || "default";
  const plan = agent.config_json?.plan || "standard";
  const toolCount = (agent as any).tools?.length || (agent.config_json?.tools || []).length;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <AgentNav agentName={agent.name} />

      {/* Info bar with agent metadata */}
      <div className="flex items-center justify-between px-4 mt-3">
        <InfoBox variant="info" icon={<Info size={14} />} className="flex-1">
          <span className="font-medium">{agent.name}</span>
          <span className="mx-2 text-text-muted">|</span>
          <span className="text-text-secondary">{model.split("/").pop()}</span>
          <span className="mx-2 text-text-muted">|</span>
          <span className="capitalize text-text-secondary">{plan}</span>
          <span className="mx-2 text-text-muted">|</span>
          <span className="text-text-secondary">{toolCount} tools</span>
        </InfoBox>
        <div className="flex items-center gap-1 ml-2">
          <Button variant="ghost" size="sm" onClick={handleNewSession} title="New conversation">
            <Plus size={14} /> New
          </Button>
          <div className="relative">
            <Button
              variant="ghost" size="sm"
              onClick={() => { if (agent) setSessions(loadSessionList(agent.name)); setSessionsOpen(!sessionsOpen); }}
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
                    onClick={() => { if (agent) loadHistory(agent.name, s.id); setSessionsOpen(false); }}
                    className="w-full px-3 py-2 text-left hover:bg-surface-alt transition-colors border-b border-border/30 last:border-0"
                  >
                    <p className="text-xs font-medium text-text truncate">{s.title}</p>
                    <p className="text-[10px] text-text-muted mt-0.5">{s.messageCount} messages · {new Date(s.updatedAt).toLocaleDateString()}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setMetaOpen(true)} title="Improve this agent">
            <Sparkles size={14} />
          </Button>
        </div>
      </div>

      {/* Meta-agent panel */}
      <MetaAgentPanel agentName={agent.name} open={metaOpen} onClose={() => setMetaOpen(false)} context="test" />

      {/* Chat */}
      <div className="flex-1 min-h-0 mt-2">
        <ChatInterface
          messages={messages}
          onSend={handleSend}
          onStop={stop}
          streaming={streaming}
          sessionMeta={sessionMeta}
          placeholder={`Message ${agent.name}...`}
        />
      </div>
    </div>
  );
}
