"""Tests for the evaluation gym and auto-research loop."""

import pytest

from agentos.eval.grader import ContainsGrader, ExactMatchGrader, LLMGrader
from agentos.eval.gym import EvalGym, EvalTask
from agentos.eval.research_loop import AutoResearchLoop, Hypothesis


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

    def test_llm_grader(self):
        grader = LLMGrader(criteria="correctness")
        result = grader.grade("python programming language", "Python is a programming language")
        assert result.score > 0


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
