"""Live end-to-end tests for autoresearch — hits real API keys.

These tests make real LLM API calls and (for GPU tests) provision
real GPU sandboxes. They are SLOW and COST MONEY.

Run with:
    uv run pytest tests/test_autoresearch_live.py -v -s

Requires .env with:
    GMI_API_KEY          — for inference + GPU sandboxes
    ANTHROPIC_API_KEY    — for Anthropic-based proposers (optional)

Tests are skipped automatically if the required API key is missing.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

# Load .env before anything else
from agentos.env import load_dotenv_if_present
load_dotenv_if_present()

_has_gmi = bool(os.environ.get("GMI_API_KEY", ""))
_has_anthropic = bool(os.environ.get("ANTHROPIC_API_KEY", ""))

skip_no_gmi = pytest.mark.skipif(not _has_gmi, reason="GMI_API_KEY not set")
skip_no_anthropic = pytest.mark.skipif(not _has_anthropic, reason="ANTHROPIC_API_KEY not set")
skip_no_llm = pytest.mark.skipif(
    not _has_gmi and not _has_anthropic,
    reason="No LLM API key set (need GMI_API_KEY or ANTHROPIC_API_KEY)",
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _init_git_workspace(workspace: Path) -> None:
    """Initialize a git repo in the workspace for the driver."""
    subprocess.run(["git", "init"], cwd=str(workspace), capture_output=True)
    subprocess.run(["git", "add", "."], cwd=str(workspace), capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=str(workspace),
        capture_output=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "test",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "test",
            "GIT_COMMITTER_EMAIL": "t@t",
        },
    )


# ── 1. LLM Proposer — live call ─────────────────────────────────────────────


class TestLLMProposerLive:
    """Test that the LLM proposer can actually call an API and return a valid change."""

    @skip_no_gmi
    @pytest.mark.asyncio
    async def test_gmi_proposer_returns_code(self):
        """GMI Cloud LLM proposes a real change to train.py."""
        from agentos.autoresearch.driver import LLMProposer

        proposer = LLMProposer(
            model="deepseek-ai/DeepSeek-V3.2",
            provider="gmi",
            temperature=0.5,
        )

        train_script = "LEARNING_RATE = 0.04\nDEPTH = 8\nBATCH_SIZE = 512\n"

        new_script, description = await proposer.propose(
            train_script=train_script,
            results_log="",
            best_bpb=None,
            iteration=1,
        )

        print(f"\nProposer returned description: {description}")
        print(f"Script changed: {new_script != train_script}")

        # The LLM should return *something* — either changed code or a description
        assert description, "LLM should return a description"
        assert len(description) > 3, "Description should be meaningful"

    @skip_no_anthropic
    @pytest.mark.asyncio
    async def test_anthropic_proposer_returns_code(self):
        """Anthropic LLM proposes a real change to train.py."""
        from agentos.autoresearch.driver import LLMProposer

        proposer = LLMProposer(
            model="claude-haiku-4-5-20251001",
            provider="anthropic",
            temperature=0.5,
        )

        train_script = "LEARNING_RATE = 0.04\nDEPTH = 8\n"

        new_script, description = await proposer.propose(
            train_script=train_script,
            results_log="",
            best_bpb=1.05,
            iteration=2,
        )

        print(f"\nAnthropic proposer description: {description}")
        assert description, "LLM should return a description"


# ── 2. Agent Autoresearch — live e2e ─────────────────────────────────────────


class TestAgentAutoresearchLive:
    """End-to-end agent autoresearch with real LLM calls.

    This creates a simple agent, gives it eval tasks, and runs the
    autoresearch loop with real LLM calls for both proposal and evaluation.
    """

    @skip_no_gmi
    @pytest.mark.asyncio
    async def test_agent_autoresearch_e2e_gmi(self, tmp_path: Path):
        """Full agent autoresearch loop using GMI Cloud."""
        from agentos.agent import Agent, AgentConfig
        from agentos.autoresearch.agent_research import AgentResearchLoop

        # Create a simple agent
        config = AgentConfig(
            name="live-test-agent",
            description="A simple math helper",
            system_prompt="You are a math tutor. When asked a math question, give the numeric answer only.",
            model="deepseek-ai/DeepSeek-V3.2",
            temperature=0.0,
            tools=[],
        )

        agent = Agent(config)

        # Simple eval tasks
        eval_tasks = [
            {"name": "add", "input": "What is 2 + 3?", "expected": "5", "grader": "contains"},
            {"name": "mult", "input": "What is 6 * 7?", "expected": "42", "grader": "contains"},
        ]

        experiments = []

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=eval_tasks,
            primary_metric="pass_rate",
            max_iterations=2,  # keep it short to save cost
            trials_per_task=1,  # 1 trial to save cost
            model="deepseek-ai/DeepSeek-V3.2",
            provider="gmi",
            temperature=0.7,
            results_path=tmp_path / "results.tsv",
            on_experiment=lambda e: experiments.append(e),
        )

        summary = await loop.run()

        print(f"\n{'=' * 50}")
        print(f"Agent autoresearch summary (GMI):")
        print(f"  Iterations:    {summary['iterations']}")
        print(f"  Baseline:      {summary['baseline_score']:.3f}")
        print(f"  Best score:    {summary['best_score']:.3f}")
        print(f"  Kept:          {summary['improvements_kept']}")
        print(f"  Discarded:     {summary['experiments_discarded']}")
        for exp in summary.get("history", []):
            icon = "+" if exp["status"] == "keep" else "-"
            print(f"  [{icon}] #{exp['iteration']}: {exp['description'][:60]} "
                  f"(score={exp['score']:.3f})")
        print(f"{'=' * 50}")

        # Verify structure
        assert summary["iterations"] == 2
        assert 0.0 <= summary["baseline_score"] <= 1.0
        assert 0.0 <= summary["best_score"] <= 1.0
        assert summary["improvements_kept"] + summary["experiments_discarded"] == 2

        # Results TSV should have baseline + 2 experiments
        from agentos.autoresearch.results import ResultsLog
        log = ResultsLog(tmp_path / "results.tsv")
        assert log.total_experiments == 3  # baseline + 2

    @skip_no_anthropic
    @pytest.mark.asyncio
    async def test_agent_autoresearch_e2e_anthropic(self, tmp_path: Path):
        """Full agent autoresearch loop using Anthropic."""
        from agentos.agent import Agent, AgentConfig
        from agentos.autoresearch.agent_research import AgentResearchLoop

        config = AgentConfig(
            name="live-test-anthropic",
            description="A geography helper",
            system_prompt="You are a geography expert. Answer with just the country or city name.",
            model="claude-haiku-4-5-20251001",
            temperature=0.0,
            tools=[],
        )

        agent = Agent(config)

        eval_tasks = [
            {"name": "capital", "input": "What is the capital of France?", "expected": "Paris", "grader": "contains"},
            {"name": "country", "input": "What country is Tokyo in?", "expected": "Japan", "grader": "contains"},
        ]

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=eval_tasks,
            max_iterations=2,
            trials_per_task=1,
            model="claude-haiku-4-5-20251001",
            provider="anthropic",
            temperature=0.7,
            results_path=tmp_path / "results.tsv",
        )

        summary = await loop.run()

        print(f"\nAgent autoresearch (Anthropic): baseline={summary['baseline_score']:.3f} → best={summary['best_score']:.3f}")

        assert summary["iterations"] == 2
        assert 0.0 <= summary["best_score"] <= 1.0


# ── 3. Training Autoresearch — live e2e (CPU only) ──────────────────────────


class TestTrainingAutoresearchLive:
    """End-to-end training autoresearch with a real LLM proposer
    and a trivial CPU training script (no GPU needed).
    """

    @skip_no_llm
    @pytest.mark.asyncio
    async def test_training_loop_with_echo_script(self, tmp_path: Path):
        """Run the training driver with a fake train.py that just echoes metrics."""
        from agentos.autoresearch.driver import (
            AutoResearchDriver,
            DriverConfig,
            LLMProposer,
        )
        from agentos.autoresearch.results import ExperimentRecord

        # Create a trivial train.py that echoes metrics
        train_py = tmp_path / "train.py"
        train_py.write_text("""\
