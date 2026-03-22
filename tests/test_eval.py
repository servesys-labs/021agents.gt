"""Tests for the evaluation gym, graders, and auto-research loop."""

import asyncio
import pytest

from agentos.eval.grader import ContainsGrader, ExactMatchGrader, GradeResult, LLMGrader
from agentos.eval.gym import AgentResult, EvalGym, EvalReport, EvalTask, TrialResult
from agentos.eval.research_loop import AutoResearchLoop, Hypothesis


# ── Graders ───────────────────────────────────────────────────────────────────


class TestGraders:
    def test_exact_match(self):
        grader = ExactMatchGrader()
        assert grader.grade("hello", "Hello").passed is True
        assert grader.grade("hello", "world").passed is False

    def test_exact_match_case_sensitive(self):
        grader = ExactMatchGrader(case_sensitive=True)
        assert grader.grade("Hello", "hello").passed is False

    def test_contains(self):
        grader = ContainsGrader()
        assert grader.grade("world", "Hello world!").passed is True
        assert grader.grade("xyz", "Hello world!").passed is False

    def test_llm_grader_heuristic(self):
        """LLMGrader without a provider uses word-overlap heuristic."""
        grader = LLMGrader(criteria="correctness")
        result = grader.grade("python programming language", "Python is a programming language")
        assert result.score > 0
        assert result.details["method"] == "word_overlap_heuristic"

    def test_llm_grader_heuristic_empty(self):
        """Heuristic should handle empty strings."""
        grader = LLMGrader()
        result = grader.grade("", "anything")
        assert isinstance(result.score, float)

    def test_llm_grader_custom_threshold(self):
        """LLMGrader should respect custom pass_threshold."""
        grader = LLMGrader(pass_threshold=0.9)
        # Word overlap is likely < 0.9 for partial match
        result = grader.grade("unique specific words", "just one unique word here")
        assert result.passed is False

    @pytest.mark.asyncio
    async def test_llm_grader_with_stub_provider(self):
        """LLMGrader with a provider should call LLM for grading."""
        from agentos.llm.provider import StubProvider
        provider = StubProvider()
        grader = LLMGrader(criteria="accuracy", provider=provider)
        # agrade falls back to heuristic because StubProvider doesn't
        # return valid JSON — but it should not crash
        result = await grader.agrade("expected answer", "actual answer")
        assert isinstance(result, GradeResult)
        assert 0.0 <= result.score <= 1.0

    @pytest.mark.asyncio
    async def test_llm_grader_agrade_no_provider(self):
        """agrade without provider should use heuristic."""
        grader = LLMGrader()
        result = await grader.agrade("hello world", "hello world")
        assert result.passed is True
        assert result.details["method"] == "word_overlap_heuristic"


# ── AgentResult ───────────────────────────────────────────────────────────────


class TestAgentResult:
    def test_plain_string_backward_compat(self):
        """Gym should accept plain str returns from agent functions."""
        from agentos.eval.gym import _unpack_agent_output
        result = _unpack_agent_output("hello")
        assert isinstance(result, AgentResult)
        assert result.output == "hello"
        assert result.cost_usd == 0.0
        assert result.tool_calls_count == 0

    def test_agent_result_passthrough(self):
        """AgentResult should pass through unchanged."""
        from agentos.eval.gym import _unpack_agent_output
        ar = AgentResult(output="hello", cost_usd=0.05, tool_calls_count=3)
        result = _unpack_agent_output(ar)
        assert result is ar
        assert result.cost_usd == 0.05
        assert result.tool_calls_count == 3


# ── EvalGym Core ──────────────────────────────────────────────────────────────


