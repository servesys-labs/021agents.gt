"""Compare router — A/B test agent versions."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends

from agentos.api.deps import CurrentUser, get_current_user

router = APIRouter(prefix="/compare", tags=["compare"])


@router.post("")
async def compare_versions(
    agent_name: str,
    version_a: str = "current",
    version_b: str = "current",
    eval_file: str = "eval/smoke-test.json",
    trials: int = 3,
    user: CurrentUser = Depends(get_current_user),
):
    """A/B test two agent versions on the same eval tasks."""
    from agentos.agent import Agent
    from agentos.eval.gym import EvalGym, EvalTask, AgentResult
    from agentos.eval.grader import ContainsGrader, LLMGrader
    import json

    agent = Agent.from_name(agent_name)

    eval_path = Path(eval_file)
    if not eval_path.exists():
        return {"error": f"Eval file not found: {eval_file}"}

    tasks_data = json.loads(eval_path.read_text())

    async def run_eval(agent_instance):
        gym = EvalGym()
        gym.trials_per_task = trials
        for t in tasks_data:
            grader = LLMGrader(criteria=t.get("criteria", t.get("expected", ""))) if t.get("grader") == "llm" else ContainsGrader()
            gym.add_task(EvalTask(name=t.get("name", ""), input=t["input"], expected=t["expected"], grader=grader))

        async def agent_fn(task_input):
            results = await agent_instance.run(task_input)
            output, cost = "", 0.0
            for r in results:
                if r.llm_response:
                    output = r.llm_response.content
                    cost += r.cost_usd
            return AgentResult(output=output, cost_usd=cost)

        return await gym.run(agent_fn)

    report_a = await run_eval(agent)
    report_b = await run_eval(agent)  # Same agent for now — version loading from ledger is TODO

    return {
        "agent": agent_name,
        "version_a": version_a,
        "version_b": version_b,
        "results": {
            "a": {
                "pass_rate": report_a.pass_rate,
                "avg_score": report_a.avg_score,
                "avg_latency_ms": report_a.avg_latency_ms,
                "total_cost_usd": report_a.total_cost_usd,
            },
            "b": {
                "pass_rate": report_b.pass_rate,
                "avg_score": report_b.avg_score,
                "avg_latency_ms": report_b.avg_latency_ms,
                "total_cost_usd": report_b.total_cost_usd,
            },
            "delta": {
                "pass_rate": report_b.pass_rate - report_a.pass_rate,
                "cost_usd": report_b.total_cost_usd - report_a.total_cost_usd,
                "latency_ms": report_b.avg_latency_ms - report_a.avg_latency_ms,
            },
        },
    }
