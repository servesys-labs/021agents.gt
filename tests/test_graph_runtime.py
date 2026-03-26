from __future__ import annotations

import pytest

from agentos.core.events import EventBus, EventType
from agentos.graph.context import GraphContext
from agentos.graph.runtime import GraphRuntime, merge_branch_states


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
