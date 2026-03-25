"""Observability router — database stats, cost ledger, spans, exports."""

from __future__ import annotations

import csv
import io
import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/observability", tags=["observability"])


class TraceAnnotationRequest(BaseModel):
    annotation_type: str = Field("note", description="annotation type: note|issue|hypothesis|fix")
    message: str = Field(..., min_length=1, max_length=5000)
    severity: str = Field("info", description="info|warn|error")
    span_id: str = ""
    node_id: str = ""
    turn: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)


def _trace_is_owned(db: Any, trace_id: str, org_id: str) -> bool:
    """Check if a trace belongs to the caller org across telemetry tables."""
    checks = [
        ("SELECT COUNT(*) AS cnt FROM sessions WHERE trace_id = ? AND org_id = ?", (trace_id, org_id)),
        ("SELECT COUNT(*) AS cnt FROM billing_records WHERE trace_id = ? AND org_id = ?", (trace_id, org_id)),
        ("SELECT COUNT(*) AS cnt FROM runtime_events WHERE trace_id = ? AND org_id = ?", (trace_id, org_id)),
    ]
    for sql, params in checks:
        try:
            row = db.conn.execute(sql, params).fetchone()
            if row and int(row["cnt"]) > 0:
                return True
        except Exception:
            continue
    return False


@router.get("/stats")
async def db_stats(user: CurrentUser = Depends(get_current_user)):
    """Get database health and table counts."""
    db = _get_db()
    return db.stats()


@router.get("/cost-ledger")
async def cost_ledger(
    limit: int = 100,
    agent_name: str = "",
    user: CurrentUser = Depends(get_current_user),
):
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
async def get_trace(
    trace_id: str,
    include_spans: bool = True,
    include_events: bool = True,
    include_checkpoints: bool = True,
    include_eval_trials: bool = True,
    include_annotations: bool = True,
    user: CurrentUser = Depends(get_current_user),
):
    """Get full trace chain with LangSmith-style telemetry bundle."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    sessions = db.query_trace(trace_id)
    rollup = db.trace_cost_rollup(trace_id)
    spans = db.query_trace_spans(trace_id) if include_spans else []
    events = db.query_runtime_events(trace_id=trace_id, limit=2000) if include_events else []
    checkpoints = db.list_graph_checkpoints(trace_id=trace_id, limit=500) if include_checkpoints else []
    eval_trials = db.list_eval_trials_by_trace(trace_id, limit=500) if include_eval_trials else []
    annotations = db.list_trace_annotations(trace_id, limit=500) if include_annotations else []
    return {
        "trace_id": trace_id,
        "sessions": sessions,
        "cost_rollup": rollup,
        "spans": spans,
        "runtime_events": events,
        "graph_checkpoints": checkpoints,
        "eval_trials": eval_trials,
        "annotations": annotations,
    }


@router.get("/traces/{trace_id}/run-tree")
async def get_trace_run_tree(
    trace_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get hierarchical run tree with lifecycle artifacts for one trace."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    return db.build_trace_run_tree(trace_id)


@router.get("/traces/{trace_id}/events")
async def get_trace_events(
    trace_id: str,
    limit: int = 2000,
    user: CurrentUser = Depends(get_current_user),
):
    """Get runtime events for a trace (node lifecycle, tool, llm, errors)."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    return {"trace_id": trace_id, "events": db.query_runtime_events(trace_id=trace_id, limit=limit)}


@router.get("/traces/{trace_id}/checkpoints")
async def get_trace_checkpoints(
    trace_id: str,
    limit: int = 500,
    user: CurrentUser = Depends(get_current_user),
):
    """Get persisted graph checkpoints for a trace."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    return {
        "trace_id": trace_id,
        "checkpoints": db.list_graph_checkpoints(trace_id=trace_id, limit=limit),
    }


@router.get("/traces/{trace_id}/eval-trials")
async def get_trace_eval_trials(
    trace_id: str,
    limit: int = 500,
    user: CurrentUser = Depends(get_current_user),
):
    """Get eval trials linked to this trace id."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    return {"trace_id": trace_id, "eval_trials": db.list_eval_trials_by_trace(trace_id, limit=limit)}


@router.get("/traces/{trace_id}/annotations")
async def get_trace_annotations(
    trace_id: str,
    limit: int = 500,
    user: CurrentUser = Depends(get_current_user),
):
    """List trace annotations for human/meta-agent review loops."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    return {"trace_id": trace_id, "annotations": db.list_trace_annotations(trace_id, limit=limit)}


@router.post("/traces/{trace_id}/annotations")
async def add_trace_annotation(
    trace_id: str,
    request: TraceAnnotationRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Add a structured annotation to a trace/span/node."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    annotation_id = db.insert_trace_annotation(
        trace_id=trace_id,
        author=user.user_id,
        annotation_type=request.annotation_type,
        message=request.message,
        span_id=request.span_id,
        node_id=request.node_id,
        turn=request.turn,
        severity=request.severity,
        metadata=request.metadata,
    )
    return {"trace_id": trace_id, "annotation_id": annotation_id}


@router.delete("/traces/{trace_id}/annotations/{annotation_id}")
async def delete_trace_annotation(
    trace_id: str,
    annotation_id: int,
    user: CurrentUser = Depends(get_current_user),
):
    """Delete one annotation from a trace."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    deleted = db.delete_trace_annotation(annotation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Annotation not found")
    return {"deleted": annotation_id, "trace_id": trace_id}


@router.get("/agents/{agent_name}/meta-report")
async def get_agent_meta_report(
    agent_name: str,
    limit_sessions: int = 200,
    user: CurrentUser = Depends(get_current_user),
):
    """Meta-agent telemetry summary with actionable recommendations."""
    db = _get_db()
    report = db.agent_meta_observability_report(
        agent_name=agent_name,
        org_id=user.org_id,
        limit_sessions=limit_sessions,
    )
    return report


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
        "SELECT * FROM billing_records WHERE org_id = ? AND created_at >= ? ORDER BY created_at",
        (user.org_id, since),
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
