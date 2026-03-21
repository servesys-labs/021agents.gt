"""Evaluation gym for benchmarking agent performance."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

from agentos.eval.grader import GradeResult, Grader

logger = logging.getLogger(__name__)


@dataclass
class AgentResult:
    """Structured result from an agent run.

    Agent functions can return either a plain ``str`` (backward-compatible)
    or an ``AgentResult`` to supply cost and tool-call metadata that the
    gym will propagate into ``TrialResult``.
    """

    output: str
    cost_usd: float = 0.0
    tool_calls_count: int = 0
    model: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvalTask:
    name: str
    input: str
    expected: Any
    grader: Grader
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TrialResult:
    task_name: str
    trial: int
    grade: GradeResult
    latency_ms: float = 0.0
    cost_usd: float = 0.0
    output: str = ""
    tool_calls_count: int = 0
    error: str | None = None  # Non-None when the trial failed with an exception
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvalReport:
    """Aggregate report from an evaluation run."""

    total_tasks: int = 0
    total_trials: int = 0
    pass_count: int = 0
    fail_count: int = 0
    avg_score: float = 0.0
    avg_latency_ms: float = 0.0
    total_cost_usd: float = 0.0
    avg_tool_calls: float = 0.0
    trial_results: list[TrialResult] = field(default_factory=list)

    # Agent identity (populated by caller for structured reporting)
    agent_name: str = ""
    agent_version: str = ""
    model: str = ""
    tools_available: list[str] = field(default_factory=list)

    # Error tracking
    error_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Serialize for JSON export."""
        return {
            "agent_name": self.agent_name,
            "agent_version": self.agent_version,
            "model": self.model,
            "total_tasks": self.total_tasks,
            "total_trials": self.total_trials,
            "pass_rate": self.pass_rate,
            "pass_count": self.pass_count,
            "fail_count": self.fail_count,
            "error_count": self.error_count,
            "avg_score": self.avg_score,
            "avg_latency_ms": self.avg_latency_ms,
            "total_cost_usd": self.total_cost_usd,
            "avg_tool_calls": self.avg_tool_calls,
            "tool_efficiency": self.tool_efficiency,
            "pass_at_1": self.pass_at_k(1),
            "pass_at_3": self.pass_at_k(3) if self.total_trials >= 3 else None,
            "tools_available": self.tools_available,
        }

    @property
    def pass_rate(self) -> float:
        return self.pass_count / self.total_trials if self.total_trials else 0.0

    def pass_at_k(self, k: int | None = None) -> float:
        """Compute pass@k: probability that at least one of k trials passes.

        Groups trials by task. For each task, calculates the probability that
        at least 1 of k random samples passes, then averages across tasks.
        If k is None, uses all available trials per task.
        """
        if not self.trial_results:
            return 0.0

        # Group trials by task
        task_trials: dict[str, list[TrialResult]] = {}
        for tr in self.trial_results:
            task_trials.setdefault(tr.task_name, []).append(tr)

        task_scores: list[float] = []
        for trials in task_trials.values():
            n = len(trials)
            c = sum(1 for t in trials if t.grade.passed)
            effective_k = min(k or n, n)
            if effective_k == 0:
                task_scores.append(0.0)
                continue
            # pass@k = 1 - C(n-c, k) / C(n, k)
            if c == 0:
                task_scores.append(0.0)
            elif n - c < effective_k:
                # Not enough failures to fill k samples — guaranteed pass
                task_scores.append(1.0)
            else:
                # P(all k fail) = C(n-c, k) / C(n, k)
                p_all_fail = 1.0
                for i in range(effective_k):
                    p_all_fail *= (n - c - i) / (n - i)
                task_scores.append(1.0 - p_all_fail)

        return sum(task_scores) / len(task_scores) if task_scores else 0.0

    @property
    def tool_efficiency(self) -> float:
        """Tool efficiency: ratio of successful trials to total tool calls.

        Higher is better — fewer tool calls needed per success.
        Returns 1.0 if no tool calls were made.
        """
        total_calls = sum(t.tool_calls_count for t in self.trial_results)
        if total_calls == 0:
            return 1.0
        return self.pass_count / total_calls


# Agent functions can return str (backward-compatible) or AgentResult.
AgentFn = Callable[[str], Coroutine[Any, Any, str | AgentResult]]


def _unpack_agent_output(raw: str | AgentResult) -> AgentResult:
    """Normalize an agent function's return value to AgentResult."""
    if isinstance(raw, AgentResult):
        return raw
    return AgentResult(output=str(raw))


