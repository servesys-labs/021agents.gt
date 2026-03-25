"""Dispatch helpers — auto-deploy/undeploy customer workers on agent lifecycle.

Shared by agents.py router and deploy.py router. All operations are
best-effort: failures are logged but never block agent CRUD.

Feature flag: DISPATCH_DEPLOY_ENABLED (env var, default "true").
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)


def dispatch_enabled() -> bool:
    """Check if auto-deploy to dispatch namespace is enabled."""
    raw = os.environ.get("DISPATCH_DEPLOY_ENABLED", "true").strip().lower()
    return raw in ("true", "1", "on", "yes")


def get_org_slug(db: Any, org_id: str) -> str:
    """Resolve org_id to org slug for worker naming."""
    if not org_id:
        return "default"
    try:
        row = db.conn.execute(
            "SELECT slug FROM orgs WHERE org_id = ?", (org_id,)
        ).fetchone()
        if row:
            return row["slug"] if isinstance(row, dict) else row[0]
    except Exception:
        pass
    return re.sub(r"[^a-z0-9-]", "-", org_id.lower()).strip("-")[:30] or "default"


async def auto_deploy_agent(
    agent_name: str,
    org_id: str,
    project_id: str = "",
    db: Any = None,
) -> dict[str, Any] | None:
    """Deploy a customer worker for this agent. Returns result or None on skip/failure."""
    if not dispatch_enabled():
        return None

    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if not cf:
        return None

    try:
        if db is None:
            from agentos.api.deps import _get_db
            db = _get_db()
        org_slug = get_org_slug(db, org_id)
        result = await cf.deploy_customer_worker(
            org_slug=org_slug,
            agent_name=agent_name,
            org_id=org_id,
            project_id=project_id,
        )
        if result.get("deployed"):
            logger.info("Auto-deployed worker: %s", result.get("worker_name"))
        else:
            logger.warning("Auto-deploy failed for %s: %s", agent_name, result)
        return result
    except Exception as exc:
        logger.warning("Auto-deploy error for %s: %s", agent_name, exc)
        return None


async def auto_undeploy_agent(
    agent_name: str,
    org_id: str,
    db: Any = None,
) -> dict[str, Any] | None:
    """Remove the customer worker for this agent. Returns result or None on skip/failure."""
    if not dispatch_enabled():
        return None

    from agentos.infra.cloudflare_client import get_cf_client
    cf = get_cf_client()
    if not cf:
        return None

    try:
        if db is None:
            from agentos.api.deps import _get_db
            db = _get_db()
        org_slug = get_org_slug(db, org_id)
        result = await cf.undeploy_customer_worker(org_slug, agent_name)
        if result.get("removed"):
            logger.info("Auto-undeployed worker for %s", agent_name)
        return result
    except Exception as exc:
        logger.warning("Auto-undeploy error for %s: %s", agent_name, exc)
        return None
