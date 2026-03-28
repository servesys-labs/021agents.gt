import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { TrendingUp, TrendingDown, MessageSquare, AlertCircle, Lightbulb, ThumbsUp, ThumbsDown, Minus } from "lucide-react";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { StatCard } from "../components/ui/StatCard";
import { TabNav } from "../components/ui/TabNav";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { SimpleChart } from "../components/SimpleChart";
import { MOCK_AGENTS } from "../lib/mock-data";

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

const MOCK_TOPICS: TopicInsight[] = [
  { topic: "Delivery & Shipping", count: 47, trend: "up", sentiment: "neutral", sample_question: "Do you deliver to the West Side on weekends?" },
  { topic: "Pricing & Quotes", count: 38, trend: "up", sentiment: "positive", sample_question: "How much is a dozen red roses?" },
  { topic: "Wedding Flowers", count: 24, trend: "up", sentiment: "positive", sample_question: "Do you do wedding centerpieces?" },
  { topic: "Order Status", count: 21, trend: "flat", sentiment: "neutral", sample_question: "Where is my order #1042?" },
  { topic: "Returns & Refunds", count: 15, trend: "down", sentiment: "negative", sample_question: "My flowers arrived dead, I want a refund" },
  { topic: "Store Hours", count: 12, trend: "flat", sentiment: "neutral", sample_question: "Are you open on Sundays?" },
  { topic: "Custom Arrangements", count: 10, trend: "up", sentiment: "positive", sample_question: "Can I get a custom bouquet for an anniversary?" },
  { topic: "Sympathy & Funeral", count: 8, trend: "flat", sentiment: "neutral", sample_question: "Do you have sympathy arrangements?" },
];

const MOCK_GAPS: KnowledgeGap[] = [
  { question: "Do you offer subscription/weekly delivery?", count: 7, category: "Services", suggestion: "Add info about subscription plans to your knowledge base" },
  { question: "Can I order same-day delivery after 3pm?", count: 5, category: "Delivery", suggestion: "Clarify cutoff times in your FAQ document" },
  { question: "Do you do corporate/office arrangements?", count: 4, category: "Services", suggestion: "Add a corporate services section to your product catalog" },
  { question: "What flowers are pet-safe?", count: 3, category: "Products", suggestion: "Add pet safety info to your product descriptions" },
  { question: "Do you accept Apple Pay / Google Pay?", count: 3, category: "Payments", suggestion: "List all accepted payment methods in your FAQ" },
];

const SENTIMENT_DATA = [
  { label: "03-22", value: 78 },
  { label: "03-23", value: 72 },
  { label: "03-24", value: 82 },
  { label: "03-25", value: 85 },
  { label: "03-26", value: 80 },
  { label: "03-27", value: 88 },
  { label: "03-28", value: 86 },
];

