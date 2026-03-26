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
from agentos.graph.autofix import lint_and_autofix_graph
from agentos.graph.contracts import summarize_graph_contracts
from agentos.graph.design_lint import lint_graph_design

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


class AutonomousMaintenanceRunRequest(BaseModel):
    dry_run: bool = True
    persist_proposals: bool = True
    max_proposals: int = Field(8, ge=1, le=50)
    min_eval_pass_rate: float = Field(0.85, ge=0.0, le=1.0)
    min_eval_trials: int = Field(3, ge=1, le=1000)
    target_channel: str = "staging"


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


def _agent_exists(agent_name: str) -> bool:
    from agentos.agent import Agent
    try:
        Agent.from_name(agent_name)
        return True
    except FileNotFoundError:
        return False


def _load_agent_graph(agent_name: str) -> dict[str, Any] | None:
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(agent_name)
    except FileNotFoundError:
        return None
    harness = getattr(agent.config, "harness", {})
    if isinstance(harness, dict):
        for key in ("declarative_graph", "graph"):
            graph = harness.get(key)
            if isinstance(graph, dict):
                return graph
    return None


def _latest_eval_gate(
    db: Any,
    agent_name: str,
    *,
    min_eval_pass_rate: float,
    min_eval_trials: int,
) -> dict[str, Any]:
    row = db.conn.execute(
        "SELECT id, pass_rate, total_trials, total_tasks, created_at FROM eval_runs WHERE agent_name = ? ORDER BY created_at DESC LIMIT 1",
        (agent_name,),
    ).fetchone()
    latest_eval = dict(row) if row else None
    passed = False
    if latest_eval is not None:
        pass_rate = float(latest_eval.get("pass_rate") or 0.0)
        total_trials = int(latest_eval.get("total_trials") or 0)
        passed = pass_rate >= min_eval_pass_rate and total_trials >= min_eval_trials
    return {
        "latest_eval_run": latest_eval,
        "min_eval_pass_rate": min_eval_pass_rate,
        "min_eval_trials": min_eval_trials,
        "passed": passed,
    }


def _maintenance_rollout_recommendation(
    *,
    agent_name: str,
    graph_available: bool,
    graph_lint_valid: bool,
    eval_gate: dict[str, Any],
    target_channel: str,
) -> dict[str, Any]:
    rollout = {
        "decision": "hold",
        "target_channel": target_channel,
        "reason": "",
        "recommended_action": "",
        "release_endpoint": f"/api/v1/releases/{agent_name}/promote?from_channel=draft&to_channel={target_channel}",
    }
    latest_eval = eval_gate.get("latest_eval_run")
    if not graph_available:
        rollout["reason"] = "No declarative graph found for agent."
        rollout["recommended_action"] = "Attach harness.declarative_graph and re-run maintenance."
    elif not graph_lint_valid:
        rollout["reason"] = "Graph lint failed."
        rollout["recommended_action"] = "Apply graph autofix and re-run maintenance."
    elif latest_eval is None:
        rollout["reason"] = "No eval run found for agent."
        rollout["recommended_action"] = "Run /api/v1/eval/run before promotion."
    elif not bool(eval_gate.get("passed")):
        rollout["reason"] = (
            f"Eval gate failed (pass_rate={float(latest_eval.get('pass_rate') or 0.0):.2f}, "
            f"trials={int(latest_eval.get('total_trials') or 0)})."
        )
        rollout["recommended_action"] = "Run targeted eval/experiments and iterate before promotion."
    else:
        rollout["decision"] = "promote_candidate"
        rollout["reason"] = "Lint and eval gates passed."
        rollout["recommended_action"] = "Promote to target channel and optionally start canary."
    return rollout


def _event_ts_seconds(event: dict[str, Any]) -> float:
    """Best-effort event timestamp in epoch seconds for filtering."""
    payload = event.get("payload", {}) if isinstance(event, dict) else {}
    if not isinstance(payload, dict):
        payload = {}
    for raw in (
        event.get("event_ts"),
        event.get("created_at"),
        event.get("timestamp"),
        payload.get("timestamp"),
        payload.get("event_ts"),
    ):
        try:
            ts = float(raw)
        except Exception:
            continue
        if ts <= 0:
            continue
        # Normalize ms epoch to seconds.
        return ts / 1000.0 if ts > 1e12 else ts
    return 0.0


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


