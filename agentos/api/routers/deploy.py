"""Deploy router — agent deployment is just config in Supabase.

No dispatch namespace workers. Each agent is a Durable Object instance
in the main worker, addressable at:

  wss://agentos.servesys.workers.dev/agents/agentos-agent/{agent-name}

"Deploying" an agent = ensuring its config exists in Supabase.
"Undeploying" = marking it inactive.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, require_scope, _get_db

router = APIRouter(prefix="/deploy", tags=["deploy"])
logger = logging.getLogger(__name__)


@router.post("/{agent_name}")
async def deploy_agent(
    agent_name: str,
    user: CurrentUser = Depends(require_scope("deploy:write")),
):
    """Deploy an agent — verifies config exists and returns the agent URL.

    The agent runs as a Durable Object in the main CF worker.
    No separate worker deployment needed.
    """
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(agent_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    return {
        "deployed": True,
        "agent": agent_name,
        "url": f"/agents/agentos-agent/{agent_name}",
        "websocket": f"wss://agentos.servesys.workers.dev/agents/agentos-agent/{agent_name}",
        "org_id": user.org_id,
    }


@router.delete("/{agent_name}")
async def undeploy_agent(
    agent_name: str,
    user: CurrentUser = Depends(require_scope("deploy:write")),
):
    """Undeploy an agent — marks it inactive in the database."""
    db = _get_db()
    try:
        db.conn.execute(
            "UPDATE agents SET is_active = 0, updated_at = ? WHERE name = ?",
            (int(__import__("time").time()), agent_name),
        )
        db.conn.commit()
    except Exception:
        pass

    return {
        "removed": True,
        "agent": agent_name,
    }


@router.get("/{agent_name}/status")
async def deploy_status(
    agent_name: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Check if an agent is deployed (active in database)."""
    db = _get_db()
    try:
        row = db.conn.execute(
            "SELECT name, is_active FROM agents WHERE name = ?",
            (agent_name,),
        ).fetchone()
        if row and row[1]:
            return {
                "deployed": True,
                "agent": agent_name,
                "url": f"/agents/agentos-agent/{agent_name}",
                "websocket": f"wss://agentos.servesys.workers.dev/agents/agentos-agent/{agent_name}",
            }
    except Exception:
        pass

    return {"deployed": False, "agent": agent_name}
