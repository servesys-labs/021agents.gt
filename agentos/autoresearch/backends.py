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


# ── GMI Cloud GPU Backend ────────────────────────────────────────────────────

# GMI Cloud API base for serverless GPU sandboxes
GMI_API_BASE = "https://api.gmi-serving.com/v1"


class GMICloudGPUBackend:
    """Runs training on a serverless GPU sandbox via GMI Cloud.

    Uses the same ``GMI_API_KEY`` as inference — one API key for
    everything (LLM calls, embeddings, GPU training sandboxes).

    Best for:
    - Real neural network training (Karpathy-style autoresearch)
    - Large models that need 40-80GB VRAM
    - The full nanochat training loop

    Lifecycle:
    1. POST /sandboxes → provisions a GPU sandbox with PyTorch pre-installed
    2. POST /sandboxes/{id}/files → uploads workspace (train.py, prepare.py)
    3. POST /sandboxes/{id}/exec → runs training command, streams output
    4. DELETE /sandboxes/{id} → tears down (unless keep_alive=True)

    Cost: ~$2.98/hr for H100, ~$3.98/hr for H200.
    A 5-minute training run costs ~$0.25 on H100.
    """

    def __init__(
        self,
        gpu_type: str = "h100",
        gpu_count: int = 1,
        keep_alive: bool = False,
        org_id: str = "",
    ) -> None:
        self.gpu_type = gpu_type
        self.gpu_count = gpu_count
        self.keep_alive = keep_alive
        self.org_id = org_id
        self._sandbox_id: str | None = None
        self._api_base = os.environ.get("GMI_API_BASE", GMI_API_BASE)

    def _api_key(self) -> str:
        key = os.environ.get("GMI_API_KEY", "")
        if not key:
            raise RuntimeError(
                "GMI_API_KEY not set. GPU sandboxes use the same API key as "
                "inference. Set GMI_API_KEY to enable GPU training."
            )
        return key

    @property
    def name(self) -> str:
        return f"gmi-{self.gpu_type}"

    @property
    def requires_gpu(self) -> bool:
        return True

    def cost_estimate(self, time_budget: int) -> str:
        rates = {"h100": 2.98, "h200": 3.98}
        rate = rates.get(self.gpu_type, 2.98)
        # Training time + ~1min overhead for provisioning
        total_minutes = (time_budget + 60) / 60
        cost = rate * total_minutes / 60
        return f"~${cost:.2f} per experiment ({self.gpu_type} @ ${rate}/hr)"

    async def setup(self, workspace: Path) -> None:
        """Provision a serverless GPU sandbox via GMI Cloud."""
        import httpx

        api_key = self._api_key()

        logger.info(
            "Provisioning GMI %s x%d GPU sandbox...",
            self.gpu_type, self.gpu_count,
        )

        async with httpx.AsyncClient(timeout=120) as client:
            # 1. Create sandbox
            resp = await client.post(
                f"{self._api_base}/sandboxes",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "gpu_type": self.gpu_type,
                    "gpu_count": self.gpu_count,
                    "template": "pytorch",  # pre-installed PyTorch + CUDA
                    "timeout_seconds": 3600,  # 1hr max lifetime
                },
            )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"GMI GPU sandbox provisioning failed: {resp.status_code} {resp.text}"
                )

            data = resp.json()
            self._sandbox_id = data.get("sandbox_id", "")

            if not self._sandbox_id:
                raise RuntimeError("GMI returned empty sandbox_id")

            # 2. Upload workspace files
            for f in workspace.iterdir():
                if f.is_file() and f.suffix in (".py", ".toml", ".txt", ".json", ".yaml", ".yml", ".md"):
                    await client.post(
                        f"{self._api_base}/sandboxes/{self._sandbox_id}/files",
                        headers={"Authorization": f"Bearer {api_key}"},
                        json={
                            "path": f"/workspace/{f.name}",
                            "content": f.read_text(),
                        },
                    )

        logger.info("GMI GPU sandbox %s ready", self._sandbox_id)

    async def teardown(self) -> None:
        """Terminate the GPU sandbox."""
        if not self._sandbox_id or self.keep_alive:
            return

        try:
            import httpx
            api_key = self._api_key()
            async with httpx.AsyncClient(timeout=30) as client:
                await client.delete(
                    f"{self._api_base}/sandboxes/{self._sandbox_id}",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
            logger.info("GMI GPU sandbox %s terminated", self._sandbox_id)
        except Exception as exc:
            logger.warning("Failed to terminate GMI sandbox %s: %s", self._sandbox_id, exc)

        self._sandbox_id = None

    async def run_training(
        self,
        command: str,
        workspace: Path,
        timeout: int,
        env: dict[str, str] | None = None,
    ) -> TrainingOutput:
        """Run training command in the GMI GPU sandbox."""
        import httpx

        if not self._sandbox_id:
            await self.setup(workspace)

        api_key = self._api_key()

        # Sync train.py if modified since setup
        train_path = workspace / "train.py"
        if train_path.exists():
            async with httpx.AsyncClient(timeout=30) as client:
                await client.post(
                    f"{self._api_base}/sandboxes/{self._sandbox_id}/files",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "path": "/workspace/train.py",
                        "content": train_path.read_text(),
                    },
                )

        # Execute training command
        env_prefix = ""
        if env:
            env_prefix = " ".join(f"{k}={v}" for k, v in env.items()) + " "

        try:
            async with httpx.AsyncClient(timeout=timeout + 60) as client:
                resp = await client.post(
                    f"{self._api_base}/sandboxes/{self._sandbox_id}/exec",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "command": f"cd /workspace && {env_prefix}{command}",
                        "timeout_seconds": timeout,
                    },
                )

                if resp.status_code >= 400:
                    return TrainingOutput.parse(
                        f"GMI EXEC ERROR: {resp.status_code} {resp.text}",
                        returncode=-1,
                    )

                data = resp.json()
                log_text = data.get("stdout", "") + "\n" + data.get("stderr", "")
                returncode = data.get("exit_code", -1)

        except httpx.TimeoutException:
            log_text = f"TIMEOUT: GPU training exceeded {timeout}s"
            returncode = -1
        except Exception as exc:
            log_text = f"GMI EXECUTION ERROR: {exc}"
            returncode = -1

        return TrainingOutput.parse(log_text, returncode)


