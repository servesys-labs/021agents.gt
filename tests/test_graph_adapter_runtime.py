from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from agentos.core.events import EventType
from agentos.core.harness import AgentHarness, HarnessConfig
from agentos.graph.adapter import run_with_graph_runtime
from agentos.llm.provider import LLMResponse
from agentos.llm.router import Complexity, LLMRouter
from agentos.middleware.base import Middleware, MiddlewareChain
from agentos.tools.executor import ToolExecutor
from agentos.tools.mcp import MCPClient, MCPServer, MCPTool


class _SimpleProvider:
    @property
    def model_id(self) -> str:
        return "graph-adapter-simple"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="adapter answer",
            model=self.model_id,
            usage={"input_tokens": 5, "output_tokens": 5},
            cost_usd=0.001,
        )


class _SlowProvider:
    @property
    def model_id(self) -> str:
        return "graph-adapter-slow"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        await asyncio.sleep(0.05)
        return LLMResponse(
            content="too slow",
            model=self.model_id,
            usage={"input_tokens": 1, "output_tokens": 1},
            cost_usd=0.001,
        )


class _CaptureSystemProvider:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_messages: list[dict] = []

    @property
    def model_id(self) -> str:
        return "graph-adapter-capture"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        self.calls += 1
        self.seen_messages = list(messages)
        return LLMResponse(
            content="captured",
            model=self.model_id,
            usage={"input_tokens": 5, "output_tokens": 5},
            cost_usd=0.001,
        )


class _ToolThenFinalizeProvider:
    def __init__(self) -> None:
        self.calls = 0

    @property
    def model_id(self) -> str:
        return "graph-adapter-tool"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        self.calls += 1
        if self.calls == 1:
            return LLMResponse(
                content="call tool",
                model=self.model_id,
                tool_calls=[{"id": "t1", "name": "tool_a", "arguments": {"value": 2}}],
                usage={"input_tokens": 4, "output_tokens": 4},
                cost_usd=0.001,
            )
        return LLMResponse(
            content="final after tool",
            model=self.model_id,
            usage={"input_tokens": 4, "output_tokens": 4},
            cost_usd=0.001,
        )


def _router_with_provider(provider) -> LLMRouter:
    router = LLMRouter()
    for tier in Complexity:
        router.register(tier, provider)
    return router


class _TrackingMiddleware(Middleware):
    name = "tracking"
    order = 10

    def __init__(self) -> None:
        self.before_calls = 0
        self.after_calls = 0
        self.turn_end_calls = 0
        self.session_start_calls = 0
        self.session_end_calls = 0

    async def before_model(self, ctx):
        self.before_calls += 1

    async def after_model(self, ctx):
        self.after_calls += 1

    async def on_turn_end(self, ctx):
        self.turn_end_calls += 1

    async def on_session_start(self, ctx):
        self.session_start_calls += 1

    async def on_session_end(self, ctx):
        self.session_end_calls += 1


class _FakeMemory:
    def __init__(self, prompt_section: str):
        self._prompt_section = prompt_section

    def to_prompt_section(self) -> str:
        return self._prompt_section


class _FakeAsyncUpdater:
    def __init__(self, prompt_section: str):
        self.memory = _FakeMemory(prompt_section)
        self.started = False
        self.queued_updates = []

    def start(self) -> None:
        self.started = True

    def queue_update(self, update) -> None:
        self.queued_updates.append(update)


