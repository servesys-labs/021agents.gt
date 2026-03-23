from __future__ import annotations

import asyncio

import pytest

from agentos.core.runtime_dag import (
    JoinStrategy,
    NodePolicy,
    NodeResult,
    NodeSpec,
    NodeType,
    RuntimeDAGRunner,
    reduce_join_outputs,
)


@pytest.mark.asyncio
async def test_runtime_dag_executes_topologically() -> None:
    runner = RuntimeDAGRunner(max_parallel=4)
    nodes = [
        NodeSpec(node_id="plan", node_type=NodeType.PLAN),
        NodeSpec(node_id="a", node_type=NodeType.LLM, depends_on=["plan"]),
        NodeSpec(node_id="b", node_type=NodeType.LLM, depends_on=["plan"]),
        NodeSpec(node_id="join", node_type=NodeType.JOIN, depends_on=["a", "b"]),
    ]
    seen: list[str] = []

    async def _exec(spec: NodeSpec, prior: dict[str, NodeResult]) -> NodeResult:
        seen.append(spec.node_id)
        if spec.node_id == "join":
            assert "a" in prior and "b" in prior
        await asyncio.sleep(0.001)
        return NodeResult(node_id=spec.node_id, status="completed", output=spec.node_id)

    result = await runner.run(nodes, _exec)
    assert set(result.keys()) == {"plan", "a", "b", "join"}
    assert seen.index("plan") < seen.index("join")


@pytest.mark.asyncio
async def test_runtime_dag_retries_after_timeout() -> None:
    runner = RuntimeDAGRunner()
    attempts = 0
    node = NodeSpec(
        node_id="slow",
        node_type=NodeType.LLM,
        policy=NodePolicy(retries=1, timeout_ms=1),
    )

    async def _exec(spec: NodeSpec, prior: dict[str, NodeResult]) -> NodeResult:
        nonlocal attempts
        attempts += 1
        await asyncio.sleep(0.01)
        return NodeResult(node_id=spec.node_id, status="completed", output="ok")

    result = await runner.run([node], _exec)
    assert result["slow"].status == "failed"
    assert result["slow"].attempts == 2
    assert attempts == 2


def test_join_reducers() -> None:
    assert reduce_join_outputs(JoinStrategy.MERGE, ["A", "B"]) == "A\n\nB"
    assert reduce_join_outputs(JoinStrategy.RERANK, ["a", "longer answer"]) == "longer answer"
    assert reduce_join_outputs(JoinStrategy.VOTE, ["x", "x", "y"]) == "x"
