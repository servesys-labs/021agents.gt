"""Tests for LLM provider and router."""

import pytest

from agentos.llm.provider import StubProvider
from agentos.llm.router import Complexity, LLMRouter


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
