"""Graph runtime contracts and harness parity invariants.

This module is intentionally small and dependency-light so both current harness
code and upcoming graph runtime code can share one set of behavioral contracts.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from agentos.core.harness import TurnResult


class GraphNodeKind(str, Enum):
    """Canonical node kinds for the graph runtime interface."""

    PLAN = "plan"
    CONTEXT = "context"
    LLM = "llm"
    TOOL = "tool"
    REFLECT = "reflect"
    VERIFY = "verify"
    FINALIZE = "finalize"
    JOIN = "join"
    HUMAN_GATE = "human_gate"


@dataclass(frozen=True)
class NodeExecutionContract:
    """Minimal execution contract expected from graph node executors."""

    node_id: str
    node_kind: GraphNodeKind
    allows_retry: bool = True
    emits_events: bool = True
    records_span: bool = True


@dataclass(frozen=True)
class HarnessParityInvariant:
    """A named runtime invariant used for harness-to-graph parity checks."""

    invariant_id: str
    description: str


DEFAULT_HARNESS_PARITY_INVARIANTS: tuple[HarnessParityInvariant, ...] = (
    HarnessParityInvariant(
        invariant_id="turn_numbers_strictly_increase",
        description="Turn numbers are strictly increasing and start at >= 1.",
    ),
    HarnessParityInvariant(
        invariant_id="cumulative_cost_monotonic",
        description="Cumulative cost is never negative and does not decrease.",
    ),
    HarnessParityInvariant(
        invariant_id="terminal_stop_reason_valid",
        description="Done turns always include a recognized terminal stop reason.",
    ),
    HarnessParityInvariant(
        invariant_id="non_terminal_stop_reason_valid",
        description="Non-done turns only use recognized transient stop reasons.",
    ),
    HarnessParityInvariant(
        invariant_id="respect_max_turns_bound",
        description="Result count never exceeds configured max turns.",
    ),
)


TERMINAL_STOP_REASONS = {
    "completed",
    "timeout",
    "budget",
    "llm_error",
    "loop_detected",
    "middleware_halt",
    "tool_error",
}

NON_TERMINAL_STOP_REASONS = {"", "reflection_retry"}


def validate_turn_results(results: list[TurnResult], max_turns: int) -> list[str]:
    """Return a list of invariant violations for a turn-result sequence."""

    violations: list[str] = []
    if not results:
        return ["No turn results produced."]

    if len(results) > max_turns:
        violations.append(
            f"Result length {len(results)} exceeds max_turns={max_turns}."
        )

    last_turn = 0
    last_cumulative_cost = -1.0

    for idx, result in enumerate(results, start=1):
        if result.turn_number < 1:
            violations.append(f"Turn #{idx} has invalid turn_number={result.turn_number}.")
        if result.turn_number <= last_turn:
            violations.append(
                f"Turn numbering not strictly increasing at turn_number={result.turn_number}."
            )
        last_turn = result.turn_number

        if result.cost_usd < 0:
            violations.append(
                f"Turn {result.turn_number} has negative cost_usd={result.cost_usd}."
            )
        if result.cumulative_cost_usd < 0:
            violations.append(
                f"Turn {result.turn_number} has negative cumulative_cost_usd={result.cumulative_cost_usd}."
            )
        if result.cumulative_cost_usd < last_cumulative_cost:
            violations.append(
                "Cumulative cost decreased at turn "
                f"{result.turn_number}: {result.cumulative_cost_usd} < {last_cumulative_cost}."
            )
        last_cumulative_cost = result.cumulative_cost_usd

        if result.done:
            if result.stop_reason not in TERMINAL_STOP_REASONS:
                violations.append(
                    "Done turn has invalid terminal stop_reason="
                    f"{result.stop_reason!r} at turn {result.turn_number}."
                )
        else:
            if result.stop_reason not in NON_TERMINAL_STOP_REASONS:
                violations.append(
                    "Non-terminal turn has invalid stop_reason="
                    f"{result.stop_reason!r} at turn {result.turn_number}."
                )

    return violations


def assert_turn_results_valid(results: list[TurnResult], max_turns: int) -> None:
    """Raise ValueError if parity invariants are violated."""

    violations = validate_turn_results(results=results, max_turns=max_turns)
    if violations:
        raise ValueError("Turn invariant violations:\n- " + "\n- ".join(violations))
