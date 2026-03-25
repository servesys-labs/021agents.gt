from __future__ import annotations

import pytest

from agentos.core.events import EventBus, EventType
from agentos.core.graph_contract import assert_turn_results_valid
from agentos.core.harness import AgentHarness, HarnessConfig
from agentos.graph.context import GraphContext
from agentos.graph.runtime import GraphRuntime
from agentos.llm.provider import LLMResponse
from agentos.llm.router import Complexity, LLMRouter


class _SingleShotProvider:
    @property
    def model_id(self) -> str:
        return "graph-runtime-compat-provider"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="Graph compatibility answer.",
            model=self.model_id,
            usage={"input_tokens": 8, "output_tokens": 10},
            cost_usd=0.001,
        )


def _router_with_provider(provider) -> LLMRouter:
    router = LLMRouter()
    for tier in Complexity:
        router.register(tier, provider)
    return router


class _AppendNode:
    def __init__(self, node_id: str, marker: str):
        self.node_id = node_id
        self.marker = marker
        self.max_retries = 0

    def should_skip(self, ctx: GraphContext) -> bool:
        return False

    async def execute(self, ctx: GraphContext) -> GraphContext:
        ctx.session_state.setdefault("path", []).append(self.marker)
        return ctx


class _SkipNode(_AppendNode):
    def should_skip(self, ctx: GraphContext) -> bool:
        return True


class _FlakyNode(_AppendNode):
    def __init__(self, node_id: str, marker: str):
        super().__init__(node_id=node_id, marker=marker)
        self.max_retries = 1
        self.calls = 0

    async def execute(self, ctx: GraphContext) -> GraphContext:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("transient failure")
        return await super().execute(ctx)


class _HarnessRunNode:
    """Compatibility scaffold: execute current harness inside a graph node."""

    node_id = "harness_run"
    max_retries = 0

    def __init__(self, harness: AgentHarness):
        self.harness = harness

    def should_skip(self, ctx: GraphContext) -> bool:
        return False

    async def execute(self, ctx: GraphContext) -> GraphContext:
        user_content = ""
        for message in reversed(ctx.messages):
            if message.get("role") == "user":
                user_content = str(message.get("content", ""))
                break
        turns = await self.harness.run(user_content)
        ctx.session_state["turn_results"] = turns
        if turns and turns[-1].llm_response:
            ctx.with_message("assistant", turns[-1].llm_response.content)
        return ctx


@pytest.mark.asyncio
async def test_graph_runtime_executes_nodes_in_order() -> None:
    runtime = GraphRuntime([
        _AppendNode("node_a", "A"),
        _AppendNode("node_b", "B"),
    ])
    ctx = GraphContext(session_state={})
    result = await runtime.run(ctx)
    assert result.session_state["path"] == ["A", "B"]
    statuses = [cp["status"] for cp in result.checkpoints]
    assert statuses.count("completed") == 2


@pytest.mark.asyncio
async def test_graph_runtime_respects_skip_and_retry() -> None:
    flaky = _FlakyNode("node_flaky", "ok")
    runtime = GraphRuntime([
        _SkipNode("node_skip", "skip"),
        flaky,
    ])
    ctx = GraphContext(session_state={})
    result = await runtime.run(ctx)
    assert result.session_state["path"] == ["ok"]
    assert flaky.calls == 2
    assert any(cp["status"] == "skipped" for cp in result.checkpoints)
    assert any(cp["status"] == "failed_attempt" for cp in result.checkpoints)


@pytest.mark.asyncio
async def test_graph_runtime_compatibility_scaffold_with_harness_output() -> None:
    harness = AgentHarness(
        config=HarnessConfig(max_turns=2),
        llm_router=_router_with_provider(_SingleShotProvider()),
    )

    direct = await harness.run("hello compatibility")
    runtime = GraphRuntime([_HarnessRunNode(harness)])
    ctx = GraphContext(messages=[{"role": "user", "content": "hello compatibility"}], session_state={})
    graph_ctx = await runtime.run(ctx)
    from_graph = graph_ctx.session_state["turn_results"]

    assert len(from_graph) == len(direct)
    assert from_graph[-1].stop_reason == direct[-1].stop_reason
    assert from_graph[-1].done == direct[-1].done
    assert_turn_results_valid(from_graph, max_turns=harness.config.max_turns)


@pytest.mark.asyncio
async def test_graph_runtime_emits_node_events_and_collects_node_spans() -> None:
    runtime = GraphRuntime([
        _AppendNode("node_a", "A"),
        _AppendNode("node_b", "B"),
    ])
    bus = EventBus()
    seen_types: list[EventType] = []

    async def _on_any(event):
        seen_types.append(event.type)

    bus.on_all(_on_any)
    ctx = GraphContext(session_state={
        "event_bus": bus,
        "trace_id": "trace-test",
        "session_id": "session-test",
        "current_turn": 1,
    })
    result = await runtime.run(ctx)
    spans = result.session_state.get("node_spans", [])
    assert len(spans) == 2
    assert {s["name"] for s in spans} == {"node_a", "node_b"}
    assert all(s["trace_id"] == "trace-test" for s in spans)
    assert EventType.NODE_START in seen_types
    assert EventType.NODE_END in seen_types
