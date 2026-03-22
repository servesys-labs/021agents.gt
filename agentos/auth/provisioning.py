"""Shared user/org provisioning helpers for external auth providers."""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any


ROLE_HIERARCHY = {"owner": 4, "admin": 3, "member": 2, "viewer": 1}


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", value.lower())
    return normalized.strip("-") or "org"


def _load_role_map() -> dict[str, str]:
    import os

    default = {
        "org:owner": "owner",
        "owner": "owner",
        "org:admin": "admin",
        "admin": "admin",
        "org:member": "member",
        "basic_member": "member",
        "member": "member",
        "org:viewer": "viewer",
        "viewer": "viewer",
        "read_only": "viewer",
    }
    raw = os.environ.get("AGENTOS_CLERK_ROLE_MAP", "").strip()
    if not raw:
        return default
    try:
        parsed = json.loads(raw)
    except Exception:
        return default
    if not isinstance(parsed, dict):
        return default
    out = dict(default)
    for key, value in parsed.items():
        if isinstance(key, str) and isinstance(value, str) and value in ROLE_HIERARCHY:
            out[key.lower()] = value
    return out


def map_clerk_role(clerk_role: str) -> str:
    if not clerk_role:
        return "member"
    mapped = _load_role_map().get(clerk_role.lower(), "member")
    return mapped if mapped in ROLE_HIERARCHY else "member"


@dataclass
class ProvisionedIdentity:
    user_id: str
    email: str
    name: str
    org_id: str
    role: str


def _ensure_user(db, user_id: str, email: str, name: str) -> tuple[str, str, str]:
    by_id = db.conn.execute(
        "SELECT user_id, email, name FROM users WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    by_email = db.conn.execute(
        "SELECT user_id, email, name FROM users WHERE email = ?",
        (email,),
    ).fetchone()
    if by_id:
        return by_id["user_id"], by_id["email"], by_id["name"] or name
    if by_email:
        return by_email["user_id"], by_email["email"], by_email["name"] or name
    db.conn.execute(
        "INSERT INTO users (user_id, email, name, password_hash, provider, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, email, name, "", "clerk", time.time()),
    )
    db.conn.commit()
    return user_id, email, name


def _ensure_org(db, org_external_id: str, org_name: str, owner_user_id: str) -> str:
    slug = _slugify(f"clerk-{org_external_id}")
    row = db.conn.execute("SELECT org_id FROM orgs WHERE slug = ?", (slug,)).fetchone()
    if row:
        return row["org_id"]
    org_id = uuid.uuid4().hex[:16]
    db.conn.execute(
        "INSERT INTO orgs (org_id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
        (org_id, org_name or f"Org {org_external_id}", slug, owner_user_id),
    )
    db.conn.commit()
    return org_id


def _ensure_personal_org(db, user_id: str, email: str, name: str) -> str:
    row = db.conn.execute(
        "SELECT org_id FROM org_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
        (user_id,),
    ).fetchone()
    if row:
        return row["org_id"]
    org_id = uuid.uuid4().hex[:16]
    org_slug = _slugify(email.split("@")[0] if "@" in email else email)
    db.conn.execute(
        "INSERT INTO orgs (org_id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
        (org_id, f"{name or org_slug}'s Org", org_slug, user_id),
    )
    db.conn.execute(
        "INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        (org_id, user_id, time.time()),
    )
    db.conn.commit()
    return org_id


def _upsert_membership(db, org_id: str, user_id: str, role: str) -> None:
    existing = db.conn.execute(
        "SELECT role FROM org_members WHERE org_id = ? AND user_id = ?",
        (org_id, user_id),
    ).fetchone()
    now = time.time()
    if not existing:
        db.conn.execute(
            "INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
            (org_id, user_id, role, now),
        )
    elif existing["role"] != role:
        db.conn.execute(
            "UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?",
            (role, org_id, user_id),
        )
    db.conn.commit()


def provision_clerk_identity(
    db,
    clerk_sub: str,
    email: str,
    name: str,
    clerk_org_id: str,
    clerk_org_name: str,
    clerk_role: str,
) -> ProvisionedIdentity:
    user_id, email, name = _ensure_user(
        db,
        user_id=f"clerk:{clerk_sub}",
        email=email,
        name=name or (email.split("@")[0] if email else "user"),
    )

    mapped_role = map_clerk_role(clerk_role)
    if clerk_org_id:
        org_id = _ensure_org(
            db,
            org_external_id=clerk_org_id,
            org_name=clerk_org_name or f"Clerk Org {clerk_org_id}",
            owner_user_id=user_id,
        )
        _upsert_membership(db, org_id, user_id, mapped_role)
    else:
        org_id = _ensure_personal_org(db, user_id=user_id, email=email, name=name)
        if mapped_role != "member":
            _upsert_membership(db, org_id, user_id, mapped_role)

    return ProvisionedIdentity(
        user_id=user_id,
        email=email,
        name=name,
        org_id=org_id,
        role=mapped_role if mapped_role else "member",
    )
