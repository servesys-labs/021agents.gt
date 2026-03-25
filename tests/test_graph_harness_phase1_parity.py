from __future__ import annotations

from dataclasses import dataclass

import pytest

from agentos.core.graph_contract import assert_turn_results_valid
from agentos.core.harness import AgentHarness, HarnessConfig, TurnResult
from agentos.graph.context import GraphContext
from agentos.graph.runtime import GraphRuntime
from agentos.llm.provider import LLMResponse
from agentos.llm.router import Complexity, LLMRouter


class _SingleShotProvider:
    @property
    def model_id(self) -> str:
        return "phase1-parity-model"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="Parity response",
            model=self.model_id,
            usage={"input_tokens": 10, "output_tokens": 6},
            cost_usd=0.001,
        )


class _ReflectionProvider:
    @property
    def model_id(self) -> str:
        return "phase1-reflection-model"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="Draft reflection answer",
            model=self.model_id,
            usage={"input_tokens": 10, "output_tokens": 6},
            cost_usd=0.001,
        )


def _router_with_provider(provider) -> LLMRouter:
    router = LLMRouter()
    for tier in Complexity:
        router.register(tier, provider)
    return router


@dataclass
class _ParityState:
    user_input: str
    complexity: str = "simple"
    available_tools: list[dict] | None = None
    initialized: bool = False
    cumulative_cost: float = 0.0
    reflection_retries: int = 0
    done: bool = False


class _SetupNode:
    node_id = "setup"

    def __init__(self, harness: AgentHarness, state: _ParityState):
        self.harness = harness
        self.state = state

    def should_skip(self, ctx: GraphContext) -> bool:
        return self.state.initialized

    async def execute(self, ctx: GraphContext) -> GraphContext:
        self.harness.governance.reset_for_session()
        complexity = self.harness.llm_router.classify(
            [{"role": "user", "content": self.state.user_input}]
        )
        self.state.complexity = complexity.value
        self.state.available_tools = self.harness.tool_executor.available_tools()
        self.harness.llm_router.set_tools(self.state.available_tools)
        memory_context = await self.harness.memory_manager.build_context(self.state.user_input)
        system_parts: list[str] = []
        if self.harness.system_prompt:
            system_parts.append(self.harness.system_prompt)
        if memory_context:
            system_parts.append(memory_context)
        system_parts.append(self.harness._reasoning_instruction(self.harness.config.reasoning_strategy))
        messages: list[dict] = [{"role": "user", "content": self.state.user_input}]
        if system_parts:
            messages.insert(0, {"role": "system", "content": "\n\n".join(system_parts)})
        ctx.messages = messages
        self.state.initialized = True
        return ctx


class _LlmNode:
    node_id = "llm"

    def __init__(self, harness: AgentHarness):
        self.harness = harness

    def should_skip(self, ctx: GraphContext) -> bool:
        return False

    async def execute(self, ctx: GraphContext) -> GraphContext:
        llm_response = await self.harness._call_llm(ctx.messages)
        ctx.session_state["llm_response"] = llm_response
        return ctx


