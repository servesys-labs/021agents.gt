from __future__ import annotations

import asyncio

import pytest

from agentos.core.graph_contract import assert_turn_results_valid
from agentos.core.harness import AgentHarness, HarnessConfig, TurnResult
from agentos.graph.context import GraphContext
from agentos.graph.nodes import (
    GovernanceNode,
    GraphTurnState,
    HarnessSetupNode,
    LLMNode,
    ToolExecNode,
    TurnResultNode,
)
from agentos.graph.runtime import GraphRuntime
from agentos.llm.provider import LLMResponse
from agentos.llm.router import Complexity, LLMRouter
from agentos.tools.executor import ToolExecutor
from agentos.tools.mcp import MCPClient, MCPServer, MCPTool


class _SingleToolThenFinalizeProvider:
    def __init__(self) -> None:
        self.calls = 0

    @property
    def model_id(self) -> str:
        return "graph-tool-single-provider"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        self.calls += 1
        if self.calls == 1:
            return LLMResponse(
                content="Calling one tool.",
                model=self.model_id,
                tool_calls=[{"id": "t1", "name": "tool_a", "arguments": {"value": 7}}],
                usage={"input_tokens": 12, "output_tokens": 20},
                cost_usd=0.001,
            )
        return LLMResponse(
            content="Single tool finished.",
            model=self.model_id,
            usage={"input_tokens": 8, "output_tokens": 10},
            cost_usd=0.001,
        )


class _ParallelToolThenFinalizeProvider:
    def __init__(self) -> None:
        self.calls = 0

    @property
    def model_id(self) -> str:
        return "graph-tool-parallel-provider"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        self.calls += 1
        if self.calls == 1:
            return LLMResponse(
                content="Calling parallel tools.",
                model=self.model_id,
                tool_calls=[
                    {"id": "t1", "name": "tool_a", "arguments": {"value": 1}},
                    {"id": "t2", "name": "tool_b", "arguments": {"value": 2}},
                ],
                usage={"input_tokens": 14, "output_tokens": 24},
                cost_usd=0.002,
            )
        return LLMResponse(
            content="Parallel tools finished.",
            model=self.model_id,
            usage={"input_tokens": 8, "output_tokens": 10},
            cost_usd=0.001,
        )


class _FailingToolProvider:
    @property
    def model_id(self) -> str:
        return "graph-tool-failing-provider"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="Retry failing tool.",
            model=self.model_id,
            tool_calls=[{"id": "tf", "name": "tool_fail", "arguments": {"value": 9}}],
            usage={"input_tokens": 10, "output_tokens": 10},
            cost_usd=0.001,
        )


def _router_with_provider(provider) -> LLMRouter:
    router = LLMRouter()
    for tier in Complexity:
        router.register(tier, provider)
    return router


def _tool_executor_with_handlers() -> ToolExecutor:
    mcp = MCPClient()
    mcp.register_server(MCPServer(name="tools", tools=[
        MCPTool(name="tool_a", description="A", input_schema={"type": "object"}),
        MCPTool(name="tool_b", description="B", input_schema={"type": "object"}),
        MCPTool(name="tool_fail", description="Fail", input_schema={"type": "object"}),
    ]))

    async def tool_a(value=0):
        await asyncio.sleep(0.001)
        return {"tool": "tool_a", "result": value}

    async def tool_b(value=0):
        await asyncio.sleep(0.001)
        return {"tool": "tool_b", "result": value}

    async def tool_fail(value=0):
        await asyncio.sleep(0.001)
        raise RuntimeError(f"forced failure {value}")

    mcp.register_handler("tool_a", tool_a)
    mcp.register_handler("tool_b", tool_b)
    mcp.register_handler("tool_fail", tool_fail)
    return ToolExecutor(mcp_client=mcp)


async def _run_graph_with_phase2_nodes(harness: AgentHarness, user_input: str) -> list[TurnResult]:
    state = GraphTurnState(user_input=user_input)
    ctx = GraphContext(
        messages=[{"role": "user", "content": user_input}],
        session_state={"results": []},
    )
    runtime = GraphRuntime(nodes=[
        HarnessSetupNode(harness, state),
        GovernanceNode(harness),
        LLMNode(harness),
        ToolExecNode(harness),
        TurnResultNode(harness, state),
    ])
    for _ in range(harness.config.max_turns):
        ctx = await runtime.run(ctx)
        if state.done:
            break
    return ctx.session_state["results"]


def _build_harness(provider, *, parallel: bool, max_retries: int = 3) -> AgentHarness:
    return AgentHarness(
        config=HarnessConfig(
            max_turns=4,
            parallel_tool_calls=parallel,
            retry_on_tool_failure=True,
            max_retries=max_retries,
            enable_reflection_stage=False,
            enable_planner_artifact=True,
        ),
        llm_router=_router_with_provider(provider),
        tool_executor=_tool_executor_with_handlers(),
    )


@pytest.mark.asyncio
async def test_phase2_parity_single_tool_then_finalize() -> None:
    baseline = _build_harness(_SingleToolThenFinalizeProvider(), parallel=False)
    graph = _build_harness(_SingleToolThenFinalizeProvider(), parallel=False)

    baseline_results = await baseline.run("single tool parity")
    graph_results = await _run_graph_with_phase2_nodes(graph, "single tool parity")

    assert_turn_results_valid(graph_results, max_turns=graph.config.max_turns)
    assert [r.stop_reason for r in graph_results] == [r.stop_reason for r in baseline_results]
    assert [r.done for r in graph_results] == [r.done for r in baseline_results]
    assert len(graph_results[0].tool_results) == 1
    assert graph_results[0].execution_mode == "sequential"
    assert graph_results[-1].stop_reason == "completed"


@pytest.mark.asyncio
async def test_phase2_parity_parallel_tools_then_finalize() -> None:
    baseline = _build_harness(_ParallelToolThenFinalizeProvider(), parallel=True)
    graph = _build_harness(_ParallelToolThenFinalizeProvider(), parallel=True)

    baseline_results = await baseline.run("parallel tool parity")
    graph_results = await _run_graph_with_phase2_nodes(graph, "parallel tool parity")

    assert_turn_results_valid(graph_results, max_turns=graph.config.max_turns)
    assert [r.stop_reason for r in graph_results] == [r.stop_reason for r in baseline_results]
    assert graph_results[0].execution_mode == "parallel"
    assert len(graph_results[0].tool_results) == 2
    assert graph_results[-1].stop_reason == "completed"


@pytest.mark.asyncio
async def test_phase2_parity_tool_failure_retry_exhaustion() -> None:
    baseline = _build_harness(_FailingToolProvider(), parallel=False, max_retries=1)
    graph = _build_harness(_FailingToolProvider(), parallel=False, max_retries=1)

    baseline_results = await baseline.run("failing tool parity")
    graph_results = await _run_graph_with_phase2_nodes(graph, "failing tool parity")

    assert_turn_results_valid(graph_results, max_turns=graph.config.max_turns)
    assert [r.stop_reason for r in graph_results] == [r.stop_reason for r in baseline_results]
    assert [r.done for r in graph_results] == [r.done for r in baseline_results]
    assert graph_results[-1].stop_reason == "tool_error"
    assert graph_results[-1].done is True
    assert any("error" in tr for tr in graph_results[-1].tool_results)
