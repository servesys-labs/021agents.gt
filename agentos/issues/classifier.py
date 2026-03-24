"""Issue classifier — categorizes issues by type and severity.

Categories:
  - security: governance violations, unsafe outputs
  - knowledge_gap: low quality, irrelevant responses
  - tool_failure: tool errors, timeouts
  - hallucination: uncertain/fabricated outputs
  - performance: slow responses, budget overruns
  - config_drift: agent config doesn't match gold image
"""

from __future__ import annotations

import re
from typing import Any


CATEGORY_PATTERNS = {
    "security": [
        r"governance.*violation", r"blocked.*tool", r"unsafe",
        r"permission.*denied", r"unauthorized",
    ],
    "tool_failure": [
        r"tool.*fail", r"tool.*error", r"timeout", r"execution.*error",
        r"command.*failed",
    ],
    "hallucination": [
        r"hallucin", r"fabricat", r"not\s+sure", r"uncertain",
        r"made\s+up", r"incorrect.*fact",
    ],
    "knowledge_gap": [
        r"low.*quality", r"irrelevant", r"unable.*to.*answer",
        r"don't.*know", r"no.*information",
    ],
    "performance": [
        r"budget", r"cost.*exceed", r"slow", r"latency", r"timeout",
        r"too.*many.*turns",
    ],
    "config_drift": [
        r"drift", r"compliance", r"gold.*image", r"config.*mismatch",
    ],
}

SEVERITY_WEIGHTS = {
    "security": "critical",
    "tool_failure": "high",
    "hallucination": "medium",
    "config_drift": "medium",
    "knowledge_gap": "low",
    "performance": "low",
}


class IssueClassifier:
    """Classifies issues into categories and assigns severity."""

    def classify(
        self,
        title: str = "",
        description: str = "",
        existing_category: str = "",
        existing_severity: str = "",
    ) -> dict[str, str]:
        """Classify an issue based on its title and description.

        Returns dict with 'category' and 'severity' keys.
        If existing values are provided and valid, they take precedence.
        """
        if existing_category and existing_category != "unknown":
            category = existing_category
        else:
            category = self._detect_category(f"{title} {description}")

        if existing_severity and existing_severity not in ("", "unknown"):
            severity = existing_severity
        else:
            severity = SEVERITY_WEIGHTS.get(category, "low")

        return {"category": category, "severity": severity}

    def _detect_category(self, text: str) -> str:
        """Detect category from text using pattern matching."""
        text_lower = text.lower()
        scores: dict[str, int] = {}

        for category, patterns in CATEGORY_PATTERNS.items():
            score = 0
            for pattern in patterns:
                if re.search(pattern, text_lower):
                    score += 1
            if score > 0:
                scores[category] = score

        if scores:
            return max(scores, key=scores.get)
        return "unknown"

    def bulk_classify(self, issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Classify multiple issues and return updated list."""
        result = []
        for issue in issues:
            classification = self.classify(
                title=issue.get("title", ""),
                description=issue.get("description", ""),
                existing_category=issue.get("category", ""),
                existing_severity=issue.get("severity", ""),
            )
            updated = {**issue, **classification}
            result.append(updated)
        return result
