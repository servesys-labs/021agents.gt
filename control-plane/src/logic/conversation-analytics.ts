/**
 * Conversation analytics -- session scoring via AI or heuristics.
 * Ported from agentos/observability/analytics.py, sentiment.py, quality.py.
 */

// ── Heuristic sentiment analysis ─────────────────────────────────

const POSITIVE_WORDS = new Set([
  "thanks", "thank", "great", "perfect", "excellent", "awesome",
  "helpful", "good", "nice", "wonderful", "appreciate", "love",
  "amazing", "fantastic", "brilliant", "superb",
]);

const NEGATIVE_WORDS = new Set([
  "bad", "terrible", "horrible", "awful", "wrong", "error",
  "fail", "broken", "useless", "hate", "worst", "sucks",
  "poor", "disappointing", "frustrated", "annoying",
]);

interface SentimentResult {
  sentiment: string;
  score: number;
  confidence: number;
}

function analyzeSentiment(text: string): SentimentResult {
  const words = text.toLowerCase().split(/\s+/);
  let posCount = 0;
  let negCount = 0;
  for (const w of words) {
    const cleaned = w.replace(/[^a-z]/g, "");
    if (POSITIVE_WORDS.has(cleaned)) posCount++;
    if (NEGATIVE_WORDS.has(cleaned)) negCount++;
  }

  const total = posCount + negCount;
  if (total === 0) {
    return { sentiment: "neutral", score: 0.0, confidence: 0.3 };
  }

  const score = (posCount - negCount) / total;
  const confidence = Math.min(0.9, 0.3 + total * 0.1);

  let sentiment: string;
  if (score > 0.2) sentiment = "positive";
  else if (score < -0.2) sentiment = "negative";
  else sentiment = "neutral";

  return { sentiment, score: Math.round(score * 1000) / 1000, confidence: Math.round(confidence * 1000) / 1000 };
}

// ── Heuristic quality scoring ────────────────────────────────────

interface QualityResult {
  relevance: number;
  coherence: number;
  helpfulness: number;
  safety: number;
  overall: number;
  topic: string;
  intent: string;
  has_tool_failure: boolean;
  has_hallucination_risk: boolean;
}

