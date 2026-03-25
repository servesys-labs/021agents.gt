"""Observability router — database stats, cost ledger, spans, exports."""

from __future__ import annotations

import csv
import io
import json
import time
import uuid
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


class SpanFeedbackRequest(BaseModel):
    span_id: str
    rating: int = Field(..., ge=-1, le=1)
    score: float = 0.0
    comment: str = ""
    labels: list[str] = Field(default_factory=list)
    session_id: str = ""
    turn: int = 0
    source: str = "human"


class TraceLineageUpsertRequest(BaseModel):
    session_id: str = ""
    agent_version: str = ""
    model: str = ""
    prompt_hash: str = ""
    eval_run_id: int = 0
    experiment_id: str = ""
    dataset_id: str = ""
    commit_sha: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class MetaProposalGenerateRequest(BaseModel):
    persist: bool = True
    max_proposals: int = Field(8, ge=1, le=50)


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


def _agent_is_owned(db: Any, agent_name: str, org_id: str) -> bool:
    """Check if an agent has telemetry for this org."""
    checks = [
        ("SELECT COUNT(*) AS cnt FROM sessions WHERE agent_name = ? AND org_id = ?", (agent_name, org_id)),
        ("SELECT COUNT(*) AS cnt FROM billing_records WHERE agent_name = ? AND org_id = ?", (agent_name, org_id)),
    ]
    for sql, params in checks:
        try:
            row = db.conn.execute(sql, params).fetchone()
            if row and int(row["cnt"]) > 0:
                return True
        except Exception:
            continue
    return False


def _meta_proposals_from_report(agent_name: str, report: dict[str, Any], max_proposals: int) -> list[dict[str, Any]]:
    signals = report.get("signals", {}) if isinstance(report, dict) else {}
    proposals: list[dict[str, Any]] = []

    node_error_rate = float(signals.get("node_error_rate", 0.0) or 0.0)
    if node_error_rate > 0.03:
        proposals.append({
            "id": uuid.uuid4().hex[:12],
            "agent_name": agent_name,
            "title": "Reduce node execution failures",
            "rationale": f"Node error rate is {node_error_rate:.1%}; add retries/fallbacks and tighten node contracts.",
            "category": "runtime",
            "priority": min(1.0, 0.4 + node_error_rate),
            "modification": {"harness": {"max_retries": 4, "retry_on_tool_failure": True}},
            "evidence": {"node_error_rate": node_error_rate},
            "status": "pending",
            "created_at": time.time(),
        })

    pending = int(signals.get("checkpoint_pending", 0) or 0)
    if pending > 0:
        proposals.append({
            "id": uuid.uuid4().hex[:12],
            "agent_name": agent_name,
            "title": "Improve human-approval throughput",
            "rationale": f"{pending} runs are pending approval; add staffing/SLA or narrower approval gating.",
            "category": "governance",
            "priority": min(1.0, 0.35 + (pending / 50.0)),
            "modification": {"harness": {"require_human_approval": True}},
            "evidence": {"checkpoint_pending": pending},
            "status": "pending",
            "created_at": time.time(),
        })

    eval_pass_rate = signals.get("eval_pass_rate")
    if isinstance(eval_pass_rate, (int, float)) and float(eval_pass_rate) < 0.85:
        proposals.append({
            "id": uuid.uuid4().hex[:12],
            "agent_name": agent_name,
            "title": "Raise eval pass rate with targeted regressions",
            "rationale": f"Eval pass rate is {float(eval_pass_rate):.1%}; run focused evals on failing traces and tighten prompt/tool policies.",
            "category": "eval",
            "priority": 0.8,
            "modification": {},
            "evidence": {"eval_pass_rate": float(eval_pass_rate)},
            "status": "pending",
            "created_at": time.time(),
        })

    avg_turns = float(signals.get("avg_turns", 0.0) or 0.0)
    if avg_turns > 8:
        proposals.append({
            "id": uuid.uuid4().hex[:12],
            "agent_name": agent_name,
            "title": "Reduce turn depth and loop overhead",
            "rationale": f"Average turns per run is {avg_turns:.1f}; optimize planning and tool selection to converge faster.",
            "category": "prompt",
            "priority": min(1.0, 0.3 + (avg_turns / 30.0)),
            "modification": {"max_turns": max(5, int(avg_turns * 1.5))},
            "evidence": {"avg_turns": avg_turns},
            "status": "pending",
            "created_at": time.time(),
        })

    if not proposals:
        proposals.append({
            "id": uuid.uuid4().hex[:12],
            "agent_name": agent_name,
            "title": "Optimize cost/latency under stable quality",
            "rationale": "Telemetry is healthy; run model/caching/tool-budget experiments to reduce cost and latency.",
            "category": "optimization",
            "priority": 0.3,
            "modification": {},
            "evidence": {"signals": signals},
            "status": "pending",
            "created_at": time.time(),
        })

    report_recs = report.get("recommendations", []) if isinstance(report, dict) else []
    for rec in report_recs[:3]:
        if isinstance(rec, str) and rec:
            proposals.append({
                "id": uuid.uuid4().hex[:12],
                "agent_name": agent_name,
                "title": "Meta-agent recommendation",
                "rationale": rec,
                "category": "meta",
                "priority": 0.5,
                "modification": {},
                "evidence": {"meta_report": True},
                "status": "pending",
                "created_at": time.time(),
            })

    proposals.sort(key=lambda p: float(p.get("priority", 0.0)), reverse=True)
    return proposals[:max_proposals]


