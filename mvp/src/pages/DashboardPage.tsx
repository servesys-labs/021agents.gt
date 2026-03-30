import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, MessageSquare, TrendingUp, Bot, AlertCircle, RefreshCw, Loader2, Trash2, DollarSign, CreditCard } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { api } from "../lib/api";
import { useToast } from "../components/ui/Toast";
import { PRODUCT } from "../lib/product";
import { agentPathSegment } from "../lib/agent-path";

interface DashboardStats {
  total_agents?: number;
  total_sessions?: number;
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

export default function DashboardPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsUnavailable, setStatsUnavailable] = useState(false);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const agentsData = await api.get<ApiAgent[]>("/agents");
      setAgents(Array.isArray(agentsData) ? agentsData : []);

      try {
        const statsData = await api.get<DashboardStats>("/dashboard/stats");
        setStats(statsData);
        setStatsUnavailable(false);
      } catch {
        setStats(null);
        setStatsUnavailable(true);
      }

      try {
        const credits = await api.get<{ balance_usd: number }>("/credits/balance");
        setCreditBalance(Number(credits.balance_usd) || 0);
      } catch {}
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

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
          <AlertCircle size={32} className="text-red-500 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-text mb-1">Something went wrong</h2>
          <p className="text-sm text-text-secondary mb-4">{error}</p>
          <Button onClick={fetchData}>
            <RefreshCw size={14} /> Retry
          </Button>
        </Card>
      </div>
    );
  }

  const assistantCount = stats?.total_agents ?? agents.length;
  const sessionCount = stats?.total_sessions ?? 0;
  const latency =
    stats?.avg_latency_ms && stats.avg_latency_ms > 0 ? `${Math.round(stats.avg_latency_ms)}ms` : PRODUCT.latencyEmpty;

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-text tracking-tight">{PRODUCT.dashboardTitle}</h1>
          <p className="text-sm text-text-secondary mt-1 max-w-xl leading-relaxed">{PRODUCT.dashboardSubtitle}</p>
          {statsUnavailable && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3 inline-block">
              Usage stats are unavailable (check permissions). Your assistants still load below.
            </p>
          )}
        </div>
        <Button
          onClick={() => navigate("/agents/new")}
          className="shrink-0 bg-gradient-to-r from-primary to-blue-500 hover:from-primary/90 hover:to-blue-500/90 shadow-md shadow-primary/20"
        >
          <Plus size={16} /> {PRODUCT.newAgentCta}
        </Button>
      </div>

      {/* Only show stats when user has activity — avoids discouraging wall of zeroes */}
      {(sessionCount > 0 || assistantCount > 1) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
          <StatCard icon={<Bot size={16} className="text-primary" />} label={PRODUCT.statAssistants} value={assistantCount} />
          <StatCard icon={<MessageSquare size={16} className="text-success" />} label={PRODUCT.statSessions} value={sessionCount} />
          <StatCard icon={<DollarSign size={16} className="text-danger" />} label="Spent" value={stats?.total_cost_usd ? `$${stats.total_cost_usd.toFixed(2)}` : "$0.00"} />
          <StatCard icon={<CreditCard size={16} className="text-info" />} label="Credits" value={creditBalance !== null ? `$${creditBalance.toFixed(2)}` : "—"} />
        </div>
      )}

      <h2 className="text-lg font-semibold text-text mb-4 pb-3 border-b border-border">{PRODUCT.agentsSectionTitle}</h2>

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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((agent) => {
            const path = agentPathSegment(agent.agent_id || agent.name);
            return (
              <Card key={agent.agent_id || agent.name} hover onClick={() => navigate(`/agents/${path}/activity`)}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-text truncate">{agent.name}</h3>
                    <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{agent.description || "—"}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      title="Remove assistant"
                      disabled={removingName === agent.name}
                      onClick={(e) => removeAgent(e, agent)}
                      className="p-1.5 rounded-lg text-text-muted hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      {removingName === agent.name ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                    <Badge variant={agent.is_active ? "success" : "default"}>{agent.is_active ? "Live" : "Inactive"}</Badge>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
                  <span>v{agent.version}</span>
                  {(agent.config_json?.model || agent.model) && (
                    <span>{(agent.config_json?.model || agent.model || "").split("/").pop()}</span>
                  )}
                  {agent.config_json?.plan && (
                    <span className="capitalize">{agent.config_json.plan}</span>
                  )}
                  {((agent.config_json?.tools || agent.tools || []).length > 0) && (
                    <span className="truncate max-w-[200px]" title={(agent.config_json?.tools || agent.tools || []).join(", ")}>
                      {(agent.config_json?.tools || agent.tools || []).length} tool{(agent.config_json?.tools || agent.tools || []).length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 mt-4">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/agents/${path}/play`);
                    }}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/agents/${path}/flow`);
                    }}
                  >
                    Edit flow
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/agents/${path}/tests`);
                    }}
                  >
                    Evals
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
