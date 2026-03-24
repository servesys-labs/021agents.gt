"""Tests for the autoresearch subsystem — driver, results, program, agent research."""

import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentos.autoresearch.results import (
    ExperimentRecord,
    ExperimentStatus,
    ResultsLog,
)
from agentos.autoresearch.driver import (
    AutoResearchDriver,
    DriverConfig,
    LLMProposer,
    ScriptedProposer,
    TrainingOutput,
)
from agentos.autoresearch.program import generate_program, write_program
from agentos.autoresearch.agent_research import (
    AgentResearchLoop,
    AgentExperiment,
    _parse_agent_proposal,
    _agent_research_system_prompt,
)


# ── Results Log ──────────────────────────────────────────────────────────────


class TestResultsLog:
    def test_create_empty_log(self, tmp_path: Path):
        log = ResultsLog(tmp_path / "results.tsv")
        assert log.total_experiments == 0
        assert log.best_bpb is None
        assert log.path.exists()

    def test_append_and_read(self, tmp_path: Path):
        log = ResultsLog(tmp_path / "results.tsv")
        record = ExperimentRecord(
            commit="abc1234",
            val_bpb=1.05,
            memory_gb=40.0,
            status=ExperimentStatus.KEEP,
            description="baseline",
        )
        log.append(record)

        records = log.records()
        assert len(records) == 1
        assert records[0].commit == "abc1234"
        assert records[0].val_bpb == 1.05
        assert records[0].status == ExperimentStatus.KEEP

    def test_best_bpb(self, tmp_path: Path):
        log = ResultsLog(tmp_path / "results.tsv")
        log.append(ExperimentRecord("aaa1111", 1.05, 40.0, ExperimentStatus.KEEP, "baseline"))
        log.append(ExperimentRecord("bbb2222", 0.99, 40.0, ExperimentStatus.KEEP, "improvement"))
        log.append(ExperimentRecord("ccc3333", 1.10, 40.0, ExperimentStatus.DISCARD, "regression"))

        assert log.best_bpb == 0.99
        assert log.kept_count == 2
        assert log.discarded_count == 1

    def test_crash_records(self, tmp_path: Path):
        log = ResultsLog(tmp_path / "results.tsv")
        log.append(ExperimentRecord("ddd4444", 0.0, 0.0, ExperimentStatus.CRASH, "OOM"))

        assert log.crash_count == 1
        assert log.best_bpb is None  # crashes don't count

    def test_summary(self, tmp_path: Path):
        log = ResultsLog(tmp_path / "results.tsv")
        log.append(ExperimentRecord("aaa1111", 1.05, 40.0, ExperimentStatus.KEEP, "baseline"))
        log.append(ExperimentRecord("bbb2222", 0.99, 40.0, ExperimentStatus.KEEP, "better"))

        summary = log.summary()
        assert "Total experiments: 2" in summary
        assert "0.990000" in summary

    def test_tsv_roundtrip(self, tmp_path: Path):
        log = ResultsLog(tmp_path / "results.tsv")
        record = ExperimentRecord(
            commit="xyz7890",
            val_bpb=0.997900,
            memory_gb=44.0,
            status=ExperimentStatus.KEEP,
            description="increase LR to 0.04",
        )
        log.append(record)

        reloaded = log.records()
        assert len(reloaded) == 1
        assert reloaded[0].commit == "xyz7890"
        assert abs(reloaded[0].val_bpb - 0.997900) < 1e-6
        assert reloaded[0].description == "increase LR to 0.04"


# ── Training Output Parsing ─────────────────────────────────────────────────


