"""Tests for LLM provider and router."""

import pytest

from agentos.llm.provider import StubProvider
from agentos.llm.router import Complexity, LLMRouter
from agentos.llm.tokens import count_tokens, count_message_tokens, estimate_cost


class TestStubProvider:
    @pytest.mark.asyncio
    async def test_complete(self):
        provider = StubProvider(model_id="test-model")
        resp = await provider.complete([{"role": "user", "content": "Hi"}])
        assert "Processed" in resp.content
        assert resp.model == "test-model"
        assert resp.cost_usd > 0


class TestLLMRouter:
    def test_classify_simple(self):
        router = LLMRouter()
        assert router.classify([{"role": "user", "content": "Hi"}]) == Complexity.SIMPLE

    def test_classify_complex(self):
        router = LLMRouter()
        result = router.classify([
            {"role": "user", "content": "Implement a multi-step pipeline to refactor the API module"}
        ])
        assert result == Complexity.COMPLEX

    @pytest.mark.asyncio
    async def test_route(self):
        router = LLMRouter()
        resp = await router.route([{"role": "user", "content": "Hello"}])
        assert resp.content
        assert resp.model


class TestTokenCounting:
    def test_count_tokens(self):
        count = count_tokens("Hello, world!")
        assert count > 0

    def test_count_message_tokens(self):
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        count = count_message_tokens(messages)
        assert count > 0
        # Should include per-message overhead
        assert count > count_tokens("Hello") + count_tokens("Hi there!")

    def test_estimate_cost(self):
        cost = estimate_cost(1000, 500, model="claude-sonnet-4-20250514")
        assert cost > 0
        # Claude Sonnet pricing: 3.0/1M input, 15.0/1M output
        expected = (1000 * 3.0 + 500 * 15.0) / 1_000_000
        assert cost == pytest.approx(expected)

    def test_estimate_cost_different_models(self):
        haiku_cost = estimate_cost(1000, 1000, model="claude-haiku-4-5-20251001")
        opus_cost = estimate_cost(1000, 1000, model="claude-opus-4-20250514")
        assert opus_cost > haiku_cost
