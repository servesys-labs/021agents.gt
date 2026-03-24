"""Autoresearch driver — autonomous edit → train → eval → keep/discard loop.

This is the heart of the system. It:
1. Uses an LLM agent to propose changes to train.py
2. Commits the change
3. Runs training with a fixed time budget
4. Parses val_bpb from output
5. Keeps (advance branch) or discards (git reset) based on improvement
6. Logs everything to results.tsv
7. Repeats indefinitely

The driver can run with:
- A real LLM agent (production mode)
- A callback function (programmatic mode)
- Manual edits (interactive mode — waits for user to edit train.py)
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Protocol

from agentos.autoresearch.results import (
    ExperimentRecord,
    ExperimentStatus,
    ResultsLog,
)

logger = logging.getLogger(__name__)


# Re-export for convenience
__all__ = ["AutoResearchDriver", "ExperimentStatus", "DriverConfig", "TrainingOutput"]


@dataclass
class TrainingOutput:
    """Parsed output from a training run."""

    val_bpb: float = 0.0
    peak_vram_mb: float = 0.0
    training_seconds: float = 0.0
    total_seconds: float = 0.0
    mfu_percent: float = 0.0
    total_tokens_m: float = 0.0
    num_steps: int = 0
    num_params_m: float = 0.0
    raw_log: str = ""
    returncode: int = 0
    error: str = ""

    @property
    def crashed(self) -> bool:
        return self.returncode != 0

    @property
    def memory_gb(self) -> float:
        return self.peak_vram_mb / 1024.0 if self.peak_vram_mb else 0.0

    @classmethod
    def parse(cls, log_text: str, returncode: int = 0) -> TrainingOutput:
        """Parse training output from run.log."""
        out = cls(raw_log=log_text, returncode=returncode)
        if returncode != 0:
            out.error = log_text[-2000:] if len(log_text) > 2000 else log_text
            return out

        patterns = {
            "val_bpb": (r"^val_bpb:\s+([\d.]+)", float),
            "peak_vram_mb": (r"^peak_vram_mb:\s+([\d.]+)", float),
            "training_seconds": (r"^training_seconds:\s+([\d.]+)", float),
            "total_seconds": (r"^total_seconds:\s+([\d.]+)", float),
            "mfu_percent": (r"^mfu_percent:\s+([\d.]+)", float),
            "total_tokens_m": (r"^total_tokens_M:\s+([\d.]+)", float),
            "num_steps": (r"^num_steps:\s+(\d+)", int),
            "num_params_m": (r"^num_params_M:\s+([\d.]+)", float),
        }

        for attr, (pattern, cast) in patterns.items():
            match = re.search(pattern, log_text, re.MULTILINE)
            if match:
                setattr(out, attr, cast(match.group(1)))

        return out


class HypothesisProposer(Protocol):
    """Protocol for proposing changes to train.py.

    Implementations can be:
    - LLM-backed (calls an LLM with program.md + context)
    - Programmatic (scripted search over hyperparameters)
    - Interactive (waits for human to make changes)
    """

    async def propose(
        self,
        train_script: str,
        results_log: str,
        best_bpb: float | None,
        iteration: int,
    ) -> tuple[str, str]:
        """Propose a change to train.py.

        Args:
            train_script: Current contents of train.py
            results_log: Current contents of results.tsv
            best_bpb: Best val_bpb so far (None if no experiments yet)
            iteration: Current iteration number

        Returns:
            (new_train_script, description) — the modified train.py
            and a short description of what was changed.
        """
        ...


@dataclass
class DriverConfig:
    """Configuration for the autoresearch driver."""

    # Workspace
    workspace: Path = field(default_factory=lambda: Path.cwd())
    train_script: str = "train.py"
    prepare_script: str = "prepare.py"
    results_file: str = "results.tsv"
    run_log: str = "run.log"

    # Training
    run_command: str = "uv run train.py"
    time_budget: int = 300  # seconds
    train_timeout: int = 600  # max wall-clock for subprocess (2x budget)

    # Execution backend: "in-process", "e2b", "gpu", "gpu-h100", "gpu-h200"
    backend: str = "in-process"

    # Loop control
    max_iterations: int = 0  # 0 = unlimited
    stop_on_crash_streak: int = 5  # stop after N consecutive crashes

    # Git
    git_branch: str = ""  # empty = use current branch
    git_auto_commit: bool = True
    git_auto_reset: bool = True

    @property
    def train_path(self) -> Path:
        return self.workspace / self.train_script

    @property
    def prepare_path(self) -> Path:
        return self.workspace / self.prepare_script

    @property
    def results_path(self) -> Path:
        return self.workspace / self.results_file

    @property
    def log_path(self) -> Path:
        return self.workspace / self.run_log


class AutoResearchDriver:
    """The main autonomous research loop.

    Usage:
        driver = AutoResearchDriver(config, proposer)
        summary = await driver.run()

    Or step-by-step:
        driver = AutoResearchDriver(config, proposer)
        while driver.should_continue:
            result = await driver.step()
    """

    def __init__(
        self,
        config: DriverConfig,
        proposer: HypothesisProposer,
        on_experiment: Callable[[ExperimentRecord], None] | None = None,
        backend: Any | None = None,
    ) -> None:
        self.config = config
        self.proposer = proposer
        self.on_experiment = on_experiment
        self.results = ResultsLog(config.results_path)
        self._iteration = 0
        self._crash_streak = 0
        self._stopped = False
        self._start_time: float = 0.0
        # Execution backend — defaults to in-process subprocess
        self._backend = backend

    @property
    def should_continue(self) -> bool:
        if self._stopped:
            return False
        if self.config.max_iterations > 0 and self._iteration >= self.config.max_iterations:
            return False
        if self.config.stop_on_crash_streak > 0 and self._crash_streak >= self.config.stop_on_crash_streak:
            logger.warning(
                "Stopping: %d consecutive crashes", self._crash_streak
            )
            return False
        return True

    def stop(self) -> None:
        """Signal the loop to stop after the current iteration."""
        self._stopped = True

    async def run(self) -> dict[str, Any]:
        """Run the full autonomous loop until stopped or limit reached."""
        self._start_time = time.monotonic()
        logger.info(
            "Autoresearch starting in %s (max_iterations=%s)",
            self.config.workspace,
            self.config.max_iterations or "unlimited",
        )

        # Ensure we're on the right branch
        if self.config.git_branch:
            self._git("checkout", "-B", self.config.git_branch)

        # Run baseline if no experiments yet
        if self.results.total_experiments == 0:
            logger.info("Running baseline experiment...")
            await self._run_baseline()

        while self.should_continue:
            try:
                record = await self.step()
                if record:
                    logger.info(
                        "Experiment %d: %s (val_bpb=%.6f, status=%s)",
                        self._iteration,
                        record.description,
                        record.val_bpb,
                        record.status.value,
                    )
            except Exception as exc:
                logger.error("Unexpected error in iteration %d: %s", self._iteration, exc)
                self._crash_streak += 1
                if not self.should_continue:
                    break

        elapsed = time.monotonic() - self._start_time
        return {
            "iterations": self._iteration,
            "elapsed_seconds": elapsed,
            "experiments_per_hour": (self._iteration / elapsed * 3600) if elapsed > 0 else 0,
            "best_bpb": self.results.best_bpb,
            "total_kept": self.results.kept_count,
            "total_discarded": self.results.discarded_count,
            "total_crashed": self.results.crash_count,
            "summary": self.results.summary(),
        }

    async def step(self) -> ExperimentRecord | None:
        """Run a single experiment iteration.

        1. Ask proposer for a change
        2. Apply change + commit
        3. Run training
        4. Parse results
        5. Keep or discard
        """
        self._iteration += 1

        # Read current state
        train_content = self.config.train_path.read_text()
        results_content = (
            self.config.results_path.read_text()
            if self.config.results_path.exists()
            else ""
        )
        best_bpb = self.results.best_bpb

        # 1. Propose a change
        logger.info("Iteration %d: requesting hypothesis...", self._iteration)
        new_train, description = await self.proposer.propose(
            train_script=train_content,
            results_log=results_content,
            best_bpb=best_bpb,
            iteration=self._iteration,
        )

        if new_train == train_content:
            logger.warning("Proposer returned unchanged train.py, skipping")
            return None

        # 2. Apply change
        self.config.train_path.write_text(new_train)

        # 3. Commit
        commit_hash = ""
        if self.config.git_auto_commit:
            commit_hash = self._commit(description)

        # 4. Run training
        output = await self._train()

        # 5. Evaluate and decide
        if output.crashed:
            record = ExperimentRecord(
                commit=commit_hash[:7] if commit_hash else "-------",
                val_bpb=0.0,
                memory_gb=0.0,
                status=ExperimentStatus.CRASH,
                description=description,
            )
            self._crash_streak += 1
            if self.config.git_auto_reset and commit_hash:
                self._git("reset", "--hard", "HEAD~1")
        else:
            improved = best_bpb is None or output.val_bpb < best_bpb
            status = ExperimentStatus.KEEP if improved else ExperimentStatus.DISCARD

            record = ExperimentRecord(
                commit=commit_hash[:7] if commit_hash else "-------",
                val_bpb=output.val_bpb,
                memory_gb=output.memory_gb,
                status=status,
                description=description,
                training_seconds=output.training_seconds,
                total_seconds=output.total_seconds,
                mfu_percent=output.mfu_percent,
                total_tokens_m=output.total_tokens_m,
                num_steps=output.num_steps,
                num_params_m=output.num_params_m,
            )

            if status == ExperimentStatus.KEEP:
                self._crash_streak = 0
                logger.info(
                    "KEEP: val_bpb=%.6f (improved from %s)",
                    output.val_bpb,
                    f"{best_bpb:.6f}" if best_bpb else "baseline",
                )
            else:
                self._crash_streak = 0
                logger.info(
                    "DISCARD: val_bpb=%.6f (no improvement over %.6f)",
                    output.val_bpb,
                    best_bpb or 0.0,
                )
                if self.config.git_auto_reset and commit_hash:
                    self._git("reset", "--hard", "HEAD~1")

        # 6. Log
        self.results.append(record)
        if self.on_experiment:
            self.on_experiment(record)

        return record

    async def _run_baseline(self) -> ExperimentRecord:
        """Run the current train.py as-is to establish baseline."""
        commit_hash = self._get_head_hash()
        output = await self._train()

        if output.crashed:
            record = ExperimentRecord(
                commit=commit_hash[:7],
                val_bpb=0.0,
                memory_gb=0.0,
                status=ExperimentStatus.CRASH,
                description="baseline (CRASHED)",
            )
        else:
            record = ExperimentRecord(
                commit=commit_hash[:7],
                val_bpb=output.val_bpb,
                memory_gb=output.memory_gb,
                status=ExperimentStatus.KEEP,
                description="baseline",
                training_seconds=output.training_seconds,
                total_seconds=output.total_seconds,
                mfu_percent=output.mfu_percent,
                total_tokens_m=output.total_tokens_m,
                num_steps=output.num_steps,
                num_params_m=output.num_params_m,
            )

        self.results.append(record)
        if self.on_experiment:
            self.on_experiment(record)
        return record

    async def _train(self) -> TrainingOutput:
        """Run the training script via the configured backend."""
        cmd = self.config.run_command
        log_path = self.config.log_path
        cwd = self.config.workspace
        train_env = {"TIME_BUDGET": str(self.config.time_budget)}

        logger.info("Running: %s (timeout=%ds, backend=%s)",
                     cmd, self.config.train_timeout,
                     self._backend.name if self._backend else "in-process")

        # Use execution backend if provided
        if self._backend is not None:
            output = await self._backend.run_training(
                command=cmd,
                workspace=cwd,
                timeout=self.config.train_timeout,
                env=train_env,
            )
            log_path.write_text(output.raw_log)
            return output

        # Default: in-process subprocess (backwards compatible)
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(cwd),
                env={**os.environ, **train_env},
            )
            stdout, _ = await asyncio.wait_for(
                proc.communicate(), timeout=self.config.train_timeout
            )
            log_text = stdout.decode("utf-8", errors="replace")
            returncode = proc.returncode or 0
        except asyncio.TimeoutError:
            logger.error("Training timed out after %ds", self.config.train_timeout)
            proc.kill()  # type: ignore[union-attr]
            log_text = "TIMEOUT: training exceeded wall-clock limit"
            returncode = -1
        except Exception as exc:
            log_text = f"LAUNCH ERROR: {exc}"
            returncode = -1

        # Save log
        log_path.write_text(log_text)

        return TrainingOutput.parse(log_text, returncode)

    # ── Git helpers ────────────────────────────────────────────────────────

    def _git(self, *args: str) -> str:
        """Run a git command in the workspace."""
        result = subprocess.run(
            ["git", *args],
            cwd=str(self.config.workspace),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            logger.warning("git %s failed: %s", " ".join(args), result.stderr.strip())
        return result.stdout.strip()

    def _commit(self, message: str) -> str:
        """Stage train.py and commit with the given message."""
        self._git("add", self.config.train_script)
        self._git("commit", "-m", message)
        return self._get_head_hash()

    def _get_head_hash(self) -> str:
        return self._git("rev-parse", "--short=7", "HEAD")


# ── Built-in proposers ─────────────────────────────────────────────────────


class LLMProposer:
    """Uses an LLM to propose changes to train.py.

    This is the production proposer — it sends the current train.py,
    results.tsv, and program.md to an LLM and asks it to propose a
    single targeted change.
    """

    def __init__(
        self,
        model: str = "claude-sonnet-4-6-20250627",
        provider: str = "anthropic",
        program_md: str = "",
        max_tokens: int = 16384,
        temperature: float = 0.7,
    ) -> None:
        self.model = model
        self.provider = provider
        self.program_md = program_md
        self.max_tokens = max_tokens
        self.temperature = temperature

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
            # GMI Cloud / OpenAI-compatible
            api_key = os.environ.get("GMI_API_KEY", "") or os.environ.get("OPENAI_API_KEY", "")
            api_base = os.environ.get("GMI_API_BASE", "https://api.gmi-serving.com/v1")
            return HttpProvider(model_id=self.model, api_base=api_base, api_key=api_key)

    async def propose(
        self,
        train_script: str,
        results_log: str,
        best_bpb: float | None,
        iteration: int,
    ) -> tuple[str, str]:
        """Ask the LLM to propose a change to train.py."""
        system = self.program_md or _default_system_prompt()

        user_msg = _build_proposal_prompt(
            train_script=train_script,
            results_log=results_log,
            best_bpb=best_bpb,
            iteration=iteration,
        )

        provider = self._get_provider()
        llm_response = await provider.complete(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=self.max_tokens,
            temperature=self.temperature,
        )

        return _parse_llm_response(llm_response.content, train_script)


class ScriptedProposer:
    """Executes a predefined list of changes in order.

    Useful for hyperparameter sweeps and ablation studies.
    """

    def __init__(self, changes: list[tuple[str, Callable[[str], str]]]) -> None:
        """Args:
            changes: List of (description, transform_fn) pairs.
                     transform_fn takes current train.py and returns modified version.
        """
        self._changes = changes
        self._index = 0

    async def propose(
        self,
        train_script: str,
        results_log: str,
        best_bpb: float | None,
        iteration: int,
    ) -> tuple[str, str]:
        if self._index >= len(self._changes):
            return train_script, "no more changes"
        description, transform = self._changes[self._index]
        self._index += 1
        return transform(train_script), description


# ── LLM prompt helpers ──────────────────────────────────────────────────────


def _default_system_prompt() -> str:
    return (
        "You are an autonomous ML researcher conducting training experiments. "
        "Your goal is to minimize val_bpb (validation bits-per-byte) by making "
        "targeted changes to train.py. Make exactly ONE change per experiment. "
        "Return the COMPLETE modified train.py inside a ```python code block, "
        "followed by a one-line DESCRIPTION: tag explaining the change."
    )


def _build_proposal_prompt(
    *,
    train_script: str,
    results_log: str,
    best_bpb: float | None,
    iteration: int,
) -> str:
    parts = [
        f"## Iteration {iteration}\n",
    ]
    if best_bpb is not None:
        parts.append(f"Current best val_bpb: **{best_bpb:.6f}**\n")
    else:
        parts.append("No experiments run yet — this will establish the baseline.\n")

    if results_log.strip():
        parts.append(f"## Previous experiments\n```\n{results_log}\n```\n")

    parts.append(f"## Current train.py\n```python\n{train_script}\n```\n")

    parts.append(
        "Propose ONE targeted change to improve val_bpb. "
        "Return the COMPLETE modified train.py in a ```python block, "
        "then on a new line: DESCRIPTION: <one-line summary of your change>"
    )

    return "\n".join(parts)


def _parse_llm_response(
    response: str, original_script: str
) -> tuple[str, str]:
    """Extract the modified train.py and description from LLM response."""
    # Extract python code block
    code_match = re.search(
        r"```python\s*\n(.*?)```", response, re.DOTALL
    )
    if not code_match:
        # Try without language tag
        code_match = re.search(r"```\s*\n(.*?)```", response, re.DOTALL)

    if code_match:
        new_script = code_match.group(1).rstrip()
    else:
        logger.warning("Could not extract code block from LLM response")
        new_script = original_script

    # Extract description
    desc_match = re.search(r"DESCRIPTION:\s*(.+)", response)
    if desc_match:
        description = desc_match.group(1).strip()
    else:
        # Try to extract from first line or commit-style message
        lines = [l.strip() for l in response.split("\n") if l.strip() and not l.startswith("```")]
        description = lines[0][:100] if lines else "LLM-proposed change"

    return new_script, description