class TestEvalGym:
    @pytest.mark.asyncio
    async def test_run(self):
        gym = EvalGym(trials_per_task=2)
        gym.add_task(EvalTask(
            name="greeting",
            input="Say hello",
            expected="hello",
            grader=ContainsGrader(),
        ))

        async def echo_agent(input: str) -> str:
            return f"hello, you said: {input}"

        report = await gym.run(echo_agent)
        assert report.total_tasks == 1
        assert report.total_trials == 2
        assert report.pass_rate == 1.0

    @pytest.mark.asyncio
    async def test_pass_at_k(self):
        gym = EvalGym(trials_per_task=4)
        gym.add_task(EvalTask(
            name="coin_flip",
            input="flip",
            expected="heads",
            grader=ContainsGrader(),
        ))

        call_count = 0

        async def flaky_agent(input: str) -> str:
            nonlocal call_count
            call_count += 1
            # Pass on 2 out of 4 trials
            return "heads" if call_count % 2 == 0 else "tails"

        report = await gym.run(flaky_agent)
        assert report.pass_rate == 0.5
        # pass@1 should be < 1.0, pass@4 should be 1.0
        assert report.pass_at_k(1) < 1.0
        assert report.pass_at_k(4) == 1.0
        # pass@k with k=None uses all trials
        assert report.pass_at_k() == 1.0

    @pytest.mark.asyncio
    async def test_tool_efficiency(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(
            name="simple",
            input="test",
            expected="ok",
            grader=ContainsGrader(),
        ))

        async def agent(input: str) -> str:
            return "ok"

        report = await gym.run(agent)
        # No tool calls → tool_efficiency should be 1.0
        assert report.tool_efficiency == 1.0


# ── Cost & Tool Tracking ─────────────────────────────────────────────────────


class TestCostAndToolTracking:
    @pytest.mark.asyncio
    async def test_agent_result_cost_tracked(self):
        """Cost from AgentResult should flow into TrialResult and EvalReport."""
        gym = EvalGym(trials_per_task=2)
        gym.add_task(EvalTask(
            name="cost_test",
            input="hello",
            expected="hello",
            grader=ContainsGrader(),
        ))

        async def agent(input: str) -> AgentResult:
            return AgentResult(output="hello", cost_usd=0.05, tool_calls_count=3)

        report = await gym.run(agent)
        # Total cost should be 2 trials * $0.05 = $0.10
        assert report.total_cost_usd == pytest.approx(0.10, abs=1e-6)
        # Each trial should have the cost
        assert all(t.cost_usd == 0.05 for t in report.trial_results)

    @pytest.mark.asyncio
    async def test_agent_result_tool_calls_tracked(self):
        """tool_calls_count from AgentResult should flow into reports."""
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(
            name="tool_test",
            input="hello",
            expected="hello",
            grader=ContainsGrader(),
        ))

        async def agent(input: str) -> AgentResult:
            return AgentResult(output="hello", tool_calls_count=5)

        report = await gym.run(agent)
        assert report.avg_tool_calls == 5.0
        assert report.trial_results[0].tool_calls_count == 5
        # 1 pass / 5 tool calls = 0.2 efficiency
        assert report.tool_efficiency == pytest.approx(0.2)

    @pytest.mark.asyncio
    async def test_mixed_str_and_agent_result(self):
        """Gym should handle agents that return str and AgentResult."""
        gym = EvalGym(trials_per_task=2)
        gym.add_task(EvalTask(
            name="mixed",
            input="hello",
            expected="hello",
            grader=ContainsGrader(),
        ))

        call_count = 0

        async def agent(input: str):
            nonlocal call_count
            call_count += 1
            if call_count % 2 == 0:
                return AgentResult(output="hello", cost_usd=0.02, tool_calls_count=1)
            return "hello"

        report = await gym.run(agent)
        assert report.total_cost_usd == pytest.approx(0.02)
        assert report.pass_count == 2


# ── Error Handling ────────────────────────────────────────────────────────────


