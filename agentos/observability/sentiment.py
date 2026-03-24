"""Sentiment analysis for agent conversations.

Provides rule-based sentiment scoring that can run without an LLM call,
with an optional LLM-enhanced mode for higher accuracy.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class SentimentResult:
    """Result of sentiment analysis on a piece of text."""

    sentiment: str  # positive, negative, neutral, mixed
    score: float  # -1.0 (negative) to 1.0 (positive)
    confidence: float  # 0.0 to 1.0

    def to_dict(self) -> dict:
        return {
            "sentiment": self.sentiment,
            "score": round(self.score, 3),
            "confidence": round(self.confidence, 3),
        }


# Word lists for rule-based analysis
_POSITIVE_WORDS = {
    "thank", "thanks", "great", "good", "excellent", "perfect", "helpful",
    "appreciate", "awesome", "wonderful", "fantastic", "love", "works",
    "solved", "fixed", "correct", "right", "yes", "exactly", "nice",
    "amazing", "brilliant", "well", "done", "success", "successful",
    "happy", "pleased", "glad", "best", "impressive", "clear",
}

_NEGATIVE_WORDS = {
    "wrong", "error", "fail", "failed", "failure", "bad", "terrible",
    "horrible", "awful", "broken", "bug", "issue", "problem", "crash",
    "hate", "useless", "slow", "stuck", "confused", "frustrat",
    "annoyed", "disappoint", "worse", "worst", "never", "can't",
    "cannot", "impossible", "incorrect", "mistake", "no", "not",
    "doesn't", "didn't", "won't", "unable", "unfortunately",
}

_NEGATION_WORDS = {"not", "no", "never", "don't", "doesn't", "didn't", "won't", "isn't", "wasn't", "aren't"}


class SentimentAnalyzer:
    """Rule-based sentiment analyzer for conversation turns."""

    def analyze(self, text: str) -> SentimentResult:
        """Analyze sentiment of a text string."""
        if not text or not text.strip():
            return SentimentResult(sentiment="neutral", score=0.0, confidence=0.5)

        text_lower = text.lower()
        words = re.findall(r'\b\w+\b', text_lower)

        positive_count = 0
        negative_count = 0
        negation_active = False

        for word in words:
            if word in _NEGATION_WORDS:
                negation_active = True
                continue

            is_positive = word in _POSITIVE_WORDS
            is_negative = word in _NEGATIVE_WORDS or any(
                word.startswith(neg) for neg in ("frustrat", "disappoint")
            )

            if negation_active:
                # Flip sentiment
                if is_positive:
                    negative_count += 1
                elif is_negative:
                    positive_count += 1
                negation_active = False
            else:
                if is_positive:
                    positive_count += 1
                elif is_negative:
                    negative_count += 1

        total_signals = positive_count + negative_count
        if total_signals == 0:
            return SentimentResult(sentiment="neutral", score=0.0, confidence=0.6)

        # Calculate score
        score = (positive_count - negative_count) / max(total_signals, 1)
        # Scale to -1.0 to 1.0
        score = max(-1.0, min(1.0, score))

        # Confidence based on signal strength
        signal_ratio = total_signals / max(len(words), 1)
        confidence = min(0.95, 0.4 + signal_ratio * 3.0)

        # Classify
        if positive_count > 0 and negative_count > 0:
            balance = abs(positive_count - negative_count) / total_signals
            if balance < 0.3:
                sentiment = "mixed"
            elif positive_count > negative_count:
                sentiment = "positive"
            else:
                sentiment = "negative"
        elif positive_count > 0:
            sentiment = "positive"
        elif negative_count > 0:
            sentiment = "negative"
        else:
            sentiment = "neutral"

        return SentimentResult(
            sentiment=sentiment,
            score=score,
            confidence=round(confidence, 3),
        )

    def analyze_conversation(self, turns: list[dict]) -> list[SentimentResult]:
        """Analyze sentiment for each turn in a conversation."""
        results = []
        for turn in turns:
            content = turn.get("content", "") or turn.get("llm_content", "") or ""
            results.append(self.analyze(content))
        return results
