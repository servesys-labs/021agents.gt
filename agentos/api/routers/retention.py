"""Retention router — data lifecycle, redaction policies."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/retention", tags=["retention"])


@router.get("")
async def list_policies(user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM retention_policies WHERE org_id = ? OR org_id = '' ORDER BY resource_type",
        (user.org_id,),
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["redact_fields"] = json.loads(d.get("redact_fields", "[]"))
        result.append(d)
    return {"policies": result}


@router.post("")
async def create_policy(
    resource_type: str,
    retention_days: int = 90,
    redact_pii: bool = False,
    redact_fields: list[str] | None = None,
    archive_before_delete: bool = True,
    user: CurrentUser = Depends(get_current_user),
):
    """Create a data retention policy."""
    valid_types = ("sessions", "turns", "episodes", "billing_records", "audit_log", "cost_ledger")
    if resource_type not in valid_types:
        raise HTTPException(status_code=400, detail=f"Invalid resource_type. Must be one of: {valid_types}")

    db = _get_db()
    policy_id = uuid.uuid4().hex[:12]
    db.conn.execute(
        """INSERT INTO retention_policies
        (policy_id, org_id, resource_type, retention_days, redact_pii, redact_fields, archive_before_delete)
        VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (policy_id, user.org_id, resource_type, retention_days,
         1 if redact_pii else 0, json.dumps(redact_fields or []),
         1 if archive_before_delete else 0),
    )
    db.conn.commit()
    return {"policy_id": policy_id, "resource_type": resource_type, "retention_days": retention_days}


@router.delete("/{policy_id}")
async def delete_policy(policy_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    db.conn.execute("DELETE FROM retention_policies WHERE policy_id = ? AND org_id = ?", (policy_id, user.org_id))
    db.conn.commit()
    return {"deleted": policy_id}


@router.post("/apply")
async def apply_retention(user: CurrentUser = Depends(get_current_user)):
    """Apply all active retention policies — deletes old data."""
    db = _get_db()
    result = db.apply_retention()
    db.audit("retention.applied", user_id=user.user_id, org_id=user.org_id,
             resource_type="retention", changes=result)
    return {"applied": result}