class TestErrorHandling:
    @pytest.mark.asyncio
    async def test_exception_doesnt_crash_gym(self):
        """An agent exception should produce a failed trial, not crash."""
        gym = EvalGym(trials_per_task=3)
        gym.add_task(EvalTask(
            name="flaky",
            input="boom",
            expected="ok",
            grader=ContainsGrader(),
        ))

        call_count = 0

        async def flaky_agent(input: str) -> str:
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise ValueError("Simulated failure")
            return "ok"

        report = await gym.run(flaky_agent)
        assert report.total_trials == 3
        assert report.pass_count == 2
        assert report.error_count == 1
        # The errored trial should have error set
        errored = [t for t in report.trial_results if t.error is not None]
        assert len(errored) == 1
        assert "Simulated failure" in errored[0].error
        assert errored[0].grade.passed is False

    @pytest.mark.asyncio
    async def test_timeout_produces_failed_trial(self):
        """A timed-out trial should be marked as failed, not crash."""
        gym = EvalGym(trials_per_task=1, trial_timeout_seconds=0.1)
        gym.add_task(EvalTask(
            name="slow",
            input="wait",
            expected="done",
            grader=ContainsGrader(),
        ))

        async def slow_agent(input: str) -> str:
            await asyncio.sleep(5)
            return "done"

        report = await gym.run(slow_agent)
        assert report.total_trials == 1
        assert report.pass_count == 0
        assert report.error_count == 1
        assert "Timed out" in report.trial_results[0].error

    @pytest.mark.asyncio
    async def test_all_trials_fail_gracefully(self):
        """If all trials fail with exceptions, report should still be valid."""
        gym = EvalGym(trials_per_task=2)
        gym.add_task(EvalTask(
            name="broken",
            input="fail",
            expected="never",
            grader=ContainsGrader(),
        ))

        async def broken_agent(input: str) -> str:
            raise RuntimeError("Always fails")

        report = await gym.run(broken_agent)
        assert report.total_trials == 2
        assert report.pass_count == 0
        assert report.error_count == 2
        assert report.pass_rate == 0.0
        assert report.avg_score == 0.0


# ── Parallel Execution ───────────────────────────────────────────────────────


class TestParallelExecution:
    @pytest.mark.asyncio
    async def test_parallel_same_results_as_sequential(self):
        """Parallel execution should produce same aggregate metrics."""
        task = EvalTask(
            name="echo",
            input="hello",
            expected="hello",
            grader=ContainsGrader(),
        )

        async def agent(input: str) -> str:
            return "hello"

        # Sequential
        gym_seq = EvalGym(trials_per_task=4, max_concurrency=1)
        gym_seq.add_task(task)
        report_seq = await gym_seq.run(agent)

        # Parallel
        gym_par = EvalGym(trials_per_task=4, max_concurrency=4)
        gym_par.add_task(task)
        report_par = await gym_par.run(agent)

        assert report_seq.pass_rate == report_par.pass_rate
        assert report_seq.total_trials == report_par.total_trials

    @pytest.mark.asyncio
    async def test_parallel_faster_than_sequential(self):
        """Parallel should be faster when trials have I/O wait."""
        task = EvalTask(
            name="slow_echo",
            input="hello",
            expected="hello",
            grader=ContainsGrader(),
        )

        async def slow_agent(input: str) -> str:
            await asyncio.sleep(0.05)
            return "hello"

        # Sequential: 4 * 50ms = ~200ms
        gym_seq = EvalGym(trials_per_task=4, max_concurrency=1)
        gym_seq.add_task(task)
        import time
        t0 = time.monotonic()
        await gym_seq.run(slow_agent)
        seq_time = time.monotonic() - t0

        # Parallel: 4 trials at max_concurrency=4 = ~50ms
        gym_par = EvalGym(trials_per_task=4, max_concurrency=4)
        gym_par.add_task(task)
        t0 = time.monotonic()
        await gym_par.run(slow_agent)
        par_time = time.monotonic() - t0

        # Parallel should be at least 2x faster
        assert par_time < seq_time * 0.75

    @pytest.mark.asyncio
    async def test_semaphore_limits_concurrency(self):
        """max_concurrency should bound how many trials run at once."""
        import threading
        peak_concurrent = 0
        current_concurrent = 0
        lock = threading.Lock()

        task = EvalTask(
            name="concurrent",
            input="go",
            expected="done",
            grader=ContainsGrader(),
        )

        async def counting_agent(input: str) -> str:
            nonlocal peak_concurrent, current_concurrent
            with lock:
                current_concurrent += 1
                peak_concurrent = max(peak_concurrent, current_concurrent)
            await asyncio.sleep(0.05)
            with lock:
                current_concurrent -= 1
            return "done"

        gym = EvalGym(trials_per_task=8, max_concurrency=2)
        gym.add_task(task)
        await gym.run(counting_agent)

        assert peak_concurrent <= 2


