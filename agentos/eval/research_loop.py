"""Auto-research loop for continuous self-improvement.

Integrates with the Evolution subsystem to:
  1. Run baseline eval
  2. Analyze failures via FailureAnalyzer
  3. Generate improvement proposals
  4. Apply modifications (sandbox) and re-evaluate
  5. Accept improvements, reject regressions
  6. Track everything in the EvolutionLedger

The key difference from the old stub: modifications are ACTUALLY APPLIED
to the agent config before re-evaluation. Each iteration produces a
real A/B comparison.

For fully autonomous, LLM-driven agent research (no pre-defined hypotheses),
use ``AutoResearchLoop.autonomous()`` which delegates to the autoresearch
subsystem's ``AgentResearchLoop``.
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

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


# A factory that takes a config dict and returns an agent function.
# This is how the loop creates modified agents for experimentation.
AgentFactory = Callable[[dict[str, Any]], AgentFn]


class AutoResearchLoop:
    """Autonomous self-improvement loop.

    Cycle:
    1. Hypothesize — propose a modification based on past performance
    2. Experiment — apply modification and create a new agent function
    3. Evaluate — run the Eval Gym on the modified agent
    4. Select — keep if primary metric improves, discard otherwise
    5. Iterate

    Unlike the previous stub, this actually applies modifications to
    the agent config and creates new agent functions for each experiment.

    For fully autonomous operation (LLM generates hypotheses), use the
    ``autonomous()`` classmethod which creates an ``AgentResearchLoop``.
    """

    @classmethod
    def autonomous(
        cls,
        agent,
        eval_tasks: list[dict],
        *,
        max_iterations: int = 20,
        model: str = "claude-sonnet-4-6-20250627",
        **kwargs,
    ):
        """Create a fully autonomous research loop for an agent.

        Instead of pre-defined hypotheses, an LLM proposes modifications
        based on eval results — the autoresearch pattern applied to agents.

        Args:
            agent: Agent instance to evolve.
            eval_tasks: List of eval task dicts (name, input, expected, grader).
            max_iterations: Max experiments to run.
            model: LLM model for hypothesis generation.
            **kwargs: Passed to AgentResearchLoop.

        Returns:
            An ``AgentResearchLoop`` instance (call ``.run()`` to start).
        """
        from agentos.autoresearch.agent_research import AgentResearchLoop

        return AgentResearchLoop(
            agent=agent,
            eval_tasks=eval_tasks,
            max_iterations=max_iterations,
            model=model,
            **kwargs,
        )

    def __init__(
        self,
        gym: EvalGym,
        primary_metric: str = "pass_rate",
        max_iterations: int = 10,
        improvement_threshold: float = 0.0,
    ) -> None:
        self.gym = gym
        self.primary_metric = primary_metric
        self.max_iterations = max_iterations
        self.improvement_threshold = improvement_threshold
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
        agent_factory: AgentFactory | None = None,
        base_config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run the auto-research loop over a list of hypotheses.

        Args:
            baseline_agent_fn: The current agent function (for baseline eval).
            hypotheses: List of hypotheses to test.
            agent_factory: Optional factory that takes a modified config dict
                and returns a new AgentFn. If provided, modifications are
                actually applied. If None, falls back to re-running baseline
                (legacy behavior for compatibility).
            base_config: The current agent config dict. Required if agent_factory
                is provided.
        """
        self._current_config = copy.deepcopy(base_config or {})

        # Establish baseline
        baseline_report = await self.gym.run(baseline_agent_fn)
        baseline_score = self._get_metric(baseline_report)
        best_score = baseline_score
        best_agent_fn = baseline_agent_fn

        logger.info("Baseline %s: %.3f", self.primary_metric, baseline_score)

        for i, hypothesis in enumerate(hypotheses[: self.max_iterations]):
            hypothesis.iteration = i + 1
            logger.info("Iteration %d: %s", i + 1, hypothesis.description)

            # Create modified agent if factory is available
            if agent_factory and self._current_config:
                # Apply the hypothesis modification to config
                experiment_config = copy.deepcopy(self._current_config)
                for key, value in hypothesis.modification.items():
                    if isinstance(value, dict) and isinstance(experiment_config.get(key), dict):
                        experiment_config[key].update(value)
                    else:
                        experiment_config[key] = value

                # Create a new agent function from modified config
                experiment_agent_fn = agent_factory(experiment_config)
            else:
                # Fallback: run baseline again (for backwards compatibility)
                experiment_agent_fn = baseline_agent_fn

            experiment_report = await self.gym.run(experiment_agent_fn)
            experiment_score = self._get_metric(experiment_report)
            improvement = experiment_score - best_score

            accepted = improvement > self.improvement_threshold
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
                best_agent_fn = experiment_agent_fn
                self._current_config.update(hypothesis.modification)
                # Update baseline for next iteration (compare against best known)
                baseline_report = experiment_report
                logger.info("Accepted: +%.3f → %.3f", improvement, best_score)
            else:
                logger.info("Rejected: %.3f (no improvement over %.3f)", experiment_score, best_score)

        return {
            "baseline_score": self._get_metric(await self.gym.run(baseline_agent_fn)) if not self._history else self._history[0].baseline_report.pass_rate,
            "best_score": best_score,
            "iterations": len(self._history),
            "accepted": sum(1 for r in self._history if r.accepted),
            "rejected": sum(1 for r in self._history if not r.accepted),
            "config": self.config,
            "history": [
                {
                    "iteration": r.hypothesis.iteration,
                    "description": r.hypothesis.description,
                    "accepted": r.accepted,
                    "improvement": r.improvement,
                    "score": self._get_metric(r.experiment_report),
                }
                for r in self._history
            ],
        }
