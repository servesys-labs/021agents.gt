"""Shared API dependencies — auth, RBAC, scoped API keys, database context.

Used by all API routers for consistent auth and permission checks.

Permission model:
  org_id / project_id / env — scope hierarchy
  role — owner > admin > member > viewer
  scopes — fine-grained capabilities on API keys

API key scopes:
  "*"                — full access
  "agents:read"      — list/get agents
  "agents:write"     — create/update/delete agents
  "agents:run"       — run agents
  "sessions:read"    — list/get sessions
  "eval:run"         — run evaluations
  "billing:read"     — view billing
  "admin"            — org/team management
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, HTTPException, Request

logger = logging.getLogger(__name__)

# ── Bounded TTL cache for auth resolution ────────────────────────────
# Eliminates repeated DB queries for the same token/key within a window.
# Thread-safe, bounded to prevent OOM under many unique tokens.

_AUTH_CACHE_MAX = 2048       # Max entries
_AUTH_CACHE_TTL = 300.0      # 5 minutes
_auth_cache: dict[str, tuple[float, Any]] = {}  # value is (timestamp, CurrentUser)
_auth_cache_lock = threading.Lock()


def _cache_get(key: str):
    """Get a cached auth result, or None if missing/expired."""
    entry = _auth_cache.get(key)
    if entry is None:
        return None
    ts, user = entry
    if time.time() - ts > _AUTH_CACHE_TTL:
        # Expired — remove lazily
        with _auth_cache_lock:
            _auth_cache.pop(key, None)
        return None
    return user


def _cache_put(key: str, user) -> None:
    """Store an auth result. Evicts oldest entries if over capacity."""
    with _auth_cache_lock:
        _auth_cache[key] = (time.time(), user)
        if len(_auth_cache) > _AUTH_CACHE_MAX:
            # Evict oldest 25% to amortize eviction cost
            items = sorted(_auth_cache.items(), key=lambda x: x[1][0])
            to_remove = len(items) // 4
            for k, _ in items[:to_remove]:
                _auth_cache.pop(k, None)

# ── Role hierarchy ────────────────────────────────────────────────────────

ROLE_HIERARCHY = {"owner": 4, "admin": 3, "member": 2, "viewer": 1}

# ── Scope definitions ────────────────────────────────────────────────────

ALL_SCOPES = {
    "*",
    "agents:read", "agents:write", "agents:run",
    "sessions:read", "sessions:write",
    "eval:read", "eval:run",
    "evolve:read", "evolve:write",
    "billing:read", "billing:write",
    "memory:read", "memory:write",
    "tools:read",
    "schedules:read", "schedules:write",
    "webhooks:read", "webhooks:write",
    "rag:read", "rag:write",
    "sandbox:read", "sandbox:write",
    "deploy:read", "deploy:write",
    "policies:read", "policies:write",
    "slos:read", "slos:write",
    "releases:read", "releases:write",
    "jobs:read", "jobs:write",
    "workflows:read", "workflows:write",
    "intelligence:read", "intelligence:write",
    "admin",
}


@dataclass
class CurrentUser:
    """Resolved user context for API requests."""
    user_id: str
    email: str
    name: str = ""
    org_id: str = ""
    project_id: str = ""  # Scoped to specific project (API keys)
    env: str = ""  # Scoped to specific environment (API keys)
    role: str = "member"  # owner/admin/member/viewer
    scopes: list[str] = field(default_factory=lambda: ["*"])
    auth_method: str = "jwt"  # jwt/api_key

    @property
    def role_level(self) -> int:
        return ROLE_HIERARCHY.get(self.role, 0)

    def has_scope(self, scope: str) -> bool:
        """Check if user has a specific scope."""
        if "*" in self.scopes:
            return True
        # Check exact match
        if scope in self.scopes:
            return True
        # Check wildcard category (e.g., "agents:*" matches "agents:read")
        category = scope.split(":")[0]
        if f"{category}:*" in self.scopes:
            return True
        return False

    def has_role(self, min_role: str) -> bool:
        """Check if user has at least the specified role."""
        return self.role_level >= ROLE_HIERARCHY.get(min_role, 0)


def _get_db():
    """Get the project's AgentDB singleton (already initialized at startup)."""
    from agentos.core.db_config import get_db, initialize_db, is_sqlite
    from pathlib import Path

    if is_sqlite():
        db_path = Path.cwd() / "data" / "agent.db"
        if not db_path.exists():
            raise HTTPException(status_code=503, detail="Database not initialized. Run 'agentos init' first.")

    # Ensure init has run (no-op after first call thanks to _db_initialized flag)
    initialize_db()
    return get_db()


