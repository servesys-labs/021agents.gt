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
    tool_calls_count: int = 0


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
        )
