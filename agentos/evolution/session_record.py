"""Structured session capture — the 'Every Eval Ever' schema for agents.

Captures the four dimensions from the EEE agentic extensions:
  [1] System Composition — model, tools, MCP servers, memory config
  [2] Session Semantics  — status, stop_reason, error_attribution
  [3] Interaction Accounting — steps, actions, latency, cost (agent + benchmark)
  [4] Eval Conditions — internet, memory exposure, reset policy, seed
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class StopReason(str, Enum):
    """Why did the agent session end?

    Distinguishes agent-initiated vs benchmark/infrastructure stops
    (slide: "stop_reason: agent vs benchmark").
    """
    # Agent-initiated stops
    COMPLETED = "completed"           # Agent decided it was done (no more tool calls)
    USER_CANCELLED = "user_cancelled" # User interrupted

    # Infrastructure / benchmark stops
    MAX_TURNS = "max_turns"           # Hit the turn limit
    BUDGET_EXHAUSTED = "budget"       # Ran out of budget
    TIMEOUT = "timeout"               # Wall-clock timeout
    LLM_ERROR = "llm_error"          # LLM call failed
    GOVERNANCE_BLOCK = "governance"   # Blocked by governance policy
    BENCHMARK_TIMEOUT = "benchmark_timeout"  # Eval gym trial timeout (not agent's own)
    BENCHMARK_ERROR = "benchmark_error"      # Eval infrastructure failure

    @property
    def initiated_by(self) -> str:
        """Who caused the stop — 'agent', 'benchmark', or 'infrastructure'."""
        if self in (StopReason.COMPLETED, StopReason.USER_CANCELLED):
            return "agent"
        if self in (StopReason.BENCHMARK_TIMEOUT, StopReason.BENCHMARK_ERROR):
            return "benchmark"
        return "infrastructure"


class ErrorSource(str, Enum):
    """Which component caused the error?"""
    LLM = "llm"
    TOOL = "tool"
    GOVERNANCE = "governance"
    MEMORY = "memory"
    TIMEOUT = "timeout"
    UNKNOWN = "unknown"


@dataclass
class CostBreakdown:
    """Per-side cost tracking."""
    llm_input_cost_usd: float = 0.0
    llm_output_cost_usd: float = 0.0
    tool_cost_usd: float = 0.0
    total_usd: float = 0.0

    def add_llm(self, input_cost: float, output_cost: float) -> None:
        self.llm_input_cost_usd += input_cost
        self.llm_output_cost_usd += output_cost
        self.total_usd += input_cost + output_cost

    def add_tool(self, cost: float) -> None:
        self.tool_cost_usd += cost
        self.total_usd += cost


@dataclass
class ErrorRecord:
    """Structured error with attribution."""
    source: ErrorSource
    message: str
    tool_name: str | None = None
    turn: int = 0
    recoverable: bool = True


@dataclass
class TurnRecord:
    """Rich record of a single agent turn."""
    turn_number: int
    model_used: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost: CostBreakdown = field(default_factory=CostBreakdown)
    latency_ms: float = 0.0
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    errors: list[ErrorRecord] = field(default_factory=list)
    llm_content: str = ""
    started_at: float = field(default_factory=time.time)
    ended_at: float = 0.0
    execution_mode: str = "sequential"
    plan_artifact: dict[str, Any] = field(default_factory=dict)
    reflection: dict[str, Any] = field(default_factory=dict)


@dataclass
class SystemComposition:
    """[1] What agent ran — full identity snapshot."""
    agent_id: str = ""  # Immutable ID — survives renames
    agent_name: str = ""
    agent_version: str = ""
    model: str = ""
    models_by_role: dict[str, str] = field(default_factory=dict)
    tools_available: list[str] = field(default_factory=list)
    mcp_servers: list[str] = field(default_factory=list)
    memory_config: dict[str, Any] = field(default_factory=dict)
    system_prompt_hash: str = ""  # Hash, not full prompt (privacy)
    governance_config: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvalConditions:
    """[4] Under what conditions did the eval run?"""
    internet_access: str = "unknown"  # true/false/restricted
    memory_exposure: str = "full"     # none/partial/full
    reset_policy: str = "fresh"       # fresh/persistent
    seed: int | None = None
    repeated_runs_count: int = 1


@dataclass
class SessionRecord:
    """The complete structured record of one agent session.

    This is the atomic unit that the Observer collects. It contains
    everything needed for post-hoc analysis, debugging, compliance,
    and continuous improvement.
    """

    # Identity
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    agent_name: str = ""
    timestamp: float = field(default_factory=time.time)

    # [1] System Composition
    composition: SystemComposition = field(default_factory=SystemComposition)

    # [2] Session Semantics
    status: str = "unknown"  # success / error / timeout
    stop_reason: StopReason = StopReason.COMPLETED
    is_finished: bool = False
    finish_accepted: bool | None = None  # Did the grader/human accept the finish?
    error_attribution: ErrorSource | None = None
    errors: list[ErrorRecord] = field(default_factory=list)

    # [3] Interaction Accounting
    step_count: int = 0
    action_count: int = 0  # Total tool calls
    time_to_first_action_ms: float = 0.0
    wall_clock_seconds: float = 0.0
    cost: CostBreakdown = field(default_factory=CostBreakdown)
    benchmark_cost: CostBreakdown = field(default_factory=CostBreakdown)  # Eval infra cost (grader LLM, etc.)

    # [4] Eval Conditions (populated when run through eval)
    eval_conditions: EvalConditions | None = None

    # Detailed turn data
    turns: list[TurnRecord] = field(default_factory=list)

    # Input/output for analysis
    input_text: str = ""
    output_text: str = ""

    # Eval result (if graded)
    eval_score: float | None = None
    eval_passed: bool | None = None
    eval_task_name: str = ""

    # Trace chain (for sub-agent audit trail)
    trace_id: str = ""
    parent_session_id: str = ""
    depth: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a flat dict for JSON export."""
        return {
            "session_id": self.session_id,
            "agent_name": self.agent_name,
            "timestamp": self.timestamp,
            "composition": {
                "agent_id": self.composition.agent_id,
                "agent_name": self.composition.agent_name,
                "agent_version": self.composition.agent_version,
                "model": self.composition.model,
                "tools_available": self.composition.tools_available,
                "mcp_servers": self.composition.mcp_servers,
                "memory_config": self.composition.memory_config,
            },
            "status": self.status,
            "stop_reason": self.stop_reason.value,
            "stop_initiated_by": self.stop_reason.initiated_by,
            "is_finished": self.is_finished,
            "finish_accepted": self.finish_accepted,
            "error_attribution": self.error_attribution.value if self.error_attribution else None,
            "errors": [
                {"source": e.source.value, "message": e.message, "tool_name": e.tool_name, "turn": e.turn}
                for e in self.errors
            ],
            "step_count": self.step_count,
            "action_count": self.action_count,
            "time_to_first_action_ms": self.time_to_first_action_ms,
            "wall_clock_seconds": self.wall_clock_seconds,
            "cost": {
                "llm_input_cost_usd": self.cost.llm_input_cost_usd,
                "llm_output_cost_usd": self.cost.llm_output_cost_usd,
                "tool_cost_usd": self.cost.tool_cost_usd,
                "total_usd": self.cost.total_usd,
            },
            "benchmark_cost": {
                "llm_input_cost_usd": self.benchmark_cost.llm_input_cost_usd,
                "llm_output_cost_usd": self.benchmark_cost.llm_output_cost_usd,
                "tool_cost_usd": self.benchmark_cost.tool_cost_usd,
                "total_usd": self.benchmark_cost.total_usd,
            },
            "input_text": self.input_text[:500],  # Truncate for storage
            "output_text": self.output_text[:500],
            "eval_score": self.eval_score,
            "eval_passed": self.eval_passed,
            "eval_task_name": self.eval_task_name,
            "trace_id": self.trace_id,
            "parent_session_id": self.parent_session_id,
            "depth": self.depth,
        }
