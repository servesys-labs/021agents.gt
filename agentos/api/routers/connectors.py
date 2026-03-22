"""Connectors router — manage external MCP connector hubs (Pipedream, etc.)."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/connectors", tags=["connectors"])


def _get_hub():
    """Get a ConnectorHub instance from env vars."""
    from agentos.connectors.hub import ConnectorHub

    provider = os.environ.get("CONNECTOR_PROVIDER", "pipedream")
    return ConnectorHub(
        provider=provider,
        project_id=os.environ.get("PIPEDREAM_PROJECT_ID", ""),
        client_id=os.environ.get("PIPEDREAM_CLIENT_ID", ""),
        client_secret=os.environ.get("PIPEDREAM_CLIENT_SECRET", ""),
        environment=os.environ.get("PIPEDREAM_ENVIRONMENT", "production"),
    )


@router.get("/providers")
async def list_providers():
    """List available connector providers."""
    from agentos.connectors.hub import ConnectorHub
    return {
        "providers": [
            {"name": "pipedream", "apps": "3,000+", "status": "supported"},
            {"name": "nango", "apps": "250+", "status": "planned"},
            {"name": "merge", "apps": "200+ (CRM/HR/Ticketing)", "status": "planned"},
        ],
        "active": os.environ.get("CONNECTOR_PROVIDER", "pipedream"),
    }


@router.get("/tools")
async def list_connector_tools(app: str = "", user: CurrentUser = Depends(get_current_user)):
    """List tools available from the connector hub, optionally filtered by app."""
    hub = _get_hub()
    tools = await hub.list_tools(app=app)
    return {
        "tools": [
            {"name": t.name, "description": t.description, "app": t.app, "provider": t.provider}
            for t in tools
        ],
        "total": len(tools),
    }


@router.post("/tools/call")
async def call_connector_tool(
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    user: CurrentUser = Depends(get_current_user),
):
    """Call a tool via the connector hub.

    If the user hasn't authenticated with the target app,
    returns an auth_url for them to connect their account.
    """
    import time as _time
    start = _time.time()

    hub = _get_hub()
    result = await hub.call_tool(tool_name, arguments or {}, user_id=user.user_id)
    duration_ms = (_time.time() - start) * 1000

    if result.auth_required:
        return {
            "success": False,
            "auth_required": True,
            "auth_url": result.auth_url,
            "message": result.error,
        }

    if not result.success:
        raise HTTPException(status_code=502, detail=result.error)

    # Track billing + audit
    db = _get_db()
    db.record_billing(
        cost_type="connector",
        total_cost_usd=0.001,  # Per-call connector cost
        org_id=user.org_id,
        customer_id=user.user_id,
        description=f"Connector: {tool_name}",
        model=tool_name,
        provider=os.environ.get("CONNECTOR_PROVIDER", "pipedream"),
    )
    db.audit(
        "connector.tool_call",
        user_id=user.user_id, org_id=user.org_id,
        resource_type="connector", resource_id=tool_name,
        changes={"arguments": arguments, "provider": "pipedream", "duration_ms": duration_ms},
    )

    return {"success": True, "data": result.data, "duration_ms": round(duration_ms, 1)}


@router.get("/usage")
async def connector_usage(since_days: int = 30, user: CurrentUser = Depends(get_current_user)):
    """Get connector usage and costs for billing."""
    import time as _time
    db = _get_db()
    since = _time.time() - (since_days * 86400)

    rows = db.conn.execute(
        """SELECT model as tool_name, COUNT(*) as calls, SUM(total_cost_usd) as cost
        FROM billing_records
        WHERE cost_type = 'connector' AND org_id = ? AND created_at >= ?
        GROUP BY model ORDER BY calls DESC""",
        (user.org_id, since),
    ).fetchall()

    total_calls = sum(r["calls"] for r in rows)
    total_cost = sum(r["cost"] for r in rows)

    return {
        "total_calls": total_calls,
        "total_cost_usd": total_cost,
        "by_tool": [dict(r) for r in rows],
        "since_days": since_days,
    }


@router.get("/auth/{app}")
async def get_auth_url(app: str, user: CurrentUser = Depends(get_current_user)):
    """Get the OAuth connection URL for a specific app.

    The user opens this URL to authorize their account with the
    connector provider (e.g., connect their Slack, GitHub, etc.)
    """
    hub = _get_hub()
    url = await hub.get_auth_url(app, user_id=user.user_id)
    return {"app": app, "auth_url": url}
