"""Karpathy-style auto-research loop for continuous self-improvement."""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, field
from typing import Any

from agentos.eval.gym import AgentFn, EvalGym, EvalReport

logger = logging.getLogger(__name__)


@dataclass
class Hypothesis:
    description: str
    modification: dict[str, Any]
    iteration: int = 0


@dataclass
class ExperimentResult:
    hypothesis: Hypothesis
    baseline_report: EvalReport
    experiment_report: EvalReport
    accepted: bool = False
    improvement: float = 0.0


class AutoResearchLoop:
    """Autonomous self-improvement loop.

    Cycle:
    1. Hypothesize — propose a modification based on past performance
    2. Experiment — apply modification in a sandbox
    3. Evaluate — run the Eval Gym
    4. Select — keep if primary metric improves, discard otherwise
    5. Iterate
    """

    def __init__(
        self,
        gym: EvalGym,
        primary_metric: str = "pass_rate",
        max_iterations: int = 10,
    ) -> None:
        self.gym = gym
        self.primary_metric = primary_metric
        self.max_iterations = max_iterations
        self._history: list[ExperimentResult] = []
        self._current_config: dict[str, Any] = {}

    @property
    def config(self) -> dict[str, Any]:
        return copy.deepcopy(self._current_config)

    @property
    def history(self) -> list[ExperimentResult]:
        return list(self._history)

    def _get_metric(self, report: EvalReport) -> float:
        return getattr(report, self.primary_metric, report.pass_rate)

    async def run(
        self,
        baseline_agent_fn: AgentFn,
        hypotheses: list[Hypothesis],
    ) -> dict[str, Any]:
        """Run the auto-research loop over a list of hypotheses."""
        # Establish baseline
        baseline_report = await self.gym.run(baseline_agent_fn)
        baseline_score = self._get_metric(baseline_report)
        best_score = baseline_score

        logger.info("Baseline %s: %.3f", self.primary_metric, baseline_score)

        for i, hypothesis in enumerate(hypotheses[: self.max_iterations]):
            hypothesis.iteration = i + 1
            logger.info("Iteration %d: %s", i + 1, hypothesis.description)

            # In a real system, the hypothesis.modification would alter the
            # agent's config/prompt. Here we re-evaluate with the same agent.
            experiment_report = await self.gym.run(baseline_agent_fn)
            experiment_score = self._get_metric(experiment_report)
            improvement = experiment_score - best_score

            accepted = improvement > 0
            result = ExperimentResult(
                hypothesis=hypothesis,
                baseline_report=baseline_report,
                experiment_report=experiment_report,
                accepted=accepted,
                improvement=improvement,
            )
            self._history.append(result)

            if accepted:
                best_score = experiment_score
                self._current_config.update(hypothesis.modification)
                logger.info("Accepted: +%.3f → %.3f", improvement, best_score)
            else:
                logger.info("Rejected: %.3f (no improvement)", experiment_score)

        return {
            "baseline_score": baseline_score,
            "best_score": best_score,
            "iterations": len(self._history),
            "accepted": sum(1 for r in self._history if r.accepted),
            "config": self.config,
        }