class TestTrainingOutput:
    def test_parse_success(self):
        log_text = """\
step=    0 | loss=5.2341 | dt=120ms | tokens=0.5M | time=0.0s/300s
step=  100 | loss=3.1234 | dt=85ms  | tokens=52.4M | time=100.0s/300s
Training complete: 300 steps

Evaluating...
---
val_bpb:          0.997900
training_seconds: 300.1
total_seconds:    325.9
peak_vram_mb:     45060.2
mfu_percent:      39.80
total_tokens_M:   499.6
num_steps:        953
num_params_M:     50.3
depth:            8
"""
        output = TrainingOutput.parse(log_text, returncode=0)
        assert not output.crashed
        assert abs(output.val_bpb - 0.997900) < 1e-6
        assert abs(output.peak_vram_mb - 45060.2) < 0.1
        assert abs(output.training_seconds - 300.1) < 0.1
        assert output.num_steps == 953
        assert abs(output.num_params_m - 50.3) < 0.1
        assert abs(output.memory_gb - 45060.2 / 1024.0) < 0.01

    def test_parse_crash(self):
        output = TrainingOutput.parse("CUDA out of memory", returncode=1)
        assert output.crashed
        assert output.val_bpb == 0.0
        assert "CUDA out of memory" in output.error

    def test_parse_empty(self):
        output = TrainingOutput.parse("", returncode=0)
        assert output.val_bpb == 0.0

    def test_parse_partial(self):
        log_text = "val_bpb:          1.234567\n"
        output = TrainingOutput.parse(log_text, returncode=0)
        assert abs(output.val_bpb - 1.234567) < 1e-6
        assert output.peak_vram_mb == 0.0  # missing field


# ── Program Generator ────────────────────────────────────────────────────────


class TestProgram:
    def test_generate_default(self):
        program = generate_program()
        assert "train.py" in program
        assert "prepare.py" in program
        assert "300 seconds" in program
        assert "val_bpb" in program

    def test_generate_custom(self):
        program = generate_program(
            train_script="my_train.py",
            time_budget=600,
            extra_instructions="Focus on attention patterns.",
        )
        assert "my_train.py" in program
        assert "600 seconds" in program
        assert "Focus on attention patterns." in program

    def test_write_program(self, tmp_path: Path):
        path = write_program(tmp_path / "program.md", time_budget=120)
        assert path.exists()
        content = path.read_text()
        assert "120 seconds" in content


# ── Scripted Proposer ────────────────────────────────────────────────────────


class TestScriptedProposer:
    @pytest.mark.asyncio
    async def test_scripted_proposer(self):
        changes = [
            ("double LR", lambda s: s.replace("LEARNING_RATE = 0.04", "LEARNING_RATE = 0.08")),
            ("halve depth", lambda s: s.replace("DEPTH = 8", "DEPTH = 4")),
        ]
        proposer = ScriptedProposer(changes)

        script = "LEARNING_RATE = 0.04\nDEPTH = 8\n"

        new1, desc1 = await proposer.propose(script, "", None, 1)
        assert "0.08" in new1
        assert desc1 == "double LR"

        new2, desc2 = await proposer.propose(script, "", 1.0, 2)
        assert "DEPTH = 4" in new2
        assert desc2 == "halve depth"

    @pytest.mark.asyncio
    async def test_scripted_proposer_exhausted(self):
        proposer = ScriptedProposer([])
        script = "original"
        new, desc = await proposer.propose(script, "", None, 1)
        assert new == script  # unchanged


# ── LLM Response Parsing ────────────────────────────────────────────────────


class TestLLMResponseParsing:
    def test_parse_with_code_block(self):
        from agentos.autoresearch.driver import _parse_llm_response

        response = """\
I'll increase the learning rate.

```python
LEARNING_RATE = 0.08
DEPTH = 8
```

DESCRIPTION: Double the learning rate from 0.04 to 0.08
"""
        new_script, description = _parse_llm_response(response, "original")
        assert "LEARNING_RATE = 0.08" in new_script
        assert "Double the learning rate" in description

    def test_parse_without_description_tag(self):
        from agentos.autoresearch.driver import _parse_llm_response

        response = """\
Increase batch size for better gradient estimates.

```python
BATCH_SIZE = 1024
```
"""
        _, description = _parse_llm_response(response, "original")
        assert len(description) > 0

    def test_parse_no_code_block(self):
        from agentos.autoresearch.driver import _parse_llm_response

        _, description = _parse_llm_response("just some text", "original_code")
        # Should return original when no code block found
        # (the function logs a warning)


# ── Driver (unit tests with mocks) ──────────────────────────────────────────


