"""Graders for evaluating agent performance."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


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
    """Uses an LLM to judge quality (stub — requires LLM provider)."""

    def __init__(self, criteria: str = "correctness") -> None:
        self.criteria = criteria

    def grade(self, expected: Any, actual: Any) -> GradeResult:
        # In production, this would call an LLM for evaluation.
        # Stub implementation uses simple heuristic.
        exp_words = set(str(expected).lower().split())
        act_words = set(str(actual).lower().split())
        overlap = len(exp_words & act_words)
        total = len(exp_words) if exp_words else 1
        score = min(1.0, overlap / total)
        return GradeResult(
            score=score,
            passed=score >= 0.5,
            details={"criteria": self.criteria, "method": "word_overlap_stub"},
        )
