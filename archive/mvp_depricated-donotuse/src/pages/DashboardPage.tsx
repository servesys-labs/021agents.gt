import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, MessageSquare, Bot, AlertCircle, RefreshCw, Loader2, Trash2,
  DollarSign, CreditCard, Wrench, Zap, Activity, Clock, AlertTriangle, Play,
  TrendingUp, Cpu, Shield, Search, Download, ChevronDown, ChevronUp,
  BarChart3, Layers,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { api } from "../lib/api";
import { useToast } from "../components/ui/Toast";
import { PRODUCT } from "../lib/product";
import { agentPathSegment } from "../lib/agent-path";
import { timeAgo } from "../lib/time-ago";

interface DashboardStats {
  total_agents?: number;
  live_agents?: number;
  total_sessions?: number;
  active_sessions?: number;
  total_runs?: number;
  avg_latency_ms?: number;
  total_cost_usd?: number;
  error_rate_pct?: number;
}

interface ApiAgent {
  agent_id: string;
  name: string;
  description: string;
  config_json?: Record<string, any>;
  model?: string;
  tools?: string[];
  tags?: string[];
  version: string;
  is_active?: boolean | number;
}

interface ActivityItem {
  id: string;
  type: string;
  message: string;
  agent_name: string;
  timestamp: number;
}

// Deterministic color per agent name
const AVATAR_COLORS = [
  "from-violet-500 to-purple-600",
  "from-blue-500 to-cyan-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-rose-500 to-pink-500",
  "from-indigo-500 to-blue-500",
];

function agentColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function agentInitials(name: string) {
  return name.split("-").map((w) => w[0]?.toUpperCase()).filter(Boolean).slice(0, 2).join("");
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  // ── Phase 7.5: Drill-down data ──
  const [byAgent, setByAgent] = useState<any[]>([]);
  const [byModel, setByModel] = useState<any[]>([]);
  const [trends, setTrends] = useState<any[]>([]);
  const [toolHealth, setToolHealth] = useState<any[]>([]);
  const [sessionSearch, setSessionSearch] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDrillDown, setShowDrillDown] = useState(false);
  const [trendPeriod, setTrendPeriod] = useState(7);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const agentsData = await api.get<ApiAgent[]>("/agents");
      setAgents(Array.isArray(agentsData) ? agentsData : []);

      const [statsRes, creditsRes, activityRes] = await Promise.allSettled([
        api.get<DashboardStats>("/dashboard/stats"),
        api.get<{ balance_usd: number }>("/credits/balance"),
        api.get<{ activity: ActivityItem[] }>("/dashboard/activity?limit=10"),
      ]);

      if (statsRes.status === "fulfilled") setStats(statsRes.value);
      if (creditsRes.status === "fulfilled") setCreditBalance(Number(creditsRes.value.balance_usd) || 0);
      if (activityRes.status === "fulfilled") setActivity(activityRes.value.activity || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // Phase 7.5: Fetch drill-down data when panel is expanded
  useEffect(() => {
    if (!showDrillDown) return;
    const fetchDrillDown = async () => {
      const [agentRes, modelRes, trendsRes, healthRes] = await Promise.allSettled([
        api.get<{ agents: any[] }>("/dashboard/stats/by-agent"),
        api.get<{ models: any[] }>("/dashboard/stats/by-model"),
        api.get<{ trends: any[] }>(`/dashboard/stats/trends?period_days=${trendPeriod}`),
        api.get<{ tools: any[] }>("/dashboard/stats/tool-health"),
      ]);
      if (agentRes.status === "fulfilled") setByAgent(agentRes.value.agents || []);
      if (modelRes.status === "fulfilled") setByModel(modelRes.value.models || []);
      if (trendsRes.status === "fulfilled") setTrends(trendsRes.value.trends || []);
      if (healthRes.status === "fulfilled") setToolHealth(healthRes.value.tools || []);
    };
    fetchDrillDown();
  }, [showDrillDown, trendPeriod]);

  // Session search
  const searchSessions = async () => {
    if (!searchQuery.trim()) return;
    try {
      const res = await api.get<{ results: any[] }>(`/sessions/search?q=${encodeURIComponent(searchQuery)}&limit=20`);
      setSessionSearch(res.results || []);
    } catch { setSessionSearch([]); }
  };

  const removeAgent = async (e: React.MouseEvent, agent: ApiAgent) => {
    e.stopPropagation();
    if (!window.confirm(`Remove "${agent.name}" from your workspace?`)) return;
    setRemovingName(agent.name);
    try {
      await api.del(`/agents/${agentPathSegment(agent.agent_id || agent.name)}`);
      toast("Assistant removed");
      await fetchData();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Could not remove assistant");
    } finally {
      setRemovingName(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-text-secondary">Loading dashboard...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <Card className="max-w-md w-full text-center">
          <AlertCircle size={32} className="text-danger mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-text mb-1">Something went wrong</h2>
          <p className="text-sm text-text-secondary mb-4">{error}</p>
          <Button onClick={fetchData}><RefreshCw size={14} /> Retry</Button>
        </Card>
      </div>
    );
  }

  const assistantCount = stats?.total_agents ?? agents.length;
  const liveCount = stats?.live_agents ?? agents.filter((a) => a.is_active).length;
  const sessionCount = stats?.total_sessions ?? 0;
  const activeNow = stats?.active_sessions ?? 0;
  const totalRuns = stats?.total_runs ?? 0;
  const cost = stats?.total_cost_usd ?? 0;
  const latencyMs = stats?.avg_latency_ms ?? 0;
  const errorRate = stats?.error_rate_pct ?? 0;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text tracking-tight">{PRODUCT.dashboardTitle}</h1>
          <p className="text-sm text-text-secondary mt-0.5">{PRODUCT.dashboardSubtitle}</p>
        </div>
        <Button
          onClick={() => navigate("/agents/new")}
          className="shrink-0 bg-gradient-to-r from-primary to-blue-500 hover:from-primary/90 hover:to-blue-500/90 shadow-md shadow-primary/20"
        >
          <Plus size={16} /> {PRODUCT.newAgentCta}
        </Button>
      </div>

      {/* Primary stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <StatCard icon={<Bot size={16} className="text-primary" />} label="Assistants" value={assistantCount} subtitle={`${liveCount} live · ${assistantCount - liveCount} draft`} />
        <StatCard icon={<MessageSquare size={16} className="text-success" />} label="Sessions" value={sessionCount} subtitle={activeNow > 0 ? `${activeNow} active now` : undefined} />
        <StatCard icon={<DollarSign size={16} className="text-danger" />} label="Spent" value={cost > 0 ? `$${cost.toFixed(2)}` : "$0.00"} />
        <StatCard icon={<CreditCard size={16} className="text-info" />} label="Credits" value={creditBalance !== null ? `$${creditBalance.toFixed(2)}` : "--"} />
      </div>

      {/* Secondary stat cards — operational metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard icon={<Play size={16} className="text-violet-500" />} label="Tool Runs" value={totalRuns} />
        <StatCard icon={<Clock size={16} className="text-amber-500" />} label="Avg Latency" value={latencyMs > 0 ? (latencyMs < 1000 ? `${latencyMs}ms` : `${(latencyMs / 1000).toFixed(1)}s`) : "--"} />
        <StatCard icon={<AlertTriangle size={16} className="text-orange-500" />} label="Error Rate" value={errorRate > 0 ? `${errorRate.toFixed(1)}%` : "0%"} />
        <StatCard icon={<Activity size={16} className="text-cyan-500" />} label="Active Now" value={activeNow} />
      </div>

      {/* ── Phase 7.5: Analytics Drill-Down Panel ── */}
      <div className="mb-6">
        <button
          onClick={() => setShowDrillDown(!showDrillDown)}
          className="flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors mb-3"
        >
          <BarChart3 size={14} />
          Analytics Deep Dive
          {showDrillDown ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {showDrillDown && (
          <div className="space-y-4">
            {/* Session Search */}
            <Card>
              <div className="flex items-center gap-2 mb-3">
                <Search size={14} className="text-text-muted" />
                <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Session Search</h3>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && searchSessions()}
                  placeholder="Search sessions by content, error, or keyword..."
                  className="flex-1 bg-surface-alt border border-border rounded-lg px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
                <Button size="sm" onClick={searchSessions}><Search size={12} /> Search</Button>
              </div>
              {sessionSearch.length > 0 && (
                <div className="mt-3 divide-y divide-border/50 max-h-48 overflow-y-auto">
                  {sessionSearch.map((s: any) => (
                    <div key={s.session_id} className="py-2 flex items-center gap-3 cursor-pointer hover:bg-surface-alt/50 px-2 rounded" onClick={() => navigate(`/sessions/${s.session_id}`)}>
                      <div className={`w-2 h-2 rounded-full ${s.status === "error" ? "bg-danger" : "bg-success"}`} />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-text">{s.agent_name}</span>
                        <span className="text-xs text-text-muted ml-2">{(s.input_preview || "").slice(0, 60)}...</span>
                      </div>
                      <span className="text-[10px] text-text-muted">${Number(s.cost_total_usd || 0).toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Trends (mini sparkline-style bars) */}
            {trends.length > 0 && (
              <Card>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp size={14} className="text-text-muted" />
                    <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Cost & Session Trends</h3>
                  </div>
                  <div className="flex gap-1">
                    {[7, 14, 30].map(p => (
                      <button key={p} onClick={() => setTrendPeriod(p)}
                        className={`px-2 py-0.5 text-[10px] rounded-full transition-colors ${trendPeriod === p ? "bg-primary text-white" : "text-text-muted hover:bg-surface-alt"}`}
                      >{p}d</button>
                    ))}
                  </div>
                </div>
                <div className="flex items-end gap-1 h-16">
                  {trends.map((d: any, i: number) => {
                    const maxCost = Math.max(...trends.map((t: any) => Number(t.cost_usd) || 0), 0.01);
                    const h = Math.max(4, (Number(d.cost_usd) / maxCost) * 100);
                    const hasErrors = Number(d.errors) > 0;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`${d.day}: $${Number(d.cost_usd).toFixed(3)}, ${d.sessions} sessions, ${d.errors} errors`}>
                        <div className={`w-full rounded-t-sm ${hasErrors ? "bg-danger/60" : "bg-primary/60"}`} style={{ height: `${h}%` }} />
                        {i % Math.ceil(trends.length / 7) === 0 && (
                          <span className="text-[8px] text-text-muted">{String(d.day).slice(5)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* By Agent + By Model side by side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {byAgent.length > 0 && (
                <Card>
                  <div className="flex items-center gap-2 mb-3">
                    <Bot size={14} className="text-text-muted" />
                    <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Cost by Agent</h3>
                  </div>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {byAgent.slice(0, 10).map((a: any) => (
                      <div key={a.agent_name} className="flex items-center gap-2">
                        <div className={`w-6 h-6 rounded bg-gradient-to-br ${agentColor(a.agent_name)} flex items-center justify-center text-white text-[8px] font-bold`}>
                          {agentInitials(a.agent_name)}
                        </div>
                        <span className="text-xs text-text flex-1 truncate">{a.agent_name}</span>
                        <span className="text-xs font-mono text-text-muted">${Number(a.total_cost_usd).toFixed(2)}</span>
                        {Number(a.error_rate_pct) > 5 && (
                          <span className="text-[9px] text-danger font-medium">{Number(a.error_rate_pct).toFixed(0)}% err</span>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {byModel.length > 0 && (
                <Card>
                  <div className="flex items-center gap-2 mb-3">
                    <Cpu size={14} className="text-text-muted" />
                    <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Cost by Model</h3>
                  </div>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {byModel.map((m: any) => (
                      <div key={m.model} className="flex items-center gap-2">
                        <Layers size={12} className="text-text-muted shrink-0" />
                        <span className="text-xs text-text flex-1 truncate">{(m.model || "").split("/").pop()}</span>
                        <span className="text-xs font-mono text-text-muted">${Number(m.total_cost_usd).toFixed(2)}</span>
                        <span className="text-[9px] text-text-muted">{(Number(m.total_input_tokens) / 1000).toFixed(0)}K tok</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>

            {/* Tool Health */}
            {toolHealth.length > 0 && (
              <Card>
                <div className="flex items-center gap-2 mb-3">
                  <Shield size={14} className="text-text-muted" />
                  <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Tool Health</h3>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {toolHealth.slice(0, 12).map((t: any) => {
                    const errRate = Number(t.error_rate_pct) || 0;
                    const status = errRate > 20 ? "danger" : errRate > 5 ? "warning" : "success";
                    return (
                      <div key={t.tool_name} className="flex items-center gap-2 p-2 rounded-lg bg-surface-alt/50">
                        <div className={`w-2 h-2 rounded-full ${status === "danger" ? "bg-danger" : status === "warning" ? "bg-warning" : "bg-success"}`} />
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] text-text truncate block">{t.tool_name}</span>
                          <span className="text-[9px] text-text-muted">{t.call_count} calls · {errRate.toFixed(0)}% err</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Agents */}
      <h2 className="text-sm font-semibold text-text mb-3 pb-2 border-b border-border uppercase tracking-wide text-text-secondary">
        {PRODUCT.agentsSectionTitle}
      </h2>

      {agents.length === 0 ? (
        <Card className="text-center py-14 px-6 max-w-lg mx-auto border-dashed">
          <Bot size={44} className="text-text-muted mx-auto mb-4 opacity-80" />
          <h3 className="text-lg font-semibold text-text mb-2">{PRODUCT.emptyAgentsTitle}</h3>
          <p className="text-sm text-text-secondary mb-6 leading-relaxed">{PRODUCT.emptyAgentsBody}</p>
          <Button onClick={() => navigate("/agents/new")}>
            <Plus size={16} /> {PRODUCT.emptyAgentsCta}
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent) => {
            const path = agentPathSegment(agent.agent_id || agent.name);
            const cfg = agent.config_json || {};
            const toolCount = (cfg.tools || agent.tools || []).length;
            const model = (cfg.model || agent.model || "").split("/").pop() || "";
            const isLive = !!agent.is_active;

            return (
              <Card key={agent.agent_id || agent.name} hover onClick={() => navigate(`/agents/${path}/play`)} className="flex flex-col">
                {/* Top section — fixed height so cards align */}
                <div className="flex items-start gap-3 mb-3">
                  <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${agentColor(agent.name)} flex items-center justify-center text-white text-xs font-bold shrink-0`}>
                    {agentInitials(agent.name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-text truncate">{agent.name}</h3>
                      <Badge variant={isLive ? "success" : "default"} className="shrink-0">{isLive ? "Live" : "Draft"}</Badge>
                    </div>
                    <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{agent.description || "No description"}</p>
                  </div>
                </div>

                {/* Meta row */}
                {(toolCount > 0 || model) && (
                  <div className="flex items-center gap-2 text-[10px] text-text-muted mb-3">
                    {toolCount > 0 && (
                      <span className="flex items-center gap-1"><Wrench size={10} /> {toolCount} tools</span>
                    )}
                    {toolCount > 0 && model && <span>·</span>}
                    {model && (
                      <span className="flex items-center gap-1"><Zap size={10} /> {model}</span>
                    )}
                  </div>
                )}

                {/* Actions — pushed to bottom */}
                <div className="flex items-center gap-2 mt-auto pt-2 border-t border-border/50">
                  <Button size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/agents/${path}/play`); }}>
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); navigate(`/agents/${path}/settings`); }}>
                    Settings
                  </Button>
                  <button
                    type="button"
                    title="Remove assistant"
                    disabled={removingName === agent.name}
                    onClick={(e) => removeAgent(e, agent)}
                    className="ml-auto p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger-light transition-colors disabled:opacity-50"
                  >
                    {removingName === agent.name ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Recent Activity */}
      {activity.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-text mb-3 pb-2 border-b border-border uppercase tracking-wide text-text-secondary flex items-center gap-1.5">
            <Activity size={14} /> Recent Activity
          </h2>
          <Card>
            <div className="divide-y divide-border/50">
              {activity.map((item) => (
                <div key={item.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${item.type === "error" ? "bg-danger" : "bg-success"}`} />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-text">
                      <span className="font-medium">{item.agent_name}</span>
                      {" "}
                      <span className="text-text-muted">{item.type === "error" ? "failed" : "session completed"}</span>
                    </span>
                  </div>
                  <span className="text-[10px] text-text-muted shrink-0">{timeAgo(new Date(item.timestamp * 1000))}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