def _meta_control_plane_entrypoints(agent_name: str) -> dict[str, Any]:
    """Canonical control-plane APIs for meta-agent CRUD, telemetry, and eval loops."""
    return {
        "agent_crud": {
            "list": "/api/v1/agents",
            "get": f"/api/v1/agents/{agent_name}",
            "create": "/api/v1/agents",
            "update": f"/api/v1/agents/{agent_name}",
            "delete": f"/api/v1/agents/{agent_name}",
            "create_from_description": "/api/v1/agents/create-from-description",
        },
        "graph_design": {
            "validate": "/api/v1/graphs/validate",
            "lint": "/api/v1/graphs/lint",
            "autofix": "/api/v1/graphs/autofix",
            "contracts_validate": "/api/v1/graphs/contracts/validate",
            "gate_pack": "/api/v1/graphs/gate-pack",
            "run_linear": "/api/v1/graphs/linear-run",
            "run_dag": "/api/v1/graphs/dag-run",
        },
        "telemetry": {
            "meta_report": f"/api/v1/observability/agents/{agent_name}/meta-report",
            "meta_control_plane": f"/api/v1/observability/agents/{agent_name}/meta-control-plane",
            "trace_bundle": "/api/v1/observability/traces/{trace_id}/bundle",
            "trace_events": "/api/v1/observability/traces/{trace_id}/events",
        },
        "eval_experiments": {
            "run_eval": "/api/v1/eval/run",
            "list_runs": "/api/v1/eval/runs",
            "list_trials_for_run": "/api/v1/eval/runs/{run_id}/trials",
            "datasets": "/api/v1/eval/datasets",
            "evaluators": "/api/v1/eval/evaluators",
            "experiments": "/api/v1/eval/experiments",
        },
        "improvement_loops": {
            "generate_meta_proposals": f"/api/v1/observability/agents/{agent_name}/meta-proposals/generate",
            "review_meta_proposal": f"/api/v1/observability/agents/{agent_name}/meta-proposals/{{proposal_id}}/review",
            "autonomous_maintenance_run": f"/api/v1/observability/agents/{agent_name}/autonomous-maintenance-run",
            "autoresearch": "/api/v1/autoresearch/start",
        },
    }


def _langchain_equivalent_runtime_map() -> dict[str, Any]:
    """Runtime feature map for chain/graph parity guidance in meta workflows."""
    return {
        "runnable_composition": {
            "primitives": ["pipe", "mapInputs", "branch", "parseOutput"],
            "module": "deploy/src/runtime/runnable.ts",
        },
        "graph_execution": {
            "deterministic_linear": "/api/v1/graphs/linear-run",
            "bounded_dag": "/api/v1/graphs/dag-run",
            "replay_integrity": "trace_digest_sha256",
        },
        "observability_eval": {
            "meta_control_plane": "/api/v1/observability/agents/{agent_name}/meta-control-plane",
            "eval_router": "/api/v1/eval/*",
        },
    }


