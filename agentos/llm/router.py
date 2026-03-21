"""Dynamic LLM selection and routing based on task complexity."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agentos.llm.provider import LLMProvider, LLMResponse, StubProvider


class Complexity(str, Enum):
    SIMPLE = "simple"
    MODERATE = "moderate"
    COMPLEX = "complex"


@dataclass
class RouteConfig:
    """Configuration for a complexity tier."""

    provider: LLMProvider
    max_tokens: int = 4096
    temperature: float = 0.0


class LLMRouter:
    """Routes requests to different LLM providers based on task complexity.

    Developers can register providers for each complexity tier. The router
    analyses the input and selects the appropriate backend.
    """

    def __init__(self) -> None:
        stub = StubProvider()
        self._routes: dict[Complexity, RouteConfig] = {
            Complexity.SIMPLE: RouteConfig(provider=stub, max_tokens=1024),
            Complexity.MODERATE: RouteConfig(provider=stub, max_tokens=4096),
            Complexity.COMPLEX: RouteConfig(provider=stub, max_tokens=8192),
        }
        self._tools: list[dict[str, Any]] = []

    def register(self, complexity: Complexity, provider: LLMProvider, max_tokens: int = 4096) -> None:
        self._routes[complexity] = RouteConfig(provider=provider, max_tokens=max_tokens)

    def set_tools(self, tools: list[dict[str, Any]]) -> None:
        self._tools = tools

    def classify(self, messages: list[dict[str, str]]) -> Complexity:
        """Classify the complexity of a request based on heuristics."""
        text = " ".join(m.get("content", "") for m in messages).lower()
        total_len = len(text)

        complex_signals = [
            r"\b(implement|architect|design|refactor|optimize|debug|analyze)\b",
            r"\b(multi.?step|pipeline|workflow|algorithm)\b",
            r"\b(code|function|class|module|api)\b",
        ]
        complex_score = sum(1 for p in complex_signals if re.search(p, text))

        if complex_score >= 2 or total_len > 2000:
            return Complexity.COMPLEX
        if complex_score >= 1 or total_len > 500:
            return Complexity.MODERATE
        return Complexity.SIMPLE

    async def route(self, messages: list[dict[str, str]]) -> LLMResponse:
        """Classify complexity and route to the appropriate provider."""
        complexity = self.classify(messages)
        config = self._routes[complexity]
        return await config.provider.complete(
            messages,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            tools=self._tools or None,
        )