# ── EvalReport ────────────────────────────────────────────────────────────────


class TestEvalReport:
    def test_to_dict_includes_error_count(self):
        report = EvalReport(
            total_tasks=1,
            total_trials=2,
            pass_count=1,
            fail_count=1,
            error_count=1,
        )
        d = report.to_dict()
        assert d["error_count"] == 1

    def test_empty_report(self):
        report = EvalReport()
        assert report.pass_rate == 0.0
        assert report.pass_at_k(1) == 0.0
        assert report.tool_efficiency == 1.0
        d = report.to_dict()
        assert d["pass_rate"] == 0.0


# ── TrialResult metadata ─────────────────────────────────────────────────────


class TestTrialMetadata:
    @pytest.mark.asyncio
    async def test_agent_result_metadata_preserved(self):
        """Metadata from AgentResult should be preserved in TrialResult."""
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(
            name="meta_test",
            input="hello",
            expected="hello",
            grader=ContainsGrader(),
        ))

        async def agent(input: str) -> AgentResult:
            return AgentResult(
                output="hello",
                metadata={"custom_key": "custom_value"},
            )

        report = await gym.run(agent)
        assert report.trial_results[0].metadata == {"custom_key": "custom_value"}


# ── Agentic Eval Extensions (Every Eval Ever gaps) ───────────────────────────


