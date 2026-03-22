"""Projects router — org → project → agents hierarchy."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/projects", tags=["projects"])


def _require_project_org(project_id: str, user: CurrentUser) -> dict[str, Any]:
    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM projects WHERE project_id = ? AND org_id = ?",
        (project_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return dict(row)


@router.get("")
async def list_projects(user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC", (user.org_id,)
    ).fetchall()
    return {"projects": [dict(r) for r in rows]}


@router.post("")
async def create_project(name: str, description: str = "", plan: str = "standard",
                         user: CurrentUser = Depends(get_current_user)):
    allowed_plans = {"starter", "standard", "pro", "enterprise"}
    if plan not in allowed_plans:
        raise HTTPException(status_code=400, detail="Invalid plan")
    db = _get_db()
    project_id = uuid.uuid4().hex[:16]
    slug = name.lower().replace(" ", "-")
    db.conn.execute(
        """INSERT INTO projects (project_id, org_id, name, slug, description, default_plan)
        VALUES (?, ?, ?, ?, ?, ?)""",
        (project_id, user.org_id, name, slug, description, plan),
    )
    # Create default environments
    for env_name in ("development", "staging", "production"):
        db.conn.execute(
            "INSERT INTO environments (env_id, project_id, name) VALUES (?, ?, ?)",
            (uuid.uuid4().hex[:16], project_id, env_name),
        )
    db.conn.commit()
    db.audit("project.create", user_id=user.user_id, org_id=user.org_id,
             resource_type="project", resource_id=project_id, changes={"name": name})
    return {"project_id": project_id, "name": name, "slug": slug, "envs": ["development", "staging", "production"]}


@router.get("/{project_id}")
async def get_project(project_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    row = _require_project_org(project_id, user)
    envs = db.conn.execute("SELECT * FROM environments WHERE project_id = ?", (project_id,)).fetchall()
    return {"project": row, "environments": [dict(e) for e in envs]}


@router.get("/{project_id}/envs")
async def list_environments(project_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    _require_project_org(project_id, user)
    rows = db.conn.execute("SELECT * FROM environments WHERE project_id = ?", (project_id,)).fetchall()
    return {"environments": [dict(r) for r in rows]}


@router.put("/{project_id}/envs/{env_name}")
async def update_environment(project_id: str, env_name: str, plan: str = "",
                             provider_config: dict[str, Any] | None = None,
                             user: CurrentUser = Depends(get_current_user)):
    _require_project_org(project_id, user)
    db = _get_db()
    updates, params = [], []
    if plan:
        updates.append("plan = ?")
        params.append(plan)
    if provider_config is not None:
        updates.append("provider_config_json = ?")
        params.append(json.dumps(provider_config))
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    params.extend([project_id, env_name])
    db.conn.execute(f"UPDATE environments SET {', '.join(updates)} WHERE project_id = ? AND name = ?", params)
    db.conn.commit()
    return {"updated": env_name}
