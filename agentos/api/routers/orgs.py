"""Orgs router — organization and team management."""

from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db, require_role, require_scope
from agentos.api.schemas import CreateOrgRequest, OrgResponse, InviteMemberRequest

router = APIRouter(prefix="/orgs", tags=["orgs"])


def _require_org_member(user: CurrentUser, org_id: str, min_role: str = "viewer") -> None:
    db = _get_db()
    row = db.conn.execute(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
        (org_id, user.user_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Organization not found")
    hierarchy = {"owner": 4, "admin": 3, "member": 2, "viewer": 1}
    if hierarchy.get(row["role"], 0) < hierarchy.get(min_role, 0):
        raise HTTPException(status_code=403, detail="Insufficient organization role")


@router.get("", response_model=list[OrgResponse])
async def list_orgs(user: CurrentUser = Depends(get_current_user)):
    """List orgs the current user belongs to."""
    db = _get_db()
    rows = db.conn.execute(
        """SELECT o.*, COUNT(m2.user_id) as member_count
        FROM orgs o
        JOIN org_members m ON o.org_id = m.org_id
        LEFT JOIN org_members m2 ON o.org_id = m2.org_id
        WHERE m.user_id = ?
        GROUP BY o.org_id""",
        (user.user_id,),
    ).fetchall()
    return [
        OrgResponse(
            org_id=r["org_id"], name=r["name"], slug=r["slug"],
            plan=r["plan"], member_count=r["member_count"],
        )
        for r in rows
    ]


@router.post("", response_model=OrgResponse)
async def create_org(request: CreateOrgRequest, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    org_id = uuid.uuid4().hex[:16]
    slug = request.slug or request.name.lower().replace(" ", "-")

    db.conn.execute(
        "INSERT INTO orgs (org_id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
        (org_id, request.name, slug, user.user_id),
    )
    db.conn.execute(
        "INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')",
        (org_id, user.user_id),
    )
    db.conn.commit()

    return OrgResponse(org_id=org_id, name=request.name, slug=slug, member_count=1)


@router.get("/{org_id}/members")
async def list_members(org_id: str, user: CurrentUser = Depends(get_current_user)):
    _require_org_member(user, org_id, "viewer")
    db = _get_db()
    rows = db.conn.execute(
        """SELECT u.user_id, u.email, u.name, m.role, m.created_at
        FROM org_members m JOIN users u ON m.user_id = u.user_id
        WHERE m.org_id = ?""",
        (org_id,),
    ).fetchall()
    return {"members": [dict(r) for r in rows]}


@router.post("/{org_id}/members")
async def invite_member(org_id: str, request: InviteMemberRequest, user: CurrentUser = Depends(require_role("admin"))):
    _require_org_member(user, org_id, "admin")
    if request.role not in ("owner", "admin", "member", "viewer"):
        raise HTTPException(status_code=400, detail="Invalid role")
    db = _get_db()

    # Find or create user
    user_row = db.conn.execute("SELECT user_id FROM users WHERE email = ?", (request.email,)).fetchone()
    if user_row:
        target_user_id = user_row["user_id"]
    else:
        target_user_id = uuid.uuid4().hex[:16]
        db.conn.execute(
            "INSERT INTO users (user_id, email, name) VALUES (?, ?, ?)",
            (target_user_id, request.email, ""),
        )

    # Add to org
    db.conn.execute(
        "INSERT OR IGNORE INTO org_members (org_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)",
        (org_id, target_user_id, request.role, user.user_id),
    )
    db.conn.commit()

    return {"invited": request.email, "role": request.role}


@router.put("/{org_id}")
async def update_org(org_id: str, name: str = "", plan: str = "", user: CurrentUser = Depends(get_current_user)):
    """Update org settings."""
    _require_org_member(user, org_id, "admin")
    db = _get_db()
    updates = []
    params: list = []
    if name:
        updates.append("name = ?")
        params.append(name)
    if plan:
        updates.append("plan = ?")
        params.append(plan)
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    updates.append("updated_at = ?")
    params.append(time.time())
    params.append(org_id)
    db.conn.execute(f"UPDATE orgs SET {', '.join(updates)} WHERE org_id = ?", params)
    db.conn.commit()
    return {"updated": org_id}


@router.delete("/{org_id}")
async def delete_org(org_id: str, user: CurrentUser = Depends(require_role("owner"))):
    """Delete an organization."""
    _require_org_member(user, org_id, "owner")
    db = _get_db()
    db.conn.execute("DELETE FROM org_members WHERE org_id = ?", (org_id,))
    db.conn.execute("DELETE FROM orgs WHERE org_id = ?", (org_id,))
    db.conn.commit()
    return {"deleted": org_id}


@router.put("/{org_id}/members/{member_user_id}")
async def update_member_role(org_id: str, member_user_id: str, role: str, user: CurrentUser = Depends(require_role("admin"))):
    """Change a member's role."""
    _require_org_member(user, org_id, "admin")
    if role not in ("owner", "admin", "member", "viewer"):
        raise HTTPException(status_code=400, detail="Invalid role")
    db = _get_db()
    db.conn.execute(
        "UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?",
        (role, org_id, member_user_id),
    )
    db.conn.commit()
    return {"updated": member_user_id, "role": role}


@router.delete("/{org_id}/members/{member_user_id}")
async def remove_member(org_id: str, member_user_id: str, user: CurrentUser = Depends(require_role("admin"))):
    _require_org_member(user, org_id, "admin")
    db = _get_db()
    db.conn.execute(
        "DELETE FROM org_members WHERE org_id = ? AND user_id = ?",
        (org_id, member_user_id),
    )
    db.conn.commit()
    return {"removed": member_user_id}
