"""Remediation engine — generates fix suggestions for issues.

Provides rule-based fix suggestions based on issue category and context.
"""

from __future__ import annotations

from typing import Any


# Fix suggestion templates by category
_FIX_TEMPLATES = {
    "tool_failure": [
        "Check tool availability and permissions",
        "Verify tool timeout settings (current may be too low)",
        "Add retry logic with exponential backoff",
        "Review tool input validation — malformed inputs may cause failures",
        "Consider adding the failing tool to the blocklist if consistently broken",
    ],
    "knowledge_gap": [
        "Expand the agent's system prompt with domain knowledge",
        "Add relevant documents to the RAG knowledge base",
        "Increase episodic memory capacity for better context retention",
        "Consider using a more capable model for this task type",
        "Add example Q&A pairs to the agent's training data",
    ],
    "hallucination": [
        "Add 'If you are unsure, say so' to the system prompt",
        "Enable RAG retrieval for factual grounding",
        "Reduce temperature to 0.0 for more deterministic outputs",
        "Add fact-checking tools (web search, knowledge base lookup)",
        "Increase system prompt emphasis on accuracy over helpfulness",
    ],
    "security": [
        "Review and tighten governance policies",
        "Add the flagged action to the blocked tools list",
        "Enable require_confirmation_for_destructive",
        "Restrict allowed domains in governance config",
        "Audit the agent's tool permissions and reduce scope",
    ],
    "performance": [
        "Lower the budget limit or add cost alerts",
        "Reduce max_turns to prevent runaway sessions",
        "Use a smaller/faster model for simple subtasks (plan routing)",
        "Enable context summarization middleware to reduce token usage",
        "Set timeout_seconds to prevent long-running sessions",
    ],
    "config_drift": [
        "Re-sync agent config with its gold image",
        "Review and approve the configuration changes",
        "Run compliance check: agentos gold-image check <agent>",
        "Update the gold image if the drift is intentional",
        "Lock the agent config to prevent unauthorized changes",
    ],
}


class RemediationEngine:
    """Generates fix suggestions for issues."""

    def suggest_fix(self, issue: dict[str, Any]) -> str:
        """Generate a fix suggestion for an issue based on its category."""
        category = issue.get("category", "unknown")
        title = issue.get("title", "")
        description = issue.get("description", "")

        templates = _FIX_TEMPLATES.get(category, [])
        if not templates:
            return "Review the issue manually and investigate root cause."

        # Pick the most relevant suggestions (up to 3)
        suggestions = templates[:3]

        # Add context-specific suggestions
        if "timeout" in f"{title} {description}".lower():
            suggestions.append("Increase timeout_seconds in agent config")
        if "budget" in f"{title} {description}".lower():
            suggestions.append("Review cost per session and adjust budget_limit_usd")

        return "\n".join(f"- {s}" for s in suggestions[:4])

    def suggest_fixes_bulk(self, issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Generate fix suggestions for multiple issues."""
        result = []
        for issue in issues:
            fix = self.suggest_fix(issue)
            result.append({**issue, "suggested_fix": fix})
        return result

    def auto_remediate(
        self,
        issue: dict[str, Any],
        agent_config: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Suggest specific config changes to remediate an issue.

        Returns a dict of config changes, or None if no auto-fix is possible.
        """
        category = issue.get("category", "")

        if category == "performance":
            changes = {}
            if "budget" in issue.get("description", "").lower():
                current_budget = agent_config.get("governance", {}).get("budget_limit_usd", 10.0)
                changes["governance.budget_limit_usd"] = current_budget * 1.5
            if "turns" in issue.get("description", "").lower():
                current_turns = agent_config.get("max_turns", 50)
                changes["max_turns"] = max(5, current_turns - 10)
            return changes if changes else None

        if category == "hallucination":
            prompt = agent_config.get("system_prompt", "")
            if "uncertain" not in prompt.lower():
                return {
                    "system_prompt_append": "\n\nIMPORTANT: If you are unsure about any fact, "
                    "clearly state your uncertainty rather than guessing."
                }
            return None

        if category == "security":
            return {
                "governance.require_confirmation_for_destructive": True,
            }

        return None
