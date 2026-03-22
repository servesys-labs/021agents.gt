"""Evolve router — run evolution, manage proposals, view ledger."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user

router = APIRouter(prefix="/evolve", tags=["evolve"])


@router.post("/{agent_name}/run")
async def run_evolution(
    agent_name: str,
    eval_file: str = "eval/smoke-test.json",
    trials: int = 3,
    auto_approve: bool = False,
    max_cycles: int = 1,
    user: CurrentUser = Depends(get_current_user),
):
    """Run the evolution loop on an agent."""
    from agentos.agent import Agent
    from agentos.evolution.loop import EvolutionLoop
    from agentos.eval.gym import EvalGym, EvalTask, AgentResult
    from agentos.eval.grader import ContainsGrader, LLMGrader

    try:
        agent = Agent.from_name(agent_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    # Load eval tasks
    eval_path = Path(eval_file)
    if not eval_path.exists():
        raise HTTPException(status_code=404, detail=f"Eval file not found: {eval_file}")

    tasks_data = json.loads(eval_path.read_text())
    gym = EvalGym()
    gym.trials_per_task = trials
    for t in tasks_data:
        grader_type = t.get("grader", "contains")
        grader = LLMGrader(criteria=t.get("criteria", t.get("expected", ""))) if grader_type == "llm" else ContainsGrader()
        gym.add_task(EvalTask(name=t.get("name", ""), input=t["input"], expected=t["expected"], grader=grader))

    async def agent_fn(task_input: str) -> AgentResult:
        results = await agent.run(task_input)
        output, cost = "", 0.0
        for r in results:
            if r.llm_response:
                output = r.llm_response.content
                cost += r.cost_usd
        return AgentResult(output=output, cost_usd=cost)

    loop = EvolutionLoop.for_agent(agent, min_sessions_for_analysis=1)

    results = []
    for cycle in range(1, max_cycles + 1):
        baseline = await gym.run(agent_fn)
        report = loop.analyze(db=agent.db)
        proposals = loop.propose(report)

        cycle_result = {
            "cycle": cycle,
            "baseline_pass_rate": baseline.pass_rate,
            "recommendations": report.recommendations,
            "proposals": [{"id": p.id, "title": p.title, "priority": p.priority, "rationale": p.rationale} for p in proposals],
        }

        if proposals and auto_approve:
            for p in loop.review_queue.pending:
                loop.approve(p.id, note="auto-approved via API")
            approved = loop.review_queue.approved
            if approved:
                metrics_before = {"pass_rate": baseline.pass_rate, "avg_score": baseline.avg_score}
                new_config = loop.apply_approved(metrics_before=metrics_before)
                if new_config:
                    cycle_result["applied"] = len(approved)
                    cycle_result["new_version"] = new_config.version
                    agent = Agent.from_name(agent_name)

        results.append(cycle_result)

    return {"agent": agent_name, "cycles": results}


@router.get("/{agent_name}/proposals")
async def list_proposals(agent_name: str):
    """List evolution proposals for an agent."""
    proposals_path = Path.cwd() / "data" / "evolution" / agent_name / "proposals.json"
    if not proposals_path.exists():
        return {"proposals": []}
    try:
        data = json.loads(proposals_path.read_text())
        return {"proposals": data.get("proposals", data) if isinstance(data, dict) else data}
    except Exception:
        return {"proposals": []}


@router.post("/{agent_name}/proposals/{proposal_id}/approve")
async def approve_proposal(agent_name: str, proposal_id: str, note: str = "", user: CurrentUser = Depends(get_current_user)):
    """Approve an evolution proposal."""
    from agentos.agent import Agent
    from agentos.evolution.loop import EvolutionLoop

    agent = Agent.from_name(agent_name)
    loop = EvolutionLoop.for_agent(agent, min_sessions_for_analysis=1)
    result = loop.approve(proposal_id, note=note)
    if result:
        return {"approved": proposal_id, "title": result.title}
    raise HTTPException(status_code=404, detail="Proposal not found")


@router.post("/{agent_name}/proposals/{proposal_id}/reject")
async def reject_proposal(agent_name: str, proposal_id: str, note: str = "", user: CurrentUser = Depends(get_current_user)):
    """Reject an evolution proposal."""
    from agentos.agent import Agent
    from agentos.evolution.loop import EvolutionLoop

    agent = Agent.from_name(agent_name)
    loop = EvolutionLoop.for_agent(agent, min_sessions_for_analysis=1)
    result = loop.reject(proposal_id, note=note)
    if result:
        return {"rejected": proposal_id, "title": result.title}
    raise HTTPException(status_code=404, detail="Proposal not found")


@router.get("/{agent_name}/ledger")
async def get_ledger(agent_name: str):
    """Get evolution version history."""
    ledger_path = Path.cwd() / "data" / "evolution" / agent_name / "ledger.json"
    if not ledger_path.exists():
        return {"entries": [], "current_version": "0.1.0"}
    try:
        return json.loads(ledger_path.read_text())
    except Exception:
        return {"entries": [], "current_version": "0.1.0"}
