"""Dynamic LLM selection and routing based on task complexity."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agentos.llm.provider import LLMProvider, LLMResponse, StubProvider
from agentos.llm.tokens import count_message_tokens, estimate_cost


class Complexity(str, Enum):
    SIMPLE = "simple"
    MODERATE = "moderate"
    COMPLEX = "complex"
    TOOL_CALL = "tool_call"  # Dedicated tier for tool-calling turns
    IMAGE_GEN = "image_gen"  # Image generation (FLUX, DALL-E, etc.)
    VISION = "vision"  # Vision/image understanding (multimodal input)
    TTS = "tts"  # Text-to-speech
    STT = "stt"  # Speech-to-text


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
            Complexity.TOOL_CALL: RouteConfig(provider=stub, max_tokens=4096),
            Complexity.IMAGE_GEN: RouteConfig(provider=stub, max_tokens=1),
            Complexity.VISION: RouteConfig(provider=stub, max_tokens=4096),
            Complexity.TTS: RouteConfig(provider=stub, max_tokens=1),
            Complexity.STT: RouteConfig(provider=stub, max_tokens=1),
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
        """Classify complexity, count tokens, and route to the appropriate provider.

        When tools are available and a dedicated TOOL_CALL model is configured,
        uses it instead of the complexity-based tier. This ensures tool calls
        go to a model with strong structured output / function-calling ability.
        """
        complexity = self.classify(messages)

        # Use TOOL_CALL tier when tools are present and a dedicated model is registered
        tool_call_route = self._routes.get(Complexity.TOOL_CALL)
        if self._tools and tool_call_route and not isinstance(tool_call_route.provider, StubProvider):
            complexity = Complexity.TOOL_CALL

        config = self._routes[complexity]

        # Token counting for cost/latency optimization
        input_tokens = count_message_tokens(messages, model=config.provider.model_id)
        effective_max_tokens = min(config.max_tokens, max(256, config.max_tokens - input_tokens // 4))

        response = await config.provider.complete(
            messages,
            max_tokens=effective_max_tokens,
            temperature=config.temperature,
            tools=self._tools or None,
        )

        # Estimate cost if not already set by the provider
        if response.cost_usd == 0 and response.usage:
            response.cost_usd = estimate_cost(
                response.usage.get("input_tokens", input_tokens),
                response.usage.get("output_tokens", 0),
                model=response.model,
            )

        return response

    def get_multimodal_config(self, modality: Complexity) -> RouteConfig | None:
        """Get the route config for a multimodal tier (image_gen, vision, tts, stt).

        Returns None if the tier has no real provider registered (still stub).
        """
        config = self._routes.get(modality)
        if config and not isinstance(config.provider, StubProvider):
            return config
        return None

    @property
    def has_image_gen(self) -> bool:
        return self.get_multimodal_config(Complexity.IMAGE_GEN) is not None

    @property
    def has_vision(self) -> bool:
        return self.get_multimodal_config(Complexity.VISION) is not None

    @property
    def has_tts(self) -> bool:
        return self.get_multimodal_config(Complexity.TTS) is not None

    @property
    def has_stt(self) -> bool:
        return self.get_multimodal_config(Complexity.STT) is not None
