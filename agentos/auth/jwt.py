"""Minimal JWT implementation — no external dependencies.

Uses HMAC-SHA256 for signing (symmetric key). Good for single-service auth.
For multi-service / zero-trust, swap to RS256 with public key verification.

This avoids requiring PyJWT or python-jose as dependencies.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Any

# Default expiry: 7 days
DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60

# Secret key — set via AGENTOS_JWT_SECRET env var, or auto-generated
_jwt_secret: str | None = None


def _get_secret() -> str:
    """Get or generate the JWT signing secret.

    Resolution order:
      1. Explicit override via set_secret()
      2. AGENTOS_JWT_SECRET env var
      3. Persisted secret in ~/.agentos/jwt_secret (created once, reused)
    This ensures tokens survive process restarts.
    """
    global _jwt_secret
    if _jwt_secret is None:
        _jwt_secret = os.environ.get("AGENTOS_JWT_SECRET", "")
        if not _jwt_secret:
            # Persist to disk so local tokens survive restarts
            from pathlib import Path
            secret_path = Path.home() / ".agentos" / "jwt_secret"
            if secret_path.exists():
                _jwt_secret = secret_path.read_text().strip()
            else:
                _jwt_secret = os.urandom(32).hex()
                secret_path.parent.mkdir(parents=True, exist_ok=True)
                secret_path.write_text(_jwt_secret)
                secret_path.chmod(0o600)
    return _jwt_secret


def set_secret(secret: str) -> None:
    """Override the JWT secret (useful for testing or explicit config)."""
    global _jwt_secret
    _jwt_secret = secret


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    if padding != 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s)


@dataclass
class TokenClaims:
    """Decoded JWT claims."""
    sub: str  # user ID
    email: str = ""
    name: str = ""
    provider: str = ""  # "github", "google", "email"
    iat: int = 0  # issued at (unix timestamp)
    exp: int = 0  # expiry (unix timestamp)
    extra: dict[str, Any] | None = None

    @property
    def expired(self) -> bool:
        return time.time() > self.exp

    @property
    def user_id(self) -> str:
        return self.sub


def create_token(
    user_id: str,
    email: str = "",
    name: str = "",
    provider: str = "",
    expiry_seconds: int = DEFAULT_EXPIRY_SECONDS,
    extra: dict[str, Any] | None = None,
) -> str:
    """Create a signed JWT token."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload: dict[str, Any] = {
        "sub": user_id,
        "email": email,
        "name": name,
        "provider": provider,
        "iat": now,
        "exp": now + expiry_seconds,
    }
    if extra:
        payload.update(extra)

    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())

    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(
        _get_secret().encode(), signing_input.encode(), hashlib.sha256
    ).digest()
    sig_b64 = _b64url_encode(signature)

    return f"{header_b64}.{payload_b64}.{sig_b64}"


def verify_token(token: str) -> TokenClaims | None:
    """Verify a JWT token and return claims. Returns None if invalid/expired."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None

        header_b64, payload_b64, sig_b64 = parts

        # Verify signature
        signing_input = f"{header_b64}.{payload_b64}"
        expected_sig = hmac.new(
            _get_secret().encode(), signing_input.encode(), hashlib.sha256
        ).digest()
        actual_sig = _b64url_decode(sig_b64)

        if not hmac.compare_digest(expected_sig, actual_sig):
            return None

        # Decode payload
        payload = json.loads(_b64url_decode(payload_b64))

        claims = TokenClaims(
            sub=payload.get("sub", ""),
            email=payload.get("email", ""),
            name=payload.get("name", ""),
            provider=payload.get("provider", ""),
            iat=payload.get("iat", 0),
            exp=payload.get("exp", 0),
        )

        # Check expiry
        if claims.expired:
            return None

        return claims
    except Exception:
        return None
