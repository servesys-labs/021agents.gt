import { useMemo, useState } from "react";
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  RefreshCw,
  Zap,
  Shield,
  Target,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { Tabs } from "../../components/common/Tabs";
import { EmptyState } from "../../components/common/EmptyState";
import { SlidePanel } from "../../components/common/SlidePanel";
import { useApiQuery, apiRequest } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ─────────────────────────────────────────────────────── */

type IntelSummary = {
  total_scored_turns: number;
  avg_sentiment_score: number;
  avg_quality_score: number;
  avg_relevance: number;
  avg_coherence: number;
  avg_helpfulness: number;
  avg_safety: number;
  tool_failure_count: number;
  hallucination_risk_count: number;
  sentiment_breakdown: Record<string, number>;
  top_topics: Array<{ topic: string; count: number }>;
  quality_trend: Array<{ day: string; avg_q: number; avg_s: number; cnt: number }>;
};

type TrendData = {
  daily: Array<{
    day: string;
    avg_quality: number;
    avg_sentiment: number;
    turn_count: number;
    tool_failures: number;
  }>;
  sentiment_distribution: Record<string, number>;
  intent_distribution: Record<string, number>;
  topic_distribution: Record<string, number>;
};

type ConversationScore = {
  id: number;
  session_id: string;
  turn_number: number;
  agent_name: string;
  sentiment: string;
  sentiment_score: number;
  quality_overall: number;
  relevance_score: number;
  coherence_score: number;
  helpfulness_score: number;
  safety_score: number;
  topic: string;
  intent: string;
  has_tool_failure: number;
  has_hallucination_risk: number;
  created_at: number;
};

type SessionAnalytics = {
  session_id: string;
  agent_name: string;
  avg_sentiment_score: number;
  dominant_sentiment: string;
  sentiment_trend: string;
  avg_quality: number;
  total_turns: number;
  topics_json: string[];
  tool_failure_count: number;
  hallucination_risk_count: number;
  created_at: number;
};

/* ── Helpers ───────────────────────────────────────────────────── */

const pct = (v: number) => `${Math.round(v * 100)}%`;
const fmt3 = (v: number) => (v ?? 0).toFixed(3);
const sentimentColor = (s: string) => {
  switch (s) {
    case "positive": return "text-status-live";
    case "negative": return "text-status-error";
    case "mixed": return "text-status-warning";
    default: return "text-text-muted";
  }
};
const sentimentIcon = (s: string) => {
  switch (s) {
    case "positive": return <ThumbsUp size={14} />;
    case "negative": return <ThumbsDown size={14} />;
    default: return <Minus size={14} />;
  }
};
const trendIcon = (t: string) => {
  switch (t) {
    case "improving": return <TrendingUp size={14} className="text-status-live" />;
    case "declining": return <TrendingDown size={14} className="text-status-error" />;
    case "volatile": return <AlertTriangle size={14} className="text-status-warning" />;
    default: return <Minus size={14} className="text-text-muted" />;
  }
};

/* ── SparkBar ──────────────────────────────────────────────────── */

const SparkBar = ({ value, max, color }: { value: number; max: number; color: string }) => (
  <div className="h-2 bg-surface-overlay rounded-full overflow-hidden">
    <div
      className={`h-full rounded-full ${color}`}
      style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }}
    />
  </div>
);

/* ── Main Page ─────────────────────────────────────────────────── */

