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
    raise HTTPException(
        status_code=410,
        detail=(
            "Evolution runtime execution is edge-only. "
            "Run trials on worker runtime and keep this API for control-plane reads/writes."
        ),
    )


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