class _FinalizeNode:
    node_id = "finalize"

    def __init__(self, harness: AgentHarness, state: _ParityState):
        self.harness = harness
        self.state = state

    def should_skip(self, ctx: GraphContext) -> bool:
        return self.state.done

    async def execute(self, ctx: GraphContext) -> GraphContext:
        turn_number = len(ctx.session_state["results"]) + 1
        llm_response = ctx.session_state.get("llm_response")
        if llm_response is None:
            is_budget = not self.harness.governance.check_budget(0.01)
            stop_reason = "budget" if is_budget else "llm_error"
            error_msg = "Budget exhausted" if is_budget else "LLM call failed"
            result = TurnResult(
                turn_number=turn_number,
                error=error_msg,
                done=True,
                stop_reason=stop_reason,
                cumulative_cost_usd=self.state.cumulative_cost,
            )
            ctx.session_state["results"].append(result)
            self.state.done = True
            return ctx

        self.state.cumulative_cost += llm_response.cost_usd
        reflection = self.harness._build_reflection_artifact(
            llm_response=llm_response,
            tool_results=[],
            middleware_warnings=[],
            done=True,
        )
        plan_artifact = self.harness._build_turn_plan_artifact(
            user_input=self.state.user_input,
            complexity=self.state.complexity,
            available_tools=self.state.available_tools or [],
            turn_number=turn_number,
            execution_mode="sequential",
            has_tool_calls=False,
            done=True,
            reasoning_strategy=self.harness.config.reasoning_strategy,
            backlog=[],
        )
        should_retry = self.harness._should_retry_for_reflection(
            reflection=reflection,
            reflection_retries=self.state.reflection_retries,
            turn=turn_number,
        )
        if should_retry:
            self.state.reflection_retries += 1
            result = TurnResult(
                turn_number=turn_number,
                llm_response=llm_response,
                done=False,
                stop_reason="reflection_retry",
                cost_usd=llm_response.cost_usd,
                cumulative_cost_usd=self.state.cumulative_cost,
                model_used=llm_response.model,
                execution_mode="sequential",
                plan_artifact=plan_artifact,
                reflection=reflection,
            )
            ctx.session_state["results"].append(result)
            ctx.messages.append({"role": "assistant", "content": llm_response.content})
            ctx.messages.append({
                "role": "system",
                "content": (
                    "Reflection gate triggered: confidence is below threshold. "
                    "Revise your answer with clearer reasoning and verification."
                ),
            })
            return ctx

        result = TurnResult(
            turn_number=turn_number,
            llm_response=llm_response,
            done=True,
            stop_reason="completed",
            cost_usd=llm_response.cost_usd,
            cumulative_cost_usd=self.state.cumulative_cost,
            model_used=llm_response.model,
            execution_mode="sequential",
            plan_artifact=plan_artifact,
            reflection=reflection,
        )
        ctx.session_state["results"].append(result)
        self.state.done = True
        return ctx


async def _run_graph_phase1_fixture(harness: AgentHarness, user_input: str) -> list[TurnResult]:
    state = _ParityState(user_input=user_input)
    ctx = GraphContext(messages=[{"role": "user", "content": user_input}], session_state={"results": []})
    runtime = GraphRuntime(nodes=[
        _SetupNode(harness, state),
        _LlmNode(harness),
        _FinalizeNode(harness, state),
    ])
    for _ in range(harness.config.max_turns):
        ctx = await runtime.run(ctx)
        if state.done:
            break
    return ctx.session_state["results"]


@pytest.mark.asyncio
async def test_phase1_parity_simple_finalize_matches_harness() -> None:
    harness = AgentHarness(
        config=HarnessConfig(max_turns=2, enable_reflection_stage=False),
        llm_router=_router_with_provider(_SingleShotProvider()),
    )
    baseline = await harness.run("simple parity")
    graph_results = await _run_graph_phase1_fixture(harness, "simple parity")

    assert_turn_results_valid(graph_results, max_turns=harness.config.max_turns)
    assert len(graph_results) == len(baseline)
    assert graph_results[-1].done == baseline[-1].done
    assert graph_results[-1].stop_reason == baseline[-1].stop_reason
    assert graph_results[-1].llm_response is not None
    assert baseline[-1].llm_response is not None
    assert graph_results[-1].llm_response.content == baseline[-1].llm_response.content


@pytest.mark.asyncio
async def test_phase1_parity_budget_stop_matches_harness() -> None:
    harness = AgentHarness(
        config=HarnessConfig(max_turns=2),
        llm_router=_router_with_provider(_SingleShotProvider()),
    )
    harness.governance.policy.budget_limit_usd = 0.0

    baseline = await harness.run("budget parity")
    graph_results = await _run_graph_phase1_fixture(harness, "budget parity")

    assert_turn_results_valid(graph_results, max_turns=harness.config.max_turns)
    assert baseline[-1].stop_reason == "budget"
    assert graph_results[-1].stop_reason == "budget"
    assert baseline[-1].done is True and graph_results[-1].done is True


@pytest.mark.asyncio
async def test_phase1_parity_reflection_retry_sequence_matches_harness() -> None:
    harness = AgentHarness(
        config=HarnessConfig(
            max_turns=3,
            enable_reflection_stage=True,
            reflection_gate_on_finalize=True,
            reflection_min_confidence=1.1,
            max_reflection_attempts=1,
        ),
        llm_router=_router_with_provider(_ReflectionProvider()),
    )
    baseline = await harness.run("reflection parity")
    graph_results = await _run_graph_phase1_fixture(harness, "reflection parity")

    assert_turn_results_valid(graph_results, max_turns=harness.config.max_turns)
    assert [r.stop_reason for r in graph_results] == [r.stop_reason for r in baseline]
    assert graph_results[0].stop_reason == "reflection_retry"
    assert graph_results[-1].stop_reason == "completed"
