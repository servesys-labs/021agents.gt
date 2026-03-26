"""Deploy router — deploy/undeploy customer agent workers to Cloudflare dispatch namespace."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, require_scope, _get_db

router = APIRouter(prefix="/deploy", tags=["deploy"])
logger = logging.getLogger(__name__)


def _get_org_slug(db: Any, org_id: str) -> str:
    from agentos.infra.dispatch import get_org_slug
    return get_org_slug(db, org_id)


@router.post("/{agent_name}")
async def deploy_agent(
    agent_name: str,
    user: CurrentUser = Depends(require_scope("deploy:write")),
):
    """Deploy an agent as an isolated customer worker in the dispatch namespace.

    Creates a stateless proxy worker at:
      agentos-{org_slug}-{agent_name}

    The worker routes all requests to the main CF worker's edge runtime.
    API keys and CF bindings live on the main worker — dispatch workers
    only carry agent identity (name, org, project) and an edge token.
    """
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(agent_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if not cf:
        raise HTTPException(status_code=503, detail="CloudflareClient not configured (set AGENTOS_WORKER_URL)")

    db = _get_db()
    org_slug = _get_org_slug(db, user.org_id)

    result = await cf.deploy_customer_worker(
        org_slug=org_slug,
        agent_name=agent_name,
        org_id=user.org_id,
        project_id=user.project_id,
    )

    if not result.get("deployed"):
        raise HTTPException(status_code=502, detail=f"Deploy failed: {result}")

    # Store worker name in agents table for quick lookup
    worker_name = result.get("worker_name", "")
    try:
        db.conn.execute(
            "UPDATE agents SET updated_at = (SELECT COALESCE(MAX(updated_at),0) FROM agents WHERE name = ?) "
            "WHERE name = ?",
            (agent_name, agent_name),
        )
        db.conn.commit()
    except Exception:
        pass

    return {
        "deployed": True,
        "agent": agent_name,
        "worker_name": worker_name,
        "namespace": result.get("namespace", ""),
        "dispatch_url": f"/agents/dispatch/{org_slug}/{agent_name}",
    }


@router.delete("/{agent_name}")
async def undeploy_agent(
    agent_name: str,
    user: CurrentUser = Depends(require_scope("deploy:write")),
):
    """Remove an agent's customer worker from the dispatch namespace."""
    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if not cf:
        raise HTTPException(status_code=503, detail="CloudflareClient not configured")

    db = _get_db()
    org_slug = _get_org_slug(db, user.org_id)

    result = await cf.undeploy_customer_worker(org_slug, agent_name)

    return {
        "removed": result.get("removed", False),
        "agent": agent_name,
        "worker_name": result.get("worker_name", ""),
    }


@router.get("/workers")
async def list_workers(
    org: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """List all deployed customer workers. Filter by org slug."""
    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if not cf:
        return {"workers": [], "error": "CloudflareClient not configured"}

    # If no org filter provided, use the user's org
    if not org:
        db = _get_db()
        org = _get_org_slug(db, user.org_id)

    workers = await cf.list_customer_workers(org_slug=org)
    return {"workers": workers, "org": org, "count": len(workers)}


@router.get("/workers/all")
async def list_all_workers(
    user: CurrentUser = Depends(require_scope("admin")),
):
    """List ALL deployed customer workers across all orgs (admin only)."""
    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if not cf:
        return {"workers": [], "error": "CloudflareClient not configured"}

    workers = await cf.list_customer_workers()
    return {"workers": workers, "count": len(workers)}


@router.get("/{agent_name}/status")
async def deploy_status(
    agent_name: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Check if an agent has a deployed customer worker."""
    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if not cf:
        return {"deployed": False, "agent": agent_name, "reason": "no_cf_client"}

    db = _get_db()
    org_slug = _get_org_slug(db, user.org_id)
    worker_name = cf._worker_name(org_slug, agent_name)

    # Check if worker exists by trying to list and filter
    workers = await cf.list_customer_workers(org_slug)
    found = any(w["worker_name"] == worker_name for w in workers)

    return {
        "deployed": found,
        "agent": agent_name,
        "worker_name": worker_name if found else "",
        "dispatch_url": f"/agents/dispatch/{org_slug}/{agent_name}" if found else "",
    }