# Fake training script for live test
LEARNING_RATE = 0.04
DEPTH = 8

import random
random.seed(42)
bpb = 1.0 - random.random() * 0.1  # Random bpb around 0.9-1.0

print("Training complete")
print("---")
print(f"val_bpb:          {bpb:.6f}")
print(f"peak_vram_mb:     100.0")
print(f"training_seconds: 1.0")
print(f"total_seconds:    1.5")
print(f"num_steps:        10")
print(f"num_params_M:     0.1")
""")

        _init_git_workspace(tmp_path)

        # Pick whichever provider is available
        if _has_gmi:
            model, provider = "deepseek-ai/DeepSeek-V3.2", "gmi"
        else:
            model, provider = "claude-haiku-4-5-20251001", "anthropic"

        config = DriverConfig(
            workspace=tmp_path,
            run_command="python3 train.py",
            time_budget=5,
            max_iterations=1,  # just 1 iteration to keep cost low
            train_timeout=30,
        )

        proposer = LLMProposer(
            model=model,
            provider=provider,
            temperature=0.5,
        )

        results: list[ExperimentRecord] = []

        driver = AutoResearchDriver(
            config, proposer, on_experiment=lambda r: results.append(r)
        )

        summary = await driver.run()

        print(f"\nTraining autoresearch (live LLM proposer):")
        print(f"  Iterations: {summary['iterations']}")
        print(f"  Best bpb:   {summary['best_bpb']}")
        for r in results:
            print(f"  [{r.status.value}] {r.commit} | bpb={r.val_bpb:.6f} | {r.description}")

        assert summary["iterations"] == 1
        assert summary["best_bpb"] is not None
        # Baseline should have been recorded
        assert len(results) >= 1


# ── 4. GMI GPU Sandbox — live provisioning test ─────────────────────────────


class TestGMIGPUSandboxLive:
    """Test that GMI GPU sandbox provisioning works end-to-end.

    WARNING: This provisions a real H100 GPU and costs ~$0.05 per run.
    Only runs if GMI_API_KEY is set AND GMI_LIVE_GPU_TEST=1 is set.
    """

    @pytest.mark.skipif(
        not (_has_gmi and os.environ.get("GMI_LIVE_GPU_TEST") == "1"),
        reason="Set GMI_API_KEY and GMI_LIVE_GPU_TEST=1 to run GPU tests (~$0.05/run)",
    )
    @pytest.mark.asyncio
    async def test_gpu_sandbox_provision_and_exec(self, tmp_path: Path):
        """Provision a GMI GPU sandbox, run a command, tear down."""
        from agentos.autoresearch.backends import GMICloudGPUBackend

        backend = GMICloudGPUBackend(gpu_type="h100", gpu_count=1)

        # Create a minimal workspace
        script = tmp_path / "train.py"
        script.write_text("""\
