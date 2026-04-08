import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { TrendingUp, TrendingDown, MessageSquare, AlertCircle, Lightbulb, ThumbsUp, ThumbsDown, Minus, Loader2 } from "lucide-react";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { StatCard } from "../components/ui/StatCard";
import { TabNav } from "../components/ui/TabNav";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { SimpleChart } from "../components/SimpleChart";
import { api } from "../lib/api";
import { agentPathSegment } from "../lib/agent-path";
import { ensureArray } from "../lib/ensure-array";

interface TopicInsight {
  topic: string;
  count: number;
  trend: "up" | "down" | "flat";
  sentiment: "positive" | "neutral" | "negative";
  sample_question: string;
}

interface KnowledgeGap {
  question: string;
  count: number;
  category: string;
  suggestion: string;
}

const sentimentIcon = {
  positive: <ThumbsUp size={14} className="text-success" />,
  neutral: <Minus size={14} className="text-text-muted" />,
  negative: <ThumbsDown size={14} className="text-danger" />,
};

const trendIcon = {
  up: <TrendingUp size={14} className="text-success" />,
  down: <TrendingDown size={14} className="text-danger" />,
  flat: <Minus size={14} className="text-text-muted" />,
};

export default function AgentInsightsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"topics" | "gaps" | "sentiment">("topics");

  const [agentName, setAgentName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [topics, setTopics] = useState<TopicInsight[]>([]);
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [sentimentData, setSentimentData] = useState<{ label: string; value: number }[]>([]);
  const [resolutionData, setResolutionData] = useState<{ label: string; value: number }[]>([]);
  /** When set, sentiment tab uses DB distribution instead of per-topic sentiment. */
  const [sentimentCounts, setSentimentCounts] = useState<{
    positive: number;
    neutral: number;
    negative: number;
  } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const agent = await api.get<{ name: string }>(`/agents/${agentPathSegment(id)}`);
        if (cancelled) return;
        setAgentName(agent.name ?? id);

        const trends = await api
          .get<Record<string, unknown>>(
            `/intelligence/trends?agent_name=${encodeURIComponent(id.trim())}&since_days=30`,
          )
          .catch(() => ({} as Record<string, unknown>));
        if (cancelled) return;

        const topicDist = trends.topic_distribution;
        if (topicDist && typeof topicDist === "object" && !Array.isArray(topicDist)) {
          const topicList: TopicInsight[] = Object.entries(topicDist as Record<string, unknown>)
            .map(([topic, count]) => ({
              topic,
              count: Number(count) || 0,
              trend: "flat" as const,
              sentiment: "neutral" as const,
              sample_question: "",
            }))
            .filter((t) => t.count > 0)
            .sort((a, b) => b.count - a.count);
          setTopics(topicList);
        } else {
          setTopics([]);
        }

        const sentDist = trends.sentiment_distribution;
        if (sentDist && typeof sentDist === "object" && !Array.isArray(sentDist)) {
          const o = sentDist as Record<string, unknown>;
          const n = (k: string) => Number(o[k] ?? 0) || 0;
          setSentimentData(
            Object.entries(o).map(([label, value]) => ({ label, value: Number(value) || 0 })),
          );
          setSentimentCounts({
            positive: n("positive") + n("Positive"),
            neutral: n("neutral") + n("Neutral"),
            negative: n("negative") + n("Negative"),
          });
        } else {
          setSentimentData([]);
          setSentimentCounts(null);
        }

        const daily = ensureArray<{ day?: string; avg_quality?: number }>(trends.daily);
        setResolutionData(
          daily.map((d) => ({
            label: String(d.day || "").slice(5) || "—",
            value: Math.min(100, Math.round((Number(d.avg_quality) || 0) * 100)),
          })),
        );

        setGaps([]);
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load insights");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-text-secondary">Loading insights...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-24">
        <p className="text-sm text-danger mb-2">{error}</p>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  if (!agentName) return <AgentNotFound />;

  const totalQuestions = topics.reduce((s, t) => s + t.count, 0);
  // Calculate positive sentiment percentage (not avg of raw counts)
  const sentimentTotal = sentimentData.reduce((s, d) => s + d.value, 0);
  const positiveSentiment = sentimentData.find(d => d.label.toLowerCase() === "positive")?.value || 0;
  const avgSentiment = sentimentTotal > 0 ? Math.round((positiveSentiment / sentimentTotal) * 100) : 0;
  const isEmpty = topics.length === 0 && gaps.length === 0 && sentimentData.length === 0 && resolutionData.length === 0;

  const posSent = sentimentCounts
    ? sentimentCounts.positive
    : topics.filter((t) => t.sentiment === "positive").reduce((s, t) => s + t.count, 0);
  const neuSent = sentimentCounts
    ? sentimentCounts.neutral
    : topics.filter((t) => t.sentiment === "neutral").reduce((s, t) => s + t.count, 0);
  const negSent = sentimentCounts
    ? sentimentCounts.negative
    : topics.filter((t) => t.sentiment === "negative").reduce((s, t) => s + t.count, 0);
  const sentDistTotal = posSent + neuSent + negSent;

  if (isEmpty) {
    return (
      <div>
        <AgentNav agentName={agentName} />
        <Card>
          <div className="text-center py-12">
            <Lightbulb size={40} className="mx-auto text-text-muted mb-3" />
            <p className="text-sm font-medium text-text mb-1">No insights yet</p>
            <p className="text-xs text-text-muted">Insights will appear here once your agent starts having conversations.</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <AgentNav agentName={agentName} />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon={<MessageSquare size={14} className="text-primary" />} label="Questions this week" value={totalQuestions} />
        <StatCard icon={<ThumbsUp size={14} className="text-success" />} label="Avg sentiment" value={`${avgSentiment}%`} />
        <StatCard icon={<TrendingUp size={14} className="text-primary" />} label="Unique topics" value={topics.length} />
        <StatCard icon={<AlertCircle size={14} className="text-warning" />} label="Knowledge gaps" value={gaps.length} />
      </div>

      {/* Charts */}
      {(sentimentData.length > 0 || resolutionData.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {sentimentData.length > 0 && (
            <Card>
              <p className="text-sm font-medium text-text mb-3">Customer Sentiment</p>
              <SimpleChart data={sentimentData} type="line" color="var(--color-success)" />
            </Card>
          )}
          {resolutionData.length > 0 && (
            <Card>
              <p className="text-sm font-medium text-text mb-3">Resolution Rate</p>
              <SimpleChart data={resolutionData} type="line" color="var(--color-primary)" />
            </Card>
          )}
        </div>
      )}

      <TabNav
        tabs={[
          { key: "topics", label: "Top Topics" },
          { key: "gaps", label: "Knowledge Gaps" },
          { key: "sentiment", label: "Sentiment Breakdown" },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />

      {/* Topics tab */}
      {tab === "topics" && (
        <div className="space-y-3">
          {topics.length === 0 && (
            <Card>
              <p className="p-6 text-sm text-text-muted text-center">No topic data available yet.</p>
            </Card>
          )}
          {topics.map((topic, i) => {
            const maxCount = topics[0]?.count || 1;
            const barWidth = (topic.count / maxCount) * 100;
            return (
              <Card key={topic.topic}>
                <div className="flex items-center gap-4">
                  <span className="text-xs font-mono text-text-muted w-5 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-text">{topic.topic}</span>
                      {trendIcon[topic.trend]}
                      {sentimentIcon[topic.sentiment]}
                    </div>
                    <div className="w-full bg-surface-alt rounded-full h-1.5 mb-1.5">
                      <div className="bg-primary rounded-full h-1.5 transition-all" style={{ width: `${barWidth}%` }} />
                    </div>
                    <p className="text-xs text-text-muted italic">"{topic.sample_question}"</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-semibold text-text">{topic.count}</p>
                    <p className="text-xs text-text-muted">questions</p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Gaps tab */}
      {tab === "gaps" && (
        <div className="space-y-3">
          {gaps.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-warning-light text-warning-dark text-xs rounded-lg mb-4">
              <Lightbulb size={14} />
              These are questions your agent couldn't confidently answer. Upload docs or update your knowledge base to fix them.
            </div>
          )}
          {gaps.length === 0 && (
            <Card>
              <p className="p-6 text-sm text-text-muted text-center">No knowledge gaps detected yet.</p>
            </Card>
          )}
          {gaps.map((gap) => (
            <Card key={gap.question}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-warning-light flex items-center justify-center shrink-0">
                  <AlertCircle size={16} className="text-warning" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">"{gap.question}"</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="default">{gap.category}</Badge>
                    <span className="text-xs text-text-muted">Asked {gap.count} times</span>
                  </div>
                  <div className="flex items-start gap-1.5 mt-2 bg-info-light rounded-lg px-3 py-2">
                    <Lightbulb size={12} className="text-primary mt-0.5 shrink-0" />
                    <p className="text-xs text-info-dark">{gap.suggestion}</p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
          {gaps.length > 0 && (
            <div className="text-center pt-4">
              <Button size="sm" variant="secondary" onClick={() => id && navigate(`/agents/${agentPathSegment(id)}/knowledge`)}>
                Go to Knowledge Base
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Sentiment tab */}
      {tab === "sentiment" && (
        <div className="space-y-4">
          {topics.length === 0 && (
            <Card>
              <p className="p-6 text-sm text-text-muted text-center">No sentiment data available yet.</p>
            </Card>
          )}
          {topics.length > 0 && (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Card>
                  <div className="flex items-center gap-2 mb-2">
                    <ThumbsUp size={16} className="text-success" />
                    <span className="text-sm font-medium text-text">Positive</span>
                  </div>
                  <p className="text-2xl font-semibold text-success">{posSent}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {sentDistTotal > 0 ? Math.round((posSent / sentDistTotal) * 100) : 0}% of scored turns
                  </p>
                </Card>
                <Card>
                  <div className="flex items-center gap-2 mb-2">
                    <Minus size={16} className="text-text-muted" />
                    <span className="text-sm font-medium text-text">Neutral</span>
                  </div>
                  <p className="text-2xl font-semibold text-text">{neuSent}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {sentDistTotal > 0 ? Math.round((neuSent / sentDistTotal) * 100) : 0}% of scored turns
                  </p>
                </Card>
                <Card>
                  <div className="flex items-center gap-2 mb-2">
                    <ThumbsDown size={16} className="text-danger" />
                    <span className="text-sm font-medium text-text">Negative</span>
                  </div>
                  <p className="text-2xl font-semibold text-danger">{negSent}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {sentDistTotal > 0 ? Math.round((negSent / sentDistTotal) * 100) : 0}% of scored turns
                  </p>
                </Card>
              </div>

              <Card>
                <p className="text-sm font-medium text-text mb-3">Sentiment by topic</p>
                <div className="space-y-2">
                  {topics.map((topic) => (
                    <div key={topic.topic} className="flex items-center gap-3">
                      <span className="text-xs text-text-secondary w-36 truncate">{topic.topic}</span>
                      {sentimentIcon[topic.sentiment]}
                      <div className="flex-1 bg-surface-alt rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${
                            topic.sentiment === "positive" ? "bg-success" : topic.sentiment === "negative" ? "bg-danger" : "bg-surface-alt"
                          }`}
                          style={{ width: `${(topic.count / (topics[0]?.count || 1)) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-text-muted w-8 text-right">{topic.count}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
