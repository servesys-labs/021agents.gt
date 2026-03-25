"""Dynamic LLM selection — routes by task category, role, and complexity.

The router auto-detects what the agent is doing (coding, research, creative,
general) and picks the best model from the user's plan. Within each category,
it selects the appropriate role (planner, implementer, reviewer, etc.).

Plan structure (config/default.json):
  plans:
    standard:
      general:   { simple, moderate, complex, tool_call }
      coding:    { planner, implementer, reviewer, debugger }
      research:  { search, analyze, synthesize }
      creative:  { write, image, voice }
      multimodal: { vision, stt }
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Any

from agentos.llm.provider import LLMProvider, LLMResponse, StubProvider
from agentos.llm.tokens import count_message_tokens, estimate_cost


class Complexity(str, Enum):
    SIMPLE = "simple"
    MODERATE = "moderate"
    COMPLEX = "complex"
    TOOL_CALL = "tool_call"
    IMAGE_GEN = "image_gen"
    VISION = "vision"
    TTS = "tts"
    STT = "stt"


class TaskCategory(str, Enum):
    GENERAL = "general"
    CODING = "coding"
    RESEARCH = "research"
    CREATIVE = "creative"


class CodingRole(str, Enum):
    PLANNER = "planner"
    IMPLEMENTER = "implementer"
    REVIEWER = "reviewer"
    DEBUGGER = "debugger"


class ResearchRole(str, Enum):
    SEARCH = "search"
    ANALYZE = "analyze"
    SYNTHESIZE = "synthesize"


class CreativeRole(str, Enum):
    WRITE = "write"
    IMAGE = "image"
    VOICE = "voice"


@dataclass
class RouteConfig:
    """Configuration for a complexity/role tier."""
    provider: LLMProvider
    max_tokens: int = 4096
    temperature: float = 0.0


@dataclass
class RouteDecision:
    """The router's decision for a given turn."""
    category: TaskCategory
    role: str           # e.g. "planner", "simple", "search"
    complexity: Complexity
    config: RouteConfig