@pytest.mark.asyncio
async def test_graph_adapter_emits_lifecycle_events_and_middleware_hooks() -> None:
    tracker = _TrackingMiddleware()
    harness = AgentHarness(
        config=HarnessConfig(max_turns=2, enable_reflection_stage=False),
        llm_router=_router_with_provider(_SimpleProvider()),
        middleware_chain=MiddlewareChain([tracker]),
    )
    seen: list[EventType] = []

    async def _on_any(event):
        seen.append(event.type)

    harness.event_bus.on_all(_on_any)
    results = await run_with_graph_runtime(harness, "hello events")

    assert results
    assert results[-1].stop_reason == "completed"
    assert tracker.session_start_calls == 1
    assert tracker.before_calls >= 1
    assert tracker.after_calls >= 1
    assert tracker.turn_end_calls >= 1
    assert tracker.session_end_calls == 1
    assert EventType.SESSION_START in seen
    assert EventType.TURN_START in seen
    assert EventType.TURN_END in seen
    assert EventType.SESSION_END in seen


@pytest.mark.asyncio
async def test_graph_adapter_applies_timeout_wait_for() -> None:
    harness = AgentHarness(
        config=HarnessConfig(max_turns=2, timeout_seconds=0.01),
        llm_router=_router_with_provider(_SlowProvider()),
    )
    seen: list[EventType] = []

    async def _on_any(event):
        seen.append(event.type)

    harness.event_bus.on_all(_on_any)
    results = await run_with_graph_runtime(harness, "hello timeout")

    assert len(results) == 1
    assert results[0].stop_reason == "timeout"
    assert results[0].done is True
    # Session should still close cleanly on timeout.
    assert EventType.SESSION_START in seen
    assert EventType.SESSION_END in seen


@pytest.mark.asyncio
async def test_graph_adapter_includes_skills_async_memory_and_procedures_in_system_prompt() -> None:
    provider = _CaptureSystemProvider()
    harness = AgentHarness(
        config=HarnessConfig(max_turns=2, enable_skills=True),
        llm_router=_router_with_provider(provider),
    )
    harness.system_prompt = "BASE_PROMPT"
    harness.skill_loader.build_prompt_section = lambda: "SKILLS_SECTION"
    harness._async_memory_updater = _FakeAsyncUpdater("<memory>\nASYNC_FACT\n</memory>")
    harness._async_memory_started = False

    class _Proc:
        name = "tool_playbook"
        success_rate = 0.9
        steps = [{"tool": "tool_a"}, {"tool": "tool_b"}]

    harness.memory_manager.procedural.find_best = lambda _input, limit=3: [_Proc()]
    await run_with_graph_runtime(harness, "inject setup context")

    system_messages = [m for m in provider.seen_messages if m.get("role") == "system"]
    assert system_messages
    text = system_messages[0]["content"]
    assert "BASE_PROMPT" in text
    assert "SKILLS_SECTION" in text
    assert "ASYNC_FACT" in text
    assert "Learned procedures (from past successes)" in text
    assert "tool_playbook" in text


@pytest.mark.asyncio
async def test_graph_adapter_persists_episode_and_procedure_on_completion() -> None:
    provider = _ToolThenFinalizeProvider()
    mcp = MCPClient()
    mcp.register_server(MCPServer(name="tools", tools=[
        MCPTool(name="tool_a", description="A", input_schema={"type": "object"}),
    ]))

    async def tool_a(value=0):
        return {"tool": "tool_a", "result": value}

    mcp.register_handler("tool_a", tool_a)
    harness = AgentHarness(
        config=HarnessConfig(max_turns=3, retry_on_tool_failure=True, max_retries=1),
        llm_router=_router_with_provider(provider),
        tool_executor=ToolExecutor(mcp_client=mcp),
    )
    harness.memory_manager.store_episode = AsyncMock()
    harness._store_procedure = AsyncMock()
    harness._async_memory_updater = _FakeAsyncUpdater("<memory>\nA\n</memory>")
    harness._async_memory_started = False

    results = await run_with_graph_runtime(harness, "persist this")
    assert results[-1].stop_reason == "completed"
    harness.memory_manager.store_episode.assert_awaited_once()
    harness._store_procedure.assert_awaited_once()
    assert harness._async_memory_updater.started is True
    assert len(harness._async_memory_updater.queued_updates) == 1