def _multi_agent_blueprint(agent_name: str) -> dict[str, Any]:
    """Recommended supervisor/specialist blueprint for multi-agent systems."""
    return {
        "pattern": "supervisor_specialists",
        "roles": [
            {
                "role": "supervisor",
                "responsibility": "Task decomposition, routing, aggregation, final response.",
                "node_kinds": ["bootstrap", "route_llm", "final"],
            },
            {
                "role": "specialists",
                "responsibility": "Focused execution (research, coding, support, compliance).",
                "invocation": "run-agent",
            },
            {
                "role": "background_ops",
                "responsibility": "Telemetry, eval, indexing, and analytics off critical path.",
                "node_kinds": ["telemetry_emit", "eval_enqueue", "index_write"],
                "requirements": ["async=true", "idempotency_key"],
            },
        ],
        "guardrails": {
            "graph_lint_endpoint": "/api/v1/graphs/lint?strict=true",
            "graph_autofix_endpoint": "/api/v1/graphs/autofix",
            "graph_contracts_validate_endpoint": "/api/v1/graphs/contracts/validate",
            "gate_pack_endpoint": "/api/v1/graphs/gate-pack",
            "critical_path_rule": "No background node on path to final response.",
            "fanin_rule": "Avoid fan-in from async branches into blocking joins.",
        },
        "workflow": [
            f"1) Query meta-control-plane for {agent_name}.",
            "2) Generate/review proposals and select top changes.",
            "3) Apply agent CRUD updates and run strict graph lint.",
            "4) Execute eval/experiments and compare deltas.",
            "5) Promote only when quality/cost/latency gates pass.",
        ],
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
    event_limit: int = 2000,
    event_type: str = "",
    tool_name: str = "",
    status: str = "",
    from_ts: float = 0.0,
    to_ts: float = 0.0,
    user: CurrentUser = Depends(get_current_user),
):
    """Get full trace chain with LangSmith-style telemetry bundle."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    sessions = db.query_trace(trace_id)
    rollup = db.trace_cost_rollup(trace_id)
    spans = db.query_trace_spans(trace_id) if include_spans else []
    events = db.query_runtime_events(
        trace_id=trace_id,
        event_types=[event_type] if event_type else None,
        status=status,
        from_ts=from_ts,
        to_ts=to_ts,
        tool_name=tool_name,
        limit=max(1, min(int(event_limit or 2000), 10000)),
    ) if include_events else []
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
        "runtime_event_filters": {
            "event_type": event_type,
            "tool_name": tool_name,
            "status": status,
            "from_ts": from_ts,
            "to_ts": to_ts,
            "limit": max(1, min(int(event_limit or 2000), 10000)),
        },
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
    event_type: str = "",
    tool_name: str = "",
    status: str = "",
    from_ts: float = 0.0,
    to_ts: float = 0.0,
    user: CurrentUser = Depends(get_current_user),
):
    """Get runtime events for a trace (node lifecycle, tool, llm, errors)."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    raw_events = db.query_runtime_events(
        trace_id=trace_id,
        event_types=[event_type] if event_type else None,
        limit=max(limit, 1),
    )
    filtered: list[dict[str, Any]] = []
    status_filter = status.strip()
    tool_filter = tool_name.strip()
    from_filter = float(from_ts or 0.0)
    to_filter = float(to_ts or 0.0)
    for event in raw_events:
        payload = event.get("payload", {}) if isinstance(event, dict) else {}
        if not isinstance(payload, dict):
            payload = {}
        if tool_filter:
            event_tool = str(
                event.get("tool_name")
                or payload.get("tool_name")
                or payload.get("tool")
                or ""
            )
            if event_tool != tool_filter:
                continue
        if status_filter:
            event_status = str(event.get("status") or payload.get("status") or "")
            if event_status != status_filter:
                continue
        event_ts = _event_ts_seconds(event)
        if from_filter > 0 and (event_ts <= 0 or event_ts < from_filter):
            continue
        if to_filter > 0 and (event_ts <= 0 or event_ts > to_filter):
            continue
        filtered.append(event)
    return {
        "trace_id": trace_id,
        "events": filtered[:limit],
        "filters": {
            "event_type": event_type,
            "tool_name": tool_name,
            "status": status,
            "from_ts": from_ts,
            "to_ts": to_ts,
        },
    }


@router.get("/traces/{trace_id}/replay")
async def get_trace_replay(
    trace_id: str,
    up_to_id: int = 0,
    cursor_index: int = -1,
    event_id: str = "",
    include_events: bool = False,
    user: CurrentUser = Depends(get_current_user),
):
    """Time-travel replay: runtime events up to a cursor and latest ``state_snapshot`` in that prefix."""
    db = _get_db()
    if not _trace_is_owned(db, trace_id, user.org_id):
        raise HTTPException(status_code=404, detail="Trace not found")
    replay = db.replay_runtime_events_at_cursor(
        trace_id=trace_id,
        up_to_row_id=up_to_id,
        cursor_index=cursor_index,
        event_id=event_id,
        include_events=include_events,
    )
    return {
        "trace_id": trace_id,
        "session_id": replay.get("session_id", ""),
        "cursor_row_id": replay.get("cursor_row_id", 0),
        "cursor_index": replay.get("cursor_index", -1),
        "event_count": replay.get("event_count", 0),
        "state_snapshot": replay.get("state_snapshot", {}),
        "event_at_cursor": replay.get("event_at_cursor"),
        "events": replay.get("events", []) if include_events else [],
        "has_more": replay.get("has_more", False),
        "next_row_id": replay.get("next_row_id"),
        "next_cursor_index": replay.get("next_cursor_index"),
        "watermark_row_id": replay.get("watermark_row_id", 0),
        "watermark_event_count": replay.get("watermark_event_count", 0),
    }


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
    if not _agent_is_owned(db, agent_name, user.org_id):
        raise HTTPException(status_code=404, detail="Agent not found")
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
    if not _agent_is_owned(db, agent_name, user.org_id):
        raise HTTPException(status_code=404, detail="Agent not found")
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


