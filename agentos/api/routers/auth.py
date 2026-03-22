"""Auth router — signup, login, token management."""

from __future__ import annotations

import hashlib
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.api.schemas import (
    LoginRequest, SignupRequest, TokenResponse, UserResponse,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup", response_model=TokenResponse)
async def signup(request: SignupRequest):
    """Create a new user account with a personal org."""
    from agentos.auth.jwt import create_token, set_secret

    db = _get_db()

    # Check if user exists
    existing = db.conn.execute("SELECT user_id FROM users WHERE email = ?", (request.email,)).fetchone()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    user_id = uuid.uuid4().hex[:16]
    password_hash = hashlib.sha256(request.password.encode()).hexdigest()

    # Create user
    db.conn.execute(
        "INSERT INTO users (user_id, email, name, password_hash) VALUES (?, ?, ?, ?)",
        (user_id, request.email, request.name, password_hash),
    )

    # Create personal org
    org_id = uuid.uuid4().hex[:16]
    org_slug = request.email.split("@")[0].lower().replace(".", "-")
    db.conn.execute(
        "INSERT INTO orgs (org_id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
        (org_id, f"{request.name or org_slug}'s Org", org_slug, user_id),
    )
    db.conn.execute(
        "INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')",
        (org_id, user_id),
    )
    db.conn.commit()

    token = create_token(user_id=user_id, email=request.email)

    return TokenResponse(token=token, user_id=user_id, email=request.email, org_id=org_id)


@router.post("/login", response_model=TokenResponse)
async def login(request: LoginRequest):
    """Authenticate with email and password."""
    from agentos.auth.jwt import create_token

    db = _get_db()
    password_hash = hashlib.sha256(request.password.encode()).hexdigest()

    row = db.conn.execute(
        "SELECT user_id, email, name FROM users WHERE email = ? AND password_hash = ?",
        (request.email, password_hash),
    ).fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user = dict(row)

    # Get default org
    org_row = db.conn.execute(
        "SELECT org_id FROM org_members WHERE user_id = ? LIMIT 1", (user["user_id"],)
    ).fetchone()
    org_id = dict(org_row)["org_id"] if org_row else ""

    token = create_token(user_id=user["user_id"], email=user["email"])

    return TokenResponse(token=token, user_id=user["user_id"], email=user["email"], org_id=org_id)


@router.get("/me", response_model=UserResponse)
async def me(user: CurrentUser = Depends(get_current_user)):
    """Get the current authenticated user."""
    return UserResponse(
        user_id=user.user_id,
        email=user.email,
        name=user.name,
        org_id=user.org_id,
        role=user.role,
    )


@router.post("/logout")
async def logout(user: CurrentUser = Depends(get_current_user)):
    """Logout (client should discard token)."""
    return {"logged_out": True}


@router.post("/password")
async def change_password(
    current_password: str,
    new_password: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Change password."""
    db = _get_db()
    current_hash = hashlib.sha256(current_password.encode()).hexdigest()

    row = db.conn.execute(
        "SELECT user_id FROM users WHERE user_id = ? AND password_hash = ?",
        (user.user_id, current_hash),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    new_hash = hashlib.sha256(new_password.encode()).hexdigest()
    db.conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?",
        (new_hash, time.time(), user.user_id),
    )
    db.conn.commit()
    return {"updated": True}
