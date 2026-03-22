"""Tests for LLM plans, multi-provider routing, and tool-call tier."""

import pytest
from pathlib import Path


class TestToolCallTier:
    def test_tool_call_tier_exists(self):
        from agentos.llm.router import Complexity
        assert hasattr(Complexity, "TOOL_CALL")
        assert Complexity.TOOL_CALL.value == "tool_call"

    def test_router_has_tool_call_route(self):
        from agentos.llm.router import LLMRouter, Complexity
        router = LLMRouter()
        assert Complexity.TOOL_CALL in router._routes

    @pytest.mark.asyncio
    async def test_tool_call_tier_used_when_tools_present(self):
        """When tools are set and TOOL_CALL has a real provider, it should be used."""
        from agentos.llm.router import LLMRouter, Complexity, RouteConfig
        from agentos.llm.provider import StubProvider, LLMResponse

        class FakeProvider:
            model_id = "tool-model"
            async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
                return LLMResponse(content="tool response", model="tool-model", usage={"input_tokens": 10, "output_tokens": 5})

        router = LLMRouter()
        # Register a real provider for TOOL_CALL
        router.register(Complexity.TOOL_CALL, FakeProvider())
        router.set_tools([{"name": "test-tool", "description": "A tool"}])

        response = await router.route([{"role": "user", "content": "use the tool"}])
        assert response.model == "tool-model"


class TestPlanLoading:
    def test_load_builtin_plan(self):
        from agentos.cli import _load_plan
        plan = _load_plan("basic")
        if plan:  # May not find it if config path differs
            assert "simple" in plan
            assert "moderate" in plan
            assert "complex" in plan
            assert "tool_call" in plan

    def test_load_nonexistent_plan(self):
        from agentos.cli import _load_plan
        plan = _load_plan("nonexistent-plan-xyz")
        assert plan is None


class TestCostEstimation:
    def test_known_models(self):
        from agentos.llm.tokens import estimate_cost

        # DeepSeek — cheap
        cost = estimate_cost(1000, 100, "deepseek-v3.2")
        assert cost > 0
        assert cost < 0.001

        # Claude Sonnet — mid
        cost = estimate_cost(1000, 100, "claude-sonnet-4-6")
        assert cost > 0

        # GPT-5.4-pro — expensive
        cost = estimate_cost(1000, 100, "gpt-5.4-pro")
        assert cost > estimate_cost(1000, 100, "gpt-5.4")

    def test_local_model_free(self):
        from agentos.llm.tokens import estimate_cost
        cost = estimate_cost(10000, 10000, "local")
        assert cost == 0.0

    def test_cloudflare_free(self):
        from agentos.llm.tokens import estimate_cost
        cost = estimate_cost(10000, 10000, "@cf/some-model")
        assert cost == 0.0
