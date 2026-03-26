from __future__ import annotations

import pytest
import random

from agentos.core.events import EventBus, EventType
from agentos.core.graph_contract import assert_turn_results_valid
from agentos.core.harness import AgentHarness, HarnessConfig
from agentos.graph.context import GraphContext
from agentos.graph.nodes import SubgraphNode, ToolExecNode
from agentos.graph.runtime import GraphRuntime, merge_branch_states
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


def test_graph_merge_branch_states_is_deterministic() -> None:
    reducers = {
        "cost_usd": "sum_numeric",
        "warnings": "extend_unique",
        "metrics": "merge_dict",
        "best_score": "max_numeric",
    }
    a = {
        "__branch_id": "b",
        "cost_usd": 0.1,
        "warnings": ["w2", "w1"],
        "metrics": {"tool_b_ms": 40},
        "best_score": 0.4,
    }
    b = {
        "__branch_id": "a",
        "cost_usd": 0.2,
        "warnings": ["w1", "w3"],
        "metrics": {"tool_a_ms": 30},
        "best_score": 0.8,
    }
    merged_one = merge_branch_states([a, b], reducers)
    merged_two = merge_branch_states([b, a], reducers)
    assert merged_one == merged_two
    assert float(merged_one["cost_usd"]) == pytest.approx(0.3)
    assert merged_one["warnings"] == ["w1", "w2", "w3"]
    assert merged_one["metrics"] == {"tool_a_ms": 30, "tool_b_ms": 40}
    assert float(merged_one["best_score"]) == pytest.approx(0.8)


def test_graph_context_apply_state_update_respects_reducers() -> None:
    ctx = GraphContext(
        session_state={"cost_usd": 0.5, "events": ["start"], "meta": {"a": 1}},
        state_reducers={"cost_usd": "sum_numeric", "events": "append_list", "meta": "merge_dict"},
    )
    ctx.apply_state_update({"events": ["mid"], "cost_usd": 0.25, "meta": {"b": 2}})
    ctx.apply_state_update({"events": ["end"], "cost_usd": 0.25})
    assert float(ctx.session_state["cost_usd"]) == pytest.approx(1.0)
    assert ctx.session_state["events"] == ["start", "mid", "end"]
    assert ctx.session_state["meta"] == {"a": 1, "b": 2}


@pytest.mark.asyncio
async def test_tool_exec_parallel_join_is_deterministic() -> None:
    class _Cfg:
        parallel_tool_calls = True

    class _Harness:
        def __init__(self, seed: int):
            self.config = _Cfg()
            self._rng = random.Random(seed)

        async def _execute_tools(self, tool_calls):
            rows = [
                {"tool": tc["name"], "tool_call_id": tc["id"], "result": f"ok:{tc['id']}"}
                for tc in tool_calls
            ]
            self._rng.shuffle(rows)
            return rows

    llm_response = LLMResponse(
        content="call tools",
        model="stub",
        tool_calls=[
            {"id": "tool_call_b", "name": "b", "arguments": {}},
            {"id": "tool_call_a", "name": "a", "arguments": {}},
        ],
    )
    ctx_a = GraphContext(session_state={"llm_response": llm_response, "results": []})
    ctx_b = GraphContext(session_state={"llm_response": llm_response, "results": []})

    node_a = ToolExecNode(_Harness(seed=1))
    node_b = ToolExecNode(_Harness(seed=2))
    out_a = await node_a.execute(ctx_a)
    out_b = await node_b.execute(ctx_b)

    ids_a = [r.get("tool_call_id", "") for r in out_a.session_state["tool_results"]]
    ids_b = [r.get("tool_call_id", "") for r in out_b.session_state["tool_results"]]
    assert ids_a == ids_b
    assert ids_a == ["tool_call_a", "tool_call_b"]
    assert out_a.session_state["state_snapshot"] == out_b.session_state["state_snapshot"]


@pytest.mark.asyncio
async def test_graph_subgraph_node_links_child_spans_to_parent() -> None:
    subgraph = SubgraphNode(
        "subgraph_main",
        [
            _AppendNode("child_a", "A"),
            _AppendNode("child_b", "B"),
        ],
    )
    runtime = GraphRuntime([subgraph])
    ctx = GraphContext(session_state={
        "trace_id": "trace-subgraph",
        "session_id": "session-subgraph",
        "current_turn": 1,
    })
    result = await runtime.run(ctx)
    assert result.session_state["path"] == ["A", "B"]
    spans = result.session_state.get("node_spans", [])
    by_name = {s["name"]: s for s in spans}
    assert "subgraph_main" in by_name
    assert "child_a" in by_name
    assert "child_b" in by_name
    parent_span_id = by_name["subgraph_main"]["span_id"]
    assert by_name["child_a"]["parent_span_id"] == parent_span_id
    assert by_name["child_b"]["parent_span_id"] == parent_span_id
    assert by_name["child_a"]["trace_id"] == "trace-subgraph"
    assert by_name["child_b"]["session_id"] == "session-subgraph"
    assert by_name["subgraph_main"]["attributes"]["graph_id"] == "root"
    child_graph_id = by_name["child_a"]["attributes"]["graph_id"]
    assert child_graph_id.startswith("subgraph_main:")
    assert by_name["child_a"]["attributes"]["parent_graph_id"] == "root"
    assert by_name["child_b"]["attributes"]["graph_id"] == child_graph_id