class LLMRouter:
    """Routes requests to different LLM providers based on task category and role.

    Supports two modes:
    1. Flat routing (backward compat): general.simple/moderate/complex/tool_call
    2. Category routing: coding.planner, research.analyze, creative.write, etc.

    The router auto-detects the category from the conversation, then picks
    the role within that category.
    """

    def __init__(self) -> None:
        stub = StubProvider()
        # Flat routes (backward compat — general category)
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
        # Category routes: category → role → RouteConfig
        self._category_routes: dict[str, dict[str, RouteConfig]] = {}
        self._tools: list[dict[str, Any]] = []

    def register(self, complexity: Complexity, provider: LLMProvider, max_tokens: int = 4096) -> None:
        """Register a provider for a flat complexity tier (backward compat)."""
        self._routes[complexity] = RouteConfig(provider=provider, max_tokens=max_tokens)

    def register_category(
        self, category: str, role: str, provider: LLMProvider, max_tokens: int = 4096
    ) -> None:
        """Register a provider for a category/role combination."""
        if category not in self._category_routes:
            self._category_routes[category] = {}
        self._category_routes[category][role] = RouteConfig(provider=provider, max_tokens=max_tokens)

    def set_tools(self, tools: list[dict[str, Any]]) -> None:
        self._tools = tools

    # ── Task Category Detection ──────────────────────────────────────

    _CODING_SIGNALS = [
        r"\b(implement|refactor|debug|fix bug|write code|write a function)\b",
        r"\b(class |def |function |import |require\(|module)\b",
        r"\b(python|javascript|typescript|rust|golang|java|cpp|sql)\b",
        r"\b(git |commit|pull request|merge|branch|deploy)\b",
        r"\b(test|unittest|pytest|jest|spec|coverage)\b",
        r"\b(api|endpoint|route|handler|middleware|schema)\b",
        r"\b(dockerfile|kubernetes|terraform|ci.?cd|pipeline)\b",
        r"\b(error|traceback|exception|stack trace|segfault)\b",
        r"\b(review.*code|code.*review|architecture|microservice)\b",
        r"\b(plan.*implementation|design.*system|build.*app)\b",
    ]

    _RESEARCH_SIGNALS = [
        r"\b(search|find|look up|research|investigate)\b",
        r"\b(compare|analyze|evaluate|benchmark|measure)\b",
        r"\b(summarize|synthesize|report|findings|conclusion)\b",
        r"\b(source|reference|citation|paper|article|study)\b",
        r"\b(data|statistics|metrics|trends|insights)\b",
    ]

    _CREATIVE_SIGNALS = [
        r"\b(write|draft|compose|author|blog|article|essay)\b",
        r"\b(generate.*image|create.*image|draw|illustrate|design)\b",
        r"\b(speak|voice|audio|narrate|read aloud|tts)\b",
        r"\b(story|poem|script|lyrics|creative|fiction)\b",
        r"\b(email|letter|proposal|presentation|pitch)\b",
    ]

    def detect_category(self, messages: list[dict[str, str]]) -> TaskCategory:
        """Detect the task category from conversation content."""
        text = " ".join(m.get("content", "") for m in messages[-3:]).lower()

        coding_score = sum(1 for p in self._CODING_SIGNALS if re.search(p, text))
        research_score = sum(1 for p in self._RESEARCH_SIGNALS if re.search(p, text))
        creative_score = sum(1 for p in self._CREATIVE_SIGNALS if re.search(p, text))

        # Coding signals are very specific — 1 is enough
        # Research and creative need 2 to avoid false positives
        if coding_score >= 1 and coding_score >= research_score and coding_score >= creative_score:
            return TaskCategory.CODING
        if research_score >= 2 and research_score > creative_score:
            return TaskCategory.RESEARCH
        if creative_score >= 1 and re.search(r"\b(image|draw|illustrate|voice|audio|tts|narrate)\b", text):
            return TaskCategory.CREATIVE
        if creative_score >= 2:
            return TaskCategory.CREATIVE
        if research_score >= 1 and re.search(r"\b(search|find|look up|research|investigate)\b", text):
            return TaskCategory.RESEARCH
        return TaskCategory.GENERAL

    # ── Role Detection within Category ───────────────────────────────

    def detect_coding_role(self, messages: list[dict[str, str]]) -> str:
        """Detect the coding sub-role from conversation."""
        text = " ".join(m.get("content", "") for m in messages[-3:]).lower()

        if re.search(r"\b(review|audit|check|inspect|security|vulnerability)\b", text):
            return "reviewer"
        if re.search(r"\b(debug|fix|error|bug|traceback|crash|broken)\b", text):
            return "debugger"
        if re.search(r"\b(plan|design|architect|approach|strategy|how should)\b", text):
            return "planner"
        return "implementer"  # default for coding

    def detect_research_role(self, messages: list[dict[str, str]]) -> str:
        text = " ".join(m.get("content", "") for m in messages[-3:]).lower()

        if re.search(r"\b(search|find|look up|web|google)\b", text):
            return "search"
        if re.search(r"\b(summarize|synthesize|report|conclude|write up)\b", text):
            return "synthesize"
        return "analyze"  # default for research

    def detect_creative_role(self, messages: list[dict[str, str]]) -> str:
        text = " ".join(m.get("content", "") for m in messages[-3:]).lower()

        if re.search(r"\b(image|picture|draw|illustrate|generate.*image)\b", text):
            return "image"
        if re.search(r"\b(voice|speak|audio|tts|narrate|read aloud)\b", text):
            return "voice"
        return "write"  # default for creative

    # ── Complexity Classification (unchanged from before) ────────────

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

    # ── Main Routing ─────────────────────────────────────────────────

    def resolve(self, messages: list[dict[str, str]]) -> RouteDecision:
        """Full routing decision: detect category → role → select config.

        Returns a RouteDecision with the category, role, complexity, and config.
        """
        category = self.detect_category(messages)
        complexity = self.classify(messages)

        # Detect role within category
        if category == TaskCategory.CODING:
            role = self.detect_coding_role(messages)
        elif category == TaskCategory.RESEARCH:
            role = self.detect_research_role(messages)
        elif category == TaskCategory.CREATIVE:
            role = self.detect_creative_role(messages)
        else:
            # General: map complexity to role name
            if self._tools:
                role = "tool_call"
            else:
                role = complexity.value  # simple/moderate/complex

        # Look up config: try category routes first, fall back to flat routes
        config = None
        cat_routes = self._category_routes.get(category.value, {})
        if role in cat_routes and not isinstance(cat_routes[role].provider, StubProvider):
            config = cat_routes[role]

        # Fallback: general category
        if config is None:
            gen_routes = self._category_routes.get("general", {})
            fallback_role = complexity.value
            if self._tools:
                fallback_role = "tool_call"
            if fallback_role in gen_routes and not isinstance(gen_routes[fallback_role].provider, StubProvider):
                config = gen_routes[fallback_role]

        # Fallback: flat routes (backward compat)
        if config is None:
            tier = Complexity.TOOL_CALL if self._tools else complexity
            config = self._routes.get(tier, self._routes[Complexity.SIMPLE])

        return RouteDecision(
            category=category,
            role=role,
            complexity=complexity,
            config=config,
        )

    async def route(self, messages: list[dict[str, str]]) -> LLMResponse:
        """Classify, resolve route, and call the appropriate provider."""
        decision = self.resolve(messages)
        config = decision.config

        input_tokens = count_message_tokens(messages, model=config.provider.model_id)
        effective_max_tokens = min(config.max_tokens, max(256, config.max_tokens - input_tokens // 4))

        response = await config.provider.complete(
            messages,
            max_tokens=effective_max_tokens,
            temperature=config.temperature,
            tools=self._tools or None,
        )

        # Annotate response with routing metadata
        if not hasattr(response, "routing"):
            response.routing = {}
        response.routing = {
            "category": decision.category.value,
            "role": decision.role,
            "complexity": decision.complexity.value,
        }

        if response.cost_usd == 0 and response.usage:
            response.cost_usd = estimate_cost(
                response.usage.get("input_tokens", input_tokens),
                response.usage.get("output_tokens", 0),
                model=response.model,
            )

        return response

    # ── Multimodal helpers ───────────────────────────────────────────

    def get_multimodal_config(self, modality: Complexity) -> RouteConfig | None:
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