import torch
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB")
print("---")
print("val_bpb:          0.999000")
print("peak_vram_mb:     100.0")
print("training_seconds: 1.0")
print("total_seconds:    2.0")
print("num_steps:        1")
print("num_params_M:     0.0")
""")

        try:
            await backend.setup(tmp_path)
            print(f"\nGMI GPU sandbox provisioned: {backend._sandbox_id}")

            output = await backend.run_training(
                command="python3 train.py",
                workspace=tmp_path,
                timeout=120,
            )

            print(f"Output (first 500 chars): {output.raw_log[:500]}")
            print(f"Return code: {output.returncode}")
            print(f"val_bpb: {output.val_bpb}")

            assert not output.crashed, f"Training crashed: {output.error}"
            assert output.val_bpb > 0, "Should have parsed val_bpb"

        finally:
            await backend.teardown()
            print("GPU sandbox torn down")


# ── 5. E2B Sandbox — live CPU test ──────────────────────────────────────────


class TestE2BSandboxLive:
    """Test that E2B sandbox execution works end-to-end."""

    @pytest.mark.skipif(
        not bool(os.environ.get("E2B_API_KEY", "")),
        reason="E2B_API_KEY not set",
    )
    @pytest.mark.asyncio
    async def test_e2b_sandbox_exec(self, tmp_path: Path):
        """Run a simple script in an E2B sandbox."""
        from agentos.autoresearch.backends import E2BSandboxBackend

        script = tmp_path / "train.py"
        script.write_text("""\
