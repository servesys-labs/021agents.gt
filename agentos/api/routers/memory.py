"""Memory router — episodic, semantic (facts), procedural, working memory."""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/memory", tags=["memory"])


# ── Episodic Memory ────────────────────────────────────────────────────

@router.get("/{agent_name}/episodes")
async def list_episodes(agent_name: str, limit: int = 50, query: str = ""):
    """List episodic memories for an agent."""
    db = _get_db()
    if query:
        rows = db.search_episodes(query, limit=limit)
    else:
        rows = db.recent_episodes(limit=limit)
    return {"episodes": rows, "total": len(rows)}


@router.post("/{agent_name}/episodes")
async def create_episode(
    agent_name: str,
    input_text: str,
    output_text: str,
    outcome: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Manually add an episodic memory."""
    import uuid
    db = _get_db()
    episode_id = uuid.uuid4().hex
    db.insert_episode({
        "id": episode_id,
        "input": input_text,
        "output": output_text,
        "outcome": outcome,
        "metadata": {"agent": agent_name, "source": "api"},
        "timestamp": time.time(),
    })
    return {"id": episode_id, "created": True}


@router.delete("/{agent_name}/episodes")
async def clear_episodes(agent_name: str, user: CurrentUser = Depends(get_current_user)):
    """Clear all episodic memories."""
    db = _get_db()
    db.conn.execute("DELETE FROM episodes")
    db.conn.commit()
    return {"cleared": True}


# ── Semantic Memory (Facts) ────────────────────────────────────────────

@router.get("/{agent_name}/facts")
async def list_facts(agent_name: str, query: str = "", limit: int = 50):
    """List semantic facts."""
    db = _get_db()
    if query:
        rows = db.search_facts_by_keyword(query, limit=limit)
    else:
        rows = db.conn.execute("SELECT key, value_json FROM facts LIMIT ?", (limit,)).fetchall()
        rows = [{"key": r["key"], "value": json.loads(r["value_json"])} for r in rows]
    return {"facts": rows, "total": len(rows)}


@router.post("/{agent_name}/facts")
async def upsert_fact(
    agent_name: str,
    key: str,
    value: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Store or update a semantic fact."""
    db = _get_db()
    db.upsert_fact(key, value)
    return {"key": key, "stored": True}


@router.delete("/{agent_name}/facts/{key}")
async def delete_fact(agent_name: str, key: str, user: CurrentUser = Depends(get_current_user)):
    """Delete a semantic fact."""
    db = _get_db()
    db.conn.execute("DELETE FROM facts WHERE key = ?", (key,))
    db.conn.commit()
    return {"deleted": key}


@router.delete("/{agent_name}/facts")
async def clear_facts(agent_name: str, user: CurrentUser = Depends(get_current_user)):
    """Clear all semantic facts."""
    db = _get_db()
    db.conn.execute("DELETE FROM facts")
    db.conn.commit()
    return {"cleared": True}


# ── Procedural Memory ─────────────────────────────────────────────────

@router.get("/{agent_name}/procedures")
async def list_procedures(agent_name: str, limit: int = 50):
    """List learned procedures (tool sequences)."""
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM procedures ORDER BY last_used DESC LIMIT ?", (limit,)
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["steps"] = json.loads(d.get("steps_json", "[]"))
        total = d.get("success_count", 0) + d.get("failure_count", 0)
        d["success_rate"] = d["success_count"] / total if total > 0 else 0
        result.append(d)
    return {"procedures": result, "total": len(result)}


@router.delete("/{agent_name}/procedures")
async def clear_procedures(agent_name: str, user: CurrentUser = Depends(get_current_user)):
    """Clear all procedural memories."""
    db = _get_db()
    db.conn.execute("DELETE FROM procedures")
    db.conn.commit()
    return {"cleared": True}


# ── Working Memory (in-memory snapshot) ────────────────────────────────

@router.get("/{agent_name}/working")
async def working_memory_snapshot(agent_name: str):
    """Get the current working memory snapshot (in-memory, not persisted)."""
    try:
        from agentos.agent import Agent
        agent = Agent.from_name(agent_name)
        snapshot = agent._harness.memory_manager.working.snapshot()
        return {"agent": agent_name, "working_memory": snapshot}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
    except Exception:
        return {"agent": agent_name, "working_memory": {}}
