import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowDownRight,
  Brain,
  ChevronDown,
  ChevronRight,
  Filter,
  MessageSquare,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useApiQuery, apiGet } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type IntelSummary = {
  total_scored_turns?: number;
  avg_sentiment_score?: number;
  avg_quality_score?: number;
  avg_relevance?: number;
  avg_coherence?: number;
  avg_helpfulness?: number;
  avg_safety?: number;
  tool_failure_count?: number;
  hallucination_risk_count?: number;
  sentiment_breakdown?: Record<string, number>;
  top_topics?: Array<{ topic: string; count: number }>;
  no_fail_rate?: number;
  total_sessions?: number;
};

type TrendDay = {
  day: string;
  avg_quality: number;
  avg_sentiment: number;
  sessions?: number;
};

type TrendData = {
  days: TrendDay[];
  sentiment_distribution?: Record<string, number>;
  topic_distribution?: Array<{ topic: string; count: number }>;
  intent_distribution?: Array<{ intent: string; count: number }>;
};

type AnalyticsRow = {
  session_id: string;
  agent_name: string;
  quality_overall: number;
  sentiment_score: number;
  topic?: string;
  intent?: string;
  created_at?: number;
};

type FeedbackItem = {
  id: string;
  session_id: string;
  turn_number: number;
  rating: "positive" | "negative" | "neutral";
  comment: string;
  message_preview: string;
  agent_name: string;
  channel: string;
  created_at: number;
};

type FeedbackStats = {
  total: number;
  positive: number;
  negative: number;
  neutral: number;
  positive_pct: number;
  negative_pct: number;
  prev_total: number;
  prev_positive: number;
  prev_negative: number;
  trend_direction: "up" | "down" | "flat";
  by_agent: Array<{
    agent_name: string;
    positive: number;
    negative: number;
    neutral: number;
    total: number;
  }>;
};

type AgentBreakdown = {
  name: string;
  avgQuality: number;
  prevAvgQuality: number;
  avgSentiment: number;
  sessionCount: number;
  declining: boolean;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

const RANGE_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
] as const;

const CHART_COLORS = [
  "var(--color-chart-orange)",
  "var(--color-chart-blue)",
  "var(--color-chart-green)",
  "var(--color-chart-purple)",
  "var(--color-chart-cyan)",
];

const CHART_COLOR_NAMES = [
  "chart-orange",
  "chart-blue",
  "chart-green",
  "chart-purple",
  "chart-cyan",
];

function formatScore(v: number | undefined, decimals = 2): string {
  if (v == null) return "--";
  return v.toFixed(decimals);
}

function formatSentiment(v: number | undefined): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

