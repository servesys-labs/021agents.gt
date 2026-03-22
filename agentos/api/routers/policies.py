"""Policies router — reusable governance policy templates."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/policies", tags=["policies"])


@router.get("")
async def list_policies(user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM policy_templates WHERE org_id = ? OR org_id = '' ORDER BY name", (user.org_id,)
    ).fetchall()
    return {"policies": [dict(r) for r in rows]}


@router.post("")
async def create_policy(
    name: str,
    budget_limit_usd: float = 10.0,
    blocked_tools: list[str] | None = None,
    allowed_domains: list[str] | None = None,
    require_confirmation: bool = True,
    max_turns: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    db = _get_db()
    policy_id = uuid.uuid4().hex[:12]
    policy = {
        "budget_limit_usd": budget_limit_usd,
        "blocked_tools": blocked_tools or [],
        "allowed_domains": allowed_domains or [],
        "require_confirmation_for_destructive": require_confirmation,
        "max_turns": max_turns,
    }
    db.conn.execute(
        "INSERT INTO policy_templates (policy_id, org_id, name, policy_json) VALUES (?, ?, ?, ?)",
        (policy_id, user.org_id, name, json.dumps(policy)),
    )
    db.conn.commit()
    db.audit("policy.create", user_id=user.user_id, org_id=user.org_id,
             resource_type="policy", resource_id=policy_id, changes={"name": name})
    return {"policy_id": policy_id, "name": name, "policy": policy}


@router.get("/{policy_id}")
async def get_policy(policy_id: str):
    db = _get_db()
    row = db.conn.execute("SELECT * FROM policy_templates WHERE policy_id = ?", (policy_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Policy not found")
    d = dict(row)
    d["policy"] = json.loads(d.pop("policy_json", "{}"))
    return d


@router.delete("/{policy_id}")
async def delete_policy(policy_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    db.conn.execute("DELETE FROM policy_templates WHERE policy_id = ? AND org_id = ?", (policy_id, user.org_id))
    db.conn.commit()
    return {"deleted": policy_id}
