"""Sessions router — list, detail, turns, traces, feedback."""

from __future__ import annotations

from typing import Any
import time as _time

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.api.schemas import SessionResponse, TurnResponse

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.get("/runtime/insights")
async def runtime_insights(
    since_days: int = 30,
    limit_sessions: int = 200,
    user: CurrentUser = Depends(get_current_user),
):
    """Runtime telemetry rollup for portal observability cards."""
    db = _get_db()
    since_days = max(1, min(365, int(since_days)))
    limit_sessions = max(10, min(200, int(limit_sessions)))
    since = _time.time() - (since_days * 86400)
    return db.runtime_insights(since=since, limit_sessions=limit_sessions)


@router.get("", response_model=list[SessionResponse])
async def list_sessions(
    agent_name: str = "",
    status: str = "",
    limit: int = 50,
    offset: int = 0,
    user: CurrentUser = Depends(get_current_user),
):
    """List sessions with optional filters."""
    # Bounds validation
    limit = max(1, min(200, limit))
    offset = max(0, offset)

    db = _get_db()
    sql = "SELECT * FROM sessions WHERE org_id = ?"
    params: list[Any] = [user.org_id]
    if agent_name:
        sql += " AND agent_name = ?"
        params.append(agent_name)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    rows = db.conn.execute(sql, params).fetchall()
    sessions: list[SessionResponse] = []
    for row in rows:
        r = dict(row)
        sessions.append(
            SessionResponse(
                session_id=r.get("session_id", ""),
                agent_name=r.get("agent_name", ""),
                status=r.get("status", ""),
                input_text=(r.get("input_text", "") or "")[:200],
                output_text=(r.get("output_text", "") or "")[:200],
                step_count=int(r.get("step_count", 0) or 0),
                cost_total_usd=float(r.get("cost_total_usd", 0) or 0),
                wall_clock_seconds=float(r.get("wall_clock_seconds", 0) or 0),
                trace_id=r.get("trace_id", "") or "",
                created_at=float(r.get("created_at", 0) or 0),
            )
        )
    return sessions


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get full session details."""
    db = _get_db()
    row = db.conn.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    r = dict(row)
    return SessionResponse(
        session_id=r.get("session_id", ""),
        agent_name=r.get("agent_name", ""),
        status=r.get("status", ""),
        input_text=r.get("input_text", "") or "",
        output_text=r.get("output_text", "") or "",
        step_count=int(r.get("step_count", 0) or 0),
        cost_total_usd=float(r.get("cost_total_usd", 0) or 0),
        wall_clock_seconds=float(r.get("wall_clock_seconds", 0) or 0),
        trace_id=r.get("trace_id", "") or "",
        created_at=float(r.get("created_at", 0) or 0),
    )


@router.get("/{session_id}/turns", response_model=list[TurnResponse])
async def get_turns(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get all turns for a session."""
    import json
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number", (session_id,)
    ).fetchall()
    turns: list[TurnResponse] = []
    for row in rows:
        r = dict(row)
        tool_calls_raw = r.get("tool_calls_json", "[]")
        try:
            tool_calls = json.loads(tool_calls_raw) if isinstance(tool_calls_raw, str) else []
        except Exception:
            tool_calls = []
        plan_raw = r.get("plan_json", "{}")
        reflection_raw = r.get("reflection_json", "{}")
        try:
            plan_artifact = json.loads(plan_raw) if isinstance(plan_raw, str) else {}
        except Exception:
            plan_artifact = {}
        try:
            reflection = json.loads(reflection_raw) if isinstance(reflection_raw, str) else {}
        except Exception:
            reflection = {}
        turns.append(
            TurnResponse(
                turn_number=int(r.get("turn_number", 0) or 0),
                model_used=r.get("model_used", "") or "",
                input_tokens=int(r.get("input_tokens", 0) or 0),
                output_tokens=int(r.get("output_tokens", 0) or 0),
                latency_ms=float(r.get("latency_ms", 0) or 0),
                content=r.get("llm_content", "") or "",
                cost_total_usd=float(r.get("cost_total_usd", 0) or 0),
                tool_calls=tool_calls,
                execution_mode=r.get("execution_mode", "sequential") or "sequential",
                plan_artifact=plan_artifact,
                reflection=reflection,
                started_at=float(r.get("started_at", 0) or 0),
                ended_at=float(r.get("ended_at", 0) or 0),
            )
        )
    return turns


@router.get("/{session_id}/runtime")
async def get_session_runtime(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get plan/reflection/execution telemetry for one session."""
    db = _get_db()
    row = db.conn.execute("SELECT session_id FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return db.session_runtime_profile(session_id)


@router.get("/{session_id}/trace")
async def get_trace(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
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
async def session_stats(
    agent_name: str = "",
    since_days: int = 30,
    user: CurrentUser = Depends(get_current_user),
):
    """Get aggregate session statistics."""
    import time as _time

    since_days = max(1, min(365, since_days))
    db = _get_db()
    since = _time.time() - (since_days * 86400)

    # Build WHERE clause properly instead of fragile string replacement
    where_parts = ["created_at >= ?"]
    params: list[Any] = [since]
    if agent_name:
        where_parts.append("agent_name = ?")
        params.append(agent_name)
    where_clause = " AND ".join(where_parts)

    sql = f"SELECT COUNT(*) as total, SUM(cost_total_usd) as cost, AVG(wall_clock_seconds) as avg_duration FROM sessions WHERE {where_clause}"
    row = db.conn.execute(sql, params).fetchone()
    r = dict(row)

    # Status breakdown — include agent_name filter if provided
    status_sql = f"SELECT status, COUNT(*) as cnt FROM sessions WHERE {where_clause} GROUP BY status"
    status_rows = db.conn.execute(status_sql, params).fetchall()

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
    user: CurrentUser = Depends(get_current_user),
):
    """Submit human feedback for a session output."""
    db = _get_db()
    row = db.conn.execute("SELECT session_id FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    db.insert_feedback(session_id=session_id, rating=rating, comment=comment, tags=tags)
    return {"submitted": True, "session_id": session_id}


@router.get("/{session_id}/feedback")
async def get_feedback(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get all feedback for a session."""
    db = _get_db()
    rows = db.query_feedback(session_id=session_id)
    return {"feedback": rows}


@router.delete("")
async def cleanup_sessions(
    before_days: int = 90,
    user: CurrentUser = Depends(get_current_user),
):
    """Delete sessions older than N days (minimum 7)."""
    import time as _time

    before_days = max(7, before_days)
    db = _get_db()
    cutoff = _time.time() - (before_days * 86400)
    result = db.conn.execute(
        "DELETE FROM sessions WHERE created_at < ? AND org_id = ?", (cutoff, user.org_id)
    )
    db.conn.execute("DELETE FROM turns WHERE session_id NOT IN (SELECT session_id FROM sessions)")
    db.conn.commit()
    return {"deleted": result.rowcount, "before_days": before_days}
