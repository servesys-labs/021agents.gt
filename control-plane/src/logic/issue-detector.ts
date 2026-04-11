/**
 * Issue detector -- auto-creates issues from session data.
 */

const QUALITY_THRESHOLD = 0.4;
const SENTIMENT_THRESHOLD = -0.5;
const TOOL_FAILURE_THRESHOLD = 2;
const BUDGET_WARN_RATIO = 0.8;

export interface DetectedIssue {
  issue_id: string;
  org_id: string;
  agent_name: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: string;
  source: string;
  source_session_id: string;
  source_turn: number;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function createIssue(
  agentName: string,
  orgId: string,
  title: string,
  description: string,
  category: string,
  severity: string,
  sourceSessionId: string = "",
): DetectedIssue {
  return {
    issue_id: randomId(),
    org_id: orgId,
    agent_name: agentName,
    title,
    description,
    category,
    severity,
    status: "open",
    source: "auto",
    source_session_id: sourceSessionId,
    source_turn: 0,
  };
}

/**
 * Analyze a completed session and detect issues.
 */
export function detectFromSession(
  sessionId: string,
  agentName: string,
  orgId: string,
  sessionData: Record<string, unknown>,
  scores: Record<string, unknown>[],
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // 1. Session errors
  const status = String(sessionData.status ?? "");
  if (status === "error" || status === "timeout") {
    issues.push(
      createIssue(
        agentName,
        orgId,
        `Session ${status}: ${sessionId.slice(0, 12)}`,
        `Session ended with status '${status}'. Error: ${sessionData.error_attribution ?? "unknown"}`,
        status === "error" ? "tool_failure" : "performance",
        status === "error" ? "high" : "medium",
        sessionId,
      ),
    );
  }

  if (scores.length > 0) {
    // 2. Low quality
    const avgQuality =
      scores.reduce((sum, s) => sum + Number(s.quality_overall ?? 0), 0) / scores.length;
    if (avgQuality < QUALITY_THRESHOLD) {
      issues.push(
        createIssue(
          agentName,
          orgId,
          `Low quality: ${agentName} (${avgQuality.toFixed(2)})`,
          `Average quality score ${avgQuality.toFixed(3)} is below threshold ${QUALITY_THRESHOLD}. Session ${sessionId.slice(0, 12)}.`,
          "knowledge_gap",
          "medium",
          sessionId,
        ),
      );
    }

    // 3. Negative sentiment
    const avgSentiment =
      scores.reduce((sum, s) => sum + Number(s.sentiment_score ?? 0), 0) / scores.length;
    if (avgSentiment < SENTIMENT_THRESHOLD) {
      issues.push(
        createIssue(
          agentName,
          orgId,
          `Negative sentiment: ${agentName}`,
          `Average sentiment score ${avgSentiment.toFixed(3)} is below threshold ${SENTIMENT_THRESHOLD}. Session ${sessionId.slice(0, 12)}.`,
          "knowledge_gap",
          "low",
          sessionId,
        ),
      );
    }

    // 4. Tool failures
    const toolFailures = scores.filter((s) => s.has_tool_failure).length;
    if (toolFailures >= TOOL_FAILURE_THRESHOLD) {
      const failedTopics = new Set<string>();
      for (const s of scores) {
        if (s.has_tool_failure) failedTopics.add(String(s.topic ?? "unknown"));
      }
      issues.push(
        createIssue(
          agentName,
          orgId,
          `Multiple tool failures: ${agentName} (${toolFailures}x)`,
          `${toolFailures} tool failures in session ${sessionId.slice(0, 12)}. Related topics: ${[...failedTopics].join(", ")}.`,
          "tool_failure",
          "high",
          sessionId,
        ),
      );
    }

    // 5. Hallucination risk
    const hallCount = scores.filter((s) => s.has_hallucination_risk).length;
    if (hallCount >= 2) {
      issues.push(
        createIssue(
          agentName,
          orgId,
          `Hallucination risk: ${agentName} (${hallCount} turns)`,
          `${hallCount} turns flagged for hallucination risk in session ${sessionId.slice(0, 12)}.`,
          "hallucination",
          "medium",
          sessionId,
        ),
      );
    }
  }

  // 6. Budget overrun
  const cost = Number(sessionData.cost_total_usd ?? 0);
  const budget = Number(sessionData.budget_limit_usd ?? 0);
  if (budget > 0 && cost > budget * BUDGET_WARN_RATIO) {
    issues.push(
      createIssue(
        agentName,
        orgId,
        `Budget warning: ${agentName} ($${cost.toFixed(4)}/$${budget.toFixed(2)})`,
        `Session cost $${cost.toFixed(4)} exceeds ${(BUDGET_WARN_RATIO * 100).toFixed(0)}% of budget $${budget.toFixed(2)}.`,
        "performance",
        cost < budget ? "low" : "high",
        sessionId,
      ),
    );
  }

  return issues;
}