function timeAgo(ts?: number): string {
  if (!ts) return "--";
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ── Intelligence Dashboard ──────────────────────────────────────── */

const TAB_OPTIONS = ["Quality", "Feedback"] as const;
type Tab = (typeof TAB_OPTIONS)[number];

export function IntelligencePage() {
  const navigate = useNavigate();
  const [sinceDays, setSinceDays] = useState(7);
  const [activeTab, setActiveTab] = useState<Tab>("Quality");

  const summaryQuery = useApiQuery<IntelSummary>(
    `/api/v1/intelligence/summary?since_days=${sinceDays}`,
  );
  const trendsQuery = useApiQuery<TrendData>(
    `/api/v1/intelligence/trends?since_days=${sinceDays}`,
  );
  const analyticsQuery = useApiQuery<AnalyticsRow[]>(
    `/api/v1/intelligence/analytics?limit=200`,
  );

  const summary = summaryQuery.data;
  const trends = trendsQuery.data;
  const analytics = useMemo(() => analyticsQuery.data ?? [], [analyticsQuery.data]);

  /* Build per-agent breakdown from analytics */
  const agentBreakdown: AgentBreakdown[] = useMemo(() => {
    if (analytics.length === 0) return [];

    const byAgent = new Map<string, AnalyticsRow[]>();
    for (const row of analytics) {
      const name = row.agent_name || "unknown";
      const existing = byAgent.get(name);
      if (existing) existing.push(row);
      else byAgent.set(name, [row]);
    }

    const midpoint = Math.floor(analytics.length / 2);
    const result: AgentBreakdown[] = [];

    for (const [name, rows] of byAgent) {
      const avgQuality =
        rows.reduce((s, r) => s + (r.quality_overall ?? 0), 0) / rows.length;
      const avgSentiment =
        rows.reduce((s, r) => s + (r.sentiment_score ?? 0), 0) / rows.length;

      /* Split into first half / second half for trend */
      const sorted = [...rows].sort(
        (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0),
      );
      const half = Math.max(1, Math.floor(sorted.length / 2));
      const prevSlice = sorted.slice(0, half);
      const currSlice = sorted.slice(half);
      const prevAvg =
        prevSlice.reduce((s, r) => s + (r.quality_overall ?? 0), 0) /
        prevSlice.length;
      const currAvg =
        currSlice.length > 0
          ? currSlice.reduce((s, r) => s + (r.quality_overall ?? 0), 0) /
            currSlice.length
          : prevAvg;
      const declining = prevAvg > 0 && (prevAvg - currAvg) / prevAvg > 0.05;

      result.push({
        name,
        avgQuality,
        prevAvgQuality: prevAvg,
        avgSentiment,
        sessionCount: rows.length,
        declining,
      });
    }

    return result.sort((a, b) => b.sessionCount - a.sessionCount);
  }, [analytics]);

  /* Build per-agent chart lines from trends.days */
  const agentNames = useMemo(
    () => agentBreakdown.map((a) => a.name),
    [agentBreakdown],
  );

  /* Sorting state for breakdown table */
  const [sortField, setSortField] = useState<
    "name" | "quality" | "sentiment" | "sessions"
  >("sessions");
  const [sortAsc, setSortAsc] = useState(false);

  const sortedBreakdown = useMemo(() => {
    const copy = [...agentBreakdown];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "quality":
          cmp = a.avgQuality - b.avgQuality;
          break;
        case "sentiment":
          cmp = a.avgSentiment - b.avgSentiment;
          break;
        case "sessions":
          cmp = a.sessionCount - b.sessionCount;
          break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return copy;
  }, [agentBreakdown, sortField, sortAsc]);

  const handleSort = (field: typeof sortField) => {
    if (field === sortField) setSortAsc(!sortAsc);
    else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  /* Sentiment distribution from trends */
  const sentimentDist = trends?.sentiment_distribution ?? {};
  const sentTotal = Object.values(sentimentDist).reduce(
    (s, v) => s + v,
    0,
  );

  /* Top topics */
  const topTopics = useMemo(() => {
    if (trends?.topic_distribution && Array.isArray(trends.topic_distribution)) {
      return trends.topic_distribution.slice(0, 5);
    }
    if (summary?.top_topics) return summary.top_topics.slice(0, 5);
    return [];
  }, [trends, summary]);

  /* Signal cards data */
  const avgQuality = summary?.avg_quality_score ?? 0;
  const avgSentiment = summary?.avg_sentiment_score ?? 0;
  const totalSessions = summary?.total_sessions ?? analytics.length;
  const noFailRate = summary?.no_fail_rate ?? (summary?.tool_failure_count != null && totalSessions > 0
    ? ((totalSessions - summary.tool_failure_count) / totalSessions) * 100
    : 100);

  /* Chart data from trends.days */
  const trendDays = trends?.days ?? [];

  return (
    <div>
      <PageHeader
        title="Intelligence Dashboard"
        subtitle="Quality trends, sentiment analysis, and agent health overview"
        actions={
          <div className="flex items-center gap-[var(--space-3)]">
            {/* Tabs */}
            <div className="flex items-center gap-[var(--space-1)] rounded-lg border border-border-default overflow-hidden">
              {TAB_OPTIONS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] font-medium min-h-[var(--touch-target-min)] transition-colors ${
                    activeTab === tab
                      ? "bg-accent text-text-inverse"
                      : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Range selector */}
            <div className="flex items-center gap-[var(--space-1)] rounded-lg border border-border-default overflow-hidden">
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSinceDays(opt.value)}
                  className={`px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] font-medium min-h-[var(--touch-target-min)] transition-colors ${
                    sinceDays === opt.value
                      ? "bg-accent text-text-inverse"
                      : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <Link
              to="/sessions"
              className="text-[var(--text-xs)] text-accent hover:text-accent/80 transition-colors flex items-center gap-[var(--space-1)] min-h-[var(--touch-target-min)]"
            >
              View All Sessions <ChevronRight size={14} />
            </Link>
          </div>
        }
      />

      {activeTab === "Feedback" && (
        <FeedbackTab sinceDays={sinceDays} />
      )}

      {activeTab !== "Feedback" && (
      <>
      {/* Signal Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)] mb-[var(--space-6)]">
        <SignalCard
          icon={<Sparkles size={16} />}
          label="Avg Quality"
          value={formatScore(avgQuality)}
          iconColor="text-chart-purple"
          bgColor="bg-chart-purple/10"
        />
        <SignalCard
          icon={<ThumbsUp size={16} />}
          label="Avg Sentiment"
          value={formatSentiment(avgSentiment)}
          iconColor={avgSentiment >= 0 ? "text-status-live" : "text-status-error"}
          bgColor={avgSentiment >= 0 ? "bg-status-live/10" : "bg-status-error/10"}
        />
        <SignalCard
          icon={<MessageSquare size={16} />}
          label="Total Sessions"
          value={String(totalSessions)}
          iconColor="text-chart-blue"
          bgColor="bg-chart-blue/10"
        />
        <SignalCard
          icon={<Activity size={16} />}
          label="No-Fail Rate"
          value={`${noFailRate.toFixed(1)}%`}
          iconColor="text-chart-green"
          bgColor="bg-chart-green/10"
        />
      </div>

      {/* Quality Trend Chart */}
      <QueryState loading={trendsQuery.loading} error={trendsQuery.error}>
        {trendDays.length > 0 && (
          <div className="card mb-[var(--space-6)]">
            <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
              Quality Trend
            </h3>
            <QualityTrendChart days={trendDays} agentNames={agentNames} />
          </div>
        )}
      </QueryState>

      {/* Agent Breakdown Table */}
      <QueryState loading={analyticsQuery.loading} error={analyticsQuery.error}>
        {sortedBreakdown.length > 0 && (
          <div className="card mb-[var(--space-6)]">
            <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
              Agent Breakdown
            </h3>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <SortTh
                      label="Agent"
                      field="name"
                      current={sortField}
                      asc={sortAsc}
                      onSort={handleSort}
                    />
                    <SortTh
                      label="Quality Score"
                      field="quality"
                      current={sortField}
                      asc={sortAsc}
                      onSort={handleSort}
                      align="right"
                    />
                    <SortTh
                      label="Sentiment"
                      field="sentiment"
                      current={sortField}
                      asc={sortAsc}
                      onSort={handleSort}
                      align="right"
                    />
                    <SortTh
                      label="Sessions"
                      field="sessions"
                      current={sortField}
                      asc={sortAsc}
                      onSort={handleSort}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedBreakdown.map((agent) => (
                    <tr
                      key={agent.name}
                      className="cursor-pointer"
                      onClick={() => navigate(`/agents/${agent.name}`)}
                    >
                      <td className="text-text-primary font-medium">
                        {agent.name}
                      </td>
                      <td className="text-right font-mono">
                        <span className="text-text-primary">
                          {agent.avgQuality.toFixed(3)}
                        </span>
                        {agent.declining && (
                          <ArrowDownRight
                            size={14}
                            className="inline ml-[var(--space-1)] text-status-error"
                          />
                        )}
                      </td>
                      <td
                        className={`text-right font-mono ${
                          agent.avgSentiment >= 0
                            ? "text-status-live"
                            : "text-status-error"
                        }`}
                      >
                        {formatSentiment(agent.avgSentiment)}
                      </td>
                      <td className="text-right font-mono text-text-secondary">
                        {agent.sessionCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>

      {/* Bottom row: Sentiment Distribution + Top Topics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-4)]">
        {/* Sentiment Distribution */}
        <div className="card">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Sentiment Distribution
          </h3>
          {sentTotal > 0 ? (
            <SentimentBar distribution={sentimentDist} total={sentTotal} />
          ) : (
            <p className="text-[var(--text-sm)] text-text-muted">
              No sentiment data available
            </p>
          )}
        </div>

        {/* Top Topics */}
        <div className="card">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Top Topics
          </h3>
          {topTopics.length > 0 ? (
            <div className="space-y-[var(--space-2)]">
              {topTopics.map((t) => (
                <div
                  key={t.topic}
                  className="flex items-center justify-between"
                >
                  <span className="text-[var(--text-sm)] text-text-secondary">
                    {t.topic}
                  </span>
                  <span className="text-[var(--text-xs)] text-text-muted font-mono">
                    {t.count}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[var(--text-sm)] text-text-muted">
              No topics detected yet
            </p>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}

/* ── Feedback Tab ───────────────────────────────────────────────── */

function FeedbackTab({ sinceDays }: { sinceDays: number }) {
  const [agentFilter, setAgentFilter] = useState("");
  const [ratingFilter, setRatingFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const statsQuery = useApiQuery<FeedbackStats>(
    `/api/v1/feedback/stats?since_days=${sinceDays}${agentFilter ? `&agent_name=${agentFilter}` : ""}`,
  );
  const listQuery = useApiQuery<{ feedback: FeedbackItem[]; count: number }>(
    `/api/v1/feedback?since_days=${sinceDays}&limit=50${agentFilter ? `&agent_name=${agentFilter}` : ""}${ratingFilter ? `&rating=${ratingFilter}` : ""}`,
  );

  const stats = statsQuery.data;
  const feedbackList = listQuery.data?.feedback ?? [];

  /* ── Feedback Trend: group by day ────────────────────────────── */
  const feedbackTrendData = useMemo(() => {
    if (feedbackList.length === 0) return [];
    const byDay = new Map<string, { positive: number; negative: number }>();

    for (const fb of feedbackList) {
      const ts = fb.created_at;
      if (!ts) continue;
      const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
      const key = d.toISOString().slice(0, 10);
      const entry = byDay.get(key) || { positive: 0, negative: 0 };
      if (fb.rating === "positive") entry.positive++;
      else if (fb.rating === "negative") entry.negative++;
      byDay.set(key, entry);
    }

    // Fill in missing days in the range
    const sorted = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (sorted.length === 0) return [];

    const result: Array<{ day: string; positive: number; negative: number }> = [];
    const start = new Date(sorted[0][0]);
    const end = new Date(sorted[sorted.length - 1][0]);
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      const entry = byDay.get(key) || { positive: 0, negative: 0 };
      result.push({ day: key, ...entry });
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }, [feedbackList]);

  /* ── Per-Agent Satisfaction ──────────────────────────────────── */
  const agentSatisfaction = useMemo(() => {
    const byAgent = stats?.by_agent ?? [];
    return byAgent
      .map((a) => {
        const total = (a.positive ?? 0) + (a.negative ?? 0);
        const satisfaction = total > 0 ? ((a.positive ?? 0) / total) * 100 : 0;
        return { name: a.agent_name, satisfaction, positive: a.positive, negative: a.negative, total };
      })
      .filter((a) => a.total > 0)
      .sort((a, b) => a.satisfaction - b.satisfaction);
  }, [stats]);

  /* ── Comment Highlights ─────────────────────────────────────── */
  const commentHighlights = useMemo(() => {
    return feedbackList
      .filter((fb) => fb.comment && fb.comment.trim().length > 0)
      .slice(0, 10);
  }, [feedbackList]);

  return (
    <div>
      {/* Signal cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)] mb-[var(--space-6)]">
        <SignalCard
          icon={<MessageSquare size={16} />}
          label="Total Feedback"
          value={String(stats?.total ?? 0)}
          iconColor="text-chart-blue"
          bgColor="bg-chart-blue/10"
        />
        <SignalCard
          icon={<ThumbsUp size={16} />}
          label="Positive %"
          value={`${(stats?.positive_pct ?? 0).toFixed(1)}%`}
          iconColor="text-status-live"
          bgColor="bg-status-live/10"
        />
        <SignalCard
          icon={<ThumbsDown size={16} />}
          label="Negative %"
          value={`${(stats?.negative_pct ?? 0).toFixed(1)}%`}
          iconColor="text-status-error"
          bgColor="bg-status-error/10"
        />
        <SignalCard
          icon={<Activity size={16} />}
          label="vs. Last Period"
          value={
            stats?.trend_direction === "up"
              ? `+${stats.total - stats.prev_total}`
              : stats?.trend_direction === "down"
                ? `${stats.total - stats.prev_total}`
                : "0"
          }
          iconColor={
            stats?.trend_direction === "up"
              ? "text-status-live"
              : stats?.trend_direction === "down"
                ? "text-status-error"
                : "text-text-muted"
          }
          bgColor={
            stats?.trend_direction === "up"
              ? "bg-status-live/10"
              : stats?.trend_direction === "down"
                ? "bg-status-error/10"
                : "bg-surface-overlay"
          }
        />
      </div>

      {/* Feedback Trend Chart */}
      {feedbackTrendData.length > 1 && (
        <div className="card mb-[var(--space-6)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Feedback Trend (Last {sinceDays} Days)
          </h3>
          <FeedbackTrendChart data={feedbackTrendData} />
        </div>
      )}

      {/* Per-Agent Satisfaction */}
      {agentSatisfaction.length > 0 && (
        <div className="card mb-[var(--space-6)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Per-Agent Satisfaction
          </h3>
          <AgentSatisfactionChart agents={agentSatisfaction} />
        </div>
      )}

      {/* Comment Highlights */}
      {commentHighlights.length > 0 && (
        <div className="card mb-[var(--space-6)]">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Comment Highlights
          </h3>
          <div className="space-y-[var(--space-2)]">
            {commentHighlights.map((fb) => (
              <div
                key={fb.id}
                className="flex items-start gap-[var(--space-3)] p-[var(--space-3)] rounded-lg border border-border-default bg-surface-base"
              >
                {fb.rating === "positive" ? (
                  <ThumbsUp size={14} className="text-status-live flex-shrink-0 mt-0.5" />
                ) : (
                  <ThumbsDown size={14} className="text-status-error flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
                    <span className="text-[var(--text-xs)] font-medium text-text-secondary">
                      {fb.agent_name || "unknown"}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono">
                      {timeAgo(fb.created_at)}
                    </span>
                  </div>
                  <p className="text-[var(--text-xs)] text-text-primary leading-relaxed">
                    {fb.comment}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <Filter size={14} className="text-text-muted" />
          <select
            value={ratingFilter}
            onChange={(e) => setRatingFilter(e.target.value)}
            className="text-[var(--text-xs)] bg-surface-base border border-border-default rounded-lg px-[var(--space-2)] py-[var(--space-1)] min-h-[var(--touch-target-min)] text-text-primary"
          >
            <option value="">All ratings</option>
            <option value="positive">Positive</option>
            <option value="negative">Negative</option>
            <option value="neutral">Neutral</option>
          </select>
        </div>

        {stats?.by_agent && stats.by_agent.length > 0 && (
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="text-[var(--text-xs)] bg-surface-base border border-border-default rounded-lg px-[var(--space-2)] py-[var(--space-1)] min-h-[var(--touch-target-min)] text-text-primary"
          >
            <option value="">All agents</option>
            {stats.by_agent.map((a) => (
              <option key={a.agent_name} value={a.agent_name}>
                {a.agent_name} ({a.total})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Feedback list */}
      <div className="card">
        <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Recent Feedback
        </h3>

        {feedbackList.length === 0 ? (
          <p className="text-[var(--text-sm)] text-text-muted py-[var(--space-4)]">
            No feedback recorded yet. Feedback appears when users click thumbs up/down in the playground.
          </p>
        ) : (
          <div className="space-y-[var(--space-2)]">
            {feedbackList.map((fb) => (
              <div
                key={fb.id}
                className="rounded-lg border border-border-default bg-surface-base overflow-hidden"
              >
                <button
                  onClick={() => setExpandedId(expandedId === fb.id ? null : fb.id)}
                  className="w-full flex items-center gap-[var(--space-3)] p-[var(--space-3)] min-h-[var(--touch-target-min)] hover:bg-surface-overlay transition-colors text-left"
                >
                  {/* Rating icon */}
                  {fb.rating === "positive" ? (
                    <ThumbsUp size={14} className="text-status-live flex-shrink-0" />
                  ) : fb.rating === "negative" ? (
                    <ThumbsDown size={14} className="text-status-error flex-shrink-0" />
                  ) : (
                    <MessageSquare size={14} className="text-text-muted flex-shrink-0" />
                  )}

                  {/* Agent name */}
                  <span className="text-[var(--text-xs)] font-medium text-text-secondary w-24 truncate flex-shrink-0">
                    {fb.agent_name || "unknown"}
                  </span>

                  {/* Message preview */}
                  <span className="text-[var(--text-xs)] text-text-muted flex-1 truncate">
                    {fb.message_preview?.slice(0, 120) || "No preview"}
                  </span>

                  {/* Timestamp */}
                  <span className="text-[10px] text-text-muted font-mono flex-shrink-0">
                    {timeAgo(fb.created_at)}
                  </span>

                  {expandedId === fb.id ? (
                    <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
                  ) : (
                    <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
                  )}
                </button>

                {expandedId === fb.id && (
                  <div className="px-[var(--space-4)] pb-[var(--space-4)] space-y-[var(--space-2)] border-t border-border-subtle">
                    {/* Full message */}
                    <div className="mt-[var(--space-2)]">
                      <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                        Message
                      </p>
                      <p className="text-[var(--text-xs)] text-text-secondary bg-surface-overlay rounded-lg p-[var(--space-3)] whitespace-pre-wrap">
                        {fb.message_preview || "No content"}
                      </p>
                    </div>

                    {/* Comment */}
                    {fb.comment && (
                      <div>
                        <p className="text-[10px] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
                          Comment
                        </p>
                        <p className="text-[var(--text-xs)] text-text-secondary">
                          {fb.comment}
                        </p>
                      </div>
                    )}

                    {/* Metadata */}
                    <div className="flex items-center gap-[var(--space-4)] text-[10px] text-text-muted font-mono">
                      <span>Channel: {fb.channel}</span>
                      <span>Turn: {fb.turn_number}</span>
                      {fb.session_id && (
                        <span>Session: {fb.session_id.slice(0, 8)}...</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Feedback Trend Chart (SVG) ─────────────────────────────────── */

function FeedbackTrendChart({
  data,
}: {
  data: Array<{ day: string; positive: number; negative: number }>;
}) {
  const width = 800;
  const height = 200;
  const padLeft = 40;
  const padRight = 16;
  const padTop = 12;
  const padBottom = 32;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxCount = Math.max(
    1,
    ...data.map((d) => Math.max(d.positive, d.negative)),
  );

  const toX = (i: number) =>
    padLeft + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2);
  const toY = (val: number) =>
    padTop + (1 - val / maxCount) * chartH;

  const posPoints = data.map((d, i) => `${toX(i)},${toY(d.positive)}`).join(" ");
  const negPoints = data.map((d, i) => `${toX(i)},${toY(d.negative)}`).join(" ");

  /* Y-axis labels */
  const ySteps = [0, Math.round(maxCount / 2), maxCount];

  /* X-axis: show a few labels */
  const xIndices =
    data.length <= 7
      ? data.map((_, i) => i)
      : [0, Math.floor(data.length / 2), data.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: "200px" }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Grid lines */}
        {ySteps.map((v) => (
          <line
            key={v}
            x1={padLeft}
            x2={width - padRight}
            y1={toY(v)}
            y2={toY(v)}
            stroke="var(--color-border-subtle)"
            strokeWidth="1"
          />
        ))}

        {/* Y labels */}
        {ySteps.map((v) => (
          <text
            key={`y-${v}`}
            x={padLeft - 8}
            y={toY(v) + 4}
            fill="var(--color-text-muted)"
            fontSize="10"
            textAnchor="end"
          >
            {v}
          </text>
        ))}

        {/* X labels */}
        {xIndices.map((i) => (
          <text
            key={`x-${i}`}
            x={toX(i)}
            y={height - 6}
            fill="var(--color-text-muted)"
            fontSize="10"
            textAnchor="middle"
          >
            {data[i]?.day?.slice(5) ?? ""}
          </text>
        ))}

        {/* Positive line (green) */}
        <polyline
          points={posPoints}
          fill="none"
          stroke="var(--color-chart-green)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.map((d, i) => (
          <circle
            key={`pos-${i}`}
            cx={toX(i)}
            cy={toY(d.positive)}
            r="2.5"
            fill="var(--color-chart-green)"
            stroke="var(--color-surface-raised)"
            strokeWidth="1"
          />
        ))}

        {/* Negative line (red) */}
        <polyline
          points={negPoints}
          fill="none"
          stroke="var(--color-status-error)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.map((d, i) => (
          <circle
            key={`neg-${i}`}
            cx={toX(i)}
            cy={toY(d.negative)}
            r="2.5"
            fill="var(--color-status-error)"
            stroke="var(--color-surface-raised)"
            strokeWidth="1"
          />
        ))}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-[var(--space-4)] mt-[var(--space-2)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <span className="inline-block w-3 h-[3px] rounded-full bg-chart-green" />
          <span className="text-[var(--text-xs)] text-text-muted">Positive</span>
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <span className="inline-block w-3 h-[3px] rounded-full bg-status-error" />
          <span className="text-[var(--text-xs)] text-text-muted">Negative</span>
        </div>
      </div>
    </div>
  );
}

/* ── Agent Satisfaction Horizontal Bars ─────────────────────────── */

function AgentSatisfactionChart({
  agents,
}: {
  agents: Array<{
    name: string;
    satisfaction: number;
    positive: number;
    negative: number;
    total: number;
  }>;
}) {
  return (
    <div className="space-y-[var(--space-3)]">
      {agents.map((agent) => {
        const barColor =
          agent.satisfaction > 80
            ? "var(--color-chart-green)"
            : agent.satisfaction >= 50
              ? "var(--color-status-warning)"
              : "var(--color-status-error)";

        return (
          <div key={agent.name} className="flex items-center gap-[var(--space-3)]">
            <span className="text-[var(--text-xs)] text-text-secondary w-28 truncate flex-shrink-0">
              {agent.name}
            </span>
            <div className="flex-1 h-5 rounded bg-surface-overlay overflow-hidden relative">
              <div
                className="h-full rounded transition-all"
                style={{
                  width: `${Math.max(agent.satisfaction, 2)}%`,
                  backgroundColor: barColor,
                }}
              />
            </div>
            <span
              className="text-[var(--text-xs)] font-mono w-12 text-right flex-shrink-0"
              style={{ color: barColor }}
            >
              {agent.satisfaction.toFixed(0)}%
            </span>
            <span className="text-[10px] text-text-muted font-mono w-16 text-right flex-shrink-0">
              {agent.positive}/{agent.total}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Signal Card ─────────────────────────────────────────────────── */

function SignalCard({
  icon,
  label,
  value,
  iconColor,
  bgColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  iconColor: string;
  bgColor: string;
}) {
  return (
    <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
      <div className={`p-2 rounded-lg ${bgColor}`}>
        <span className={iconColor}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
          {value}
        </p>
        <p className="text-[10px] text-text-muted uppercase tracking-wide">
          {label}
        </p>
      </div>
    </div>
  );
}

/* ── Quality Trend Chart (Multi-line SVG) ────────────────────────── */

function QualityTrendChart({
  days,
  agentNames,
}: {
  days: TrendDay[];
  agentNames: string[];
}) {
  const width = 800;
  const height = 400;
  const padLeft = 48;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 40;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  /* Y axis: 0 to 1 */
  const yMin = 0;
  const yMax = 1;
  const thresholdY = 0.7;

  const toX = (i: number) =>
    padLeft + (days.length > 1 ? (i / (days.length - 1)) * chartW : chartW / 2);
  const toY = (val: number) =>
    padTop + (1 - (val - yMin) / (yMax - yMin)) * chartH;

  /* Build overall quality polyline */
  const overallPoints = days
    .map((d, i) => `${toX(i)},${toY(d.avg_quality)}`)
    .join(" ");

  /* Y-axis labels */
  const yLabels = [0, 0.25, 0.5, 0.7, 1.0];

  /* X-axis labels: show first, middle, last */
  const xLabelIndices = days.length <= 7
    ? days.map((_, i) => i)
    : [0, Math.floor(days.length / 2), days.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: "400px" }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Grid lines */}
        {yLabels.map((v) => (
          <line
            key={v}
            x1={padLeft}
            x2={width - padRight}
            y1={toY(v)}
            y2={toY(v)}
            stroke="var(--color-border-subtle)"
            strokeWidth="1"
          />
        ))}

        {/* Threshold line at 0.7 */}
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={toY(thresholdY)}
          y2={toY(thresholdY)}
          stroke="var(--color-status-warning)"
          strokeWidth="1"
          strokeDasharray="6 4"
          opacity="0.6"
        />
        <text
          x={width - padRight + 4}
          y={toY(thresholdY) + 4}
          fill="var(--color-status-warning)"
          fontSize="10"
          opacity="0.8"
        >
          0.7
        </text>

        {/* Y-axis labels */}
        {yLabels.map((v) => (
          <text
            key={`ylbl-${v}`}
            x={padLeft - 8}
            y={toY(v) + 4}
            fill="var(--color-text-muted)"
            fontSize="10"
            textAnchor="end"
          >
            {v.toFixed(1)}
          </text>
        ))}

        {/* X-axis labels */}
        {xLabelIndices.map((i) => (
          <text
            key={`xlbl-${i}`}
            x={toX(i)}
            y={height - 8}
            fill="var(--color-text-muted)"
            fontSize="10"
            textAnchor="middle"
          >
            {days[i]?.day?.slice(5) ?? ""}
          </text>
        ))}

        {/* Overall quality line */}
        <polyline
          points={overallPoints}
          fill="none"
          stroke={CHART_COLORS[0]}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dots on the line */}
        {days.map((d, i) => (
          <circle
            key={i}
            cx={toX(i)}
            cy={toY(d.avg_quality)}
            r="3"
            fill={
              d.avg_quality < thresholdY
                ? "var(--color-status-error)"
                : CHART_COLORS[0]
            }
            stroke="var(--color-surface-raised)"
            strokeWidth="1.5"
          />
        ))}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-[var(--space-4)] mt-[var(--space-2)] flex-wrap">
        <div className="flex items-center gap-[var(--space-2)]">
          <span
            className="inline-block w-3 h-[3px] rounded-full"
            style={{ backgroundColor: CHART_COLORS[0] }}
          />
          <span className="text-[var(--text-xs)] text-text-muted">
            Avg Quality
          </span>
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <span className="inline-block w-3 h-[2px] rounded-full bg-status-warning opacity-60" />
          <span className="text-[var(--text-xs)] text-text-muted">
            Threshold (0.7)
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Sentiment Stacked Bar ───────────────────────────────────────── */

function SentimentBar({
  distribution,
  total,
}: {
  distribution: Record<string, number>;
  total: number;
}) {
  const positive = distribution.positive ?? 0;
  const neutral = distribution.neutral ?? 0;
  const negative = distribution.negative ?? 0;

  const posPct = (positive / total) * 100;
  const neuPct = (neutral / total) * 100;
  const negPct = (negative / total) * 100;

  return (
    <div>
      {/* Stacked bar */}
      <div className="flex h-6 rounded-md overflow-hidden mb-[var(--space-3)]">
        {posPct > 0 && (
          <div
            className="h-full"
            style={{
              width: `${posPct}%`,
              backgroundColor: "var(--color-chart-green)",
            }}
            title={`Positive: ${positive}`}
          />
        )}
        {neuPct > 0 && (
          <div
            className="h-full"
            style={{
              width: `${neuPct}%`,
              backgroundColor: "var(--color-text-muted)",
              opacity: 0.5,
            }}
            title={`Neutral: ${neutral}`}
          />
        )}
        {negPct > 0 && (
          <div
            className="h-full"
            style={{
              width: `${negPct}%`,
              backgroundColor: "var(--color-status-error)",
            }}
            title={`Negative: ${negative}`}
          />
        )}
      </div>

      {/* Labels */}
      <div className="flex items-center gap-[var(--space-4)] text-[var(--text-xs)]">
        <div className="flex items-center gap-[var(--space-1)]">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-chart-green" />
          <span className="text-text-muted">
            Positive {positive} ({posPct.toFixed(0)}%)
          </span>
        </div>
        <div className="flex items-center gap-[var(--space-1)]">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-text-muted opacity-50" />
          <span className="text-text-muted">
            Neutral {neutral} ({neuPct.toFixed(0)}%)
          </span>
        </div>
        <div className="flex items-center gap-[var(--space-1)]">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-status-error" />
          <span className="text-text-muted">
            Negative {negative} ({negPct.toFixed(0)}%)
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Sortable Table Header ───────────────────────────────────────── */

function SortTh({
  label,
  field,
  current,
  asc,
  onSort,
  align,
}: {
  label: string;
  field: string;
  current: string;
  asc: boolean;
  onSort: (f: any) => void;
  align?: "right";
}) {
  const isActive = field === current;
  return (
    <th
      className={`cursor-pointer select-none ${align === "right" ? "text-right" : "text-left"}`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-[var(--space-1)]">
        {label}
        {isActive && (
          <span className="text-accent text-[10px]">{asc ? "\u25B2" : "\u25BC"}</span>
        )}
      </span>
    </th>
  );
}

export { IntelligencePage as default };
