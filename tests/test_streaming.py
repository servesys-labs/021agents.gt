"""Tests for streaming output and on_turn_complete callback."""

import asyncio
import pytest
from unittest.mock import MagicMock


class TestOnTurnCallback:
    @pytest.mark.asyncio
    async def test_callback_fires(self):
        """on_turn_complete should be called after each turn."""
        from agentos.core.harness import AgentHarness, HarnessConfig
        from agentos.llm.router import LLMRouter, Complexity, RouteConfig
        from agentos.llm.provider import LLMResponse, StubProvider

        router = LLMRouter()
        for c in Complexity:
            router._routes[c] = RouteConfig(provider=StubProvider(), max_tokens=1024)

        harness = AgentHarness(config=HarnessConfig(max_turns=3), llm_router=router)
        harness.system_prompt = "You are helpful."

        turns_received = []
        harness.on_turn_complete = lambda result: turns_received.append(result.turn_number)

        results = await harness.run("hello")
        assert len(turns_received) > 0
        assert turns_received[0] == 1

    @pytest.mark.asyncio
    async def test_callback_error_doesnt_break_run(self):
        """Errors in the callback should not crash the agent run."""
        from agentos.core.harness import AgentHarness, HarnessConfig
        from agentos.llm.router import LLMRouter, Complexity, RouteConfig
        from agentos.llm.provider import StubProvider

        router = LLMRouter()
        for c in Complexity:
            router._routes[c] = RouteConfig(provider=StubProvider(), max_tokens=1024)

        harness = AgentHarness(config=HarnessConfig(max_turns=2), llm_router=router)
        harness.system_prompt = "Test"
        harness.on_turn_complete = lambda r: (_ for _ in ()).throw(RuntimeError("callback boom"))

        # Should not raise
        results = await harness.run("test")
        assert len(results) > 0


class TestTraceContext:
    @pytest.mark.asyncio
    async def test_trace_id_generated(self):
        """Root runs should generate a trace_id."""
        from agentos.core.harness import AgentHarness, HarnessConfig
        from agentos.llm.router import LLMRouter, Complexity, RouteConfig
        from agentos.llm.provider import StubProvider

        router = LLMRouter()
        for c in Complexity:
            router._routes[c] = RouteConfig(provider=StubProvider(), max_tokens=1024)

        harness = AgentHarness(config=HarnessConfig(max_turns=1), llm_router=router)
        harness.system_prompt = "Test"

        await harness.run("hello")
        assert harness.trace_id != ""
        assert len(harness.trace_id) == 16

    @pytest.mark.asyncio
    async def test_parent_trace_propagated(self):
        """Sub-agent should inherit parent trace_id."""
        from agentos.core.harness import AgentHarness, HarnessConfig
        from agentos.llm.router import LLMRouter, Complexity, RouteConfig
        from agentos.llm.provider import StubProvider

        router = LLMRouter()
        for c in Complexity:
            router._routes[c] = RouteConfig(provider=StubProvider(), max_tokens=1024)

        harness = AgentHarness(config=HarnessConfig(max_turns=1), llm_router=router)
        harness.system_prompt = "Test"
        harness.trace_id = "parent-trace-123"
        harness.parent_session_id = "parent-session"
        harness.depth = 1

        await harness.run("hello")
        assert harness.trace_id == "parent-trace-123"
        assert harness.depth == 1
