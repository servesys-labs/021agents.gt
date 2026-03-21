"""Evaluation gym for benchmarking agent performance."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

from agentos.eval.grader import GradeResult, Grader


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
    trial_results: list[TrialResult] = field(default_factory=list)

    @property
    def pass_rate(self) -> float:
        return self.pass_count / self.total_trials if self.total_trials else 0.0


AgentFn = Callable[[str], Coroutine[Any, Any, str]]


class EvalGym:
    """Standardized environment for benchmarking agent performance.

    Runs multiple trials per task to account for LLM non-determinism.
    Produces aggregate reports with pass rate, latency, and cost metrics.
    """

    def __init__(self, trials_per_task: int = 5) -> None:
        self.trials_per_task = trials_per_task
        self._tasks: list[EvalTask] = []

    def add_task(self, task: EvalTask) -> None:
        self._tasks.append(task)

    def add_tasks(self, tasks: list[EvalTask]) -> None:
        self._tasks.extend(tasks)

    async def run(self, agent_fn: AgentFn) -> EvalReport:
        """Run all tasks through the agent and produce a report."""
        results: list[TrialResult] = []

        for task in self._tasks:
            for trial in range(1, self.trials_per_task + 1):
                start = time.monotonic()
                output = await agent_fn(task.input)
                elapsed = (time.monotonic() - start) * 1000

                grade = task.grader.grade(task.expected, output)
                results.append(TrialResult(
                    task_name=task.name,
                    trial=trial,
                    grade=grade,
                    latency_ms=elapsed,
                    output=output,
                ))

        pass_count = sum(1 for r in results if r.grade.passed)
        scores = [r.grade.score for r in results]
        latencies = [r.latency_ms for r in results]

        return EvalReport(
            total_tasks=len(self._tasks),
            total_trials=len(results),
            pass_count=pass_count,
            fail_count=len(results) - pass_count,
            avg_score=sum(scores) / len(scores) if scores else 0.0,
            avg_latency_ms=sum(latencies) / len(latencies) if latencies else 0.0,
            trial_results=results,
        )
