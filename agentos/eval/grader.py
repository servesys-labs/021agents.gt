"""Graders for evaluating agent performance."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class GradeResult:
    score: float  # 0.0 - 1.0
    passed: bool
    details: dict[str, Any] = field(default_factory=dict)


class Grader(ABC):
    """Base class for evaluation graders."""

    @abstractmethod
    def grade(self, expected: Any, actual: Any) -> GradeResult: ...


class ExactMatchGrader(Grader):
    """Grades by exact string match (case-insensitive by default)."""

    def __init__(self, case_sensitive: bool = False) -> None:
        self.case_sensitive = case_sensitive

    def grade(self, expected: Any, actual: Any) -> GradeResult:
        exp = str(expected)
        act = str(actual)
        if not self.case_sensitive:
            exp = exp.lower().strip()
            act = act.lower().strip()
        match = exp == act
        return GradeResult(score=1.0 if match else 0.0, passed=match)


class ContainsGrader(Grader):
    """Grades by checking if expected value is contained in actual."""

    def grade(self, expected: Any, actual: Any) -> GradeResult:
        contained = str(expected).lower() in str(actual).lower()
        return GradeResult(score=1.0 if contained else 0.0, passed=contained)


class LLMGrader(Grader):
    """Uses an LLM to judge response quality.

    When a provider is supplied, sends a structured prompt to the LLM
    asking it to score the response on the given criteria. Falls back
    to a word-overlap heuristic when no provider is available.

    Usage::

        # With a real LLM (recommended)
        from agentos.llm.provider import HttpProvider
        provider = HttpProvider(model_id="anthropic/claude-sonnet-4.6", ...)
        grader = LLMGrader(criteria="correctness", provider=provider)

        # Without a provider (heuristic fallback)
        grader = LLMGrader(criteria="correctness")
    """

    # The grading prompt template. The LLM is asked to return a JSON
    # object with ``score`` (0.0-1.0) and ``reasoning`` fields.
    GRADING_PROMPT = (
        "You are an evaluation judge. Score the ACTUAL response against "
        "the EXPECTED answer on the criterion: {criteria}.\n\n"
        "EXPECTED:\n{expected}\n\n"
        "ACTUAL:\n{actual}\n\n"
        "Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):\n"
        '{{"score": <0.0-1.0>, "reasoning": "<brief explanation>"}}'
    )

    def __init__(
        self,
        criteria: str = "correctness",
        provider: Any = None,
        pass_threshold: float = 0.5,
    ) -> None:
        self.criteria = criteria
        self._provider = provider
        self.pass_threshold = pass_threshold

    def grade(self, expected: Any, actual: Any) -> GradeResult:
        """Grade synchronously.

        If a provider is set, runs the async LLM call in a new event
        loop (safe from sync contexts like the test suite). Otherwise
        falls back to the word-overlap heuristic.
        """
        if self._provider is not None:
            import asyncio
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None

            if loop and loop.is_running():
                # We're inside an existing event loop — can't nest.
                # Use the heuristic and log a warning.
                logger.debug(
                    "LLMGrader: running inside event loop, using heuristic fallback"
                )
                return self._grade_heuristic(expected, actual)
            return asyncio.run(self._grade_llm(expected, actual))
        return self._grade_heuristic(expected, actual)

    async def agrade(self, expected: Any, actual: Any) -> GradeResult:
        """Grade asynchronously — preferred in async contexts."""
        if self._provider is not None:
            return await self._grade_llm(expected, actual)
        return self._grade_heuristic(expected, actual)

    async def _grade_llm(self, expected: Any, actual: Any) -> GradeResult:
        """Call the LLM provider for semantic evaluation."""
        import json

        prompt = self.GRADING_PROMPT.format(
            criteria=self.criteria,
            expected=str(expected),
            actual=str(actual),
        )
        messages = [{"role": "user", "content": prompt}]

        try:
            response = await self._provider.complete(
                messages, max_tokens=256, temperature=0.0,
            )
            # Parse the JSON score from the response
            text = response.content.strip()
            # Strip markdown fences if present
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            data = json.loads(text)
            score = float(data.get("score", 0.0))
            score = max(0.0, min(1.0, score))  # Clamp to [0, 1]
            reasoning = data.get("reasoning", "")
            return GradeResult(
                score=score,
                passed=score >= self.pass_threshold,
                details={
                    "criteria": self.criteria,
                    "method": "llm",
                    "reasoning": reasoning,
                    "model": response.model,
                    "cost_usd": response.cost_usd,
                },
            )
        except Exception as exc:
            logger.warning("LLMGrader: LLM call failed (%s), using heuristic", exc)
            result = self._grade_heuristic(expected, actual)
            result.details["llm_error"] = str(exc)
            return result

    def _grade_heuristic(self, expected: Any, actual: Any) -> GradeResult:
        """Word-overlap heuristic — used when no LLM provider is available."""
        exp_words = set(str(expected).lower().split())
        act_words = set(str(actual).lower().split())
        overlap = len(exp_words & act_words)
        total = len(exp_words) if exp_words else 1
        score = min(1.0, overlap / total)
        return GradeResult(
            score=score,
            passed=score >= self.pass_threshold,
            details={"criteria": self.criteria, "method": "word_overlap_heuristic"},
        )
