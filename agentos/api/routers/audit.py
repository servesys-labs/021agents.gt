"""Audit router — compliance audit log."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/log")
async def query_audit_log(
    action: str = "",
    user_id: str = "",
    since_days: int = 30,
    limit: int = 100,
    user: CurrentUser = Depends(get_current_user),
):
    """Query the audit log with filters."""
    import time
    db = _get_db()
    since = time.time() - (since_days * 86400)
    entries = db.query_audit_log(org_id=user.org_id, action=action, user_id=user_id, since=since, limit=limit)
    return {"entries": entries, "total": len(entries)}


@router.get("/events")
async def list_event_types():
    """List all defined event types in the taxonomy."""
    db = _get_db()
    rows = db.conn.execute("SELECT * FROM event_types ORDER BY category, event_type").fetchall()
    return {"event_types": [dict(r) for r in rows]}
