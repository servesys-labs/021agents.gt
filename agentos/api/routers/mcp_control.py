"""MCP control plane router — register, monitor, and sync MCP servers."""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/mcp", tags=["mcp"])


class RegisterMCPServerRequest(BaseModel):
    name: str = Field(..., description="Human-readable server name")
    url: str = Field(..., description="MCP server endpoint URL")
    transport: str = Field("stdio", description="Transport type: stdio, sse, http")
    auth_token: str = Field("", description="Optional auth token for the server")
    metadata: dict = Field(default_factory=dict, description="Extra metadata")


@router.get("/servers")
async def list_mcp_servers(user: CurrentUser = Depends(get_current_user)):
    """List all registered MCP servers for the org."""
    db = _get_db()
    rows = db.conn.execute(
        "SELECT server_id, name, url, transport, status, last_sync_at, created_at FROM mcp_servers WHERE org_id = ? ORDER BY name",
        (user.org_id,),
    ).fetchall()
    return {"servers": [dict(r) for r in rows]}


@router.post("/servers")
async def register_mcp_server(
    request: RegisterMCPServerRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Register a new MCP server."""
    db = _get_db()
    server_id = uuid.uuid4().hex[:16]
    now = time.time()
    db.conn.execute(
        """INSERT INTO mcp_servers (server_id, org_id, name, url, transport, auth_token, metadata_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (server_id, user.org_id, request.name, request.url, request.transport,
         request.auth_token, str(request.metadata), "registered", now),
    )
    db.conn.commit()
    return {"server_id": server_id, "name": request.name, "status": "registered"}


@router.get("/servers/{server_id}/status")
async def get_mcp_server_status(
    server_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Check connection health of an MCP server."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM mcp_servers WHERE server_id = ? AND org_id = ?",
        (server_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="MCP server not found")

    server = dict(row)

    # Attempt a lightweight health check
    healthy = False
    error = ""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(server["url"].rstrip("/") + "/health")
            healthy = resp.status_code < 400
    except Exception as exc:
        error = str(exc)

    status = "healthy" if healthy else "unhealthy"
    db.conn.execute(
        "UPDATE mcp_servers SET status = ? WHERE server_id = ?",
        (status, server_id),
    )
    db.conn.commit()

    return {
        "server_id": server_id,
        "name": server["name"],
        "status": status,
        "healthy": healthy,
        "error": error or None,
    }


@router.post("/servers/{server_id}/sync")
async def sync_mcp_server(
    server_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Force a tool sync with the MCP server — re-fetch available tools."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM mcp_servers WHERE server_id = ? AND org_id = ?",
        (server_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="MCP server not found")

    server = dict(row)
    tools: list[dict] = []
    error = ""

    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(server["url"].rstrip("/") + "/tools")
            if resp.status_code < 400:
                data = resp.json()
                tools = data.get("tools", data) if isinstance(data, dict) else data
    except Exception as exc:
        error = str(exc)

    now = time.time()
    db.conn.execute(
        "UPDATE mcp_servers SET last_sync_at = ?, status = ? WHERE server_id = ?",
        (now, "synced" if not error else "sync_failed", server_id),
    )
    db.conn.commit()

    return {
        "server_id": server_id,
        "synced_tools": len(tools),
        "tools": tools,
        "error": error or None,
        "synced_at": now,
    }


@router.delete("/servers/{server_id}")
async def remove_mcp_server(
    server_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Remove a registered MCP server."""
    db = _get_db()
    result = db.conn.execute(
        "DELETE FROM mcp_servers WHERE server_id = ? AND org_id = ?",
        (server_id, user.org_id),
    )
    db.conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {"deleted": server_id}
