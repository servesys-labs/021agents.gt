"""Clerk token verification helpers (RS256 via JWKS).

This module lets AgentOS trust Clerk-issued JWTs without introducing
additional JWT libraries. It verifies signature, expiry, issuer, and
optionally audience against environment configuration.
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class ClerkClaims:
    sub: str
    email: str
    name: str
    org_id: str
    org_name: str
    org_role: str
    iss: str
    exp: int
    iat: int
    aud: str | None = None


def clerk_enabled() -> bool:
    return os.environ.get("AGENTOS_AUTH_PROVIDER", "").lower() == "clerk"


def _b64url_decode(value: str) -> bytes:
    padded = value + "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(padded)


def _issuer() -> str:
    issuer = os.environ.get("AGENTOS_CLERK_ISSUER", "").strip()
    return issuer.rstrip("/")


def _audience() -> str:
    return os.environ.get("AGENTOS_CLERK_AUDIENCE", "").strip()


def _jwks_url() -> str:
    configured = os.environ.get("AGENTOS_CLERK_JWKS_URL", "").strip()
    if configured:
        return configured
    issuer = _issuer()
    if not issuer:
        raise ValueError("AGENTOS_CLERK_ISSUER is required for Clerk auth")
    return f"{issuer}/.well-known/jwks.json"


def _load_jwks() -> dict[str, Any]:
    url = _jwks_url()
    timeout = float(os.environ.get("AGENTOS_CLERK_JWKS_TIMEOUT_SECONDS", "5"))
    response = httpx.get(url, timeout=timeout)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or "keys" not in payload:
        raise ValueError("Invalid JWKS payload from Clerk")
    return payload


def _public_key_from_jwk(jwk: dict[str, Any]):
    from cryptography.hazmat.primitives.asymmetric import rsa

    n = int.from_bytes(_b64url_decode(jwk["n"]), "big")
    e = int.from_bytes(_b64url_decode(jwk["e"]), "big")
    return rsa.RSAPublicNumbers(e, n).public_key()


def _pick_key(jwks: dict[str, Any], kid: str) -> dict[str, Any] | None:
    keys = jwks.get("keys", [])
    for key in keys:
        if key.get("kid") == kid and key.get("kty") == "RSA":
            return key
    return None


def verify_clerk_token(token: str) -> ClerkClaims | None:
    """Verify Clerk JWT and return normalized claims."""
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        header_b64, payload_b64, signature_b64 = token.split(".")
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
        if header.get("alg") != "RS256":
            return None
        kid = header.get("kid", "")
        if not kid:
            return None

        jwks = _load_jwks()
        jwk = _pick_key(jwks, kid)
        if jwk is None:
            return None

        pub_key = _public_key_from_jwk(jwk)
        signed = f"{header_b64}.{payload_b64}".encode()
        signature = _b64url_decode(signature_b64)
        pub_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())

        now = int(time.time())
        exp = int(payload.get("exp", 0))
        iat = int(payload.get("iat", 0))
        if exp <= now or iat > now + 60:
            return None

        expected_iss = _issuer()
        if expected_iss and payload.get("iss", "").rstrip("/") != expected_iss:
            return None

        expected_aud = _audience()
        if expected_aud:
            aud = payload.get("aud")
            if isinstance(aud, list):
                if expected_aud not in aud:
                    return None
            elif aud != expected_aud:
                return None

        email = payload.get("email", "") or payload.get("primary_email_address", "")
        name = payload.get("name", "") or payload.get("full_name", "") or email.split("@")[0]
        org_id = (
            payload.get("org_id")
            or payload.get("organization_id")
            or payload.get("org")
            or ""
        )
        org_name = payload.get("org_name") or payload.get("organization_name") or ""
        org_role = (
            payload.get("org_role")
            or payload.get("organization_role")
            or payload.get("role")
            or ""
        )
        return ClerkClaims(
            sub=str(payload.get("sub", "")),
            email=str(email),
            name=str(name),
            org_id=str(org_id),
            org_name=str(org_name),
            org_role=str(org_role),
            iss=str(payload.get("iss", "")),
            exp=exp,
            iat=iat,
            aud=str(payload.get("aud")) if payload.get("aud") else None,
        )
    except Exception:
        return None