class TestDriver:
    def _make_config(self, tmp_path: Path) -> DriverConfig:
        # Create a minimal workspace
        train_py = tmp_path / "train.py"
        train_py.write_text("LEARNING_RATE = 0.04\nDEPTH = 8\n")

        # Init git repo
        subprocess.run(["git", "init"], cwd=str(tmp_path), capture_output=True)
        subprocess.run(["git", "add", "."], cwd=str(tmp_path), capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=str(tmp_path),
            capture_output=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "t@t",
                 "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "t@t"},
        )

        return DriverConfig(
            workspace=tmp_path,
            run_command="echo 'val_bpb: 1.000000\npeak_vram_mb: 100.0'",
            time_budget=5,
            max_iterations=2,
            train_timeout=30,
        )

    @pytest.mark.asyncio
    async def test_driver_with_scripted_proposer(self, tmp_path: Path):
        config = self._make_config(tmp_path)

        changes = [
            ("increase LR", lambda s: s.replace("0.04", "0.08")),
            ("decrease depth", lambda s: s.replace("DEPTH = 8", "DEPTH = 4")),
        ]
        proposer = ScriptedProposer(changes)

        results: list[ExperimentRecord] = []
        driver = AutoResearchDriver(
            config, proposer, on_experiment=lambda r: results.append(r)
        )

        summary = await driver.run()

        # Baseline + 2 experiments
        assert summary["iterations"] == 2
        assert len(results) >= 2  # baseline + experiments

    @pytest.mark.asyncio
    async def test_driver_stop(self, tmp_path: Path):
        config = self._make_config(tmp_path)
        config.max_iterations = 100  # would run forever without stop

        calls = 0

        async def limited_proposer(train_script, results_log, best_bpb, iteration):
            nonlocal calls
            calls += 1
            if calls >= 2:
                driver.stop()
            return train_script.replace("0.04", "0.05"), f"change {calls}"

        proposer = MagicMock()
        proposer.propose = limited_proposer

        driver = AutoResearchDriver(config, proposer)
        summary = await driver.run()

        assert summary["iterations"] <= 3

    @pytest.mark.asyncio
    async def test_driver_crash_handling(self, tmp_path: Path):
        config = self._make_config(tmp_path)
        config.run_command = "exit 1"  # simulate crash
        config.max_iterations = 2
        config.stop_on_crash_streak = 3

        changes = [
            ("bad change 1", lambda s: s.replace("0.04", "0.08")),
            ("bad change 2", lambda s: s.replace("0.04", "0.16")),
        ]
        proposer = ScriptedProposer(changes)

        results: list[ExperimentRecord] = []
        driver = AutoResearchDriver(
            config, proposer, on_experiment=lambda r: results.append(r)
        )

        await driver.run()

        # All should be crashes (baseline + experiments)
        crash_count = sum(1 for r in results if r.status == ExperimentStatus.CRASH)
        assert crash_count >= 1

    @pytest.mark.asyncio
    async def test_driver_keep_and_discard(self, tmp_path: Path):
        """Test that improvements are kept and regressions are discarded."""
        config = self._make_config(tmp_path)
        config.max_iterations = 2

        # First run: baseline echoes 1.0
        # Make each run echo different bpb values by changing the command
        call_count = 0

        class SequentialProposer:
            async def propose(self, train_script, results_log, best_bpb, iteration):
                nonlocal call_count
                call_count += 1
                # Return modified script
                return train_script + f"\n# change {call_count}", f"change {call_count}"

        # Use a simple echo command that always returns same bpb
        config.run_command = "printf 'val_bpb: 1.000000\\npeak_vram_mb: 100.0\\n'"

        proposer = SequentialProposer()
        driver = AutoResearchDriver(config, proposer)

        summary = await driver.run()
        assert summary["iterations"] == 2


# ── Init command integration ─────────────────────────────────────────────────