export const IntelligencePage = () => {
  const { showToast } = useToast();
  const [sinceDays, setSinceDays] = useState(30);
  const [agentFilter, setAgentFilter] = useState("");
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);

  const agentParam = agentFilter ? `&agent_name=${encodeURIComponent(agentFilter)}` : "";

  const summaryQuery = useApiQuery<IntelSummary>(
    `/api/v1/intelligence/summary?since_days=${sinceDays}${agentParam}`,
  );
  const trendsQuery = useApiQuery<TrendData>(
    `/api/v1/intelligence/trends?since_days=${sinceDays}${agentParam}`,
  );
  const analyticsQuery = useApiQuery<SessionAnalytics[]>(
    `/api/v1/intelligence/analytics?since_days=${sinceDays}&limit=50${agentParam}`,
  );
  const scoresQuery = useApiQuery<ConversationScore[]>(
    `/api/v1/intelligence/scores?session_id=${selectedSession ?? ""}&limit=100`,
    Boolean(selectedSession),
  );

  const summary = summaryQuery.data;
  const trends = trendsQuery.data;
  const analytics = useMemo(() => analyticsQuery.data ?? [], [analyticsQuery.data]);
  const turnScores = useMemo(() => scoresQuery.data ?? [], [scoresQuery.data]);

  const handleRefresh = () => {
    summaryQuery.refetch();
    trendsQuery.refetch();
    analyticsQuery.refetch();
  };

  const handleScoreSession = async (sessionId: string) => {
    try {
      await apiRequest(`/api/v1/intelligence/score/${sessionId}`, "POST");
      showToast("Session scored successfully", "success");
      handleRefresh();
    } catch {
      showToast("Failed to score session", "error");
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Conversation Intelligence"
        subtitle="Sentiment analysis, quality scoring, and conversation analytics"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={sinceDays}
              onChange={(e) => setSinceDays(Number(e.target.value))}
              className="px-2 py-1.5 text-xs rounded-lg bg-surface-raised border border-border-default text-text-primary"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <input
              type="text"
              placeholder="Filter by agent..."
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="px-2 py-1.5 text-xs rounded-lg bg-surface-raised border border-border-default text-text-primary w-40"
            />
            <button onClick={handleRefresh} className="btn btn-secondary">
              <RefreshCw size={14} />
            </button>
          </div>
        }
      />

      <Tabs
        tabs={["Overview", "Trends", "Sessions", "Scores"]}
        activeIndex={activeTab}
        onChange={setActiveTab}
      />

      {/* ── Tab: Overview ──────────────────────────────────────── */}
      {activeTab === 0 && (
        <QueryState loading={summaryQuery.loading} error={summaryQuery.error}>
          {summary && (
            <div className="space-y-6 mt-4">
              {/* KPI Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard
                  icon={<MessageSquare size={16} />}
                  label="Scored Turns"
                  value={String(summary.total_scored_turns)}
                  color="text-chart-blue"
                />
                <KpiCard
                  icon={<Sparkles size={16} />}
                  label="Avg Quality"
                  value={pct(summary.avg_quality_score)}
                  color="text-chart-purple"
                />
                <KpiCard
                  icon={<ThumbsUp size={16} />}
                  label="Avg Sentiment"
                  value={`${summary.avg_sentiment_score >= 0 ? "+" : ""}${fmt3(summary.avg_sentiment_score)}`}
                  color={summary.avg_sentiment_score >= 0 ? "text-status-live" : "text-status-error"}
                />
                <KpiCard
                  icon={<Shield size={16} />}
                  label="Avg Safety"
                  value={pct(summary.avg_safety)}
                  color="text-chart-green"
                />
              </div>

              {/* Quality Breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="card">
                  <h3 className="text-sm font-medium text-text-primary mb-4">Quality Breakdown</h3>
                  <div className="space-y-3">
                    <QualityBar label="Relevance" value={summary.avg_relevance} />
                    <QualityBar label="Coherence" value={summary.avg_coherence} />
                    <QualityBar label="Helpfulness" value={summary.avg_helpfulness} />
                    <QualityBar label="Safety" value={summary.avg_safety} />
                  </div>
                </div>

                <div className="card">
                  <h3 className="text-sm font-medium text-text-primary mb-4">Sentiment Distribution</h3>
                  {Object.keys(summary.sentiment_breakdown).length > 0 ? (
                    <div className="space-y-3">
                      {Object.entries(summary.sentiment_breakdown).map(([label, count]) => (
                        <div key={label} className="flex items-center gap-3">
                          <span className={`flex items-center gap-1.5 text-xs w-24 ${sentimentColor(label)}`}>
                            {sentimentIcon(label)} {label}
                          </span>
                          <div className="flex-1">
                            <SparkBar
                              value={count}
                              max={summary.total_scored_turns}
                              color={
                                label === "positive" ? "bg-status-live" :
                                label === "negative" ? "bg-status-error" :
                                label === "mixed" ? "bg-status-warning" :
                                "bg-text-muted"
                              }
                            />
                          </div>
                          <span className="text-xs text-text-muted w-8 text-right">{count}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted">No sentiment data yet</p>
                  )}
                </div>
              </div>

              {/* Alerts + Topics */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="card">
                  <h3 className="text-sm font-medium text-text-primary mb-4">Alerts</h3>
                  <div className="space-y-2">
                    <AlertRow
                      icon={<Zap size={14} />}
                      label="Tool Failures"
                      count={summary.tool_failure_count}
                      color="text-status-error"
                    />
                    <AlertRow
                      icon={<AlertTriangle size={14} />}
                      label="Hallucination Risks"
                      count={summary.hallucination_risk_count}
                      color="text-status-warning"
                    />
                  </div>
                </div>

                <div className="card">
                  <h3 className="text-sm font-medium text-text-primary mb-4">Top Topics</h3>
                  {summary.top_topics.length > 0 ? (
                    <div className="space-y-2">
                      {summary.top_topics.slice(0, 6).map((t) => (
                        <div key={t.topic} className="flex items-center justify-between">
                          <span className="text-xs text-text-secondary">{t.topic}</span>
                          <span className="text-xs text-text-muted">{t.count}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted">No topics detected yet</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </QueryState>
      )}

      {/* ── Tab: Trends ────────────────────────────────────────── */}
      {activeTab === 1 && (
        <QueryState loading={trendsQuery.loading} error={trendsQuery.error}>
          {trends && (
            <div className="space-y-6 mt-4">
              {/* Daily trend table */}
              <div className="card">
                <h3 className="text-sm font-medium text-text-primary mb-4">Daily Quality & Sentiment</h3>
                {trends.daily.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-default text-text-muted">
                          <th className="text-left py-2 pr-4">Date</th>
                          <th className="text-right py-2 px-3">Quality</th>
                          <th className="text-right py-2 px-3">Sentiment</th>
                          <th className="text-right py-2 px-3">Turns</th>
                          <th className="text-right py-2 px-3">Failures</th>
                          <th className="py-2 px-3 w-32">Quality Bar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trends.daily.map((d) => (
                          <tr key={d.day} className="border-b border-border-default/50 hover:bg-surface-overlay/30">
                            <td className="py-2 pr-4 text-text-secondary">{d.day}</td>
                            <td className="py-2 px-3 text-right text-text-primary">{(d.avg_quality ?? 0).toFixed(3)}</td>
                            <td className={`py-2 px-3 text-right ${(d.avg_sentiment ?? 0) >= 0 ? "text-status-live" : "text-status-error"}`}>
                              {(d.avg_sentiment ?? 0) >= 0 ? "+" : ""}{(d.avg_sentiment ?? 0).toFixed(3)}
                            </td>
                            <td className="py-2 px-3 text-right text-text-muted">{d.turn_count}</td>
                            <td className="py-2 px-3 text-right">
                              {(d.tool_failures ?? 0) > 0 ? (
                                <span className="text-status-error">{d.tool_failures}</span>
                              ) : (
                                <span className="text-text-muted">0</span>
                              )}
                            </td>
                            <td className="py-2 px-3">
                              <SparkBar value={d.avg_quality ?? 0} max={1} color="bg-chart-purple" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState message="No trend data available. Score some sessions first." />
                )}
              </div>

              {/* Distributions */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <DistributionCard title="Sentiment" data={trends.sentiment_distribution} colorMap={{
                  positive: "bg-status-live",
                  negative: "bg-status-error",
                  neutral: "bg-text-muted",
                  mixed: "bg-status-warning",
                }} />
                <DistributionCard title="Intent" data={trends.intent_distribution} colorMap={{
                  question: "bg-chart-blue",
                  command: "bg-chart-orange",
                  feedback: "bg-chart-green",
                  complaint: "bg-status-error",
                  chitchat: "bg-text-muted",
                }} />
                <DistributionCard title="Topic" data={trends.topic_distribution} colorMap={{}} />
              </div>
            </div>
          )}
        </QueryState>
      )}

      {/* ── Tab: Sessions ──────────────────────────────────────── */}
      {activeTab === 2 && (
        <QueryState loading={analyticsQuery.loading} error={analyticsQuery.error}>
          {analytics.length > 0 ? (
            <div className="card mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted">
                      <th className="text-left py-2 pr-4">Session</th>
                      <th className="text-left py-2 px-3">Agent</th>
                      <th className="text-right py-2 px-3">Quality</th>
                      <th className="text-center py-2 px-3">Sentiment</th>
                      <th className="text-center py-2 px-3">Trend</th>
                      <th className="text-right py-2 px-3">Turns</th>
                      <th className="text-right py-2 px-3">Failures</th>
                      <th className="text-left py-2 px-3">Topics</th>
                      <th className="text-center py-2 px-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.map((a) => (
                      <tr
                        key={a.session_id}
                        className="border-b border-border-default/50 hover:bg-surface-overlay/30 cursor-pointer"
                        onClick={() => { setSelectedSession(a.session_id); setDrawerOpen(true); }}
                      >
                        <td className="py-2 pr-4 font-mono text-text-secondary">{a.session_id.slice(0, 12)}...</td>
                        <td className="py-2 px-3 text-text-primary">{a.agent_name || "—"}</td>
                        <td className="py-2 px-3 text-right text-text-primary">{(a.avg_quality ?? 0).toFixed(2)}</td>
                        <td className="py-2 px-3 text-center">
                          <span className={`inline-flex items-center gap-1 ${sentimentColor(a.dominant_sentiment)}`}>
                            {sentimentIcon(a.dominant_sentiment)}
                            <span className="text-[10px]">{a.dominant_sentiment}</span>
                          </span>
                        </td>
                        <td className="py-2 px-3 text-center">{trendIcon(a.sentiment_trend)}</td>
                        <td className="py-2 px-3 text-right text-text-muted">{a.total_turns}</td>
                        <td className="py-2 px-3 text-right">
                          {a.tool_failure_count > 0 ? (
                            <span className="text-status-error">{a.tool_failure_count}</span>
                          ) : (
                            <span className="text-text-muted">0</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <div className="flex flex-wrap gap-1">
                            {(a.topics_json ?? []).slice(0, 3).map((t) => (
                              <span key={t} className="px-1.5 py-0.5 rounded text-[10px] bg-surface-overlay text-text-secondary">{t}</span>
                            ))}
                          </div>
                        </td>
                        <td className="py-2 px-3 text-center">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleScoreSession(a.session_id); }}
                            className="text-accent hover:text-accent-hover text-[10px]"
                          >
                            Re-score
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState message="No session analytics yet. Score sessions to see data here." />
          )}
        </QueryState>
      )}

      {/* ── Tab: Scores (per-turn detail) ──────────────────────── */}
      {activeTab === 3 && (
        <div className="mt-4 space-y-4">
          <div className="card">
            <p className="text-xs text-text-muted mb-3">
              Select a session from the Sessions tab to view per-turn scores, or enter a session ID:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Session ID..."
                value={selectedSession ?? ""}
                onChange={(e) => setSelectedSession(e.target.value || null)}
                className="flex-1 px-3 py-2 text-xs rounded-lg bg-surface-raised border border-border-default text-text-primary"
              />
              <button
                onClick={() => selectedSession && handleScoreSession(selectedSession)}
                className="btn btn-primary text-xs"
                disabled={!selectedSession}
              >
                Score
              </button>
            </div>
          </div>

          {selectedSession && (
            <QueryState loading={scoresQuery.loading} error={scoresQuery.error}>
              {turnScores.length > 0 ? (
                <div className="card">
                  <h3 className="text-sm font-medium text-text-primary mb-3">
                    Turn Scores — {selectedSession.slice(0, 16)}
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-default text-text-muted">
                          <th className="text-left py-2 pr-3">Turn</th>
                          <th className="text-right py-2 px-3">Quality</th>
                          <th className="text-right py-2 px-3">Relevance</th>
                          <th className="text-right py-2 px-3">Coherence</th>
                          <th className="text-right py-2 px-3">Helpful</th>
                          <th className="text-right py-2 px-3">Safety</th>
                          <th className="text-center py-2 px-3">Sentiment</th>
                          <th className="text-left py-2 px-3">Topic</th>
                          <th className="text-left py-2 px-3">Intent</th>
                          <th className="text-center py-2 px-3">Flags</th>
                        </tr>
                      </thead>
                      <tbody>
                        {turnScores.map((s) => (
                          <tr key={s.id} className="border-b border-border-default/50 hover:bg-surface-overlay/30">
                            <td className="py-2 pr-3 text-text-secondary">#{s.turn_number}</td>
                            <td className="py-2 px-3 text-right text-text-primary">{(s.quality_overall ?? 0).toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-text-muted">{(s.relevance_score ?? 0).toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-text-muted">{(s.coherence_score ?? 0).toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-text-muted">{(s.helpfulness_score ?? 0).toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-text-muted">{(s.safety_score ?? 0).toFixed(2)}</td>
                            <td className="py-2 px-3 text-center">
                              <span className={`inline-flex items-center gap-1 ${sentimentColor(s.sentiment)}`}>
                                {sentimentIcon(s.sentiment)}
                                <span className="text-[10px]">{(s.sentiment_score ?? 0).toFixed(2)}</span>
                              </span>
                            </td>
                            <td className="py-2 px-3 text-text-secondary">{s.topic || "—"}</td>
                            <td className="py-2 px-3 text-text-secondary">{s.intent || "—"}</td>
                            <td className="py-2 px-3 text-center space-x-1">
                              {s.has_tool_failure ? (
                                <span className="text-status-error" title="Tool failure"><Zap size={12} /></span>
                              ) : null}
                              {s.has_hallucination_risk ? (
                                <span className="text-status-warning" title="Hallucination risk"><AlertTriangle size={12} /></span>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <EmptyState message="No scores for this session. Click 'Score' to analyze it." />
              )}
            </QueryState>
          )}
        </div>
      )}

      {/* Drawer for session detail */}
      <SlidePanel
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedSession(null); }}
        title={`Session Intelligence — ${selectedSession?.slice(0, 16) ?? ""}`}
      >
        {selectedSession && (
          <QueryState loading={scoresQuery.loading} error={scoresQuery.error}>
            <div className="space-y-4">
              {turnScores.map((s) => (
                <div key={s.id} className="p-3 rounded-lg bg-surface-overlay/30 border border-border-default/50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-text-primary">Turn #{s.turn_number}</span>
                    <span className={`text-xs ${sentimentColor(s.sentiment)}`}>{s.sentiment}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <span className="text-text-muted">Quality</span>
                      <SparkBar value={s.quality_overall} max={1} color="bg-chart-purple" />
                    </div>
                    <div>
                      <span className="text-text-muted">Relevance</span>
                      <SparkBar value={s.relevance_score} max={1} color="bg-chart-blue" />
                    </div>
                    <div>
                      <span className="text-text-muted">Coherence</span>
                      <SparkBar value={s.coherence_score} max={1} color="bg-chart-cyan" />
                    </div>
                    <div>
                      <span className="text-text-muted">Helpfulness</span>
                      <SparkBar value={s.helpfulness_score} max={1} color="bg-chart-orange" />
                    </div>
                  </div>
                  {(s.topic || s.intent) && (
                    <div className="flex gap-2 mt-2">
                      {s.topic && <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-overlay text-text-secondary">{s.topic}</span>}
                      {s.intent && <span className="px-1.5 py-0.5 rounded text-[10px] bg-accent-muted text-accent">{s.intent}</span>}
                    </div>
                  )}
                </div>
              ))}
              {turnScores.length === 0 && (
                <div className="text-center py-8">
                  <p className="text-xs text-text-muted mb-3">No scores yet for this session</p>
                  <button onClick={() => handleScoreSession(selectedSession)} className="btn btn-primary text-xs">
                    Score Now
                  </button>
                </div>
              )}
            </div>
          </QueryState>
        )}
      </SlidePanel>
    </div>
  );
};

/* ── Sub-components ────────────────────────────────────────────── */

const KpiCard = ({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) => (
  <div className="card flex items-center gap-3">
    <div className={`flex items-center justify-center w-9 h-9 rounded-lg bg-surface-overlay ${color}`}>
      {icon}
    </div>
    <div>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
      <p className="text-[10px] text-text-muted uppercase tracking-wide">{label}</p>
    </div>
  </div>
);

const QualityBar = ({ label, value }: { label: string; value: number }) => (
  <div className="flex items-center gap-3">
    <span className="text-xs text-text-secondary w-24">{label}</span>
    <div className="flex-1">
      <SparkBar value={value} max={1} color="bg-chart-purple" />
    </div>
    <span className="text-xs text-text-primary w-12 text-right">{pct(value)}</span>
  </div>
);

const AlertRow = ({ icon, label, count, color }: { icon: React.ReactNode; label: string; count: number; color: string }) => (
  <div className="flex items-center justify-between">
    <span className={`flex items-center gap-2 text-xs ${color}`}>
      {icon} {label}
    </span>
    <span className={`text-sm font-semibold ${count > 0 ? color : "text-text-muted"}`}>{count}</span>
  </div>
);

const DistributionCard = ({ title, data, colorMap }: { title: string; data: Record<string, number>; colorMap: Record<string, string> }) => {
  const total = Object.values(data).reduce((s, v) => s + v, 0);
  const defaultColors = ["bg-chart-blue", "bg-chart-orange", "bg-chart-purple", "bg-chart-cyan", "bg-chart-green"];
  let colorIdx = 0;
  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-3">{title}</h3>
      {Object.keys(data).length > 0 ? (
        <div className="space-y-2">
          {Object.entries(data)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([label, count]) => {
              const color = colorMap[label] || defaultColors[colorIdx++ % defaultColors.length];
              return (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary w-20 truncate">{label}</span>
                  <div className="flex-1">
                    <SparkBar value={count} max={total} color={color} />
                  </div>
                  <span className="text-[10px] text-text-muted w-6 text-right">{count}</span>
                </div>
              );
            })}
        </div>
      ) : (
        <p className="text-xs text-text-muted">No data</p>
      )}
    </div>
  );
};
