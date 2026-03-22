"""Sessions router — list, detail, turns, traces, feedback."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from agentos.api.deps import _get_db
from agentos.api.schemas import SessionResponse, TurnResponse

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.get("", response_model=list[SessionResponse])
async def list_sessions(
    agent_name: str = "",
    status: str = "",
    limit: int = 50,
    offset: int = 0,
):
    """List sessions with optional filters."""
    db = _get_db()
    sql = "SELECT * FROM sessions WHERE 1=1"
    params: list[Any] = []
    if agent_name:
        sql += " AND agent_name = ?"
        params.append(agent_name)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    rows = db.conn.execute(sql, params).fetchall()
    return [
        SessionResponse(
            session_id=r["session_id"], agent_name=r["agent_name"],
            status=r["status"], input_text=r["input_text"][:200],
            output_text=r["output_text"][:200], step_count=r["step_count"],
            cost_total_usd=r["cost_total_usd"],
            wall_clock_seconds=r["wall_clock_seconds"],
            trace_id=r["trace_id"], created_at=r["created_at"],
        )
        for r in rows
    ]


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(session_id: str):
    """Get full session details."""
    db = _get_db()
    row = db.conn.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    r = dict(row)
    return SessionResponse(
        session_id=r["session_id"], agent_name=r["agent_name"],
        status=r["status"], input_text=r["input_text"],
        output_text=r["output_text"], step_count=r["step_count"],
        cost_total_usd=r["cost_total_usd"],
        wall_clock_seconds=r["wall_clock_seconds"],
        trace_id=r["trace_id"], created_at=r["created_at"],
    )


@router.get("/{session_id}/turns", response_model=list[TurnResponse])
async def get_turns(session_id: str):
    """Get all turns for a session."""
    import json
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number", (session_id,)
    ).fetchall()
    return [
        TurnResponse(
            turn_number=r["turn_number"], model_used=r["model_used"],
            input_tokens=r["input_tokens"], output_tokens=r["output_tokens"],
            latency_ms=r["latency_ms"], content=r["llm_content"],
            cost_total_usd=r["cost_total_usd"],
            tool_calls=json.loads(r["tool_calls_json"]),
            started_at=r["started_at"], ended_at=r["ended_at"],
        )
        for r in rows
    ]


@router.get("/{session_id}/trace")
async def get_trace(session_id: str):
    """Get the full trace chain for a session."""
    db = _get_db()
    row = db.conn.execute("SELECT trace_id FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    if not row or not row["trace_id"]:
        raise HTTPException(status_code=404, detail="No trace found for session")
    trace_id = row["trace_id"]
    sessions = db.query_trace(trace_id)
    rollup = db.trace_cost_rollup(trace_id)
    return {"trace_id": trace_id, "sessions": sessions, "cost_rollup": rollup}


@router.get("/stats/summary")
async def session_stats(agent_name: str = "", since_days: int = 30):
    """Get aggregate session statistics."""
    import time as _time
    db = _get_db()
    since = _time.time() - (since_days * 86400)
    sql = "SELECT COUNT(*) as total, SUM(cost_total_usd) as cost, AVG(wall_clock_seconds) as avg_duration FROM sessions WHERE created_at >= ?"
    params: list[Any] = [since]
    if agent_name:
        sql = sql.replace("WHERE", "WHERE agent_name = ? AND")
        params.insert(0, agent_name)
    row = db.conn.execute(sql, params).fetchone()
    r = dict(row)

    # Status breakdown
    status_rows = db.conn.execute(
        "SELECT status, COUNT(*) as cnt FROM sessions WHERE created_at >= ? GROUP BY status", (since,)
    ).fetchall()

    return {
        "total_sessions": r["total"] or 0,
        "total_cost_usd": r["cost"] or 0,
        "avg_duration_seconds": r["avg_duration"] or 0,
        "by_status": {s["status"]: s["cnt"] for s in status_rows},
    }


@router.post("/{session_id}/feedback")
async def submit_feedback(
    session_id: str,
    rating: int = 0,
    comment: str = "",
    tags: str = "",
):
    """Submit human feedback for a session output."""
    db = _get_db()
    row = db.conn.execute("SELECT session_id FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    db.insert_feedback(session_id=session_id, rating=rating, comment=comment, tags=tags)
    return {"submitted": True, "session_id": session_id}


@router.get("/{session_id}/feedback")
async def get_feedback(session_id: str):
    """Get all feedback for a session."""
    db = _get_db()
    rows = db.query_feedback(session_id=session_id)
    return {"feedback": rows}


@router.delete("")
async def cleanup_sessions(before_days: int = 90):
    """Delete sessions older than N days."""
    import time as _time
    db = _get_db()
    cutoff = _time.time() - (before_days * 86400)
    result = db.conn.execute("DELETE FROM sessions WHERE created_at < ?", (cutoff,))
    db.conn.execute("DELETE FROM turns WHERE session_id NOT IN (SELECT session_id FROM sessions)")
    db.conn.commit()
    return {"deleted": result.rowcount, "before_days": before_days}


@router.post("/{session_id}/feedback")
async def submit_feedback(session_id: str, rating: int = 1, comment: str = ""):
    """Submit feedback for a session (-1=negative, 0=neutral, 1=positive)."""
    db = _get_db()
    db.conn.execute(
        "INSERT INTO feedback (session_id, rating, comment, created_at) VALUES (?, ?, ?, ?)",
        (session_id, rating, comment, __import__("time").time()),
    )
    db.conn.commit()
    return {"submitted": True}