def _get_db_safe():
    """Get DB instance without raising HTTPException (for background tasks)."""
    try:
        return _get_db()
    except Exception:
        return None


async def get_current_user(request: Request) -> CurrentUser:
    """Extract authenticated user from JWT token or API key.

    Supports dual-mode auth:
    - Bearer <jwt_token> — browser sessions (full access per role)
    - Bearer ak_<api_key> — programmatic access (scoped to org/project/env + capabilities)
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


# ── Permission checkers (use as FastAPI dependencies) ──────────────────

def require_scope(scope: str):
    """FastAPI dependency that checks for a specific scope."""
    async def _check(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not user.has_scope(scope):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required scope: {scope}",
            )
        return user
    return _check


def require_role(min_role: str):
    """FastAPI dependency that checks for a minimum role level."""
    async def _check(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not user.has_role(min_role):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient role. Required: {min_role}, current: {user.role}",
            )
        return user
    return _check


def require_admin():
    """Shortcut: require admin or owner role."""
    return require_role("admin")


# ── Token resolution ──────────────────────────────────────────────────

def _resolve_jwt(token: str) -> CurrentUser:
    """Resolve a JWT token to a CurrentUser (cached with TTL)."""
    cache_key = f"jwt:{hashlib.sha256(token.encode()).hexdigest()[:16]}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    from agentos.auth.jwt import verify_token
    from agentos.auth.clerk import clerk_enabled, verify_clerk_token
    from agentos.auth.provisioning import provision_clerk_identity

    claims = verify_token(token)
    if claims is None and clerk_enabled():
        clerk_claims = verify_clerk_token(token)
        if clerk_claims is not None and clerk_claims.sub and clerk_claims.email:
            db = _get_db()
            provisioned = provision_clerk_identity(
                db=db,
                clerk_sub=clerk_claims.sub,
                email=clerk_claims.email,
                name=clerk_claims.name,
                clerk_org_id=clerk_claims.org_id,
                clerk_org_name=clerk_claims.org_name,
                clerk_role=clerk_claims.org_role,
            )

            user = CurrentUser(
                user_id=provisioned.user_id,
                email=provisioned.email,
                name=provisioned.name,
                org_id=provisioned.org_id,
                role=provisioned.role,
                scopes=["*"],
                auth_method="jwt",
            )
            _cache_put(cache_key, user)
            return user

    if claims is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = claims.user_id
    org_id = getattr(claims, "org_id", "") or ""
    role_from_token = getattr(claims, "extra", {}) or {}
    token_role = role_from_token.get("role", "") if isinstance(role_from_token, dict) else ""

    # Look up role from org_members if org_id is available
    role = "member"
    if token_role in ROLE_HIERARCHY:
        role = token_role
    try:
        db = _get_db()
        # If token does not carry org context, resolve a default org membership.
        if not org_id:
            org_row = db.conn.execute(
                "SELECT org_id, role FROM org_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
                (user_id,),
            ).fetchone()
            if org_row:
                org_id = org_row["org_id"]
                role = org_row["role"]
        if org_id:
            row = db.conn.execute(
                "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
                (org_id, user_id),
            ).fetchone()
            if row:
                role = row["role"]
    except Exception:
        pass

    user = CurrentUser(
        user_id=user_id,
        email=claims.email,
        name=getattr(claims, "name", ""),
        org_id=org_id,
        role=role,
        scopes=["*"],  # JWT users get full scopes, controlled by role
        auth_method="jwt",
    )
    _cache_put(cache_key, user)
    return user


def _resolve_api_key(key: str) -> CurrentUser:
    """Resolve an API key to a CurrentUser with scoped permissions (cached with TTL)."""
    cache_key = f"ak:{hashlib.sha256(key.encode()).hexdigest()[:16]}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

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

        # Parse scopes
        scopes = json.loads(row.get("scopes", '["*"]'))

        user = CurrentUser(
            user_id=row["user_id"],
            email=dict(user_row)["email"] if user_row else "",
            org_id=row["org_id"],
            project_id=row.get("project_id", ""),
            env=row.get("env", ""),
            role="member",  # API keys don't inherit role — controlled by scopes
            scopes=scopes,
            auth_method="api_key",
        )
        _cache_put(cache_key, user)
        return user
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