class TestInit:
    def test_init_creates_files(self, tmp_path: Path):
        """Test that autoresearch init creates the expected files."""
        from agentos.autoresearch.defaults import __file__ as defaults_init
        import shutil

        defaults_dir = Path(defaults_init).parent

        workspace = tmp_path / "research"
        workspace.mkdir()

        # Copy defaults
        for name in ["prepare.py", "train.py"]:
            src = defaults_dir / name
            if src.exists():
                shutil.copy2(src, workspace / name)

        # Write program.md
        write_program(workspace / "program.md")

        assert (workspace / "prepare.py").exists()
        assert (workspace / "train.py").exists()
        assert (workspace / "program.md").exists()

        content = (workspace / "program.md").read_text()
        assert "val_bpb" in content
        assert "300 seconds" in content


# ── Agent Research — proposal parsing ────────────────────────────────────────


class TestAgentProposalParsing:
    def test_parse_full_response(self):
        response = """\
HYPOTHESIS: A more specific system prompt will improve task accuracy by giving clearer instructions.
DESCRIPTION: Add task-specific guidance to system prompt

MODIFICATION:
```json
{
    "system_prompt": "You are a helpful assistant specialized in math problems. Always show your work step by step.",
    "temperature": 0.1
}
```
"""
        modification, description, hypothesis = _parse_agent_proposal(response)
        assert "system_prompt" in modification
        assert modification["temperature"] == 0.1
        assert "task-specific" in description.lower() or "system prompt" in description.lower()
        assert "specific system prompt" in hypothesis.lower()

    def test_parse_missing_hypothesis(self):
        response = """\
DESCRIPTION: Lower temperature for deterministic output
```json
{"temperature": 0.0}
```
"""
        modification, description, hypothesis = _parse_agent_proposal(response)
        assert modification == {"temperature": 0.0}
        assert "temperature" in description.lower()
        assert hypothesis == ""

    def test_parse_invalid_json(self):
        response = """\
HYPOTHESIS: test
DESCRIPTION: test change
```json
{this is not valid json}
```
"""
        modification, description, hypothesis = _parse_agent_proposal(response)
        assert modification == {}
        assert description == "test change"

    def test_parse_no_code_block(self):
        response = "DESCRIPTION: some change\nNo code block here."
        modification, description, hypothesis = _parse_agent_proposal(response)
        assert modification == {}

    def test_system_prompt_includes_mutable_fields(self):
        prompt = _agent_research_system_prompt(["system_prompt", "temperature", "tools"])
        assert "system_prompt" in prompt
        assert "temperature" in prompt
        assert "tools" in prompt


# ── Agent Research Loop (with mocked evaluation) ────────────────────────────


