"""Observability router — database stats, cost ledger, spans, exports."""

from __future__ import annotations

import csv
import io
import json
import time
from typing import Any

from fastapi import APIRouter, Depends
from starlette.responses import StreamingResponse

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/observability", tags=["observability"])


@router.get("/stats")
async def db_stats():
    """Get database health and table counts."""
    db = _get_db()
    return db.stats()


@router.get("/cost-ledger")
async def cost_ledger(limit: int = 100, agent_name: str = ""):
    """Get raw cost ledger entries."""
    db = _get_db()
    sql = "SELECT * FROM cost_ledger WHERE 1=1"
    params: list[Any] = []
    if agent_name:
        sql += " AND agent_name = ?"
        params.append(agent_name)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = db.conn.execute(sql, params).fetchall()
    return {"entries": [dict(r) for r in rows]}


@router.get("/traces/{trace_id}")
async def get_trace(trace_id: str):
    """Get full trace chain with cost rollup."""
    db = _get_db()
    sessions = db.query_trace(trace_id)
    rollup = db.trace_cost_rollup(trace_id)
    return {"trace_id": trace_id, "sessions": sessions, "cost_rollup": rollup}


@router.get("/billing/export")
async def export_billing(
    format: str = "csv",
    since_days: int = 30,
    user: CurrentUser = Depends(get_current_user),
):
    """Export billing data as CSV or JSON."""
    db = _get_db()
    since = time.time() - (since_days * 86400)
    rows = db.conn.execute(
        "SELECT * FROM billing_records WHERE created_at >= ? ORDER BY created_at",
        (since,),
    ).fetchall()
    records = [dict(r) for r in rows]

    if format == "json":
        return {"records": records, "total": len(records)}

    # CSV export
    output = io.StringIO()
    if records:
        writer = csv.DictWriter(output, fieldnames=records[0].keys())
        writer.writeheader()
        writer.writerows(records)

    return StreamingResponse(
        io.BytesIO(output.getvalue().encode()),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=billing_export.csv"},
    )
