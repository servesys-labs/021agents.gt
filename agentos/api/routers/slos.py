"""SLOs router — success rate, latency, cost thresholds."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/slos", tags=["slos"])


@router.get("")
async def list_slos(agent_name: str = "", user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    sql = "SELECT * FROM slo_definitions WHERE org_id = ?"
    params = [user.org_id]
    if agent_name:
        sql += " AND agent_name = ?"
        params.append(agent_name)
    rows = db.conn.execute(sql, params).fetchall()
    return {"slos": [dict(r) for r in rows]}


@router.post("")
async def create_slo(
    metric: str,
    threshold: float,
    agent_name: str = "",
    env: str = "",
    operator: str = "gte",
    window_hours: int = 24,
    user: CurrentUser = Depends(get_current_user),
):
    if metric not in ("success_rate", "p95_latency_ms", "cost_per_run_usd", "avg_turns"):
        raise HTTPException(status_code=400, detail=f"Unknown metric: {metric}")
    if operator not in ("gte", "lte", "eq"):
        raise HTTPException(status_code=400, detail=f"Unknown operator: {operator}")

    db = _get_db()
    slo_id = uuid.uuid4().hex[:12]
    db.conn.execute(
        """INSERT INTO slo_definitions (slo_id, org_id, agent_name, env, metric, threshold, operator, window_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (slo_id, user.org_id, agent_name, env, metric, threshold, operator, window_hours),
    )
    db.conn.commit()
    return {"slo_id": slo_id, "metric": metric, "threshold": threshold, "operator": operator}


@router.delete("/{slo_id}")
async def delete_slo(slo_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    db.conn.execute("DELETE FROM slo_definitions WHERE slo_id = ? AND org_id = ?", (slo_id, user.org_id))
    db.conn.commit()
    return {"deleted": slo_id}


@router.get("/status")
async def check_slos(user: CurrentUser = Depends(get_current_user)):
    """Check all SLOs and return current status vs thresholds."""
    import time
    db = _get_db()
    slos = db.conn.execute("SELECT * FROM slo_definitions WHERE org_id = ?", (user.org_id,)).fetchall()

    results = []
    for slo in slos:
        s = dict(slo)
        since = time.time() - (s["window_hours"] * 3600)
        agent_filter = f"AND agent_name = '{s['agent_name']}'" if s["agent_name"] else ""

        if s["metric"] == "success_rate":
            row = db.conn.execute(f"""
                SELECT CAST(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as val
                FROM sessions WHERE created_at >= ? {agent_filter}""", (since,)).fetchone()
        elif s["metric"] == "p95_latency_ms":
            row = db.conn.execute(f"""
                SELECT wall_clock_seconds * 1000 as val FROM sessions
                WHERE created_at >= ? {agent_filter}
                ORDER BY wall_clock_seconds DESC LIMIT 1 OFFSET
                (SELECT CAST(COUNT(*) * 0.05 AS INT) FROM sessions WHERE created_at >= ? {agent_filter})
            """, (since, since)).fetchone()
        elif s["metric"] == "cost_per_run_usd":
            row = db.conn.execute(f"""
                SELECT AVG(cost_total_usd) as val FROM sessions
                WHERE created_at >= ? {agent_filter}""", (since,)).fetchone()
        else:
            row = None

        current = dict(row)["val"] if row and dict(row).get("val") is not None else None
        breached = False
        if current is not None:
            if s["operator"] == "gte":
                breached = current < s["threshold"]
            elif s["operator"] == "lte":
                breached = current > s["threshold"]

        results.append({**s, "current_value": current, "breached": breached})

    return {"slos": results, "breached_count": sum(1 for r in results if r["breached"])}
