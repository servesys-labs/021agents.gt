import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Info, RefreshCw, Trash2, Sparkles, Plus, History, FolderOpen, Eye, FolderClosed } from "lucide-react";
import { MetaAgentPanel } from "../components/MetaAgentPanel";
import { ArtifactPreview } from "../components/ArtifactPreview";
import { WorkspaceFiles } from "../components/WorkspaceFiles";
import { ChatInterface, type WorkspaceProject } from "../components/ChatInterface";
import { CompanionWidget } from "../components/CompanionWidget";
import { InfoBox } from "../components/ui/InfoBox";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAgentStream, loadSessionList, fetchServerSessions, type StoredSession } from "../lib/use-agent-stream";
import { useAutopilot } from "../lib/use-autopilot";
import { agentPathSegment } from "../lib/agent-path";
import { timeAgo } from "../lib/time-ago";

type RightPanel = "closed" | "preview" | "files" | "meta";

interface AgentDetail {
  name: string;
  description: string;
  config_json: Record<string, any>;
  is_active: boolean;
  version: number;
  tools?: string[];
}

export default function AgentPlaygroundPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const { user } = useAuth();

  const { messages, streaming, sessionMeta, send, stop, clear, loadHistory, retry, setPlan } = useAgentStream();
  const autopilot = useAutopilot(agent?.name || "");
  const [activePlan, setActivePlan] = useState("standard");
  const [rightPanel, setRightPanel] = useState<RightPanel>("closed");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);

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
      const cached = loadSessionList(data.name);
      if (cached.length > 0) setSessions(cached);
      // Server is source of truth
      fetchServerSessions(data.name, 30).then(s => {
        setSessions(s.length > 0 ? s : cached);
      });
      // Load workspace projects from R2 via the list-project-versions tool pattern
      try {
        const res = await api.get<{ projects?: Array<{ name: string; last_sync?: string; file_count?: number }> }>(
          `/workspace/projects?agent_name=${encodeURIComponent(data.name)}`,
        );
        if (res.projects) {
          setProjects(res.projects.map(p => ({ name: p.name, lastSync: p.last_sync, fileCount: p.file_count })));
        }
      } catch {
        // Projects endpoint may not exist yet — graceful degradation
      }
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

  const handleSelectProject = useCallback(
    (projectName: string) => {
      setActiveProject(projectName || null);
      if (projectName && agent) {
        // Auto-load the project into the workspace when selected
        send(agent.name, `Load my project "${projectName}" — run load-project with project_name="${projectName}" and tell me what files are available.`);
      }
    },
    [agent, send],
  );

  const handleCreateProject = useCallback(
    (projectName: string) => {
      if (!agent) return;
      setActiveProject(projectName);
      setProjects(prev => [...prev, { name: projectName }]);
      // Tell agent to save current workspace as this project
      send(agent.name, `Save our current workspace as project "${projectName}" using save-project.`);
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
              onClick={() => {
                if (agent) setSessions(loadSessionList(agent.name));
                setSessionsOpen(!sessionsOpen);
                if (!sessionsOpen && agent) fetchServerSessions(agent.name).then(s => { if (s.length > 0) setSessions(s); });
              }}
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
                    <p className="text-[10px] text-text-muted mt-0.5">{s.messageCount} messages · {timeAgo(s.updatedAt)}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={autopilot.toggle}
            disabled={autopilot.loading}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              autopilot.active
                ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                : "bg-white/5 text-text-secondary hover:bg-white/10 border border-white/10"
            }`}
          >
            {autopilot.active ? "\u26A1 Autopilot ON" : "\u26A1 Autopilot"}
          </button>
          {/* Workspace panel toggles -- hidden on mobile */}
          <div className="hidden lg:flex items-center gap-0.5 ml-1 border-l border-border/50 pl-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRightPanel(p => p === "preview" ? "closed" : "preview")}
              title="Preview artifacts"
              className={rightPanel === "preview" ? "bg-primary/10 text-primary" : ""}
            >
              <Eye size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRightPanel(p => p === "files" ? "closed" : "files")}
              title="Session files"
              className={rightPanel === "files" ? "bg-primary/10 text-primary" : ""}
            >
              <FolderClosed size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRightPanel(p => p === "meta" ? "closed" : "meta")}
              title="Improve this agent"
              className={rightPanel === "meta" ? "bg-primary/10 text-primary" : ""}
            >
              <Sparkles size={14} />
            </Button>
          </div>
          {/* Mobile: only meta button */}
          <Button variant="ghost" size="sm" onClick={() => setRightPanel(p => p === "meta" ? "closed" : "meta")} title="Improve this agent" className="lg:hidden">
            <Sparkles size={14} />
          </Button>
        </div>
      </div>

      {/* Autopilot event banner */}
      {autopilot.active && autopilot.messages.length > 0 && (
        <div className="px-4 py-2 border-b border-white/5">
          {autopilot.messages.slice(-3).map((msg, i) => (
            <div key={i} className="text-sm text-purple-400/80 py-1">
              <span className="text-purple-500 font-medium">[autopilot]</span> {msg.content}
            </div>
          ))}
        </div>
      )}

      {/* Chat + Right panel (workspace) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className={`flex-1 min-w-0 transition-all duration-300 ease-out ${rightPanel !== "closed" ? "" : "max-w-3xl mx-auto"}`}>
          <ChatInterface
            messages={messages}
            onSend={handleSend}
            onStop={stop}
            onRetry={retry}
            streaming={streaming}
            sessionMeta={sessionMeta}
            placeholder={`Message ${agent.name}...`}
            projects={projects}
            activeProject={activeProject}
            onSelectProject={handleSelectProject}
            onCreateProject={handleCreateProject}
            activePlan={activePlan}
            onChangePlan={(plan) => { setActivePlan(plan); setPlan(plan); }}
            agentName={agent.name}
            agentDescription={agent.description || (agent.config_json as any)?.description}
            toolCount={(agent.config_json as any)?.tools?.length || (agent.tools || []).length}
          />
        </div>
        {rightPanel !== "closed" && (
          <div className="hidden lg:block w-[40%] min-w-[360px] shrink-0 border-l border-border bg-surface">
            {rightPanel === "preview" && (
              <ArtifactPreview messages={messages} />
            )}
            {rightPanel === "files" && (
              <WorkspaceFiles
                messages={messages}
                onOpenFile={() => setRightPanel("preview")}
              />
            )}
            {rightPanel === "meta" && (
              <MetaAgentPanel agentName={agent.name} open={true} onClose={() => setRightPanel("closed")} context="test" />
            )}
          </div>
        )}
      </div>

      <CompanionWidget userEmail={user?.email || "default"} />
    </div>
  );
}
