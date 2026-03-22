"""Releases router — channels, canary splits, promotions."""

from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/releases", tags=["releases"])


# ── Release Channels ───────────────────────────────────────────────────

@router.get("/{agent_name}/channels")
async def list_channels(agent_name: str):
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM release_channels WHERE agent_name = ? ORDER BY channel", (agent_name,)
    ).fetchall()
    return {"channels": [dict(r) for r in rows]}


@router.post("/{agent_name}/promote")
async def promote(
    agent_name: str,
    from_channel: str = "draft",
    to_channel: str = "staging",
    user: CurrentUser = Depends(get_current_user),
):
    """Promote an agent version from one channel to another."""
    db = _get_db()

    # Get source channel config
    source = db.conn.execute(
        "SELECT * FROM release_channels WHERE agent_name = ? AND channel = ?",
        (agent_name, from_channel),
    ).fetchone()

    if not source:
        # If no channels exist, create from current agent config
        from agentos.agent import Agent
        try:
            agent = Agent.from_name(agent_name)
            config_json = json.dumps(agent.config.to_dict())
            version = agent.config.version
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
    else:
        s = dict(source)
        config_json = s["config_json"]
        version = s["version"]

    # Upsert target channel
    db.conn.execute(
        """INSERT INTO release_channels (org_id, agent_name, channel, version, config_json, promoted_by, promoted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_name, channel) DO UPDATE SET
            version = excluded.version, config_json = excluded.config_json,
            promoted_by = excluded.promoted_by, promoted_at = excluded.promoted_at""",
        (user.org_id, agent_name, to_channel, version, config_json, user.user_id, time.time()),
    )
    db.conn.commit()
    db.audit("agent.promoted", user_id=user.user_id, resource_type="agent",
             resource_id=agent_name, changes={"from": from_channel, "to": to_channel, "version": version})

    return {"promoted": agent_name, "from": from_channel, "to": to_channel, "version": version}


# ── Canary Splits ──────────────────────────────────────────────────────

@router.get("/{agent_name}/canary")
async def get_canary(agent_name: str):
    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM canary_splits WHERE agent_name = ? AND is_active = 1", (agent_name,)
    ).fetchone()
    if not row:
        return {"canary": None}
    return {"canary": dict(row)}


@router.post("/{agent_name}/canary")
async def set_canary(
    agent_name: str,
    primary_version: str,
    canary_version: str,
    canary_weight: float = 0.1,
    user: CurrentUser = Depends(get_current_user),
):
    """Set up a canary traffic split between two versions."""
    if not 0 <= canary_weight <= 1:
        raise HTTPException(status_code=400, detail="canary_weight must be 0.0-1.0")
    db = _get_db()
    # Deactivate existing canary
    db.conn.execute("UPDATE canary_splits SET is_active = 0 WHERE agent_name = ?", (agent_name,))
    db.conn.execute(
        """INSERT INTO canary_splits (agent_name, primary_version, canary_version, canary_weight)
        VALUES (?, ?, ?, ?)""",
        (agent_name, primary_version, canary_version, canary_weight),
    )
    db.conn.commit()
    return {"agent": agent_name, "primary": primary_version, "canary": canary_version, "weight": canary_weight}


@router.delete("/{agent_name}/canary")
async def remove_canary(agent_name: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    db.conn.execute("UPDATE canary_splits SET is_active = 0 WHERE agent_name = ?", (agent_name,))
    db.conn.commit()
    return {"removed": True}