# Keep old name as alias for backwards compatibility
GPUCloudBackend = GMICloudGPUBackend


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
            - "gpu" / "gpu-h100"    — GMI Cloud H100 ($2.98/hr, same GMI_API_KEY as inference)
            - "gpu-h200"            — GMI Cloud H200 ($3.98/hr)
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
        "gpu": GMICloudGPUBackend,
        "gpu-cloud": GMICloudGPUBackend,
        "gpu-h100": lambda **kw: GMICloudGPUBackend(gpu_type="h100", **kw),
        "gpu-h200": lambda **kw: GMICloudGPUBackend(gpu_type="h200", **kw),
        "gmi": GMICloudGPUBackend,
        "gmi-h100": lambda **kw: GMICloudGPUBackend(gpu_type="h100", **kw),
        "gmi-h200": lambda **kw: GMICloudGPUBackend(gpu_type="h200", **kw),
    }

    factory = backends.get(name)
    if not factory:
        raise ValueError(
            f"Unknown backend: {name}. Available: {', '.join(backends.keys())}"
        )

    return factory(**kwargs)


def recommend_backend(has_gpu_code: bool = False, needs_isolation: bool = False) -> str:
    """Recommend the best backend based on workload characteristics.

    Args:
        has_gpu_code: True if the training script imports torch/cuda.
        needs_isolation: True if untrusted code needs sandboxing (CPU).

    Returns:
        Backend name string.
    """
    if has_gpu_code:
        return "gmi-h100"  # GMI Cloud GPU — same API key as inference
    if needs_isolation:
        return "e2b"  # E2B sandbox — CPU isolation
    return "in-process"
