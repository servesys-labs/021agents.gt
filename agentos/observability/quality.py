"""Quality scoring for agent conversation turns.

Evaluates: relevance, coherence, helpfulness, and safety.
Uses heuristic scoring that runs without LLM calls.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass


@dataclass
class QualityResult:
    """Quality assessment of a single turn."""

    relevance: float  # 0.0 to 1.0 — does the response address the input?
    coherence: float  # 0.0 to 1.0 — is the response well-structured?
    helpfulness: float  # 0.0 to 1.0 — does it provide actionable info?
    safety: float  # 0.0 to 1.0 — is the response safe/appropriate?
    overall: float  # 0.0 to 1.0 — weighted composite
    topic: str  # detected topic
    intent: str  # question/command/feedback/complaint/chitchat
    has_tool_failure: bool
    has_hallucination_risk: bool

    def to_dict(self) -> dict:
        return {
            "relevance": round(self.relevance, 3),
            "coherence": round(self.coherence, 3),
            "helpfulness": round(self.helpfulness, 3),
            "safety": round(self.safety, 3),
            "overall": round(self.overall, 3),
            "topic": self.topic,
            "intent": self.intent,
            "has_tool_failure": self.has_tool_failure,
            "has_hallucination_risk": self.has_hallucination_risk,
        }


# Intent classification patterns
_QUESTION_PATTERNS = re.compile(
    r'\b(what|how|why|when|where|who|which|can you|could you|is it|are there|do you)\b', re.I
)
_COMMAND_PATTERNS = re.compile(
    r'\b(create|make|build|write|fix|update|change|delete|remove|add|set|run|deploy|install)\b', re.I
)
_COMPLAINT_PATTERNS = re.compile(
    r'\b(wrong|broken|doesn\'t work|not working|failed|error|bug|issue|problem|crash)\b', re.I
)
_FEEDBACK_PATTERNS = re.compile(
    r'\b(thank|great|good job|well done|perfect|awesome|excellent|love it|works great)\b', re.I
)

# Safety concern patterns
_SAFETY_PATTERNS = re.compile(
    r'\b(hack|exploit|inject|attack|bypass|credentials|password|secret|token|api.key)\b', re.I
)

# Hallucination risk indicators (when the agent says things that might be made up)
_HALLUCINATION_INDICATORS = re.compile(
    r'\b(I believe|I think|probably|might be|possibly|I\'m not sure|as far as I know)\b', re.I
)


class QualityScorer:
    """Heuristic quality scorer for conversation turns."""

    def __init__(
        self,
        relevance_weight: float = 0.3,
        coherence_weight: float = 0.2,
        helpfulness_weight: float = 0.35,
        safety_weight: float = 0.15,
    ):
        self.weights = {
            "relevance": relevance_weight,
            "coherence": coherence_weight,
            "helpfulness": helpfulness_weight,
            "safety": safety_weight,
        }

    def score_turn(
        self,
        input_text: str,
        output_text: str,
        tool_calls: list[dict] | None = None,
        tool_results: list[dict] | None = None,
    ) -> QualityResult:
        """Score a single conversation turn."""
        tool_calls = tool_calls or []
        tool_results = tool_results or []

        relevance = self._score_relevance(input_text, output_text)
        coherence = self._score_coherence(output_text)
        helpfulness = self._score_helpfulness(output_text, tool_calls)
        safety = self._score_safety(output_text)
        topic = self._detect_topic(input_text, output_text)
        intent = self._classify_intent(input_text)
        has_tool_failure = self._check_tool_failures(tool_results)
        has_hallucination_risk = bool(_HALLUCINATION_INDICATORS.search(output_text))

        overall = (
            relevance * self.weights["relevance"]
            + coherence * self.weights["coherence"]
            + helpfulness * self.weights["helpfulness"]
            + safety * self.weights["safety"]
        )

        return QualityResult(
            relevance=relevance,
            coherence=coherence,
            helpfulness=helpfulness,
            safety=safety,
            overall=overall,
            topic=topic,
            intent=intent,
            has_tool_failure=has_tool_failure,
            has_hallucination_risk=has_hallucination_risk,
        )

    def _score_relevance(self, input_text: str, output_text: str) -> float:
        """Score how relevant the output is to the input."""
        if not input_text or not output_text:
            return 0.5

        input_words = set(re.findall(r'\b\w{3,}\b', input_text.lower()))
        output_words = set(re.findall(r'\b\w{3,}\b', output_text.lower()))

        if not input_words:
            return 0.5

        # Word overlap ratio
        overlap = len(input_words & output_words)
        overlap_ratio = overlap / len(input_words)

        # Scale: 0% overlap → 0.3, 50%+ overlap → 0.9+
        return min(1.0, 0.3 + overlap_ratio * 1.2)

    def _score_coherence(self, text: str) -> float:
        """Score structural coherence of the response."""
        if not text:
            return 0.3

        score = 0.5
        words = text.split()

        # Reasonable length (not too short, not excessively long)
        if 10 <= len(words) <= 500:
            score += 0.15
        elif len(words) > 3:
            score += 0.05

        # Has sentence structure (periods, question marks)
        if re.search(r'[.!?]', text):
            score += 0.1

        # Has paragraphs or structure (newlines, bullet points)
        if '\n' in text or re.search(r'[-*•]\s', text):
            score += 0.1

        # Code blocks or formatted output
        if '```' in text or re.search(r'`[^`]+`', text):
            score += 0.1

        # No excessive repetition
        sentences = re.split(r'[.!?\n]', text)
        unique_sentences = set(s.strip().lower() for s in sentences if s.strip())
        if len(sentences) > 1 and len(unique_sentences) / len(sentences) < 0.5:
            score -= 0.2  # Repetitive

        return max(0.0, min(1.0, score))

    def _score_helpfulness(self, text: str, tool_calls: list[dict]) -> float:
        """Score how helpful the response is."""
        if not text:
            return 0.2

        score = 0.4

        # Provides concrete information (numbers, code, specific details)
        if re.search(r'\d+', text):
            score += 0.05
        if '```' in text:
            score += 0.15
        if re.search(r'https?://', text):
            score += 0.05

        # Uses tools (takes action, not just talking)
        if tool_calls:
            score += 0.15

        # Provides step-by-step guidance
        if re.search(r'\b(step\s*\d|first|then|next|finally)\b', text, re.I):
            score += 0.1

        # Length-based (very short responses less helpful for complex tasks)
        word_count = len(text.split())
        if word_count >= 20:
            score += 0.1

        return max(0.0, min(1.0, score))

    def _score_safety(self, text: str) -> float:
        """Score safety of the response."""
        if not text:
            return 1.0

        score = 1.0
        safety_matches = len(_SAFETY_PATTERNS.findall(text))
        if safety_matches > 0:
            score -= min(0.3, safety_matches * 0.1)

        return max(0.0, score)

    def _detect_topic(self, input_text: str, output_text: str) -> str:
        """Detect the primary topic of the conversation."""
        combined = f"{input_text} {output_text}".lower()

        topic_keywords = {
            "coding": ["code", "function", "class", "variable", "bug", "debug", "compile", "syntax"],
            "deployment": ["deploy", "production", "staging", "ci/cd", "pipeline", "docker", "kubernetes"],
            "database": ["database", "sql", "query", "table", "schema", "migration", "postgres", "sqlite"],
            "api": ["api", "endpoint", "rest", "graphql", "request", "response", "http"],
            "security": ["security", "auth", "permission", "token", "encrypt", "vulnerability"],
            "testing": ["test", "spec", "assert", "mock", "fixture", "coverage", "pytest"],
            "configuration": ["config", "settings", "environment", "env", "variable"],
            "performance": ["performance", "latency", "speed", "optimize", "cache", "memory"],
            "documentation": ["docs", "readme", "document", "explain", "tutorial"],
            "infrastructure": ["server", "cloud", "aws", "gcp", "azure", "terraform"],
        }

        topic_scores: dict[str, int] = {}
        for topic, keywords in topic_keywords.items():
            count = sum(1 for kw in keywords if kw in combined)
            if count > 0:
                topic_scores[topic] = count

        if topic_scores:
            return max(topic_scores, key=topic_scores.get)
        return "general"

    def _classify_intent(self, input_text: str) -> str:
        """Classify the intent of the user's input."""
        if not input_text:
            return "chitchat"

        # Check question first — questions about errors are still questions
        if _QUESTION_PATTERNS.search(input_text):
            return "question"
        if _FEEDBACK_PATTERNS.search(input_text):
            return "feedback"
        if _COMPLAINT_PATTERNS.search(input_text):
            return "complaint"
        if _COMMAND_PATTERNS.search(input_text):
            return "command"
        return "chitchat"

    def _check_tool_failures(self, tool_results: list[dict]) -> bool:
        """Check if any tool calls failed."""
        for result in tool_results:
            error = result.get("error") or result.get("error_message") or ""
            if error:
                return True
            status = result.get("status", "")
            if status in ("error", "failed", "failure"):
                return True
        return False