@router.post("/agents/{agent_name}/autonomous-maintenance-run")
async def autonomous_maintenance_run(
    agent_name: str,
    request: AutonomousMaintenanceRunRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Run one meta-agent maintenance cycle and return a human approval packet."""
    db = _get_db()
    if not _agent_is_owned(db, agent_name, user.org_id):
        raise HTTPException(status_code=404, detail="Agent not found")

    report = db.agent_meta_observability_report(
        agent_name=agent_name,
        org_id=user.org_id,
        limit_sessions=200,
    )
    proposals = _meta_proposals_from_report(agent_name, report, request.max_proposals)
    if request.persist_proposals and not request.dry_run:
        for proposal in proposals:
            db.upsert_meta_proposal(proposal)

    graph = _load_agent_graph(agent_name)
    graph_available = isinstance(graph, dict)
    graph_autofix: dict[str, Any] | None = None
    graph_lint: dict[str, Any] | None = None
    contracts_validate: dict[str, Any] | None = None
    if graph_available and isinstance(graph, dict):
        graph_autofix = lint_and_autofix_graph(graph, strict=True, apply=True)
        graph_lint = graph_autofix.get("lint_after") if isinstance(graph_autofix, dict) else None
        contracts_result = lint_graph_design(graph, strict=True)
        contracts_summary = dict(contracts_result.summary or {})
        contracts_summary["contracts"] = summarize_graph_contracts(graph)
        contracts_validate = {
            "valid": contracts_result.valid,
            "errors": [e.to_dict() for e in contracts_result.errors],
            "warnings": [w.to_dict() for w in contracts_result.warnings],
            "summary": contracts_summary,
        }

    eval_gate = _latest_eval_gate(
        db,
        agent_name,
        min_eval_pass_rate=request.min_eval_pass_rate,
        min_eval_trials=request.min_eval_trials,
    )
    lint_valid = bool((graph_lint or {}).get("valid")) if graph_lint is not None else False
    rollout = _maintenance_rollout_recommendation(
        agent_name=agent_name,
        graph_available=graph_available,
        graph_lint_valid=lint_valid,
        eval_gate=eval_gate,
        target_channel=request.target_channel,
    )
    blocking_reasons: list[str] = []
    if rollout["decision"] == "hold":
        blocking_reasons.append(str(rollout.get("reason") or "Hold decision"))

    return {
        "agent_name": agent_name,
        "dry_run": request.dry_run,
        "generated_at": time.time(),
        "meta_report": report,
        "graph_checks": {
            "available": graph_available,
            "graph_lint": graph_lint,
            "contracts_validate": contracts_validate,
            "graph_autofix": graph_autofix,
        },
        "eval_gate": eval_gate,
        "rollout": rollout,
        "proposals": {
            "generated": len(proposals),
            "persisted": request.persist_proposals and not request.dry_run,
            "items": proposals,
        },
        "approval_packet": {
            "requires_human_approval": True,
            "ready_for_approval": rollout["decision"] == "promote_candidate",
            "blocking_reasons": blocking_reasons,
            "review_endpoints": {
                "meta_control_plane": f"/api/v1/observability/agents/{agent_name}/meta-control-plane",
                "meta_proposals": f"/api/v1/observability/agents/{agent_name}/meta-proposals",
                "gate_pack": "/api/v1/graphs/gate-pack",
            },
        },
        "suggested_actions": [
            "Review generated proposals and graph contract/lint outputs.",
            "Approve config changes and run targeted eval regressions.",
            "Promote only if rollout decision is promote_candidate.",
        ],
    }


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
        "control_plane_entrypoints": _meta_control_plane_entrypoints(agent_name),
        "langchain_equivalent_runtime": _langchain_equivalent_runtime_map(),
        "multi_agent_blueprint": _multi_agent_blueprint(agent_name),
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
