"""Auth middleware for FastAPI — JWT verification + OAuth callback endpoints.

Adds:
  - Bearer token verification on protected routes
  - POST /auth/login  — email/password login (returns JWT)
  - POST /auth/signup — create account (returns JWT)
  - GET  /auth/me     — current user info
  - POST /auth/logout — invalidate (client-side)
  - GET  /auth/github/callback — OAuth redirect callback
  - GET  /auth/google/callback — OAuth redirect callback

Public routes (no auth required):
  /health, /auth/*, static assets
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from agentos.auth.jwt import TokenClaims, create_token, verify_token

logger = logging.getLogger(__name__)

# Simple file-based user store for local dev
# In production (CF), users are stored in D1
USERS_FILE = Path("data/users.json")

security = HTTPBearer(auto_error=False)


# ── Request/Response models ──────────────────────────────────────────────


class SignupRequest(BaseModel):
    email: str = Field(..., description="User email")
    password: str = Field(..., min_length=8, description="Password (min 8 chars)")
    name: str = Field("", description="Display name")


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenExchangeRequest(BaseModel):
    oauth_token: str = Field(..., min_length=1)
    provider: str = Field(..., description="OAuth provider")
    user_id: str = ""
    email: str = ""
    name: str = ""


class AuthResponse(BaseModel):
    token: str
    user_id: str
    email: str
    name: str
    provider: str


class UserInfo(BaseModel):
    user_id: str
    email: str
    name: str
    provider: str


# ── User store (local dev) ──────────────────────────────────────────────


def _load_users() -> dict[str, Any]:
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text())
    return {}


def _save_users(users: dict[str, Any]) -> None:
    USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    USERS_FILE.write_text(json.dumps(users, indent=2) + "\n")


def _hash_password(password: str, salt: str = "") -> str:
    if not salt:
        salt = os.urandom(16).hex()
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()
    return f"{salt}:{hashed}"


def _verify_password(password: str, stored: str) -> bool:
    salt, expected_hash = stored.split(":", 1)
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()
    return actual == expected_hash


# ── Auth dependency ──────────────────────────────────────────────────────


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> TokenClaims | None:
    """Extract and verify JWT from Authorization header. Returns None if no token."""
    if credentials is None:
        return None
    claims = verify_token(credentials.credentials)
    return claims


async def require_auth(
    user: TokenClaims | None = Depends(get_current_user),
) -> TokenClaims:
    """Require a valid JWT. Raises 401 if missing/invalid."""
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


# ── Public routes that skip auth ─────────────────────────────────────────

PUBLIC_PREFIXES = ("/health", "/auth/", "/static/", "/assets/")


# ── Mount auth routes ────────────────────────────────────────────────────


def mount_auth_routes(app: FastAPI) -> None:
    """Add authentication endpoints to the FastAPI app."""

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        """Check auth on protected routes if AUTH_REQUIRED is set."""
        # Skip auth check if not required
        if not os.environ.get("AGENTOS_AUTH_REQUIRED"):
            return await call_next(request)

        path = request.url.path
        # Allow public routes
        if any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return await call_next(request)
        if path == "/":
            return await call_next(request)

        # Check for Bearer token
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            claims = verify_token(token)
            if claims is None:
                return JSONResponse(
                    {"error": "Invalid or expired token"},
                    status_code=401,
                )
            request.state.user = claims
        else:
            return JSONResponse(
                {"error": "Authentication required"},
                status_code=401,
            )

        return await call_next(request)

    @app.post("/auth/signup", response_model=AuthResponse)
    async def signup(req: SignupRequest) -> AuthResponse:
        """Create a new account with email/password."""
        users = _load_users()
        if req.email in users:
            raise HTTPException(status_code=409, detail="Email already registered")

        user_id = f"email:{hashlib.sha256(req.email.encode()).hexdigest()[:16]}"
        users[req.email] = {
            "user_id": user_id,
            "email": req.email,
            "name": req.name or req.email.split("@")[0],
            "password_hash": _hash_password(req.password),
            "provider": "email",
        }
        _save_users(users)

        token = create_token(
            user_id=user_id,
            email=req.email,
            name=users[req.email]["name"],
            provider="email",
        )

        return AuthResponse(
            token=token,
            user_id=user_id,
            email=req.email,
            name=users[req.email]["name"],
            provider="email",
        )

    @app.post("/auth/login", response_model=AuthResponse)
    async def login(req: LoginRequest) -> AuthResponse:
        """Login with email/password."""
        users = _load_users()
        user = users.get(req.email)
        if not user or not _verify_password(req.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        token = create_token(
            user_id=user["user_id"],
            email=user["email"],
            name=user["name"],
            provider=user["provider"],
        )

        return AuthResponse(
            token=token,
            user_id=user["user_id"],
            email=user["email"],
            name=user["name"],
            provider=user["provider"],
        )

    @app.get("/auth/me", response_model=UserInfo)
    async def me(user: TokenClaims = Depends(require_auth)) -> UserInfo:
        """Get current user info."""
        return UserInfo(
            user_id=user.sub,
            email=user.email,
            name=user.name,
            provider=user.provider,
        )

    @app.post("/auth/logout")
    async def logout() -> dict[str, str]:
        """Logout (client should discard token)."""
        return {"status": "logged_out"}

    @app.post("/auth/token/exchange")
    async def exchange(req: TokenExchangeRequest) -> dict[str, Any]:
        """Exchange an OAuth token for a server-signed JWT.

        Called by ``agentos login --server <url>`` so the CLI gets a JWT
        signed with this server's secret rather than a client-minted one.
        """
        from agentos.auth import oauth

        if req.provider not in ("github", "google"):
            raise HTTPException(status_code=400, detail="Unsupported OAuth provider")

        try:
            if req.provider == "github":
                verified = oauth.github_get_user(req.oauth_token)
            else:
                verified = oauth.google_get_user(req.oauth_token)
        except Exception as exc:
            logger.warning(
                "OAuth token exchange failed for provider %s: %s",
                req.provider,
                exc,
            )
            raise HTTPException(status_code=401, detail="Invalid OAuth token")

        if req.user_id and req.user_id != verified.id:
            raise HTTPException(status_code=401, detail="OAuth identity mismatch")
        if req.email and req.email != verified.email:
            raise HTTPException(status_code=401, detail="OAuth identity mismatch")

        # Ensure user exists in the local store
        users = _load_users()
        user_key = verified.email or verified.id
        if user_key not in users:
            users[user_key] = {
                "user_id": verified.id,
                "email": verified.email,
                "name": verified.name or verified.email.split("@")[0],
                "password_hash": "",  # OAuth users have no password
                "provider": verified.provider,
            }
            _save_users(users)

        token = create_token(
            user_id=verified.id,
            email=verified.email,
            name=verified.name,
            provider=verified.provider,
        )
        return {"token": token, "user_id": verified.id}

    @app.post("/auth/token/verify")
    async def verify(user: TokenClaims | None = Depends(get_current_user)) -> dict[str, Any]:
        """Verify a JWT token and return claims."""
        if user is None:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        return {
            "valid": True,
            "user_id": user.sub,
            "email": user.email,
            "name": user.name,
            "provider": user.provider,
            "expires_at": user.exp,
        }
