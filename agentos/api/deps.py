"""Shared API dependencies — auth, database, org context.

Used by all API routers for consistent auth and data access.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request

logger = logging.getLogger(__name__)


@dataclass
class CurrentUser:
    """Resolved user context for API requests."""
    user_id: str
    email: str
    name: str = ""
    org_id: str = ""
    role: str = "member"  # owner/admin/member/viewer
    auth_method: str = "jwt"  # jwt/api_key


def _get_db():
    """Get the project's AgentDB instance."""
    from pathlib import Path
    from agentos.core.database import AgentDB

    db_path = Path.cwd() / "data" / "agent.db"
    if not db_path.exists():
        raise HTTPException(status_code=503, detail="Database not initialized. Run 'agentos init' first.")
    db = AgentDB(db_path)
    db.initialize()
    return db


async def get_current_user(request: Request) -> CurrentUser:
    """Extract authenticated user from JWT token or API key.

    Supports dual-mode auth:
    - Bearer <jwt_token> — browser sessions
    - Bearer ak_<api_key> — programmatic access
    """
    auth_header = request.headers.get("Authorization", "")

    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    token = auth_header[7:]  # Strip "Bearer "

    # API key auth (prefixed with ak_)
    if token.startswith("ak_"):
        return _resolve_api_key(token)

    # JWT auth
    return _resolve_jwt(token)


async def get_optional_user(request: Request) -> CurrentUser | None:
    """Same as get_current_user but returns None instead of 401."""
    try:
        return await get_current_user(request)
    except HTTPException:
        return None


def _resolve_jwt(token: str) -> CurrentUser:
    """Resolve a JWT token to a CurrentUser."""
    from agentos.auth.jwt import verify_token

    claims = verify_token(token)
    if claims is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return CurrentUser(
        user_id=claims.user_id,
        email=claims.email,
        name=getattr(claims, "name", ""),
        org_id=getattr(claims, "org_id", ""),
        auth_method="jwt",
    )


def _resolve_api_key(key: str) -> CurrentUser:
    """Resolve an API key to a CurrentUser."""
    try:
        db = _get_db()
        key_hash = hashlib.sha256(key.encode()).hexdigest()
        row = db.conn.execute(
            "SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1",
            (key_hash,),
        ).fetchone()

        if not row:
            raise HTTPException(status_code=401, detail="Invalid API key")

        row = dict(row)

        # Check expiry
        if row.get("expires_at") and row["expires_at"] < time.time():
            raise HTTPException(status_code=401, detail="API key expired")

        # Update last_used
        db.conn.execute(
            "UPDATE api_keys SET last_used_at = ? WHERE key_id = ?",
            (time.time(), row["key_id"]),
        )
        db.conn.commit()

        # Get user info
        user_row = db.conn.execute(
            "SELECT * FROM users WHERE user_id = ?", (row["user_id"],)
        ).fetchone()

        return CurrentUser(
            user_id=row["user_id"],
            email=dict(user_row)["email"] if user_row else "",
            org_id=row["org_id"],
            auth_method="api_key",
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid API key")


def generate_api_key() -> tuple[str, str, str]:
    """Generate a new API key. Returns (full_key, key_prefix, key_hash)."""
    raw = f"ak_{uuid.uuid4().hex}"
    prefix = raw[:11]  # "ak_" + first 8 hex chars
    key_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, prefix, key_hash
