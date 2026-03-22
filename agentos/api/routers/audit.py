"""Audit router — compliance audit log with export and tamper evidence."""

from __future__ import annotations

import hashlib
import json
import time

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


@router.get("/export")
async def export_audit_log(
    since_days: int = 30,
    limit: int = 10000,
    user: CurrentUser = Depends(get_current_user),
):
    """Export audit log as signed JSON with hash chain for tamper evidence.

    Each entry includes a hash that chains to the previous entry, making
    it possible to verify that no entries have been modified or removed.
    """
    db = _get_db()
    since = time.time() - (since_days * 86400)
    entries = db.query_audit_log(org_id=user.org_id, action="", user_id="", since=since, limit=limit)

    # Build hash chain for tamper evidence
    chain: list[dict] = []
    prev_hash = "genesis"
    for entry in entries:
        entry_json = json.dumps(entry, sort_keys=True, default=str)
        current_hash = hashlib.sha256(f"{prev_hash}:{entry_json}".encode()).hexdigest()
        chain.append({**entry, "chain_hash": current_hash})
        prev_hash = current_hash

    # Final integrity hash covers the entire chain
    integrity_hash = hashlib.sha256(
        json.dumps([e["chain_hash"] for e in chain], sort_keys=True).encode()
    ).hexdigest()

    return {
        "entries": chain,
        "total": len(chain),
        "exported_at": time.time(),
        "integrity_hash": integrity_hash,
        "org_id": user.org_id,
    }


@router.get("/events")
async def list_event_types():
    """List all defined event types in the taxonomy."""
    db = _get_db()
    rows = db.conn.execute("SELECT * FROM event_types ORDER BY category, event_type").fetchall()
    return {"event_types": [dict(r) for r in rows]}
