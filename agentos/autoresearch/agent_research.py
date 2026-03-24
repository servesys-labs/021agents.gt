"""Agent-level autoresearch — continuous evolution of agents via the
autoresearch pattern.

Instead of editing train.py and measuring val_bpb, this module:
  - Edits **agent configs** (system_prompt, tools, model, temperature, etc.)
  - Evaluates via **EvalGym** (pass_rate, cost, latency)
  - Keeps improvements, discards regressions
  - Logs to a TSV results file
  - Uses git to track config changes (commit on keep, reset on discard)
  - Runs autonomously — no human in the loop

This bridges the standalone autoresearch driver to the AgentOS evolution
system, giving agents the ability to self-improve continuously.

Usage:
    loop = AgentResearchLoop(agent, eval_tasks, model="claude-sonnet-4-6-20250627")
    summary = await loop.run()

Or via CLI:
    agentos autoresearch agent my-agent eval_tasks.json --max-iterations 20
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine

from agentos.autoresearch.results import (
    ExperimentRecord,
    ExperimentStatus,
    ResultsLog,
)

logger = logging.getLogger(__name__)


@dataclass
class AgentExperiment:
    """One experiment in the agent research loop."""

    iteration: int
    description: str
    hypothesis: str
    modification: dict[str, Any]
    metrics_before: dict[str, float]
    metrics_after: dict[str, float]
    status: ExperimentStatus
    config_snapshot: dict[str, Any] = field(default_factory=dict)

    @property
    def primary_improvement(self) -> float:
        """Improvement in pass_rate (the primary agent metric)."""
        return self.metrics_after.get("pass_rate", 0) - self.metrics_before.get("pass_rate", 0)


class AgentResearchLoop:
    """Autonomous self-improvement loop for agents.

    This is the autoresearch pattern applied to agent evolution:
    1. LLM proposes a modification to the agent config
    2. Modified config is evaluated via EvalGym
    3. If primary metric improves → keep, else → discard
    4. Log result to TSV and repeat

    Unlike EvolutionLoop (which requires human approval), this runs
    fully autonomously — the LLM is both the proposer and the decision
    maker, constrained only by the eval metric.
    """

    def __init__(
        self,
        agent: Any,  # Agent instance
        eval_tasks: list[dict[str, Any]],
        *,
        primary_metric: str = "pass_rate",
        higher_is_better: bool = True,
        max_iterations: int = 0,
        improvement_threshold: float = 0.0,
        trials_per_task: int = 3,
        model: str = "claude-sonnet-4-6-20250627",
        provider: str = "anthropic",
        temperature: float = 0.7,
        results_path: Path | None = None,
        on_experiment: Callable[[AgentExperiment], None] | None = None,
        # What aspects of the config the LLM may modify
        mutable_fields: list[str] | None = None,
        # Database for observability (optional — if provided, all experiments are persisted)
        db: Any | None = None,
        org_id: str = "",
    ) -> None:
        self.agent = agent
        self.eval_tasks = eval_tasks
        self.primary_metric = primary_metric
        self.higher_is_better = higher_is_better
        self.max_iterations = max_iterations
        self.improvement_threshold = improvement_threshold
        self.trials_per_task = trials_per_task
        self.model = model
        self.provider = provider
        self.temperature = temperature
        self.on_experiment = on_experiment

        self.mutable_fields = mutable_fields or [
            "system_prompt",
            "temperature",
            "max_tokens",
            "tools",
            "model",
            "personality",
            "governance",
        ]

        # Results tracking
        data_dir = Path("data") / "autoresearch" / agent.config.name
        self.results = ResultsLog(results_path or data_dir / "results.tsv")

        # Database observability (optional)
        self._db = db
        self._org_id = org_id
        import secrets
        self._run_id = secrets.token_hex(12)

        # State
        self._history: list[AgentExperiment] = []
        self._best_config: dict[str, Any] = agent.config.to_dict()
        self._best_score: float | None = None
        self._iteration = 0
        self._stopped = False

    @property
    def should_continue(self) -> bool:
        if self._stopped:
            return False
        if self.max_iterations > 0 and self._iteration >= self.max_iterations:
            return False
        return True

    def stop(self) -> None:
        self._stopped = True

    async def run(self) -> dict[str, Any]:
        """Run the full autonomous agent research loop."""
        start_time = time.monotonic()

        logger.info(
            "Agent autoresearch starting for '%s' (metric=%s, max=%s)",
            self.agent.config.name,
            self.primary_metric,
            self.max_iterations or "unlimited",
        )

        # Persist run start to DB
        self._db_insert_run("running")

        # Step 1: Establish baseline
        baseline_metrics = await self._evaluate(self.agent.config.to_dict())
        self._best_score = baseline_metrics.get(self.primary_metric, 0.0)
        logger.info("Baseline %s: %.3f", self.primary_metric, self._best_score)

        self.results.append(ExperimentRecord(
            commit="base",
            val_bpb=self._best_score,  # repurposing val_bpb field for primary metric
            memory_gb=baseline_metrics.get("total_cost_usd", 0.0),
            status=ExperimentStatus.KEEP,
            description=f"baseline ({self.primary_metric}={self._best_score:.3f})",
        ))

        # Step 2: Loop — hypothesize → modify → evaluate → keep/discard
        while self.should_continue:
            try:
                experiment = await self.step()
                if experiment:
                    logger.info(
                        "Experiment %d: %s → %s (delta=%+.3f)",
                        experiment.iteration,
                        experiment.description,
                        experiment.status.value,
                        experiment.primary_improvement,
                    )
            except Exception as exc:
                logger.error("Error in iteration %d: %s", self._iteration, exc)
                self._iteration += 1

        elapsed = time.monotonic() - start_time

        # Persist run completion to DB
        self._db_update_run(elapsed)

        return {
            "agent": self.agent.config.name,
            "iterations": self._iteration,
            "elapsed_seconds": elapsed,
            "baseline_score": baseline_metrics.get(self.primary_metric, 0),
            "best_score": self._best_score,
            "improvements_kept": sum(1 for e in self._history if e.status == ExperimentStatus.KEEP),
            "experiments_discarded": sum(1 for e in self._history if e.status == ExperimentStatus.DISCARD),
            "primary_metric": self.primary_metric,
            "best_config": self._best_config,
            "history": [
                {
                    "iteration": e.iteration,
                    "description": e.description,
                    "status": e.status.value,
                    "improvement": e.primary_improvement,
                    "score": e.metrics_after.get(self.primary_metric, 0),
                }
                for e in self._history
            ],
        }

    async def step(self) -> AgentExperiment | None:
        """Run one experiment iteration."""
        self._iteration += 1

        # 1. Ask LLM to propose a modification
        modification, description, hypothesis = await self._propose()

        if not modification:
            logger.info("No modification proposed, skipping iteration %d", self._iteration)
            return None

        # 2. Create modified config
        experiment_config = copy.deepcopy(self._best_config)
        for key, value in modification.items():
            if key in self.mutable_fields:
                if isinstance(value, dict) and isinstance(experiment_config.get(key), dict):
                    experiment_config[key].update(value)
                else:
                    experiment_config[key] = value

        # 3. Evaluate modified config
        metrics_before = {self.primary_metric: self._best_score or 0.0}
        metrics_after = await self._evaluate(experiment_config)
        new_score = metrics_after.get(self.primary_metric, 0.0)

        # 4. Decide: keep or discard
        if self.higher_is_better:
            improved = new_score > (self._best_score or 0.0) + self.improvement_threshold
        else:
            improved = new_score < (self._best_score or float("inf")) - self.improvement_threshold

        status = ExperimentStatus.KEEP if improved else ExperimentStatus.DISCARD

        experiment = AgentExperiment(
            iteration=self._iteration,
            description=description,
            hypothesis=hypothesis,
            modification=modification,
            metrics_before=metrics_before,
            metrics_after=metrics_after,
            status=status,
            config_snapshot=experiment_config if improved else {},
        )
        self._history.append(experiment)

        # 5. Update best if improved
        if improved:
            self._best_score = new_score
            self._best_config = experiment_config
            logger.info("KEEP: %s=%.3f (+%.3f) — %s",
                        self.primary_metric, new_score, experiment.primary_improvement, description)
        else:
            logger.info("DISCARD: %s=%.3f (no improvement over %.3f) — %s",
                        self.primary_metric, new_score, self._best_score or 0, description)

        # 6. Log to TSV
        self.results.append(ExperimentRecord(
            commit=f"iter{self._iteration:03d}",
            val_bpb=new_score,
            memory_gb=metrics_after.get("total_cost_usd", 0.0),
            status=status,
            description=description,
        ))

        # 7. Persist experiment to DB
        self._db_insert_experiment(experiment, modification)

        if self.on_experiment:
            self.on_experiment(experiment)

        return experiment

    async def _evaluate(self, config: dict[str, Any]) -> dict[str, float]:
        """Evaluate an agent config using EvalGym."""
        from agentos.agent import Agent, AgentConfig
        from agentos.eval.gym import EvalGym, EvalTask
        from agentos.eval.grader import ExactMatchGrader, ContainsGrader, LLMGrader

        # Build eval tasks
        grader_map = {
            "exact": ExactMatchGrader,
            "contains": ContainsGrader,
            "llm": LLMGrader,
        }

        tasks = []
        for t in self.eval_tasks:
            grader_cls = grader_map.get(t.get("grader", "contains"), ContainsGrader)
            tasks.append(EvalTask(
                name=t.get("name", "task"),
                input=t["input"],
                expected=t["expected"],
                grader=grader_cls(),
            ))

        gym = EvalGym(trials_per_task=self.trials_per_task)
        gym.add_tasks(tasks)

        # Create a temporary agent with the experiment config
        agent_config = AgentConfig.from_dict(config)

        # Build agent function — Agent.run() returns list[TurnResult], extract content
        async def agent_fn(prompt: str) -> str:
            try:
                temp_agent = Agent(agent_config)
                results = await temp_agent.run(prompt)
                for r in reversed(results):
                    if r.llm_response and r.llm_response.content:
                        return r.llm_response.content
                return ""
            except Exception as exc:
                return f"Error: {exc}"

        report = await gym.run(agent_fn)

        return {
            "pass_rate": report.pass_rate,
            "avg_score": report.avg_score,
            "avg_latency_ms": report.avg_latency_ms,
            "total_cost_usd": report.total_cost_usd,
            "tool_efficiency": getattr(report, "tool_efficiency", 0.0),
        }

    def _get_provider(self):
        """Resolve the LLM provider from config."""
        from agentos.llm.provider import HttpProvider
        import os

        if self.provider == "anthropic":
            api_key = os.environ.get("ANTHROPIC_API_KEY", "")
            return HttpProvider(
                model_id=self.model,
                api_base="https://api.anthropic.com",
                api_key=api_key,
                headers={"anthropic-version": "2023-06-01"},
            )
        else:
            api_key = os.environ.get("GMI_API_KEY", "") or os.environ.get("OPENAI_API_KEY", "")
            api_base = os.environ.get("GMI_API_BASE", "https://api.gmi-serving.com/v1")
            return HttpProvider(model_id=self.model, api_base=api_base, api_key=api_key)

    async def _propose(self) -> tuple[dict[str, Any], str, str]:
        """Ask the LLM to propose a modification to the agent config.

        Returns (modification_dict, description, hypothesis).
        """
        system = _agent_research_system_prompt(self.mutable_fields)

        user_msg = _build_agent_proposal_prompt(
            config=self._best_config,
            history=self._history,
            best_score=self._best_score,
            primary_metric=self.primary_metric,
            iteration=self._iteration,
            eval_tasks_summary=_summarize_eval_tasks(self.eval_tasks),
        )

        provider = self._get_provider()
        llm_response = await provider.complete(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=4096,
            temperature=self.temperature,
        )

        return _parse_agent_proposal(llm_response.content)

    # ── DB persistence helpers ───────────────────────────────────────

    def _db_insert_run(self, status: str) -> None:
        if not self._db:
            return
        try:
            self._db.insert_autoresearch_run({
                "run_id": self._run_id,
                "org_id": self._org_id,
                "agent_name": self.agent.config.name,
                "mode": "agent",
                "primary_metric": self.primary_metric,
                "max_iterations": self.max_iterations,
                "proposer_model": self.model,
                "proposer_provider": self.provider,
                "backend": "in-process",
                "status": status,
                "source": "backend",
            })
        except Exception as exc:
            logger.debug("DB insert_autoresearch_run failed: %s", exc)

    def _db_update_run(self, elapsed: float) -> None:
        if not self._db:
            return
        try:
            self._db.update_autoresearch_run(self._run_id, {
                "status": "completed",
                "total_iterations": self._iteration,
                "best_score": self._best_score or 0,
                "improvements_kept": sum(1 for e in self._history if e.status == ExperimentStatus.KEEP),
                "experiments_discarded": sum(1 for e in self._history if e.status == ExperimentStatus.DISCARD),
                "elapsed_seconds": elapsed,
                "completed_at": time.time(),
            })
        except Exception as exc:
            logger.debug("DB update_autoresearch_run failed: %s", exc)

    def _db_insert_experiment(self, exp: AgentExperiment, modification: dict) -> None:
        if not self._db:
            return
        try:
            self._db.insert_autoresearch_experiment({
                "run_id": self._run_id,
                "org_id": self._org_id,
                "agent_name": self.agent.config.name,
                "iteration": exp.iteration,
                "hypothesis": exp.hypothesis,
                "description": exp.description,
                "modification": modification,
                "score_before": exp.metrics_before.get(self.primary_metric, 0),
                "score_after": exp.metrics_after.get(self.primary_metric, 0),
                "improvement": exp.primary_improvement,
                "primary_metric": self.primary_metric,
                "all_metrics": exp.metrics_after,
                "status": exp.status.value,
            })
        except Exception as exc:
            logger.debug("DB insert_autoresearch_experiment failed: %s", exc)

    def apply_best(self) -> Any:
        """Apply the best discovered config to the agent and save.

        Call this after run() to persist the best-found config.
        """
        from agentos.agent import AgentConfig, save_agent_config

        best = AgentConfig.from_dict(self._best_config)
        self.agent.config = best
        path = save_agent_config(best)
        logger.info("Applied best config → saved to %s", path)
        return best


# ── LLM prompt construction ─────────────────────────────────────────────────


def _agent_research_system_prompt(mutable_fields: list[str]) -> str:
    return f"""\
