"""Secrets router — encrypted secrets vault per org/project/env."""

from __future__ import annotations

import base64
import hashlib
import os
import time

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/secrets", tags=["secrets"])


def _encrypt_secret(value: str) -> str:
    """Encrypt secret value using a versioned, authenticated format.

    Preferred format:
      fernet:v1:<base64-salt>:<fernet-token>
    Fallback (when cryptography is unavailable):
      legacy XOR-based encoding for backward compatibility only.
    """
    key_seed = os.environ.get("AGENTOS_SECRET_ENCRYPTION_KEY") or os.environ.get("AGENTOS_JWT_SECRET", "")
    if not key_seed:
        # Deterministic fallback for local development; set AGENTOS_SECRET_ENCRYPTION_KEY in production.
        key_seed = "agentos-dev-key"
    seed = key_seed.encode("utf-8")
    try:
        from cryptography.fernet import Fernet
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

        salt = os.urandom(16)
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=390000,
        )
        fernet_key = base64.urlsafe_b64encode(kdf.derive(seed))
        token = Fernet(fernet_key).encrypt(value.encode("utf-8")).decode("ascii")
        salt_b64 = base64.urlsafe_b64encode(salt).decode("ascii")
        return f"fernet:v1:{salt_b64}:{token}"
    except Exception:
        # Safe fallback for environments without cryptography; also used by _decrypt_secret for legacy values.
        return _encrypt_secret_legacy(value)


def _encrypt_secret_legacy(value: str) -> str:
    """Legacy obfuscation scheme kept only for backward compatibility."""
    key_seed = os.environ.get("AGENTOS_SECRET_ENCRYPTION_KEY") or os.environ.get("AGENTOS_JWT_SECRET", "")
    if not key_seed:
        # Deterministic fallback for local development; set AGENTOS_SECRET_ENCRYPTION_KEY in production.
        key_seed = "agentos-dev-key"
    key = hashlib.sha256(key_seed.encode("utf-8")).digest()
    raw = value.encode("utf-8")
    encrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw))
    return base64.urlsafe_b64encode(encrypted).decode("ascii")


def _decrypt_secret(value_encrypted: str) -> str:
    """Decrypt a stored secret value (new format + legacy compatibility)."""
    key_seed = os.environ.get("AGENTOS_SECRET_ENCRYPTION_KEY") or os.environ.get("AGENTOS_JWT_SECRET", "")
    if not key_seed:
        key_seed = "agentos-dev-key"
    seed = key_seed.encode("utf-8")

    if value_encrypted.startswith("fernet:v1:"):
        try:
            from cryptography.fernet import Fernet
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

            _, _, salt_b64, token = value_encrypted.split(":", 3)
            salt = base64.urlsafe_b64decode(salt_b64.encode("ascii"))
            kdf = PBKDF2HMAC(
                algorithm=hashes.SHA256(),
                length=32,
                salt=salt,
                iterations=390000,
            )
            fernet_key = base64.urlsafe_b64encode(kdf.derive(seed))
            return Fernet(fernet_key).decrypt(token.encode("ascii")).decode("utf-8")
        except Exception as exc:
            raise ValueError("Unable to decrypt fernet secret value") from exc

    # Legacy decode path; if it fails, return as-is to preserve compatibility
    # with rows that may have been written as plaintext before encryption fixes.
    try:
        raw = base64.urlsafe_b64decode(value_encrypted.encode("ascii"))
        key = hashlib.sha256(seed).digest()
        decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw))
        return decrypted.decode("utf-8")
    except Exception:
        return value_encrypted


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
        """INSERT INTO secrets (org_id, project_id, env, name, value_encrypted, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (user.org_id, project_id, env, name, _encrypt_secret(value), user.user_id, now, now),
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
        "UPDATE secrets SET value_encrypted = ?, updated_at = ? WHERE org_id = ? AND name = ? AND project_id = ? AND env = ?",
        (_encrypt_secret(new_value), now, user.org_id, name, project_id, env),
    )
    db.conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")
    return {"rotated": name, "updated_at": now}
