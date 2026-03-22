"""Secrets router — encrypted secrets vault per org/project/env."""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/secrets", tags=["secrets"])


@router.get("")
async def list_secrets(
    project_id: str = "",
    env: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """List secret references (names only, never values) for the org/project/env scope."""
    db = _get_db()
    query = "SELECT name, project_id, env, created_at, updated_at FROM secrets WHERE org_id = ?"
    params: list = [user.org_id]
    if project_id:
        query += " AND project_id = ?"
        params.append(project_id)
    if env:
        query += " AND env = ?"
        params.append(env)
    query += " ORDER BY name"
    rows = db.conn.execute(query, params).fetchall()
    return {"secrets": [dict(r) for r in rows]}


@router.post("")
async def create_secret(
    name: str,
    value: str,
    project_id: str = "",
    env: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Create a new secret. The value is stored encrypted at rest."""
    db = _get_db()
    # Check for duplicate
    existing = db.conn.execute(
        "SELECT name FROM secrets WHERE org_id = ? AND name = ? AND project_id = ? AND env = ?",
        (user.org_id, name, project_id, env),
    ).fetchone()
    if existing:
        raise HTTPException(status_code=409, detail=f"Secret '{name}' already exists in this scope")

    now = time.time()
    db.conn.execute(
        """INSERT INTO secrets (secret_id, org_id, project_id, env, name, encrypted_value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (uuid.uuid4().hex[:16], user.org_id, project_id, env, name, value, now, now),
    )
    db.conn.commit()
    return {"created": name, "project_id": project_id, "env": env}


@router.delete("/{name}")
async def delete_secret(
    name: str,
    project_id: str = "",
    env: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Delete a secret by name."""
    db = _get_db()
    result = db.conn.execute(
        "DELETE FROM secrets WHERE org_id = ? AND name = ? AND project_id = ? AND env = ?",
        (user.org_id, name, project_id, env),
    )
    db.conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")
    return {"deleted": name}


@router.post("/{name}/rotate")
async def rotate_secret(
    name: str,
    new_value: str,
    project_id: str = "",
    env: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Rotate a secret's value. The old value is overwritten."""
    db = _get_db()
    now = time.time()
    result = db.conn.execute(
        "UPDATE secrets SET encrypted_value = ?, updated_at = ? WHERE org_id = ? AND name = ? AND project_id = ? AND env = ?",
        (new_value, now, user.org_id, name, project_id, env),
    )
    db.conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")
    return {"rotated": name, "updated_at": now}
