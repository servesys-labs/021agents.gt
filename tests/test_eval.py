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