const RESOLUTION_DATA = [
  { label: "03-22", value: 85 },
  { label: "03-23", value: 82 },
  { label: "03-24", value: 90 },
  { label: "03-25", value: 88 },
  { label: "03-26", value: 92 },
  { label: "03-27", value: 91 },
  { label: "03-28", value: 94 },
];

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
  const { id } = useParams();
  const navigate = useNavigate();
  const agent = MOCK_AGENTS.find((a) => a.id === id);
  const [tab, setTab] = useState<"topics" | "gaps" | "sentiment">("topics");

  if (!agent) return <AgentNotFound />;

  const totalQuestions = MOCK_TOPICS.reduce((s, t) => s + t.count, 0);
  const positiveTopics = MOCK_TOPICS.filter((t) => t.sentiment === "positive").length;
  const avgSentiment = Math.round(SENTIMENT_DATA.reduce((s, d) => s + d.value, 0) / SENTIMENT_DATA.length);

  return (
    <div>
      <AgentNav agentName={agent.name} />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon={<MessageSquare size={14} className="text-primary" />} label="Questions this week" value={totalQuestions} />
        <StatCard icon={<ThumbsUp size={14} className="text-success" />} label="Avg sentiment" value={`${avgSentiment}%`} />
        <StatCard icon={<TrendingUp size={14} className="text-primary" />} label="Unique topics" value={MOCK_TOPICS.length} />
        <StatCard icon={<AlertCircle size={14} className="text-warning" />} label="Knowledge gaps" value={MOCK_GAPS.length} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <Card>
          <p className="text-sm font-medium text-text mb-3">Customer Sentiment</p>
          <SimpleChart data={SENTIMENT_DATA} type="line" color="var(--color-success)" />
        </Card>
        <Card>
          <p className="text-sm font-medium text-text mb-3">Resolution Rate</p>
          <SimpleChart data={RESOLUTION_DATA} type="line" color="var(--color-primary)" />
        </Card>
      </div>

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
          {MOCK_TOPICS.map((topic, i) => {
            const maxCount = MOCK_TOPICS[0].count;
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
                    <div className="w-full bg-gray-100 rounded-full h-1.5 mb-1.5">
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
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 text-amber-700 text-xs rounded-lg mb-4">
            <Lightbulb size={14} />
            These are questions your agent couldn't confidently answer. Upload docs or update your knowledge base to fix them.
          </div>
          {MOCK_GAPS.map((gap) => (
            <Card key={gap.question}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                  <AlertCircle size={16} className="text-warning" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">"{gap.question}"</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="default">{gap.category}</Badge>
                    <span className="text-xs text-text-muted">Asked {gap.count} times</span>
                  </div>
                  <div className="flex items-start gap-1.5 mt-2 bg-blue-50 rounded-lg px-3 py-2">
                    <Lightbulb size={12} className="text-primary mt-0.5 shrink-0" />
                    <p className="text-xs text-blue-700">{gap.suggestion}</p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
          <div className="text-center pt-4">
            <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/knowledge`)}>
              Go to Knowledge Base
            </Button>
          </div>
        </div>
      )}

      {/* Sentiment tab */}
      {tab === "sentiment" && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <div className="flex items-center gap-2 mb-2">
                <ThumbsUp size={16} className="text-success" />
                <span className="text-sm font-medium text-text">Positive</span>
              </div>
              <p className="text-2xl font-semibold text-success">
                {MOCK_TOPICS.filter((t) => t.sentiment === "positive").reduce((s, t) => s + t.count, 0)}
              </p>
              <p className="text-xs text-text-muted mt-1">
                {Math.round(
                  (MOCK_TOPICS.filter((t) => t.sentiment === "positive").reduce((s, t) => s + t.count, 0) / totalQuestions) * 100,
                )}% of conversations
              </p>
            </Card>
            <Card>
              <div className="flex items-center gap-2 mb-2">
                <Minus size={16} className="text-text-muted" />
                <span className="text-sm font-medium text-text">Neutral</span>
              </div>
              <p className="text-2xl font-semibold text-text">
                {MOCK_TOPICS.filter((t) => t.sentiment === "neutral").reduce((s, t) => s + t.count, 0)}
              </p>
              <p className="text-xs text-text-muted mt-1">
                {Math.round(
                  (MOCK_TOPICS.filter((t) => t.sentiment === "neutral").reduce((s, t) => s + t.count, 0) / totalQuestions) * 100,
                )}% of conversations
              </p>
            </Card>
            <Card>
              <div className="flex items-center gap-2 mb-2">
                <ThumbsDown size={16} className="text-danger" />
                <span className="text-sm font-medium text-text">Negative</span>
              </div>
              <p className="text-2xl font-semibold text-danger">
                {MOCK_TOPICS.filter((t) => t.sentiment === "negative").reduce((s, t) => s + t.count, 0)}
              </p>
              <p className="text-xs text-text-muted mt-1">
                {Math.round(
                  (MOCK_TOPICS.filter((t) => t.sentiment === "negative").reduce((s, t) => s + t.count, 0) / totalQuestions) * 100,
                )}% of conversations
              </p>
            </Card>
          </div>

          <Card>
            <p className="text-sm font-medium text-text mb-3">Sentiment by topic</p>
            <div className="space-y-2">
              {MOCK_TOPICS.map((topic) => (
                <div key={topic.topic} className="flex items-center gap-3">
                  <span className="text-xs text-text-secondary w-36 truncate">{topic.topic}</span>
                  {sentimentIcon[topic.sentiment]}
                  <div className="flex-1 bg-gray-100 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${
                        topic.sentiment === "positive" ? "bg-success" : topic.sentiment === "negative" ? "bg-danger" : "bg-gray-300"
                      }`}
                      style={{ width: `${(topic.count / MOCK_TOPICS[0].count) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-text-muted w-8 text-right">{topic.count}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