function scoreQuality(
  inputText: string,
  outputText: string,
  toolCalls: unknown[],
  toolResults: unknown[],
): QualityResult {
  const outputLen = outputText.length;

  // Relevance: does output address the input?
  const inputWords = new Set(inputText.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const outputWords = new Set(outputText.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  let overlap = 0;
  for (const w of inputWords) {
    if (outputWords.has(w)) overlap++;
  }
  const relevance = inputWords.size > 0
    ? Math.min(1.0, 0.3 + (overlap / inputWords.size) * 0.7)
    : 0.5;

  // Coherence: based on output length and structure
  const coherence = outputLen > 20
    ? Math.min(1.0, 0.4 + Math.min(outputLen, 2000) / 3000)
    : 0.2;

  // Helpfulness: did it provide substantive content?
  const helpfulness = outputLen > 50 ? Math.min(1.0, 0.3 + outputLen / 2000) : 0.2;

  // Safety: check for unsafe patterns
  const lower = outputText.toLowerCase();
  const unsafePatterns = ["<script", "rm -rf", "drop table", "exec(", "eval("];
  const hasSafetyIssue = unsafePatterns.some((p) => lower.includes(p));
  const safety = hasSafetyIssue ? 0.1 : 0.95;

  // Tool failure detection
  const hasToolFailure = toolResults.some((r) => {
    if (typeof r === "object" && r !== null) {
      const rr = r as Record<string, unknown>;
      return rr.error || rr.status === "error" || String(rr.output ?? "").includes("Error");
    }
    return false;
  });

  // Hallucination risk heuristic
  const uncertaintyMarkers = ["i think", "i believe", "not sure", "might be", "possibly"];
  const hasHallucinationRisk =
    !uncertaintyMarkers.some((m) => lower.includes(m)) &&
    outputLen > 200 &&
    relevance < 0.5;

  // Topic detection (simple keyword)
  let topic = "general";
  const topicMap: Record<string, string[]> = {
    code: ["function", "class", "import", "const", "let", "var", "def"],
    data: ["database", "query", "table", "sql", "csv"],
    api: ["endpoint", "request", "response", "http", "api"],
    devops: ["deploy", "docker", "kubernetes", "ci/cd", "pipeline"],
  };
  for (const [t, keywords] of Object.entries(topicMap)) {
    if (keywords.some((k) => lower.includes(k))) {
      topic = t;
      break;
    }
  }

  // Intent detection
  let intent = "question";
  if (lower.includes("fix") || lower.includes("solve") || lower.includes("debug"))
    intent = "troubleshoot";
  else if (lower.includes("create") || lower.includes("generate") || lower.includes("write"))
    intent = "create";
  else if (lower.includes("explain") || lower.includes("how") || lower.includes("why"))
    intent = "explain";

  const overall = (relevance * 0.3 + coherence * 0.2 + helpfulness * 0.3 + safety * 0.2);

  return {
    relevance: Math.round(relevance * 1000) / 1000,
    coherence: Math.round(coherence * 1000) / 1000,
    helpfulness: Math.round(helpfulness * 1000) / 1000,
    safety: Math.round(safety * 1000) / 1000,
    overall: Math.round(overall * 1000) / 1000,
    topic,
    intent,
    has_tool_failure: hasToolFailure,
    has_hallucination_risk: hasHallucinationRisk,
  };
}

// ── Trend computation ────────────────────────────────────────────

function computeTrend(values: number[]): string {
  if (values.length < 2) return "stable";

  const mid = Math.floor(values.length / 2);
  const firstHalf = mid > 0 ? values.slice(0, mid) : values.slice(0, 1);
  const secondHalf = values.slice(mid);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const delta = secondAvg - firstAvg;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev > 0.4) return "volatile";
  if (delta > 0.15) return "improving";
  if (delta < -0.15) return "declining";
  return "stable";
}

// ── LLM-based scoring via Workers AI ─────────────────────────────

interface AIScoreResult {
  quality: number;
  sentiment: number;
  sentiment_label: string;
  relevance: number;
  coherence: number;
  helpfulness: number;
  safety: number;
  topic: string;
  intent: string;
}

async function scoreTurnWithAI(
  ai: Ai,
  inputText: string,
  outputText: string,
  modelId: string,
): Promise<AIScoreResult | null> {
  try {
    const prompt = `Score this AI agent conversation turn. Return JSON only, no other text.

User input: "${inputText.slice(0, 500)}"
Agent output: "${outputText.slice(0, 1000)}"

Return exactly this JSON structure:
{"quality":0.0-1.0,"sentiment":-1.0-1.0,"sentiment_label":"positive|negative|neutral","relevance":0.0-1.0,"coherence":0.0-1.0,"helpfulness":0.0-1.0,"safety":0.0-1.0,"topic":"general|code|data|api|devops","intent":"question|troubleshoot|create|explain"}`;

    const response = await ai.run(modelId as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });

    const text = typeof response === "string"
      ? response
      : (response as { response?: string }).response ?? "";

    // Extract JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as AIScoreResult;
    return parsed;
  } catch {
    return null;
  }
}

// ── Main session scoring function ────────────────────────────────

export interface TurnScore {
  turn_number: number;
  sentiment: SentimentResult;
  quality: QualityResult;
  scorer_model: string;
}

export interface SessionScoreResult {
  session_id: string;
  total_turns: number;
  avg_sentiment_score: number;
  dominant_sentiment: string;
  sentiment_trend: string;
  avg_quality: number;
  min_quality: number;
  max_quality: number;
  topics: string[];
  intents: string[];
  failure_patterns: string[];
  tool_failure_count: number;
  hallucination_risk_count: number;
  turn_scores: TurnScore[];
}

