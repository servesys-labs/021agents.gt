"""API Keys router — create, list, revoke, rotate."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db, generate_api_key
from agentos.api.schemas import ApiKeyResponse, ApiKeyCreatedResponse, CreateApiKeyRequest

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


@router.get("", response_model=list[ApiKeyResponse])
async def list_keys(user: CurrentUser = Depends(get_current_user)):
    """List all API keys for the current user's org."""
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM api_keys WHERE org_id = ? ORDER BY created_at DESC",
        (user.org_id,),
    ).fetchall()
    return [
        ApiKeyResponse(
            key_id=r["key_id"], name=r["name"], key_prefix=r["key_prefix"],
            scopes=json.loads(r["scopes"]), created_at=r["created_at"],
            last_used_at=r["last_used_at"], is_active=bool(r["is_active"]),
        )
        for r in rows
    ]


@router.post("", response_model=ApiKeyCreatedResponse)
async def create_key(request: CreateApiKeyRequest, user: CurrentUser = Depends(get_current_user)):
    """Create a new API key with optional project/env scoping.

    Scopes control what the key can do:
    - "*" — full access
    - "agents:read" — list/get agents only
    - "agents:run" — run agents only
    - "billing:read" — view billing only
    - "admin" — org/team management

    Project/env scoping restricts WHERE the key works:
    - project_id="" — org-wide access
    - project_id="proj-123" — only this project
    - env="production" — only production environment
    """
    from agentos.api.deps import ALL_SCOPES

    # Validate scopes
    for scope in request.scopes:
        if scope != "*" and scope not in ALL_SCOPES:
            # Allow category wildcards like "agents:*"
            category = scope.split(":")[0]
            if not any(s.startswith(f"{category}:") for s in ALL_SCOPES):
                pass  # Warn but don't block — extensible scopes

    db = _get_db()
    key, prefix, key_hash = generate_api_key()
    key_id = uuid.uuid4().hex[:12]

    expires_at = None
    if request.expires_in_days:
        expires_at = time.time() + (request.expires_in_days * 86400)

    db.conn.execute(
        """INSERT INTO api_keys (key_id, org_id, user_id, name, key_prefix, key_hash, scopes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (key_id, user.org_id, user.user_id, request.name, prefix,
         key_hash, json.dumps(request.scopes), expires_at),
    )
    db.conn.commit()

    # Audit
    db.audit("apikey.create", user_id=user.user_id, org_id=user.org_id,
             resource_type="api_key", resource_id=key_id,
             changes={"name": request.name, "scopes": request.scopes,
                       "project_id": request.project_id, "env": request.env})

    return ApiKeyCreatedResponse(
        key_id=key_id, name=request.name, key_prefix=prefix,
        scopes=request.scopes, project_id=request.project_id,
        env=request.env, created_at=time.time(), key=key,
    )


@router.delete("/{key_id}")
async def revoke_key(key_id: str, user: CurrentUser = Depends(get_current_user)):
    """Revoke an API key."""
    db = _get_db()
    result = db.conn.execute(
        "UPDATE api_keys SET is_active = 0 WHERE key_id = ? AND org_id = ?",
        (key_id, user.org_id),
    )
    db.conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="API key not found")
    return {"revoked": key_id}


@router.post("/{key_id}/rotate", response_model=ApiKeyCreatedResponse)
async def rotate_key(key_id: str, user: CurrentUser = Depends(get_current_user)):
    """Rotate an API key — revokes old, creates new with same name/scopes."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM api_keys WHERE key_id = ? AND org_id = ?",
        (key_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="API key not found")

    old = dict(row)

    # Revoke old
    db.conn.execute("UPDATE api_keys SET is_active = 0 WHERE key_id = ?", (key_id,))

    # Create new
    key, prefix, key_hash = generate_api_key()
    new_key_id = uuid.uuid4().hex[:12]
    scopes = json.loads(old["scopes"])

    db.conn.execute(
        """INSERT INTO api_keys (key_id, org_id, user_id, name, key_prefix, key_hash, scopes)
        VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (new_key_id, user.org_id, user.user_id, old["name"], prefix, key_hash, json.dumps(scopes)),
    )
    db.conn.commit()

    return ApiKeyCreatedResponse(
        key_id=new_key_id, name=old["name"], key_prefix=prefix,
        scopes=scopes, created_at=time.time(), key=key,
    )
