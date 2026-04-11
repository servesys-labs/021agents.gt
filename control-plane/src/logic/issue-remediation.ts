/**
 * Remediation engine -- generates fix suggestions for issues.
 */

const FIX_TEMPLATES: Record<string, string[]> = {
  tool_failure: [
    "Check tool availability and permissions",
    "Verify tool timeout settings (current may be too low)",
    "Add retry logic with exponential backoff",
    "Review tool input validation -- malformed inputs may cause failures",
    "Consider adding the failing tool to the blocklist if consistently broken",
  ],
  knowledge_gap: [
    "Expand the agent's system prompt with domain knowledge",
    "Add relevant documents to the RAG knowledge base",
    "Increase episodic memory capacity for better context retention",
    "Consider using a more capable model for this task type",
    "Add example Q&A pairs to the agent's training data",
  ],
  hallucination: [
    "Add 'If you are unsure, say so' to the system prompt",
    "Enable RAG retrieval for factual grounding",
    "Reduce temperature to 0.0 for more deterministic outputs",
    "Add fact-checking tools (web search, knowledge base lookup)",
    "Increase system prompt emphasis on accuracy over helpfulness",
  ],
  security: [
    "Review and tighten governance policies",
    "Add the flagged action to the blocked tools list",
    "Enable require_confirmation_for_destructive",
    "Restrict allowed domains in governance config",
    "Audit the agent's tool permissions and reduce scope",
  ],
  performance: [
    "Lower the budget limit or add cost alerts",
    "Reduce max_turns to prevent runaway sessions",
    "Use a smaller/faster model for simple subtasks (plan routing)",
    "Enable context summarization middleware to reduce token usage",
    "Set timeout_seconds to prevent long-running sessions",
  ],
  config_drift: [
    "Re-sync agent config with its gold image",
    "Review and approve the configuration changes",
    "Run compliance check: agentos gold-image check <agent>",
    "Update the gold image if the drift is intentional",
    "Lock the agent config to prevent unauthorized changes",
  ],
};

/** Generate a fix suggestion string for an issue. */
export function suggestFix(issue: Record<string, unknown>): string {
  const category = String(issue.category ?? "unknown");
  const title = String(issue.title ?? "");
  const description = String(issue.description ?? "");

  const templates = FIX_TEMPLATES[category];
  if (!templates) {
    return "Review the issue manually and investigate root cause.";
  }

  const suggestions = [...templates.slice(0, 3)];

  const combined = `${title} ${description}`.toLowerCase();
  if (combined.includes("timeout")) {
    suggestions.push("Increase timeout_seconds in agent config");
  }
  if (combined.includes("budget")) {
    suggestions.push("Review cost per session and adjust budget_limit_usd");
  }

  return suggestions
    .slice(0, 4)
    .map((s) => `- ${s}`)
    .join("\n");
}

/**
 * Suggest specific config changes to remediate an issue.
 * Returns a record of config changes, or null if no auto-fix is possible.
 */
export function autoRemediate(
  issue: Record<string, unknown>,
  agentConfig: Record<string, unknown>,
): Record<string, unknown> | null {
  const category = String(issue.category ?? "");

  if (category === "performance") {
    const changes: Record<string, unknown> = {};
    const description = String(issue.description ?? "").toLowerCase();
    if (description.includes("budget")) {
      const gov = (agentConfig.governance ?? {}) as Record<string, unknown>;
      const currentBudget = Number(gov.budget_limit_usd ?? 10.0);
      changes["governance.budget_limit_usd"] = currentBudget * 1.5;
    }
    if (description.includes("turns")) {
      const currentTurns = Number(agentConfig.max_turns ?? 50);
      changes["max_turns"] = Math.max(5, currentTurns - 10);
    }
    return Object.keys(changes).length ? changes : null;
  }

  if (category === "hallucination") {
    const prompt = String(agentConfig.system_prompt ?? "");
    if (!prompt.toLowerCase().includes("uncertain")) {
      return {
        system_prompt_append:
          "\n\nIMPORTANT: If you are unsure about any fact, " +
          "clearly state your uncertainty rather than guessing.",
      };
    }
    return null;
  }

  if (category === "security") {
    return {
      "governance.require_confirmation_for_destructive": true,
    };
  }

  return null;
}