def _build_eval_plan(agent_name: str, report: dict[str, Any], proposals: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a lightweight suggested eval plan from telemetry + proposals."""
    signals = report.get("signals", {}) if isinstance(report, dict) else {}
    focus_areas: list[str] = []
    if float(signals.get("node_error_rate", 0.0) or 0.0) > 0.03:
        focus_areas.append("node_reliability")
    if int(signals.get("checkpoint_pending", 0) or 0) > 0:
        focus_areas.append("approval_resume_flow")
    eval_pass = signals.get("eval_pass_rate")
    if isinstance(eval_pass, (int, float)) and float(eval_pass) < 0.85:
        focus_areas.append("regression_failures")
    if float(signals.get("avg_turns", 0.0) or 0.0) > 8:
        focus_areas.append("turn_efficiency")
    if not focus_areas:
        focus_areas.append("cost_latency_optimization")

    proposal_titles = [
        p.get("title", "")
        for p in proposals[:5]
        if isinstance(p, dict) and p.get("title")
    ]
    tasks = [
        {
            "name": f"{area}-smoke",
            "input": f"Run an {area} regression scenario for {agent_name}.",
            "expected": "stable behavior",
            "grader": "llm",
            "criteria": f"Validates {area} with no critical errors.",
        }
        for area in focus_areas
    ]
    return {
        "agent_name": agent_name,
        "focus_areas": focus_areas,
        "proposal_context": proposal_titles,
        "recommended_trials_per_task": 3,
        "tasks": tasks,
    }


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


@router.get("/traces/{trace_id}/span-feedback")
async def get_trace_span_feedback(
    trace_id: str,
    limit: int = 500,
    user: CurrentUser = Depends(get_current_user),
):
    """List span-level feedback for a trace."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    return {
        "trace_id": trace_id,
        "summary": db.span_feedback_summary(trace_id=trace_id),
        "feedback": db.query_span_feedback(trace_id=trace_id, limit=limit),
    }


@router.post("/traces/{trace_id}/span-feedback")
async def add_trace_span_feedback(
    trace_id: str,
    request: SpanFeedbackRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Add span-level feedback/score for meta-agent learning loops."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    feedback_id = db.insert_span_feedback(
        trace_id=trace_id,
        span_id=request.span_id,
        rating=request.rating,
        score=request.score,
        comment=request.comment,
        labels=request.labels,
        author=user.user_id,
        source=request.source,
        session_id=request.session_id,
        turn=request.turn,
    )
    return {"trace_id": trace_id, "feedback_id": feedback_id}


