from __future__ import annotations

import pytest

from agentos.core.graph_contract import (
    DEFAULT_HARNESS_PARITY_INVARIANTS,
    TERMINAL_STOP_REASONS,
    assert_turn_results_valid,
    validate_turn_results,
)
from agentos.core.harness import AgentHarness, HarnessConfig, TurnResult
from agentos.llm.provider import LLMResponse
from agentos.llm.router import Complexity, LLMRouter


class _SingleShotProvider:
    @property
    def model_id(self) -> str:
        return "test-single-shot"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="All done.",
            model=self.model_id,
            usage={"input_tokens": 10, "output_tokens": 5},
            cost_usd=0.001,
        )


class _ReflectionRetryProvider:
    @property
    def model_id(self) -> str:
        return "test-reflection-retry"

    async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
        return LLMResponse(
            content="Draft answer.",
            model=self.model_id,
            usage={"input_tokens": 10, "output_tokens": 5},
            cost_usd=0.001,
        )


def _router_with_provider(provider) -> LLMRouter:
    router = LLMRouter()
    for tier in Complexity:
        router.register(tier, provider)
    return router


@pytest.mark.asyncio
async def test_harness_results_satisfy_graph_contract_for_completed_run() -> None:
    harness = AgentHarness(
        config=HarnessConfig(max_turns=2),
        llm_router=_router_with_provider(_SingleShotProvider()),
    )
    results = await harness.run("say hello")

    # Week-1 migration guard: current harness behavior must satisfy shared invariants.
    assert_turn_results_valid(results, max_turns=harness.config.max_turns)
    assert results[-1].done is True
    assert results[-1].stop_reason in TERMINAL_STOP_REASONS


@pytest.mark.asyncio
async def test_harness_results_allow_reflection_retry_as_non_terminal() -> None:
    harness = AgentHarness(
        config=HarnessConfig(
            max_turns=3,
            enable_reflection_stage=True,
            reflection_gate_on_finalize=True,
            reflection_min_confidence=1.1,
            max_reflection_attempts=1,
        ),
        llm_router=_router_with_provider(_ReflectionRetryProvider()),
    )

    results = await harness.run("answer with confidence")
    assert results[0].stop_reason == "reflection_retry"
    assert results[0].done is False
    assert_turn_results_valid(results, max_turns=harness.config.max_turns)


def test_validate_turn_results_catches_negative_cost_and_bad_stop_reason() -> None:
    bad_results = [
        TurnResult(
            turn_number=1,
            done=False,
            stop_reason="bad_non_terminal_reason",
            cost_usd=-0.5,
            cumulative_cost_usd=-0.5,
        ),
    ]

    violations = validate_turn_results(bad_results, max_turns=5)
    assert any("negative cost_usd" in item for item in violations)
    assert any("invalid stop_reason" in item for item in violations)


def test_default_invariants_are_named_and_stable() -> None:
    invariant_ids = [item.invariant_id for item in DEFAULT_HARNESS_PARITY_INVARIANTS]
    assert invariant_ids == [
        "turn_numbers_strictly_increase",
        "cumulative_cost_monotonic",
        "terminal_stop_reason_valid",
        "non_terminal_stop_reason_valid",
        "respect_max_turns_bound",
        "budget_stop_is_terminal",
        "reflection_retry_has_reflection_signal",
        "tool_error_requires_tool_failure_signal",
    ]


def test_validate_turn_results_flags_budget_non_terminal() -> None:
    bad_results = [
        TurnResult(
            turn_number=1,
            done=False,
            stop_reason="budget",
            cost_usd=0.1,
            cumulative_cost_usd=0.1,
        ),
    ]
    violations = validate_turn_results(bad_results, max_turns=3)
    assert any("Budget stop must be terminal" in item for item in violations)


def test_validate_turn_results_flags_reflection_retry_without_metadata() -> None:
    bad_results = [
        TurnResult(
            turn_number=1,
            done=False,
            stop_reason="reflection_retry",
            cost_usd=0.1,
            cumulative_cost_usd=0.1,
            reflection={},
        ),
    ]
    violations = validate_turn_results(bad_results, max_turns=3)
    assert any("missing reflection metadata" in item for item in violations)