You are an autonomous agent researcher. Your goal is to improve an AI agent's
performance on evaluation tasks by modifying its configuration.

You may modify these fields: {', '.join(mutable_fields)}

For each experiment, propose exactly ONE targeted change. Return your response
in this format:

HYPOTHESIS: <why you think this change will help>
DESCRIPTION: <one-line summary of the change>
MODIFICATION:
```json
{{
    "field_name": "new_value"
}}
```

Guidelines:
- Make atomic changes (one idea per experiment) for clear attribution
- Study the history to avoid repeating failed approaches
- system_prompt changes have the highest impact — focus on clarity, specificity,
  and task-relevant instructions
- temperature affects creativity vs determinism — lower for factual tasks,
  higher for creative ones
- Tool selection matters — add tools that help, remove tools that confuse
- Consider the eval tasks when choosing what to optimize
"""


def _build_agent_proposal_prompt(
    *,
    config: dict[str, Any],
    history: list[AgentExperiment],
    best_score: float | None,
    primary_metric: str,
    iteration: int,
    eval_tasks_summary: str,
) -> str:
    parts = [f"## Iteration {iteration}\n"]

    if best_score is not None:
        parts.append(f"Current best {primary_metric}: **{best_score:.3f}**\n")

    # Config summary (exclude large fields)
    config_display = {
        k: v for k, v in config.items()
        if k not in ("previous_config", "new_config", "agent_id")
    }
    # Truncate system_prompt for display
    if "system_prompt" in config_display and len(str(config_display["system_prompt"])) > 500:
        config_display["system_prompt"] = str(config_display["system_prompt"])[:500] + "..."

    parts.append(f"## Current agent config\n```json\n{json.dumps(config_display, indent=2)}\n```\n")

    # Eval tasks
    parts.append(f"## Evaluation tasks\n{eval_tasks_summary}\n")

    # History
    if history:
        parts.append("## Experiment history")
        for exp in history[-15:]:  # last 15 experiments
            icon = "+" if exp.status == ExperimentStatus.KEEP else "-"
            score = exp.metrics_after.get(primary_metric, 0)
            parts.append(
                f"  [{icon}] #{exp.iteration}: {exp.description} "
                f"({primary_metric}={score:.3f}, delta={exp.primary_improvement:+.3f})"
            )
        parts.append("")

    parts.append(
        f"Propose ONE targeted change to improve {primary_metric}. "
        "Follow the response format specified in your instructions."
    )

    return "\n".join(parts)


def _summarize_eval_tasks(tasks: list[dict[str, Any]]) -> str:
    """Short summary of eval tasks for the LLM context."""
    lines = []
    for i, t in enumerate(tasks[:10], 1):
        name = t.get("name", f"task_{i}")
        inp = str(t.get("input", ""))[:80]
        lines.append(f"  {i}. {name}: \"{inp}...\"")
    if len(tasks) > 10:
        lines.append(f"  ... and {len(tasks) - 10} more tasks")
    return "\n".join(lines) if lines else "No eval tasks provided."


def _parse_agent_proposal(
    response: str,
) -> tuple[dict[str, Any], str, str]:
    """Parse the LLM's proposal response.

    Returns (modification, description, hypothesis).
    """
    # Extract hypothesis
    hyp_match = re.search(r"HYPOTHESIS:\s*(.+?)(?:\n|$)", response)
    hypothesis = hyp_match.group(1).strip() if hyp_match else ""

    # Extract description
    desc_match = re.search(r"DESCRIPTION:\s*(.+?)(?:\n|$)", response)
    description = desc_match.group(1).strip() if desc_match else "LLM-proposed change"

    # Extract JSON modification
    json_match = re.search(r"```json\s*\n(.*?)```", response, re.DOTALL)
    if not json_match:
        json_match = re.search(r"```\s*\n(.*?)```", response, re.DOTALL)

    modification: dict[str, Any] = {}
    if json_match:
        try:
            modification = json.loads(json_match.group(1))
        except json.JSONDecodeError:
            logger.warning("Could not parse JSON modification from LLM response")

    return modification, description, hypothesis