@router.get("/traces/{trace_id}/lineage")
async def get_trace_lineage(
    trace_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get experiment/dataset/version lineage linked to a trace."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    return {"trace_id": trace_id, "lineage": db.list_trace_lineage(trace_id=trace_id, limit=50)}


@router.post("/traces/{trace_id}/lineage")
async def upsert_trace_lineage(
    trace_id: str,
    request: TraceLineageUpsertRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Upsert lineage metadata for one trace run."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    sessions = db.query_trace(trace_id)
    agent_name = sessions[0].get("agent_name", "") if sessions else ""
    db.upsert_trace_lineage({
        "trace_id": trace_id,
        "session_id": request.session_id or (sessions[0].get("session_id", "") if sessions else ""),
        "agent_name": agent_name,
        "agent_version": request.agent_version,
        "model": request.model,
        "prompt_hash": request.prompt_hash,
        "eval_run_id": request.eval_run_id,
        "experiment_id": request.experiment_id,
        "dataset_id": request.dataset_id,
        "commit_sha": request.commit_sha,
        "metadata": request.metadata,
    })
    return {"trace_id": trace_id, "upserted": True}


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


@router.get("/agents/{agent_name}/meta-proposals")
async def list_agent_meta_proposals(
    agent_name: str,
    status: str = "",
    limit: int = 100,
    user: CurrentUser = Depends(get_current_user),
):
    """List meta-agent generated proposals for an agent."""
    db = _get_db()
    _ = user  # reserved for auth/scope usage parity
    return {"agent_name": agent_name, "proposals": db.list_meta_proposals(agent_name=agent_name, status=status, limit=limit)}


@router.post("/agents/{agent_name}/meta-proposals/generate")
async def generate_agent_meta_proposals(
    agent_name: str,
    request: MetaProposalGenerateRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Generate prioritized meta-agent proposals from telemetry signals."""
    db = _get_db()
    report = db.agent_meta_observability_report(
        agent_name=agent_name,
        org_id=user.org_id,
        limit_sessions=200,
    )
    proposals = _meta_proposals_from_report(agent_name, report, request.max_proposals)
    if request.persist:
        for proposal in proposals:
            db.upsert_meta_proposal(proposal)
            # Mirror into legacy proposals queue so existing review UIs still surface them.
            db.insert_proposal({
                "id": proposal["id"],
                "title": proposal.get("title", ""),
                "rationale": proposal.get("rationale", ""),
                "category": proposal.get("category", ""),
                "modification": proposal.get("modification", {}),
                "priority": proposal.get("priority", 0.0),
                "evidence": {
                    **proposal.get("evidence", {}),
                    "source": "meta_observability",
                    "agent_name": agent_name,
                },
                "status": proposal.get("status", "pending"),
                "surfaced": True,
                "created_at": proposal.get("created_at", time.time()),
            })
    return {
        "agent_name": agent_name,
        "generated": len(proposals),
        "persisted": request.persist,
        "proposals": proposals,
    }


@router.post("/agents/{agent_name}/meta-proposals/{proposal_id}/review")
async def review_agent_meta_proposal(
    agent_name: str,
    proposal_id: str,
    approved: bool = True,
    note: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Approve/reject a meta proposal for human-in-the-loop review."""
    db = _get_db()
    _ = (agent_name, user)
    status = "approved" if approved else "rejected"
    ok = db.review_meta_proposal(proposal_id, status=status, note=note)
    if not ok:
        raise HTTPException(status_code=404, detail="Meta proposal not found")
    # Keep legacy proposal table in sync when IDs match.
    try:
        db.update_proposal_status(proposal_id, status=status, note=note)
    except Exception:
        pass
    return {"proposal_id": proposal_id, "status": status}


@router.get("/agents/{agent_name}/meta-control-plane")
async def get_agent_meta_control_plane(
    agent_name: str,
    limit_sessions: int = 200,
    max_proposals: int = 8,
    generate_proposals: bool = True,
    persist_generated: bool = False,
    user: CurrentUser = Depends(get_current_user),
):
    """Single meta-agent control-plane payload for human review workflows."""
    db = _get_db()
    if not _agent_is_owned(db, agent_name, user.org_id):
        raise HTTPException(status_code=404, detail="Agent telemetry not found")

    report = db.agent_meta_observability_report(
        agent_name=agent_name,
        org_id=user.org_id,
        limit_sessions=limit_sessions,
    )
    existing_meta = db.list_meta_proposals(agent_name=agent_name, status="", limit=200)
    generated: list[dict[str, Any]] = []
    if generate_proposals:
        generated = _meta_proposals_from_report(agent_name, report, max_proposals=max_proposals)
        if persist_generated:
            for proposal in generated:
                db.upsert_meta_proposal(proposal)
                db.insert_proposal({
                    "id": proposal["id"],
                    "title": proposal.get("title", ""),
                    "rationale": proposal.get("rationale", ""),
                    "category": proposal.get("category", ""),
                    "modification": proposal.get("modification", {}),
                    "priority": proposal.get("priority", 0.0),
                    "evidence": {
                        **proposal.get("evidence", {}),
                        "source": "meta_observability_control_plane",
                        "agent_name": agent_name,
                    },
                    "status": proposal.get("status", "pending"),
                    "surfaced": True,
                    "created_at": proposal.get("created_at", time.time()),
                })
            existing_meta = db.list_meta_proposals(agent_name=agent_name, status="", limit=200)

    pending_checkpoints: list[dict[str, Any]] = []
    try:
        rows = db.conn.execute(
            """SELECT g.checkpoint_id, g.session_id, g.trace_id, g.updated_at
               FROM graph_checkpoints g
               JOIN sessions s ON s.session_id = g.session_id
               WHERE g.agent_name = ? AND g.status = 'pending_approval' AND s.org_id = ?
               ORDER BY g.updated_at DESC
               LIMIT 200""",
            (agent_name, user.org_id),
        ).fetchall()
        pending_checkpoints = [dict(r) for r in rows]
    except Exception:
        pending_checkpoints = []

    pending_meta = [p for p in existing_meta if str(p.get("status", "")) == "pending"]
    eval_plan = _build_eval_plan(
        agent_name=agent_name,
        report=report,
        proposals=generated if generated else existing_meta,
    )
    return {
        "agent_name": agent_name,
        "generated_at": time.time(),
        "meta_report": report,
        "meta_proposals": {
            "existing_total": len(existing_meta),
            "pending_total": len(pending_meta),
            "generated_in_this_call": len(generated),
            "items": generated if generated else existing_meta[:max_proposals],
        },
        "pending_approvals": {
            "checkpoint_count": len(pending_checkpoints),
            "proposal_count": len(pending_meta),
            "checkpoints": pending_checkpoints,
            "proposal_ids": [str(p.get("id", "")) for p in pending_meta[:100]],
        },
        "suggested_eval_plan": eval_plan,
    }


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
