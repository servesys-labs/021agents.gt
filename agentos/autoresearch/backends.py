"""Execution backends for autoresearch — where the training actually runs.

Three backends for different compute profiles:

1. **InProcess** — For agent autoresearch (config + EvalGym). Pure LLM API
   calls, no local compute. Runs anywhere: Cloudflare Worker, E2B sandbox,
   Lambda, any CPU container.

2. **E2BSandbox** — For CPU-capable training workloads. Spins up an E2B
   sandbox, copies train.py + prepare.py, runs the training command, and
   parses results. Good for small models, hyperparameter sweeps, or
   anything that doesn't need a GPU.

3. **GMICloud** — For real GPU training (Karpathy-style). Provisions a
   serverless GPU sandbox via GMI Cloud, runs training, captures output,
   tears down. Uses the same ``GMI_API_KEY`` as inference — one key for
   everything.

Usage:
    # Agent autoresearch — runs in-process (API calls only)
    backend = InProcessBackend()

    # Training in E2B sandbox (CPU)
    backend = E2BSandboxBackend()

    # Training on GMI Cloud GPU (same API key as inference)
    backend = GMICloudGPUBackend(gpu_type="h100")

    # Use with driver
    output = await backend.run_training(command, workspace, timeout)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from agentos.autoresearch.driver import TrainingOutput

logger = logging.getLogger(__name__)


class ExecutionBackend(Protocol):
    """Protocol for autoresearch execution backends."""

    async def run_training(
        self,
        command: str,
        workspace: Path,
        timeout: int,
        env: dict[str, str] | None = None,
    ) -> TrainingOutput:
        """Run a training command and return parsed output."""
        ...

    async def setup(self, workspace: Path) -> None:
        """One-time setup (provision resources, copy files, etc.)."""
        ...

    async def teardown(self) -> None:
        """Clean up resources."""
        ...

    @property
    def name(self) -> str:
        ...

    @property
    def requires_gpu(self) -> bool:
        ...

    def cost_estimate(self, time_budget: int) -> str:
        """Human-readable cost estimate for one experiment."""
        ...


# ── InProcess Backend ───────────────────────────────────────────────────────


class InProcessBackend:
    """Runs training as a local subprocess.

    Best for:
    - Agent autoresearch (pure API calls, no real training)
    - Development/testing
    - CPU-only training on small models

    This is the default backend. It runs the command directly in the
    workspace directory using asyncio subprocess.
    """

    @property
    def name(self) -> str:
        return "in-process"

    @property
    def requires_gpu(self) -> bool:
        return False

    def cost_estimate(self, time_budget: int) -> str:
        return "Free (local CPU)"

    async def setup(self, workspace: Path) -> None:
        pass

    async def teardown(self) -> None:
        pass

    async def run_training(
        self,
        command: str,
        workspace: Path,
        timeout: int,
        env: dict[str, str] | None = None,
    ) -> TrainingOutput:
        run_env = {**os.environ, **(env or {})}

        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(workspace),
                env=run_env,
            )
            stdout, _ = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
            log_text = stdout.decode("utf-8", errors="replace")
            returncode = proc.returncode or 0
        except asyncio.TimeoutError:
            proc.kill()  # type: ignore[union-attr]
            log_text = f"TIMEOUT: training exceeded {timeout}s wall-clock limit"
            returncode = -1
        except Exception as exc:
            log_text = f"LAUNCH ERROR: {exc}"
            returncode = -1

        return TrainingOutput.parse(log_text, returncode)


# ── E2B Sandbox Backend ─────────────────────────────────────────────────────


class E2BSandboxBackend:
    """Runs training in an E2B cloud sandbox (CPU).

    Best for:
    - Isolated execution (untrusted training code)
    - CPU-capable workloads (small models, sweeps)
    - When you need a clean environment per experiment

    Provisions an E2B sandbox, copies workspace files, runs the command,
    and captures output. Each experiment gets a fresh sandbox.
    """

    def __init__(
        self,
        template: str = "base",
        sandbox_timeout: int = 600,
        reuse_sandbox: bool = True,
    ) -> None:
        self.template = template
        self.sandbox_timeout = sandbox_timeout
        self.reuse_sandbox = reuse_sandbox
        self._sandbox_id: str | None = None
        self._mgr: Any = None  # Reuse SandboxManager across calls

    @property
    def name(self) -> str:
        return "e2b-sandbox"

    @property
    def requires_gpu(self) -> bool:
        return False

    def cost_estimate(self, time_budget: int) -> str:
        # E2B pricing: ~$0.10/hr for base sandbox
        hours = time_budget / 3600
        return f"~${hours * 0.10:.3f} per experiment (E2B sandbox)"

    async def setup(self, workspace: Path) -> None:
        from agentos.sandbox.manager import SandboxManager

        mgr = SandboxManager()
        self._mgr = mgr
        result = await mgr.create(template=self.template, timeout_sec=self.sandbox_timeout)
        # SandboxManager.create returns a SandboxSession object or dict
        if hasattr(result, "sandbox_id"):
            self._sandbox_id = result.sandbox_id
        else:
            self._sandbox_id = result.get("sandbox_id", "") if isinstance(result, dict) else ""

        if not self._sandbox_id:
            raise RuntimeError("Failed to create E2B sandbox")

        # Copy workspace files into sandbox home dir
        for f in workspace.iterdir():
            if f.is_file() and f.suffix in (".py", ".md", ".toml", ".txt", ".json", ".yaml", ".yml"):
                content = f.read_text()
                await mgr.file_write(
                    path=f"/home/user/{f.name}",
                    content=content,
                    sandbox_id=self._sandbox_id,
                )

        logger.info("E2B sandbox %s ready with workspace files", self._sandbox_id)

    async def teardown(self) -> None:
        if self._sandbox_id and self._mgr:
            await self._mgr.kill(self._sandbox_id)
            self._sandbox_id = None
            self._mgr = None

    async def run_training(
        self,
        command: str,
        workspace: Path,
        timeout: int,
        env: dict[str, str] | None = None,
    ) -> TrainingOutput:
        if not self._sandbox_id:
            await self.setup(workspace)

        mgr = self._mgr

        # If train.py was modified locally, sync it to sandbox
        train_path = workspace / "train.py"
        if train_path.exists():
            await mgr.file_write(
                path="/home/user/train.py",
                content=train_path.read_text(),
                sandbox_id=self._sandbox_id,
            )

        # Build environment string
        env_prefix = ""
        if env:
            env_prefix = " ".join(f"{k}={v}" for k, v in env.items()) + " "

        # Run in sandbox (home dir is /home/user)
        result = await mgr.exec(
            command=f"cd /home/user && {env_prefix}{command}",
            sandbox_id=self._sandbox_id,
            timeout_ms=timeout * 1000,
        )

        # ExecResult may be a dataclass or dict depending on sandbox mode
        if hasattr(result, "stdout"):
            log_text = (result.stdout or "") + "\n" + (result.stderr or "")
            returncode = result.exit_code if hasattr(result, "exit_code") else -1
        else:
            log_text = result.get("stdout", "") + "\n" + result.get("stderr", "")
            returncode = result.get("exit_code", -1)

        return TrainingOutput.parse(log_text, returncode)




# ── Backend factory ──────────────────────────────────────────────────────────


def get_backend(
    name: str = "in-process",
    **kwargs,
) -> ExecutionBackend:
    """Get an execution backend by name.

    Args:
        name: Backend name. Options:
            - "in-process" / "local" — local subprocess (CPU, free)
            - "e2b" / "sandbox"     — E2B cloud sandbox (CPU, ~$0.10/hr)
        **kwargs: Passed to the backend constructor.

    Returns:
        An ExecutionBackend instance.
    """
    backends = {
        "in-process": InProcessBackend,
        "local": InProcessBackend,
        "e2b": E2BSandboxBackend,
        "e2b-sandbox": E2BSandboxBackend,
        "sandbox": E2BSandboxBackend,
    }

    factory = backends.get(name)
    if not factory:
        raise ValueError(
            f"Unknown backend: {name}. Available: {', '.join(backends.keys())}"
        )

    return factory(**kwargs)


def recommend_backend(has_gpu_code: bool = False, needs_isolation: bool = False) -> str:
    """Recommend the best backend based on workload characteristics."""
    if needs_isolation:
        return "e2b"
    return "in-process"
