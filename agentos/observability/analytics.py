"""Conversation analytics — aggregation, trend detection, session scoring.

Orchestrates SentimentAnalyzer and QualityScorer to produce per-session
analytics and store results in the database.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agentos.observability.sentiment import SentimentAnalyzer
from agentos.observability.quality import QualityScorer

logger = logging.getLogger(__name__)


class ConversationAnalytics:
    """Orchestrates conversation intelligence scoring and analytics."""

    def __init__(
        self,
        sentiment_analyzer: SentimentAnalyzer | None = None,
        quality_scorer: QualityScorer | None = None,
        use_llm: bool = False,
    ):
        self.sentiment = sentiment_analyzer or SentimentAnalyzer()
        self.quality = quality_scorer or QualityScorer()
        self._llm_scorer = None
        if use_llm:
            try:
                from agentos.observability.llm_scorer import LLMQualityScorer
                self._llm_scorer = LLMQualityScorer()
                if not self._llm_scorer.api_key:
                    self._llm_scorer = None
            except Exception:
                pass

    def score_session(
        self,
        session_id: str,
        turns: list[dict[str, Any]],
        input_text: str = "",
        org_id: str = "",
        agent_name: str = "",
        db: Any = None,
    ) -> dict[str, Any]:
        """Score all turns in a session and compute aggregate analytics.

        Args:
            session_id: Session identifier
            turns: List of turn dicts with content, tool_calls, etc.
            input_text: The original user input
            org_id: Organization ID for scoping
            agent_name: Agent name for scoping
            db: AgentDB instance (optional — if provided, scores are persisted)

        Returns:
            Session analytics summary dict
        """
        turn_scores = []
        all_topics: list[str] = []
        all_intents: list[str] = []
        failure_patterns: list[str] = []
        quality_values: list[float] = []
        sentiment_values: list[float] = []

        for turn in turns:
            turn_number = turn.get("turn_number", 0)
            content = turn.get("content", "") or turn.get("llm_content", "") or ""
            turn_input = turn.get("input_text", "") or input_text
            tool_calls_raw = turn.get("tool_calls_json", "[]")
            tool_results_raw = turn.get("tool_results_json", "[]")

            try:
                tool_calls = json.loads(tool_calls_raw) if isinstance(tool_calls_raw, str) else (tool_calls_raw or [])
            except (json.JSONDecodeError, TypeError):
                tool_calls = []
            try:
                tool_results = json.loads(tool_results_raw) if isinstance(tool_results_raw, str) else (tool_results_raw or [])
            except (json.JSONDecodeError, TypeError):
                tool_results = []

            # Score with LLM if available, else heuristic
            scorer_model = "heuristic"
            if self._llm_scorer:
                qual, sent, scorer_model = self._llm_scorer.score_turn(
                    input_text=turn_input,
                    output_text=content,
                    tool_calls=tool_calls,
                    tool_results=tool_results,
                )
            else:
                sent = self.sentiment.analyze(content)
                qual = self.quality.score_turn(
                    input_text=turn_input,
                    output_text=content,
                    tool_calls=tool_calls,
                    tool_results=tool_results,
                )

            sentiment_values.append(sent.score)
            quality_values.append(qual.overall)

            if qual.topic and qual.topic != "general":
                all_topics.append(qual.topic)
            all_intents.append(qual.intent)

            if qual.has_tool_failure:
                failure_patterns.append(f"turn_{turn_number}_tool_failure")

            turn_score = {
                "turn_number": turn_number,
                "sentiment": sent.to_dict(),
                "quality": qual.to_dict(),
            }
            turn_scores.append(turn_score)

            # Persist per-turn score
            if db:
                try:
                    db.insert_conversation_score(
                        session_id=session_id,
                        turn_number=turn_number,
                        org_id=org_id,
                        agent_name=agent_name,
                        sentiment=sent.sentiment,
                        sentiment_score=sent.score,
                        sentiment_confidence=sent.confidence,
                        relevance_score=qual.relevance,
                        coherence_score=qual.coherence,
                        helpfulness_score=qual.helpfulness,
                        safety_score=qual.safety,
                        quality_overall=qual.overall,
                        topic=qual.topic,
                        intent=qual.intent,
                        has_tool_failure=qual.has_tool_failure,
                        has_hallucination_risk=qual.has_hallucination_risk,
                        scorer_model=scorer_model,
                    )
                except Exception as exc:
                    logger.debug("Failed to persist turn score: %s", exc)

        # Compute aggregates
        avg_sentiment = sum(sentiment_values) / len(sentiment_values) if sentiment_values else 0.0
        avg_quality = sum(quality_values) / len(quality_values) if quality_values else 0.0
        min_quality = min(quality_values) if quality_values else 0.0
        max_quality = max(quality_values) if quality_values else 0.0

        # Sentiment trend
        sentiment_trend = self._compute_trend(sentiment_values)

        # Dominant sentiment
        sentiment_labels = [ts["sentiment"]["sentiment"] for ts in turn_scores]
        dominant_sentiment = max(set(sentiment_labels), key=sentiment_labels.count) if sentiment_labels else "neutral"

        # Unique topics and intents
        unique_topics = list(dict.fromkeys(all_topics))  # preserves order, dedupes
        unique_intents = list(dict.fromkeys(all_intents))

        # Tool failure count
        tool_failure_count = sum(1 for ts in turn_scores if ts["quality"]["has_tool_failure"])
        hallucination_risk_count = sum(1 for ts in turn_scores if ts["quality"]["has_hallucination_risk"])

        analytics = {
            "session_id": session_id,
            "total_turns": len(turns),
            "avg_sentiment_score": round(avg_sentiment, 3),
            "dominant_sentiment": dominant_sentiment,
            "sentiment_trend": sentiment_trend,
            "avg_quality": round(avg_quality, 3),
            "min_quality": round(min_quality, 3),
            "max_quality": round(max_quality, 3),
            "topics": unique_topics,
            "intents": unique_intents,
            "failure_patterns": failure_patterns,
            "tool_failure_count": tool_failure_count,
            "hallucination_risk_count": hallucination_risk_count,
            "turn_scores": turn_scores,
        }

        # Persist session analytics
        if db:
            try:
                db.upsert_conversation_analytics(
                    session_id=session_id,
                    org_id=org_id,
                    agent_name=agent_name,
                    avg_sentiment_score=avg_sentiment,
                    dominant_sentiment=dominant_sentiment,
                    sentiment_trend=sentiment_trend,
                    avg_quality=avg_quality,
                    min_quality=min_quality,
                    max_quality=max_quality,
                    topics=unique_topics,
                    intents=unique_intents,
                    failure_patterns=failure_patterns,
                    total_turns=len(turns),
                    tool_failure_count=tool_failure_count,
                    hallucination_risk_count=hallucination_risk_count,
                )
            except Exception as exc:
                logger.debug("Failed to persist session analytics: %s", exc)

        return analytics

    def _compute_trend(self, values: list[float]) -> str:
        """Compute trend direction from a sequence of values."""
        if len(values) < 2:
            return "stable"

        # Split into first and second half
        mid = len(values) // 2
        first_half = values[:mid] if mid > 0 else values[:1]
        second_half = values[mid:]

        first_avg = sum(first_half) / len(first_half)
        second_avg = sum(second_half) / len(second_half)
        delta = second_avg - first_avg

        # Check volatility (standard deviation)
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        std_dev = variance ** 0.5

        if std_dev > 0.4:
            return "volatile"
        if delta > 0.15:
            return "improving"
        if delta < -0.15:
            return "declining"
        return "stable"
