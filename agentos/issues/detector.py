"""Issue detector — auto-creates issues from event bus signals.

Hooks into SESSION_END, CONVERSATION_SCORED, and error events to
detect problems and create issues automatically.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

# Thresholds for auto-detection
QUALITY_THRESHOLD = 0.4
SENTIMENT_THRESHOLD = -0.5
TOOL_FAILURE_THRESHOLD = 2
BUDGET_WARN_RATIO = 0.8


class IssueDetector:
    """Detects issues from session data and conversation scores."""

    def __init__(self, db: Any = None):
        self.db = db

    def detect_from_session(
        self,
        session_id: str,
        agent_name: str = "",
        org_id: str = "",
        session_data: dict[str, Any] | None = None,
        scores: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """Analyze a completed session and create issues for detected problems."""
        issues_created = []
        session = session_data or {}
        scores = scores or []

        # 1. Check for session errors
        status = session.get("status", "")
        if status in ("error", "timeout"):
            issue = self._create_issue(
                agent_name=agent_name,
                org_id=org_id,
                title=f"Session {status}: {session_id[:12]}",
                description=f"Session ended with status '{status}'. "
                            f"Error: {session.get('error_attribution', 'unknown')}",
                category="tool_failure" if status == "error" else "performance",
                severity="high" if status == "error" else "medium",
                source_session_id=session_id,
            )
            issues_created.append(issue)

        # 2. Check for low quality scores
        if scores:
            avg_quality = sum(s.get("quality_overall", 0) for s in scores) / len(scores)
            if avg_quality < QUALITY_THRESHOLD:
                issue = self._create_issue(
                    agent_name=agent_name,
                    org_id=org_id,
                    title=f"Low quality: {agent_name} ({avg_quality:.2f})",
                    description=f"Average quality score {avg_quality:.3f} is below threshold {QUALITY_THRESHOLD}. "
                                f"Session {session_id[:12]}.",
                    category="knowledge_gap",
                    severity="medium",
                    source_session_id=session_id,
                )
                issues_created.append(issue)

        # 3. Check for negative sentiment
        if scores:
            avg_sentiment = sum(s.get("sentiment_score", 0) for s in scores) / len(scores)
            if avg_sentiment < SENTIMENT_THRESHOLD:
                issue = self._create_issue(
                    agent_name=agent_name,
                    org_id=org_id,
                    title=f"Negative sentiment: {agent_name}",
                    description=f"Average sentiment score {avg_sentiment:.3f} is below threshold {SENTIMENT_THRESHOLD}. "
                                f"Session {session_id[:12]}.",
                    category="knowledge_gap",
                    severity="low",
                    source_session_id=session_id,
                )
                issues_created.append(issue)

        # 4. Check for tool failures
        if scores:
            tool_failures = sum(1 for s in scores if s.get("has_tool_failure"))
            if tool_failures >= TOOL_FAILURE_THRESHOLD:
                failed_tools = set()
                for s in scores:
                    if s.get("has_tool_failure"):
                        failed_tools.add(s.get("topic", "unknown"))
                issue = self._create_issue(
                    agent_name=agent_name,
                    org_id=org_id,
                    title=f"Multiple tool failures: {agent_name} ({tool_failures}x)",
                    description=f"{tool_failures} tool failures in session {session_id[:12]}. "
                                f"Related topics: {', '.join(failed_tools)}.",
                    category="tool_failure",
                    severity="high",
                    source_session_id=session_id,
                )
                issues_created.append(issue)

        # 5. Check for hallucination risks (threshold: 2+ turns to reduce noise from heuristic)
        if scores:
            hallucination_count = sum(1 for s in scores if s.get("has_hallucination_risk"))
            if hallucination_count >= 2:
                issue = self._create_issue(
                    agent_name=agent_name,
                    org_id=org_id,
                    title=f"Hallucination risk: {agent_name} ({hallucination_count} turns)",
                    description=f"{hallucination_count} turns flagged for hallucination risk "
                                f"in session {session_id[:12]}.",
                    category="hallucination",
                    severity="medium",
                    source_session_id=session_id,
                )
                issues_created.append(issue)

        # 6. Check budget overrun
        cost = float(session.get("cost_total_usd", 0) or 0)
        budget = float(session.get("budget_limit_usd", 0) or 0)
        if budget > 0 and cost > budget * BUDGET_WARN_RATIO:
            issue = self._create_issue(
                agent_name=agent_name,
                org_id=org_id,
                title=f"Budget warning: {agent_name} (${cost:.4f}/${budget:.2f})",
                description=f"Session cost ${cost:.4f} exceeds {BUDGET_WARN_RATIO*100:.0f}% of budget ${budget:.2f}.",
                category="performance",
                severity="low" if cost < budget else "high",
                source_session_id=session_id,
            )
            issues_created.append(issue)

        return issues_created

    def _create_issue(
        self,
        agent_name: str,
        org_id: str,
        title: str,
        description: str,
        category: str,
        severity: str,
        source_session_id: str = "",
        source_turn: int = 0,
    ) -> dict[str, Any]:
        """Create and optionally persist an issue."""
        issue_id = uuid.uuid4().hex[:16]
        issue = {
            "issue_id": issue_id,
            "org_id": org_id,
            "agent_name": agent_name,
            "title": title,
            "description": description,
            "category": category,
            "severity": severity,
            "status": "open",
            "source": "auto",
            "source_session_id": source_session_id,
            "source_turn": source_turn,
        }

        if self.db:
            try:
                self.db.insert_issue(
                    issue_id=issue_id,
                    org_id=org_id,
                    agent_name=agent_name,
                    title=title,
                    description=description,
                    category=category,
                    severity=severity,
                    source="auto",
                    source_session_id=source_session_id,
                    source_turn=source_turn,
                )
            except Exception as exc:
                logger.debug("Failed to persist issue: %s", exc)

        return issue