export async function scoreSession(
  sessionId: string,
  turns: Record<string, unknown>[],
  inputText: string,
  orgId: string,
  agentName: string,
  ai?: Ai,
  aiScoringModel = "@cf/meta/llama-3.1-8b-instruct",
): Promise<SessionScoreResult> {
  const turnScores: TurnScore[] = [];
  const allTopics: string[] = [];
  const allIntents: string[] = [];
  const failurePatterns: string[] = [];
  const qualityValues: number[] = [];
  const sentimentValues: number[] = [];

  for (const turn of turns) {
    const turnNumber = Number(turn.turn_number ?? 0);
    const content = String(turn.content ?? turn.llm_content ?? "");
    const turnInput = String(turn.input_text ?? inputText);

    let toolCalls: unknown[] = [];
    let toolResults: unknown[] = [];
    try {
      const raw = turn.tool_calls;
      toolCalls = typeof raw === "string" ? JSON.parse(raw) : (raw as unknown[]) ?? [];
    } catch { /* empty */ }
    try {
      const raw = turn.tool_results;
      toolResults = typeof raw === "string" ? JSON.parse(raw) : (raw as unknown[]) ?? [];
    } catch { /* empty */ }

    let scorerModel = "heuristic";
    let sent: SentimentResult;
    let qual: QualityResult;

    // Try AI scoring if available
    if (ai) {
      const aiResult = await scoreTurnWithAI(ai, turnInput, content, aiScoringModel);
      if (aiResult) {
        scorerModel = aiScoringModel;
        sent = {
          sentiment: aiResult.sentiment_label,
          score: aiResult.sentiment,
          confidence: 0.8,
        };
        qual = {
          relevance: aiResult.relevance,
          coherence: aiResult.coherence,
          helpfulness: aiResult.helpfulness,
          safety: aiResult.safety,
          overall: aiResult.quality,
          topic: aiResult.topic,
          intent: aiResult.intent,
          has_tool_failure: toolResults.some((r) => {
            if (typeof r === "object" && r !== null) {
              const rr = r as Record<string, unknown>;
              return rr.error || rr.status === "error";
            }
            return false;
          }),
          has_hallucination_risk: false,
        };
      } else {
        // Fallback to heuristic
        sent = analyzeSentiment(content);
        qual = scoreQuality(turnInput, content, toolCalls, toolResults);
      }
    } else {
      sent = analyzeSentiment(content);
      qual = scoreQuality(turnInput, content, toolCalls, toolResults);
    }

    sentimentValues.push(sent.score);
    qualityValues.push(qual.overall);

    if (qual.topic && qual.topic !== "general") allTopics.push(qual.topic);
    allIntents.push(qual.intent);
    if (qual.has_tool_failure) failurePatterns.push(`turn_${turnNumber}_tool_failure`);

    turnScores.push({
      turn_number: turnNumber,
      sentiment: sent,
      quality: qual,
      scorer_model: scorerModel,
    });
  }

  // Aggregates
  const avgSentiment = sentimentValues.length
    ? sentimentValues.reduce((a, b) => a + b, 0) / sentimentValues.length
    : 0.0;
  const avgQuality = qualityValues.length
    ? qualityValues.reduce((a, b) => a + b, 0) / qualityValues.length
    : 0.0;
  const minQuality = qualityValues.length ? Math.min(...qualityValues) : 0.0;
  const maxQuality = qualityValues.length ? Math.max(...qualityValues) : 0.0;

  const sentimentTrend = computeTrend(sentimentValues);

  // Dominant sentiment
  const sentimentLabels = turnScores.map((ts) => ts.sentiment.sentiment);
  const labelCounts: Record<string, number> = {};
  for (const label of sentimentLabels) {
    labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  }
  let dominantSentiment = "neutral";
  let maxCount = 0;
  for (const [label, count] of Object.entries(labelCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantSentiment = label;
    }
  }

  // Dedupe topics/intents preserving order
  const uniqueTopics = [...new Map(allTopics.map((t) => [t, t])).values()];
  const uniqueIntents = [...new Map(allIntents.map((i) => [i, i])).values()];

  const toolFailureCount = turnScores.filter((ts) => ts.quality.has_tool_failure).length;
  const hallucinationRiskCount = turnScores.filter((ts) => ts.quality.has_hallucination_risk).length;

  return {
    session_id: sessionId,
    total_turns: turns.length,
    avg_sentiment_score: Math.round(avgSentiment * 1000) / 1000,
    dominant_sentiment: dominantSentiment,
    sentiment_trend: sentimentTrend,
    avg_quality: Math.round(avgQuality * 1000) / 1000,
    min_quality: Math.round(minQuality * 1000) / 1000,
    max_quality: Math.round(maxQuality * 1000) / 1000,
    topics: uniqueTopics,
    intents: uniqueIntents,
    failure_patterns: failurePatterns,
    tool_failure_count: toolFailureCount,
    hallucination_risk_count: hallucinationRiskCount,
    turn_scores: turnScores,
  };
}
