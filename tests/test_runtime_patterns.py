from __future__ import annotations

import asyncio

import pytest

from agentos.core.harness import AgentHarness, HarnessConfig
from agentos.llm.provider import LLMResponse
from agentos.llm.router import Complexity, LLMRouter
from agentos.tools.executor import ToolExecutor
from agentos.tools.mcp import MCPClient, MCPServer, MCPTool


class _AlwaysFinalizeProvider:
    @property
    def model_id(self) -> str:
        return "test-reflection-model"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="Final answer draft.",
            model=self.model_id,
            usage={"input_tokens": 10, "output_tokens": 20},
            cost_usd=0.001,
        )


class _ParallelToolProvider:
    def __init__(self) -> None:
        self.calls = 0

    @property
    def model_id(self) -> str:
        return "test-parallel-model"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        self.calls += 1
        if self.calls == 1:
            return LLMResponse(
                content="I will call tools.",
                model=self.model_id,
                tool_calls=[
                    {"id": "t1", "name": "tool_a", "arguments": {"value": 1}},
                    {"id": "t2", "name": "tool_b", "arguments": {"value": 2}},
                ],
                usage={"input_tokens": 15, "output_tokens": 25},
                cost_usd=0.002,
            )
        return LLMResponse(
            content="All tools completed.",
            model=self.model_id,
            usage={"input_tokens": 8, "output_tokens": 12},
            cost_usd=0.001,
        )


def _router_with_provider(provider) -> LLMRouter:
    router = LLMRouter()
    for tier in Complexity:
        router.register(tier, provider)
    return router


@pytest.mark.asyncio
async def test_reflection_gate_retries_before_finalizing() -> None:
    harness = AgentHarness(
        config=HarnessConfig(
            max_turns=3,
            enable_reflection_stage=True,
            reflection_gate_on_finalize=True,
            reflection_min_confidence=1.1,  # force one retry (confidence max is 1.0)
            max_reflection_attempts=1,
            enable_planner_artifact=True,
        ),
        llm_router=_router_with_provider(_AlwaysFinalizeProvider()),
    )

    results = await harness.run("Summarize this request.")
    assert len(results) >= 2
    assert results[0].stop_reason == "reflection_retry"
    assert results[0].done is False
    assert results[-1].done is True
    assert results[-1].stop_reason == "completed"
    assert results[0].plan_artifact.get("dag", {}).get("nodes")


@pytest.mark.asyncio
async def test_parallel_tool_fanout_updates_execution_mode_and_dag() -> None:
    provider = _ParallelToolProvider()
    mcp = MCPClient()
    mcp.register_server(MCPServer(name="tools", tools=[
        MCPTool(name="tool_a", description="A", input_schema={"type": "object"}),
        MCPTool(name="tool_b", description="B", input_schema={"type": "object"}),
    ]))

    async def tool_a(value=0):
        await asyncio.sleep(0.01)
        return {"tool": "tool_a", "result": value}

    async def tool_b(value=0):
        await asyncio.sleep(0.01)
        return {"tool": "tool_b", "result": value}

    mcp.register_handler("tool_a", tool_a)
    mcp.register_handler("tool_b", tool_b)

    harness = AgentHarness(
        config=HarnessConfig(max_turns=4, parallel_tool_calls=True, enable_planner_artifact=True),
        llm_router=_router_with_provider(provider),
        tool_executor=ToolExecutor(mcp_client=mcp),
    )

    results = await harness.run("Run both tools then finish.")
    parallel_turns = [r for r in results if r.execution_mode == "parallel"]
    assert parallel_turns, "Expected at least one parallel turn"
    assert len(parallel_turns[0].tool_results) == 2
    dag_nodes = parallel_turns[0].plan_artifact.get("dag", {}).get("nodes", [])
    assert any(n.get("type") == "tool_fanout" for n in dag_nodes)
