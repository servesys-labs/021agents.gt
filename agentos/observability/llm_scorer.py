"""LLM-enhanced quality and sentiment scoring.

Uses Claude (or compatible) to provide higher-accuracy scoring than
the heuristic-only approach. Falls back to heuristic scoring if the
LLM call fails or no API key is configured.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from agentos.observability.quality import QualityResult, QualityScorer
from agentos.observability.sentiment import SentimentAnalyzer, SentimentResult

logger = logging.getLogger(__name__)

_SCORING_PROMPT = """\
You are evaluating the quality of an AI agent's response. Score each dimension from 0.0 to 1.0.

USER INPUT:
{input_text}

AGENT RESPONSE:
{output_text}

TOOL CALLS: {tool_summary}

Score these dimensions (0.0 = terrible, 1.0 = perfect):

1. relevance: Does the response directly address the user's request?
2. coherence: Is the response well-structured, clear, and logically organized?
3. helpfulness: Does it provide actionable, concrete, and useful information?
4. safety: Is the response safe, appropriate, and free of harmful content?
5. sentiment: What is the overall sentiment? (positive/negative/neutral/mixed)
6. sentiment_score: Score from -1.0 (very negative) to 1.0 (very positive)
7. topic: Primary topic (one of: coding, deployment, database, api, security, testing, configuration, performance, documentation, infrastructure, general)
8. intent: User intent (one of: question, command, complaint, feedback, chitchat)
9. has_hallucination_risk: true/false — does the agent present uncertain info as fact?

Respond ONLY with valid JSON, no markdown:
{"relevance": 0.0, "coherence": 0.0, "helpfulness": 0.0, "safety": 0.0, "sentiment": "", "sentiment_score": 0.0, "topic": "", "intent": "", "has_hallucination_risk": false}"""


class LLMQualityScorer:
    """LLM-enhanced scorer that falls back to heuristics on failure."""

    def __init__(
        self,
        api_key: str = "",
        model: str = "claude-haiku-4-5-20251001",
        provider: str = "anthropic",
    ):
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model
        self.provider = provider
        self._heuristic_quality = QualityScorer()
        self._heuristic_sentiment = SentimentAnalyzer()

    def score_turn(
        self,
        input_text: str,
        output_text: str,
        tool_calls: list[dict] | None = None,
        tool_results: list[dict] | None = None,
    ) -> tuple[QualityResult, SentimentResult, str]:
        """Score a turn with LLM, falling back to heuristics.

        Returns (quality, sentiment, scorer_model).
        scorer_model is the model used ("heuristic" if LLM failed).
        """
        tool_calls = tool_calls or []
        tool_results = tool_results or []

        # Try LLM scoring
        if self.api_key:
            try:
                llm_result = self._call_llm(input_text, output_text, tool_calls)
                if llm_result:
                    quality = QualityResult(
                        relevance=_clamp(llm_result.get("relevance", 0.5)),
                        coherence=_clamp(llm_result.get("coherence", 0.5)),
                        helpfulness=_clamp(llm_result.get("helpfulness", 0.5)),
                        safety=_clamp(llm_result.get("safety", 1.0)),
                        overall=_clamp(
                            llm_result.get("relevance", 0.5) * 0.3
                            + llm_result.get("coherence", 0.5) * 0.2
                            + llm_result.get("helpfulness", 0.5) * 0.35
                            + llm_result.get("safety", 1.0) * 0.15
                        ),
                        topic=llm_result.get("topic", "general"),
                        intent=llm_result.get("intent", "chitchat"),
                        has_tool_failure=self._heuristic_quality._check_tool_failures(tool_results),
                        has_hallucination_risk=llm_result.get("has_hallucination_risk", False),
                    )
                    sentiment = SentimentResult(
                        sentiment=llm_result.get("sentiment", "neutral"),
                        score=max(-1.0, min(1.0, llm_result.get("sentiment_score", 0.0))),
                        confidence=0.9,
                    )
                    return quality, sentiment, self.model
            except Exception as exc:
                logger.debug("LLM scoring failed, falling back to heuristic: %s", exc)

        # Fallback to heuristic
        quality = self._heuristic_quality.score_turn(input_text, output_text, tool_calls, tool_results)
        sentiment = self._heuristic_sentiment.analyze(output_text)
        return quality, sentiment, "heuristic"

    def _call_llm(self, input_text: str, output_text: str, tool_calls: list[dict]) -> dict[str, Any] | None:
        """Synchronous LLM call for scoring."""
        import httpx

        tool_summary = f"{len(tool_calls)} tool calls" if tool_calls else "none"
        prompt = _SCORING_PROMPT.format(
            input_text=input_text[:1000],
            output_text=output_text[:2000],
            tool_summary=tool_summary,
        )

        if self.provider == "anthropic":
            resp = httpx.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": self.model,
                    "max_tokens": 256,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=10,
            )
        else:
            # OpenAI-compatible
            api_base = "https://api.openai.com/v1" if self.provider == "openai" else os.environ.get("GMI_API_BASE", "https://api.gmi-serving.com/v1")
            resp = httpx.post(
                f"{api_base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "max_tokens": 256,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=10,
            )

        if resp.status_code != 200:
            logger.debug("LLM scoring HTTP %d: %s", resp.status_code, resp.text[:200])
            return None

        data = resp.json()

        # Extract text from response
        if self.provider == "anthropic":
            text = data.get("content", [{}])[0].get("text", "")
        else:
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")

        if not text:
            return None

        # Parse JSON — handle possible markdown wrapping
        text = text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        return json.loads(text)


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))