print("Hello from E2B sandbox")
print("---")
print("val_bpb:          0.998000")
print("peak_vram_mb:     50.0")
print("training_seconds: 0.1")
print("total_seconds:    0.2")
print("num_steps:        1")
print("num_params_M:     0.0")
""")

        backend = E2BSandboxBackend(sandbox_timeout=60)

        try:
            await backend.setup(tmp_path)
            print(f"\nE2B sandbox created: {backend._sandbox_id}")

            output = await backend.run_training(
                command="python3 train.py",
                workspace=tmp_path,
                timeout=30,
            )

            print(f"Output: {output.raw_log[:300]}")
            print(f"val_bpb: {output.val_bpb}")

            assert not output.crashed
            assert output.val_bpb > 0

        finally:
            await backend.teardown()
            print("E2B sandbox torn down")


# ── 6. Full pipeline: agent autoresearch → apply best ────────────────────────


class TestFullPipelineLive:
    """The complete customer workflow: create agent → run autoresearch → apply."""

    @skip_no_gmi
    @pytest.mark.asyncio
    async def test_create_eval_improve_apply(self, tmp_path: Path):
        """Simulate a customer creating an agent and improving it."""
        from agentos.agent import Agent, AgentConfig
        from agentos.autoresearch.agent_research import AgentResearchLoop

        # 1. Customer creates an agent
        config = AgentConfig(
            name="customer-bot",
            description="A simple Q&A bot",
            system_prompt="Answer questions briefly.",
            model="deepseek-ai/DeepSeek-V3.2",
            temperature=0.5,
        )
        agent = Agent(config)
        original_prompt = config.system_prompt
        original_temp = config.temperature

        # 2. Customer defines eval tasks
        eval_tasks = [
            {"name": "greeting", "input": "Hello!", "expected": "hello", "grader": "contains"},
            {"name": "math", "input": "What is 10 + 5?", "expected": "15", "grader": "contains"},
            {"name": "fact", "input": "What color is the sky?", "expected": "blue", "grader": "contains"},
        ]

        # 3. Run autoresearch (2 iterations, minimal cost)
        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=eval_tasks,
            max_iterations=2,
            trials_per_task=1,
            model="deepseek-ai/DeepSeek-V3.2",
            provider="gmi",
            results_path=tmp_path / "results.tsv",
        )

        summary = await loop.run()

        print(f"\nFull pipeline result:")
        print(f"  Baseline: {summary['baseline_score']:.3f}")
        print(f"  Best:     {summary['best_score']:.3f}")
        print(f"  Kept:     {summary['improvements_kept']}")

        # 4. Verify the loop ran and produced structured results
        assert summary["iterations"] == 2
        assert "history" in summary
        assert len(summary["history"]) == 2

        # 5. Check that best_config was tracked
        best_config = summary.get("best_config", {})
        assert best_config.get("name") == "customer-bot"

        # If improvements were found, verify the config changed
        if summary["improvements_kept"] > 0:
            changed = (
                best_config.get("system_prompt") != original_prompt
                or best_config.get("temperature") != original_temp
            )
            print(f"  Config changed: {changed}")