class EvalGym:
    """Standardized environment for benchmarking agent performance.

    Runs multiple trials per task to account for LLM non-determinism.
    Produces aggregate reports with pass rate, latency, and cost metrics.

    Features:
    - Per-trial timeout (``trial_timeout_seconds``)
    - Graceful error handling (exceptions → error trials, not crashes)
    - Parallel execution (``max_concurrency`` > 1)
    - Cost and tool-call tracking via ``AgentResult``
    """

    def __init__(
        self,
        trials_per_task: int = 5,
        trial_timeout_seconds: float | None = None,
        max_concurrency: int = 1,
    ) -> None:
        self.trials_per_task = trials_per_task
        self.trial_timeout_seconds = trial_timeout_seconds
        self.max_concurrency = max(1, max_concurrency)
        self._tasks: list[EvalTask] = []

    def add_task(self, task: EvalTask) -> None:
        self._tasks.append(task)

    def add_tasks(self, tasks: list[EvalTask]) -> None:
        self._tasks.extend(tasks)

    async def _run_single_trial(
        self,
        task: EvalTask,
        trial: int,
        agent_fn: AgentFn,
    ) -> TrialResult:
        """Execute a single trial with timeout and error handling."""
        start = time.monotonic()
        try:
            coro = agent_fn(task.input)
            if self.trial_timeout_seconds:
                raw = await asyncio.wait_for(coro, timeout=self.trial_timeout_seconds)
            else:
                raw = await coro
            elapsed = (time.monotonic() - start) * 1000

            result = _unpack_agent_output(raw)
            grade = task.grader.grade(task.expected, result.output)
            return TrialResult(
                task_name=task.name,
                trial=trial,
                grade=grade,
                latency_ms=elapsed,
                cost_usd=result.cost_usd,
                output=result.output,
                tool_calls_count=result.tool_calls_count,
                metadata=result.metadata,
            )
        except asyncio.TimeoutError:
            elapsed = (time.monotonic() - start) * 1000
            logger.warning(
                "Trial %d of task '%s' timed out after %.1fs",
                trial, task.name, self.trial_timeout_seconds,
            )
            return TrialResult(
                task_name=task.name,
                trial=trial,
                grade=GradeResult(score=0.0, passed=False, details={"error": "timeout"}),
                latency_ms=elapsed,
                error=f"Timed out after {self.trial_timeout_seconds:.0f}s",
            )
        except Exception as exc:
            elapsed = (time.monotonic() - start) * 1000
            logger.warning(
                "Trial %d of task '%s' failed: %s", trial, task.name, exc,
            )
            return TrialResult(
                task_name=task.name,
                trial=trial,
                grade=GradeResult(score=0.0, passed=False, details={"error": str(exc)}),
                latency_ms=elapsed,
                error=str(exc),
            )

    async def run(self, agent_fn: AgentFn) -> EvalReport:
        """Run all tasks through the agent and produce a report.

        Supports parallel execution when ``max_concurrency > 1``.
        Handles exceptions and timeouts gracefully per trial.
        """
        # Build list of (task, trial_number) pairs
        work: list[tuple[EvalTask, int]] = [
            (task, trial)
            for task in self._tasks
            for trial in range(1, self.trials_per_task + 1)
        ]

        if self.max_concurrency <= 1:
            # Sequential — simple and deterministic
            results = [
                await self._run_single_trial(task, trial, agent_fn)
                for task, trial in work
            ]
        else:
            # Parallel with bounded concurrency
            semaphore = asyncio.Semaphore(self.max_concurrency)

            async def bounded(task: EvalTask, trial: int) -> TrialResult:
                async with semaphore:
                    return await self._run_single_trial(task, trial, agent_fn)

            results = await asyncio.gather(
                *(bounded(task, trial) for task, trial in work)
            )
            results = list(results)

        pass_count = sum(1 for r in results if r.grade.passed)
        error_count = sum(1 for r in results if r.error is not None)
        scores = [r.grade.score for r in results]
        latencies = [r.latency_ms for r in results]
        tool_counts = [r.tool_calls_count for r in results]
        costs = [r.cost_usd for r in results]

        return EvalReport(
            total_tasks=len(self._tasks),
            total_trials=len(results),
            pass_count=pass_count,
            fail_count=len(results) - pass_count,
            avg_score=sum(scores) / len(scores) if scores else 0.0,
            avg_latency_ms=sum(latencies) / len(latencies) if latencies else 0.0,
            total_cost_usd=sum(costs),
            avg_tool_calls=sum(tool_counts) / len(tool_counts) if tool_counts else 0.0,
            trial_results=results,
            error_count=error_count,
        )
