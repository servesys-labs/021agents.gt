"""Deploy router — trigger deploys, check status, view logs."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user

router = APIRouter(prefix="/deploy", tags=["deploy"])


@router.post("/{agent_name}")
async def deploy_agent(agent_name: str, user: CurrentUser = Depends(get_current_user)):
    """Trigger a Cloudflare Workers deployment for an agent."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(agent_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    config = agent.config
    gov = config.governance

    deploy_dir = Path.cwd() / "deploy"
    package_deploy = Path(__file__).resolve().parent.parent.parent.parent / "deploy"

    if not deploy_dir.exists() and package_deploy.exists():
        shutil.copytree(package_deploy, deploy_dir)

    if not deploy_dir.exists():
        raise HTTPException(status_code=503, detail="No deploy scaffold found")

    cf_config = {
        "agentName": config.name,
        "agentDescription": config.description,
        "systemPrompt": config.system_prompt,
        "maxTurns": config.max_turns,
        "budgetLimitUsd": gov.get("budget_limit_usd", 10.0),
        "model": config.model,
    }

    (deploy_dir / "agent-config.json").write_text(json.dumps(cf_config, indent=2) + "\n")

    return {
        "status": "config_written",
        "agent": config.name,
        "deploy_dir": str(deploy_dir),
        "next": "Run 'npm install && npx wrangler deploy' in deploy/",
    }


@router.get("/{agent_name}/status")
async def deploy_status(agent_name: str, user: CurrentUser = Depends(get_current_user)):
    """Get deployment status for an agent."""
    deploy_dir = Path.cwd() / "deploy"
    config_path = deploy_dir / "agent-config.json"

    if not config_path.exists():
        return {"deployed": False, "agent": agent_name}

    config = json.loads(config_path.read_text())
    return {
        "deployed": True,
        "agent": config.get("agentName", agent_name),
        "model": config.get("model", ""),
        "deploy_dir": str(deploy_dir),
    }