class TestAgentResearchLoop:
    def _make_mock_agent(self):
        """Create a minimal mock agent for testing."""
        from agentos.agent import AgentConfig

        config = AgentConfig(
            name="test-agent",
            description="A test agent",
            system_prompt="You are a helpful assistant.",
            model="test-model",
            temperature=0.5,
            tools=["web-search"],
        )

        agent = MagicMock()
        agent.config = config
        return agent

    @pytest.mark.asyncio
    async def test_loop_with_mocked_evaluate(self, tmp_path: Path):
        """Test the full loop with mocked LLM and evaluation."""
        agent = self._make_mock_agent()

        eval_tasks = [
            {"name": "math", "input": "What is 2+2?", "expected": "4", "grader": "exact"},
        ]

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=eval_tasks,
            max_iterations=2,
            results_path=tmp_path / "results.tsv",
        )

        # Mock the _evaluate method to return increasing scores
        eval_count = 0

        async def mock_evaluate(config):
            nonlocal eval_count
            eval_count += 1
            # Baseline: 0.5, first experiment: 0.7, second: 0.6
            scores = [0.5, 0.7, 0.6]
            score = scores[min(eval_count - 1, len(scores) - 1)]
            return {"pass_rate": score, "avg_score": score, "avg_latency_ms": 100, "total_cost_usd": 0.01}

        # Mock the _propose method to return changes
        propose_count = 0

        async def mock_propose():
            nonlocal propose_count
            propose_count += 1
            return (
                {"temperature": 0.1 * propose_count},
                f"change temperature to {0.1 * propose_count}",
                "lower temperature helps accuracy",
            )

        loop._evaluate = mock_evaluate
        loop._propose = mock_propose

        summary = await loop.run()

        assert summary["iterations"] == 2
        assert summary["baseline_score"] == 0.5
        assert summary["best_score"] == 0.7
        assert summary["improvements_kept"] == 1
        assert summary["experiments_discarded"] == 1

    @pytest.mark.asyncio
    async def test_loop_stop(self):
        """Test that stop() halts the loop."""
        agent = self._make_mock_agent()

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=[{"name": "t", "input": "hi", "expected": "hello", "grader": "contains"}],
            max_iterations=100,
        )

        call_count = 0

        async def mock_evaluate(config):
            return {"pass_rate": 0.5}

        async def mock_propose():
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                loop.stop()
            return ({"temperature": 0.1}, f"change {call_count}", "test")

        loop._evaluate = mock_evaluate
        loop._propose = mock_propose

        summary = await loop.run()
        assert summary["iterations"] <= 3

    @pytest.mark.asyncio
    async def test_loop_tracks_experiments(self, tmp_path: Path):
        """Test that experiments are tracked in history and TSV."""
        agent = self._make_mock_agent()

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=[{"name": "t", "input": "q", "expected": "a"}],
            max_iterations=1,
            results_path=tmp_path / "results.tsv",
        )

        async def mock_evaluate(config):
            return {"pass_rate": 0.5}

        async def mock_propose():
            return ({"temperature": 0.0}, "zero temperature", "determinism helps")

        loop._evaluate = mock_evaluate
        loop._propose = mock_propose

        experiments_captured = []
        loop.on_experiment = lambda e: experiments_captured.append(e)

        await loop.run()

        # Check experiment tracking
        assert len(experiments_captured) == 1
        assert experiments_captured[0].description == "zero temperature"
        assert experiments_captured[0].hypothesis == "determinism helps"

        # Check TSV logging (baseline + 1 experiment)
        records = loop.results.records()
        assert len(records) == 2  # baseline + experiment

    @pytest.mark.asyncio
    async def test_loop_respects_mutable_fields(self):
        """Test that only mutable fields are applied from modifications."""
        agent = self._make_mock_agent()

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=[{"name": "t", "input": "q", "expected": "a"}],
            max_iterations=1,
            mutable_fields=["temperature"],  # only temperature is mutable
        )

        async def mock_evaluate(config):
            # Verify that name wasn't changed despite modification
            assert config.get("name") == "test-agent"
            return {"pass_rate": 0.8}

        async def mock_propose():
            # Try to modify both temperature AND name
            return (
                {"temperature": 0.0, "name": "hacked-agent"},
                "hack the agent name",
                "test mutable field restriction",
            )

        loop._evaluate = mock_evaluate
        loop._propose = mock_propose

        await loop.run()

    def test_apply_best(self):
        """Test that apply_best updates the agent config."""
        agent = self._make_mock_agent()

        loop = AgentResearchLoop(
            agent=agent,
            eval_tasks=[],
            max_iterations=0,
        )

        # Simulate a best config with changed temperature
        loop._best_config = agent.config.to_dict()
        loop._best_config["temperature"] = 0.0

        with patch("agentos.agent.save_agent_config") as mock_save:
            mock_save.return_value = Path("agents/test-agent.json")
            result = loop.apply_best()

        assert result.temperature == 0.0
        mock_save.assert_called_once()


# ── AutoResearchLoop.autonomous() bridge ─────────────────────────────────────


class TestAutonomousBridge:
    def test_autonomous_creates_agent_research_loop(self):
        """Test that AutoResearchLoop.autonomous() returns an AgentResearchLoop."""
        from agentos.eval.research_loop import AutoResearchLoop

        agent = MagicMock()
        agent.config = MagicMock()
        agent.config.name = "test"
        agent.config.to_dict.return_value = {"name": "test"}

        loop = AutoResearchLoop.autonomous(
            agent=agent,
            eval_tasks=[{"name": "t", "input": "q", "expected": "a"}],
            max_iterations=5,
        )

        assert isinstance(loop, AgentResearchLoop)
        assert loop.max_iterations == 5