class TestFinishAccepted:
    """Gap 1: finish_accepted — did the grader accept the output?"""

    @pytest.mark.asyncio
    async def test_passing_trial_has_finish_accepted_true(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        assert report.trial_results[0].finish_accepted is True

    @pytest.mark.asyncio
    async def test_failing_trial_has_finish_accepted_false(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(name="t", input="hi", expected="xyz", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        assert report.trial_results[0].finish_accepted is False

    @pytest.mark.asyncio
    async def test_error_trial_has_finish_accepted_false(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            raise RuntimeError("boom")

        report = await gym.run(agent)
        assert report.trial_results[0].finish_accepted is False


class TestStopReasonAttribution:
    """Gap 2: stop_reason distinguishes agent vs benchmark stops."""

    @pytest.mark.asyncio
    async def test_completed_trial_stop_reason(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        assert report.trial_results[0].stop_reason == "completed"

    @pytest.mark.asyncio
    async def test_timeout_trial_stop_reason(self):
        import asyncio as _asyncio
        gym = EvalGym(trials_per_task=1, trial_timeout_seconds=0.05)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            await _asyncio.sleep(5)
            return "hi"

        report = await gym.run(agent)
        assert report.trial_results[0].stop_reason == "benchmark_timeout"

    @pytest.mark.asyncio
    async def test_error_trial_stop_reason(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            raise ValueError("oops")

        report = await gym.run(agent)
        assert report.trial_results[0].stop_reason == "error"

    def test_stop_reason_initiated_by(self):
        from agentos.evolution.session_record import StopReason
        assert StopReason.COMPLETED.initiated_by == "agent"
        assert StopReason.USER_CANCELLED.initiated_by == "agent"
        assert StopReason.BENCHMARK_TIMEOUT.initiated_by == "benchmark"
        assert StopReason.BENCHMARK_ERROR.initiated_by == "benchmark"
        assert StopReason.TIMEOUT.initiated_by == "infrastructure"
        assert StopReason.BUDGET_EXHAUSTED.initiated_by == "infrastructure"
        assert StopReason.MAX_TURNS.initiated_by == "infrastructure"


class TestBenchmarkCost:
    """Gap 3: benchmark_cost separates eval infra cost from agent cost."""

    @pytest.mark.asyncio
    async def test_benchmark_cost_aggregated(self):
        gym = EvalGym(trials_per_task=2)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> AgentResult:
            return AgentResult(output="hi", cost_usd=0.10)

        report = await gym.run(agent)
        # Agent cost should be $0.20 (2 trials * $0.10)
        assert report.total_cost_usd == pytest.approx(0.20)
        # ContainsGrader has no LLM cost, so benchmark cost = $0
        assert report.benchmark_cost_usd == pytest.approx(0.0)

    @pytest.mark.asyncio
    async def test_trial_result_has_benchmark_cost(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        assert hasattr(report.trial_results[0], "benchmark_cost_usd")
        assert report.trial_results[0].benchmark_cost_usd == 0.0


class TestSeedAndPerturbation:
    """Gap 4: seed control and prompt perturbation in the gym."""

    @pytest.mark.asyncio
    async def test_seed_in_eval_conditions(self):
        gym = EvalGym(trials_per_task=1, seed=42)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        assert report.eval_conditions["seed"] == 42

    @pytest.mark.asyncio
    async def test_perturbation_trial_1_unmodified(self):
        """Trial 1 should always use the original input (baseline)."""
        received_inputs = []

        gym = EvalGym(trials_per_task=3, perturbation=True, seed=42)
        gym.add_task(EvalTask(name="t", input="Hello world", expected="hello", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            received_inputs.append(inp)
            return "hello"

        await gym.run(agent)
        # Trial 1 should be unmodified
        assert received_inputs[0] == "Hello world"
        # At least one subsequent trial should be different
        assert any(inp != "Hello world" for inp in received_inputs[1:])

    @pytest.mark.asyncio
    async def test_perturbation_deterministic_with_seed(self):
        """Same seed should produce same perturbations."""
        inputs_run1 = []
        inputs_run2 = []

        async def agent1(inp: str) -> str:
            inputs_run1.append(inp)
            return "hello"

        async def agent2(inp: str) -> str:
            inputs_run2.append(inp)
            return "hello"

        for agent, inputs in [(agent1, inputs_run1), (agent2, inputs_run2)]:
            gym = EvalGym(trials_per_task=5, perturbation=True, seed=123)
            gym.add_task(EvalTask(name="t", input="Test input", expected="hello", grader=ContainsGrader()))
            await gym.run(agent)

        assert inputs_run1 == inputs_run2

    @pytest.mark.asyncio
    async def test_no_perturbation_by_default(self):
        """Without perturbation flag, all trials get identical input."""
        received_inputs = []

        gym = EvalGym(trials_per_task=3)
        gym.add_task(EvalTask(name="t", input="Exact input", expected="exact", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            received_inputs.append(inp)
            return "exact"

        await gym.run(agent)
        assert all(inp == "Exact input" for inp in received_inputs)

    def test_perturbation_class_strategies(self):
        from agentos.eval.gym import PromptPerturbation
        p = PromptPerturbation(seed=0)
        original = "Hello world"
        # Trial 1 always unperturbed
        assert p.perturb(original, 1) == original
        # Later trials should vary
        results = {p.perturb(original, t) for t in range(2, 20)}
        assert len(results) > 1  # At least 2 different perturbations


class TestBenchmarkMetadata:
    """Gap 5: benchmark env/grader/protocol in EvalReport."""

    @pytest.mark.asyncio
    async def test_report_includes_benchmark_metadata(self):
        gym = EvalGym(
            trials_per_task=1,
            benchmark_name="smoke-test",
            benchmark_version="1.0",
            protocol="agentos",
        )
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        assert report.benchmark_name == "smoke-test"
        assert report.benchmark_version == "1.0"
        assert report.protocol == "agentos"
        assert report.grader_type == "contains"

    @pytest.mark.asyncio
    async def test_report_to_dict_has_benchmark_fields(self):
        gym = EvalGym(trials_per_task=1, seed=99)
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ExactMatchGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        d = report.to_dict()
        assert "benchmark_name" in d
        assert "benchmark_cost_usd" in d
        assert "eval_conditions" in d
        assert d["grader_type"] == "exactmatch"
        assert d["eval_conditions"]["seed"] == 99

    @pytest.mark.asyncio
    async def test_eval_conditions_in_report(self):
        gym = EvalGym(
            trials_per_task=3,
            trial_timeout_seconds=30.0,
            max_concurrency=2,
            seed=7,
            perturbation=True,
        )
        gym.add_task(EvalTask(name="t", input="hi", expected="hi", grader=ContainsGrader()))

        async def agent(inp: str) -> str:
            return "hi"

        report = await gym.run(agent)
        conds = report.eval_conditions
        assert conds["seed"] == 7
        assert conds["perturbation"] is True
        assert conds["trials_per_task"] == 3
        assert conds["trial_timeout_seconds"] == 30.0
        assert conds["max_concurrency"] == 2


class TestSessionRecordGaps:
    """Tests for SessionRecord fields: finish_accepted, benchmark_cost, stop_reason."""

    def test_finish_accepted_field(self):
        from agentos.evolution.session_record import SessionRecord
        rec = SessionRecord()
        assert rec.finish_accepted is None  # Unknown by default
        rec.finish_accepted = True
        assert rec.finish_accepted is True

    def test_benchmark_cost_field(self):
        from agentos.evolution.session_record import CostBreakdown, SessionRecord
        rec = SessionRecord()
        assert rec.benchmark_cost.total_usd == 0.0
        rec.benchmark_cost.add_llm(0.01, 0.02)
        assert rec.benchmark_cost.total_usd == pytest.approx(0.03)

    def test_to_dict_includes_new_fields(self):
        from agentos.evolution.session_record import SessionRecord, StopReason
        rec = SessionRecord(
            finish_accepted=True,
            stop_reason=StopReason.BENCHMARK_TIMEOUT,
        )
        d = rec.to_dict()
        assert d["finish_accepted"] is True
        assert d["stop_reason"] == "benchmark_timeout"
        assert d["stop_initiated_by"] == "benchmark"
        assert "benchmark_cost" in d
        assert d["benchmark_cost"]["total_usd"] == 0.0


# ── AutoResearchLoop ─────────────────────────────────────────────────────────


class TestAutoResearchLoop:
    @pytest.mark.asyncio
    async def test_run_loop(self):
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(
            name="math",
            input="2+2",
            expected="4",
            grader=ContainsGrader(),
        ))

        async def agent(input: str) -> str:
            return "The answer is 4"

        loop = AutoResearchLoop(gym=gym, max_iterations=2)
        result = await loop.run(agent, [
            Hypothesis(description="test prompt v1", modification={"prompt": "v1"}),
            Hypothesis(description="test prompt v2", modification={"prompt": "v2"}),
        ])
        assert result["baseline_score"] == 1.0
        assert result["iterations"] == 2

    @pytest.mark.asyncio
    async def test_research_loop_with_factory(self):
        """Research loop with agent_factory should apply modifications."""
        gym = EvalGym(trials_per_task=1)
        gym.add_task(EvalTask(
            name="configurable",
            input="greet",
            expected="hi",
            grader=ContainsGrader(),
        ))

        def agent_factory(config: dict) -> "AgentFn":
            greeting = config.get("greeting", "hello")

            async def agent_fn(input: str) -> str:
                return greeting

            return agent_fn

        async def baseline(input: str) -> str:
            return "hello"  # does not contain "hi"

        loop = AutoResearchLoop(gym=gym, max_iterations=2)
        result = await loop.run(
            baseline,
            [
                Hypothesis(
                    description="use hi",
                    modification={"greeting": "hi there"},
                ),
            ],
            agent_factory=agent_factory,
            base_config={"greeting": "hello"},
        )
        # The "hi" hypothesis should be accepted
        assert result["accepted"] >= 1
        assert result["best_score"] == 1.0
