"""Edge ingest router — Cloudflare worker telemetry writeback."""

from __future__ import annotations

import os
import json
import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException

from agentos.api.deps import _get_db

router = APIRouter(prefix="/edge-ingest", tags=["edge-ingest"])


def _require_ingest_token(
    authorization: str | None = None,
    x_edge_token: str | None = None,
) -> None:
    expected = os.environ.get("EDGE_INGEST_TOKEN", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="EDGE_INGEST_TOKEN not configured")
    supplied = (x_edge_token or "").strip()
    if not supplied and authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if supplied != expected:
        raise HTTPException(status_code=401, detail="Invalid ingest token")


def _payload_text(payload: dict[str, Any], key: str, default: str = "", limit: int = 0) -> str:
    value = str(payload.get(key, default))
    if limit > 0:
        return value[:limit]
    return value


@router.post("/session")
async def ingest_session(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Upsert edge session summary into canonical backend DB."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    session_id = str(payload.get("session_id", "")).strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")

    org_id = str(payload.get("org_id", "")).strip()
    project_id = str(payload.get("project_id", "")).strip()
    agent_name = str(payload.get("agent_name", "")).strip()
    status = str(payload.get("status", "completed")).strip() or "completed"
    input_text = str(payload.get("input_text", ""))[:5000]
    output_text = str(payload.get("output_text", ""))[:10000]
    model = str(payload.get("model", ""))
    trace_id = str(payload.get("trace_id", ""))
    parent_session_id = str(payload.get("parent_session_id", ""))
    depth = int(payload.get("depth", 0) or 0)
    step_count = int(payload.get("step_count", 0) or 0)
    action_count = int(payload.get("action_count", 0) or 0)
    wall_clock_seconds = float(payload.get("wall_clock_seconds", 0) or 0)
    cost_total_usd = float(payload.get("cost_total_usd", 0) or 0)
    now = float(payload.get("created_at", 0) or 0) or time.time()

    db.conn.execute(
        """INSERT INTO sessions (
            session_id, org_id, project_id, agent_name, model, status,
            input_text, output_text, step_count, action_count, wall_clock_seconds,
            cost_total_usd, trace_id, parent_session_id, depth, created_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            org_id = excluded.org_id,
            project_id = excluded.project_id,
            agent_name = excluded.agent_name,
            model = excluded.model,
            status = excluded.status,
            input_text = excluded.input_text,
            output_text = excluded.output_text,
            step_count = excluded.step_count,
            action_count = excluded.action_count,
            wall_clock_seconds = excluded.wall_clock_seconds,
            cost_total_usd = excluded.cost_total_usd,
            trace_id = excluded.trace_id,
            parent_session_id = excluded.parent_session_id,
            depth = excluded.depth,
            ended_at = excluded.ended_at
        """,
        (
            session_id,
            org_id,
            project_id,
            agent_name,
            model,
            status,
            input_text,
            output_text,
            step_count,
            action_count,
            wall_clock_seconds,
            cost_total_usd,
            trace_id,
            parent_session_id,
            depth,
            now,
            time.time(),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "session_id": session_id}


@router.post("/turn")
async def ingest_turn(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Insert/replace one turn record for an edge session."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    session_id = str(payload.get("session_id", "")).strip()
    turn_number = int(payload.get("turn_number", 0) or 0)
    if not session_id or turn_number <= 0:
        raise HTTPException(status_code=400, detail="session_id and turn_number required")

    db.conn.execute(
        "DELETE FROM turns WHERE session_id = ? AND turn_number = ?",
        (session_id, turn_number),
    )
    db.conn.execute(
        """INSERT INTO turns (
            session_id, turn_number, model_used, input_tokens, output_tokens, latency_ms,
            llm_content, cost_total_usd, tool_calls_json, tool_results_json, errors_json,
            execution_mode, plan_json, reflection_json, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session_id,
            turn_number,
            str(payload.get("model_used", "")),
            int(payload.get("input_tokens", 0) or 0),
            int(payload.get("output_tokens", 0) or 0),
            float(payload.get("latency_ms", 0) or 0),
            str(payload.get("llm_content", ""))[:10000],
            float(payload.get("cost_total_usd", 0) or 0),
            str(payload.get("tool_calls_json", "[]")),
            str(payload.get("tool_results_json", "[]")),
            str(payload.get("errors_json", "[]")),
            str(payload.get("execution_mode", "sequential")),
            str(payload.get("plan_json", "{}")),
            str(payload.get("reflection_json", "{}")),
            float(payload.get("started_at", 0) or time.time()),
            float(payload.get("ended_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "session_id": session_id, "turn_number": turn_number}


@router.post("/events")
async def ingest_events(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Ingest OTel-like runtime events from workers."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    rows = payload.get("events", [])
    if not isinstance(rows, list):
        raise HTTPException(status_code=400, detail="events must be a list")

    inserted = 0
    for evt in rows[:1000]:
        if not isinstance(evt, dict):
            continue
        db.conn.execute(
            """INSERT INTO otel_events (
                session_id, turn, event_type, action, plan, tier, provider, model, tool_name, status,
                latency_ms, input_tokens, output_tokens, cost_usd, details_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                _payload_text(evt, "session_id", "", 64),
                int(evt.get("turn", 0) or 0),
                _payload_text(evt, "event_type", "", 64),
                _payload_text(evt, "action", "", 64),
                _payload_text(evt, "plan", "", 64),
                _payload_text(evt, "tier", "", 64),
                _payload_text(evt, "provider", "", 64),
                _payload_text(evt, "model", "", 256),
                _payload_text(evt, "tool_name", "", 128),
                _payload_text(evt, "status", "", 32),
                float(evt.get("latency_ms", 0) or 0),
                int(evt.get("input_tokens", 0) or 0),
                int(evt.get("output_tokens", 0) or 0),
                float(evt.get("cost_usd", 0) or 0),
                _payload_text(evt, "details_json", "{}", 20000),
                float(evt.get("created_at", 0) or time.time()),
            ),
        )
        inserted += 1
    db.conn.commit()
    return {"ingested": True, "events": inserted}


@router.post("/conversation/score")
async def ingest_conversation_score(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Ingest one turn-level conversation score."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    session_id = _payload_text(payload, "session_id", "", 64)
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    db.conn.execute(
        """INSERT INTO conversation_scores (
            session_id, turn_number, org_id, agent_name, sentiment, sentiment_score,
            sentiment_confidence, relevance_score, coherence_score, helpfulness_score, safety_score,
            quality_overall, topic, intent, has_tool_failure, has_hallucination_risk, scorer_model, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session_id,
            int(payload.get("turn_number", 1) or 1),
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "agent_name", "", 128),
            _payload_text(payload, "sentiment", "neutral", 32),
            float(payload.get("sentiment_score", 0) or 0),
            float(payload.get("sentiment_confidence", 0) or 0),
            float(payload.get("relevance_score", 0) or 0),
            float(payload.get("coherence_score", 0) or 0),
            float(payload.get("helpfulness_score", 0) or 0),
            float(payload.get("safety_score", 1) or 1),
            float(payload.get("quality_overall", 0) or 0),
            _payload_text(payload, "topic", "", 256),
            _payload_text(payload, "intent", "", 256),
            int(payload.get("has_tool_failure", 0) or 0),
            int(payload.get("has_hallucination_risk", 0) or 0),
            _payload_text(payload, "scorer_model", "", 128),
            float(payload.get("created_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "session_id": session_id}


@router.post("/conversation/analytics")
async def ingest_conversation_analytics(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Upsert session-level conversation analytics."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    session_id = _payload_text(payload, "session_id", "", 64)
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    db.conn.execute(
        """INSERT INTO conversation_analytics (
            session_id, org_id, agent_name, avg_sentiment_score, dominant_sentiment,
            sentiment_trend, avg_quality, topics_json, total_turns, tool_failure_count, hallucination_risk_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            org_id = excluded.org_id,
            agent_name = excluded.agent_name,
            avg_sentiment_score = excluded.avg_sentiment_score,
            dominant_sentiment = excluded.dominant_sentiment,
            sentiment_trend = excluded.sentiment_trend,
            avg_quality = excluded.avg_quality,
            topics_json = excluded.topics_json,
            total_turns = excluded.total_turns,
            tool_failure_count = excluded.tool_failure_count,
            hallucination_risk_count = excluded.hallucination_risk_count,
            created_at = excluded.created_at
        """,
        (
            session_id,
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "agent_name", "", 128),
            float(payload.get("avg_sentiment_score", 0) or 0),
            _payload_text(payload, "dominant_sentiment", "neutral", 32),
            _payload_text(payload, "sentiment_trend", "stable", 32),
            float(payload.get("avg_quality", 0) or 0),
            _payload_text(payload, "topics_json", "[]", 20000),
            int(payload.get("total_turns", 0) or 0),
            int(payload.get("tool_failure_count", 0) or 0),
            int(payload.get("hallucination_risk_count", 0) or 0),
            float(payload.get("created_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "session_id": session_id}


@router.post("/issues")
async def ingest_issue(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Upsert issue/remediation signals from workers."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    issue_id = _payload_text(payload, "issue_id", "", 64)
    if not issue_id:
        raise HTTPException(status_code=400, detail="issue_id required")
    now = float(payload.get("created_at", 0) or time.time())
    db.conn.execute(
        """INSERT INTO issues (
            issue_id, org_id, agent_name, title, description, category, severity, status,
            source, source_session_id, source_turn, suggested_fix, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET
            org_id = excluded.org_id,
            agent_name = excluded.agent_name,
            title = excluded.title,
            description = excluded.description,
            category = excluded.category,
            severity = excluded.severity,
            status = excluded.status,
            source = excluded.source,
            source_session_id = excluded.source_session_id,
            source_turn = excluded.source_turn,
            suggested_fix = excluded.suggested_fix,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        """,
        (
            issue_id,
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "agent_name", "", 128),
            _payload_text(payload, "title", "", 500),
            _payload_text(payload, "description", "", 5000),
            _payload_text(payload, "category", "unknown", 64),
            _payload_text(payload, "severity", "low", 32),
            _payload_text(payload, "status", "open", 32),
            _payload_text(payload, "source", "auto", 64),
            _payload_text(payload, "source_session_id", "", 64),
            int(payload.get("source_turn", 0) or 0),
            _payload_text(payload, "suggested_fix", "", 5000),
            _payload_text(payload, "metadata_json", "{}", 20000),
            now,
            float(payload.get("updated_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "issue_id": issue_id}


@router.post("/security/scan")
async def ingest_security_scan(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    scan_id = _payload_text(payload, "scan_id", "", 64)
    if not scan_id:
        raise HTTPException(status_code=400, detail="scan_id required")
    db.conn.execute(
        """INSERT INTO security_scans (
            scan_id, org_id, agent_name, scan_type, status, total_probes,
            passed, failed, errors, risk_score, risk_level, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
            org_id = excluded.org_id,
            agent_name = excluded.agent_name,
            scan_type = excluded.scan_type,
            status = excluded.status,
            total_probes = excluded.total_probes,
            passed = excluded.passed,
            failed = excluded.failed,
            errors = excluded.errors,
            risk_score = excluded.risk_score,
            risk_level = excluded.risk_level,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at
        """,
        (
            scan_id,
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "agent_name", "", 128),
            _payload_text(payload, "scan_type", "full", 64),
            _payload_text(payload, "status", "pending", 32),
            int(payload.get("total_probes", 0) or 0),
            int(payload.get("passed", 0) or 0),
            int(payload.get("failed", 0) or 0),
            int(payload.get("errors", 0) or 0),
            float(payload.get("risk_score", 0) or 0),
            _payload_text(payload, "risk_level", "unknown", 32),
            float(payload.get("started_at", 0) or 0),
            float(payload.get("completed_at", 0) or 0),
            float(payload.get("created_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "scan_id": scan_id}


@router.post("/security/finding")
async def ingest_security_finding(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    db.conn.execute(
        """INSERT INTO security_findings (
            scan_id, org_id, agent_name, probe_id, probe_name, category, layer, severity,
            status, title, description, evidence, remediation, aivss_vector, aivss_score, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            _payload_text(payload, "scan_id", "", 64),
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "agent_name", "", 128),
            _payload_text(payload, "probe_id", "", 128),
            _payload_text(payload, "probe_name", "", 256),
            _payload_text(payload, "category", "", 128),
            _payload_text(payload, "layer", "", 128),
            _payload_text(payload, "severity", "info", 32),
            _payload_text(payload, "status", "open", 32),
            _payload_text(payload, "title", "", 500),
            _payload_text(payload, "description", "", 5000),
            _payload_text(payload, "evidence", "", 5000),
            _payload_text(payload, "remediation", "", 5000),
            _payload_text(payload, "aivss_vector", "", 512),
            float(payload.get("aivss_score", 0) or 0),
            float(payload.get("created_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True}


@router.post("/security/risk-profile")
async def ingest_risk_profile(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    org_id = _payload_text(payload, "org_id", "", 64)
    agent_name = _payload_text(payload, "agent_name", "", 128)
    if not agent_name:
        raise HTTPException(status_code=400, detail="agent_name required")
    # Maintain one risk profile per org+agent with deterministic update.
    row = db.conn.execute(
        "SELECT id FROM agent_risk_profiles WHERE org_id = ? AND agent_name = ?",
        (org_id, agent_name),
    ).fetchone()
    if row:
        db.conn.execute(
            """UPDATE agent_risk_profiles
               SET risk_score = ?, risk_level = ?, aivss_vector_json = ?, last_scan_id = ?,
                   findings_summary_json = ?, updated_at = ?
               WHERE id = ?""",
            (
                float(payload.get("risk_score", 0) or 0),
                _payload_text(payload, "risk_level", "unknown", 32),
                _payload_text(payload, "aivss_vector_json", "{}", 20000),
                _payload_text(payload, "last_scan_id", "", 64),
                _payload_text(payload, "findings_summary_json", "{}", 20000),
                float(payload.get("updated_at", 0) or time.time()),
                int(row["id"]),
            ),
        )
    else:
        db.conn.execute(
            """INSERT INTO agent_risk_profiles (
                org_id, agent_name, risk_score, risk_level, aivss_vector_json, last_scan_id,
                findings_summary_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                org_id,
                agent_name,
                float(payload.get("risk_score", 0) or 0),
                _payload_text(payload, "risk_level", "unknown", 32),
                _payload_text(payload, "aivss_vector_json", "{}", 20000),
                _payload_text(payload, "last_scan_id", "", 64),
                _payload_text(payload, "findings_summary_json", "{}", 20000),
                float(payload.get("created_at", 0) or time.time()),
                float(payload.get("updated_at", 0) or time.time()),
            ),
        )
    db.conn.commit()
    return {"ingested": True, "agent_name": agent_name}


@router.post("/config/audit")
async def ingest_config_audit(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    db.conn.execute(
        """INSERT INTO config_audit_log (
            org_id, agent_name, action, field_changed, old_value, new_value,
            change_reason, changed_by, image_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "agent_name", "", 128),
            _payload_text(payload, "action", "", 128),
            _payload_text(payload, "field_changed", "", 128),
            _payload_text(payload, "old_value", "", 5000),
            _payload_text(payload, "new_value", "", 5000),
            _payload_text(payload, "change_reason", "", 5000),
            _payload_text(payload, "changed_by", "", 128),
            _payload_text(payload, "image_id", "", 64),
            float(payload.get("created_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True}


@router.post("/gold-image")
async def ingest_gold_image(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    image_id = _payload_text(payload, "image_id", "", 64)
    if not image_id:
        raise HTTPException(status_code=400, detail="image_id required")
    db.conn.execute(
        """INSERT INTO gold_images (
            image_id, org_id, name, description, config_json, config_hash,
            version, category, is_active, created_by, approved_by, approved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(image_id) DO UPDATE SET
            org_id = excluded.org_id,
            name = excluded.name,
            description = excluded.description,
            config_json = excluded.config_json,
            config_hash = excluded.config_hash,
            version = excluded.version,
            category = excluded.category,
            is_active = excluded.is_active,
            created_by = excluded.created_by,
            approved_by = excluded.approved_by,
            approved_at = excluded.approved_at,
            updated_at = excluded.updated_at
        """,
        (
            image_id,
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "name", "", 256),
            _payload_text(payload, "description", "", 5000),
            _payload_text(payload, "config_json", "{}", 50000),
            _payload_text(payload, "config_hash", "", 128),
            _payload_text(payload, "version", "1.0.0", 64),
            _payload_text(payload, "category", "general", 64),
            int(payload.get("is_active", 1) or 0),
            _payload_text(payload, "created_by", "", 128),
            _payload_text(payload, "approved_by", "", 128),
            float(payload.get("approved_at", 0) or 0),
            float(payload.get("created_at", 0) or time.time()),
            float(payload.get("updated_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "image_id": image_id}


@router.post("/compliance-check")
async def ingest_compliance_check(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    db.conn.execute(
        """INSERT INTO compliance_checks (
            org_id, agent_name, image_id, image_name, status,
            drift_count, drift_fields, drift_details_json, checked_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            _payload_text(payload, "org_id", "", 64),
            _payload_text(payload, "agent_name", "", 128),
            _payload_text(payload, "image_id", "", 64),
            _payload_text(payload, "image_name", "", 256),
            _payload_text(payload, "status", "unchecked", 32),
            int(payload.get("drift_count", 0) or 0),
            _payload_text(payload, "drift_fields", "[]", 20000),
            _payload_text(payload, "drift_details_json", "{}", 50000),
            _payload_text(payload, "checked_by", "", 128),
            float(payload.get("created_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True}


@router.post("/episode")
async def ingest_episode(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Persist one episodic-memory entry from edge worker."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    episode_id = _payload_text(payload, "id", "", 64)
    if not episode_id:
        raise HTTPException(status_code=400, detail="id required")
    db.conn.execute(
        """INSERT INTO episodes (id, input, output, outcome, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            input = excluded.input,
            output = excluded.output,
            outcome = excluded.outcome,
            metadata_json = excluded.metadata_json,
            created_at = excluded.created_at
        """,
        (
            episode_id,
            _payload_text(payload, "input", "", 5000),
            _payload_text(payload, "output", "", 10000),
            _payload_text(payload, "outcome", "", 128),
            _payload_text(payload, "metadata_json", "{}", 20000)
            if "metadata_json" in payload
            else json.dumps(payload.get("metadata", {})),
            float(payload.get("created_at", 0) or time.time()),
        ),
    )
    db.conn.commit()
    return {"ingested": True, "id": episode_id}


@router.post("/vapi/call")
async def ingest_vapi_call(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Upsert one Vapi call row from edge worker."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    call_id = _payload_text(payload, "call_id", "", 64)
    if not call_id:
        raise HTTPException(status_code=400, detail="call_id required")
    db.insert_vapi_call(
        call_id=call_id,
        org_id=_payload_text(payload, "org_id", "", 64),
        agent_name=_payload_text(payload, "agent_name", "", 128),
        phone_number=_payload_text(payload, "phone_number", "", 64),
        direction=_payload_text(payload, "direction", "outbound", 32),
        status=_payload_text(payload, "status", "pending", 32),
        vapi_assistant_id=_payload_text(payload, "vapi_assistant_id", "", 128),
        metadata=payload.get("metadata", {}),
        started_at=float(payload.get("started_at", 0) or time.time()),
    )
    # Optional mutable fields update.
    db.update_vapi_call(
        call_id,
        status=_payload_text(payload, "status", "pending", 32),
        duration_seconds=float(payload.get("duration_seconds", 0) or 0),
        transcript=_payload_text(payload, "transcript", "", 20000),
        cost_usd=float(payload.get("cost_usd", 0) or 0),
        ended_at=float(payload.get("ended_at", 0) or 0),
        agent_name=_payload_text(payload, "agent_name", "", 128),
    )
    return {"ingested": True, "call_id": call_id}


@router.post("/vapi/event")
async def ingest_vapi_event(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Persist one Vapi event row from edge worker."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    call_id = _payload_text(payload, "call_id", "", 64)
    if not call_id:
        raise HTTPException(status_code=400, detail="call_id required")
    event_type = _payload_text(payload, "event_type", "", 64)
    if not event_type:
        raise HTTPException(status_code=400, detail="event_type required")
    db.insert_vapi_event(
        call_id=call_id,
        event_type=event_type,
        payload_json=_payload_text(payload, "payload_json", "{}", 50000),
        org_id=_payload_text(payload, "org_id", "", 64),
    )
    return {"ingested": True, "call_id": call_id, "event_type": event_type}


@router.post("/voice/call")
async def ingest_voice_call(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Upsert one generic (non-Vapi) voice call row from edge worker."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    call_id = _payload_text(payload, "call_id", "", 64)
    platform = _payload_text(payload, "platform", "", 32)
    if not call_id:
        raise HTTPException(status_code=400, detail="call_id required")
    if not platform:
        raise HTTPException(status_code=400, detail="platform required")
    db.insert_voice_call(
        call_id=call_id,
        platform=platform,
        org_id=_payload_text(payload, "org_id", "", 64),
        agent_name=_payload_text(payload, "agent_name", "", 128),
        phone_number=_payload_text(payload, "phone_number", "", 64),
        direction=_payload_text(payload, "direction", "outbound", 32),
        status=_payload_text(payload, "status", "pending", 32),
        platform_agent_id=_payload_text(payload, "platform_agent_id", "", 128),
        metadata=payload.get("metadata", {}),
        started_at=float(payload.get("started_at", 0) or time.time()),
    )
    db.update_voice_call(
        call_id,
        status=_payload_text(payload, "status", "pending", 32),
        duration_seconds=float(payload.get("duration_seconds", 0) or 0),
        transcript=_payload_text(payload, "transcript", "", 20000),
        cost_usd=float(payload.get("cost_usd", 0) or 0),
        ended_at=float(payload.get("ended_at", 0) or 0),
        agent_name=_payload_text(payload, "agent_name", "", 128),
    )
    return {"ingested": True, "call_id": call_id, "platform": platform}


@router.post("/voice/event")
async def ingest_voice_event(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
):
    """Persist one generic (non-Vapi) voice event row from edge worker."""
    _require_ingest_token(authorization=authorization, x_edge_token=x_edge_token)
    db = _get_db()
    call_id = _payload_text(payload, "call_id", "", 64)
    platform = _payload_text(payload, "platform", "", 32)
    event_type = _payload_text(payload, "event_type", "", 64)
    if not call_id:
        raise HTTPException(status_code=400, detail="call_id required")
    if not platform:
        raise HTTPException(status_code=400, detail="platform required")
    if not event_type:
        raise HTTPException(status_code=400, detail="event_type required")
    db.insert_voice_event(
        call_id=call_id,
        platform=platform,
        event_type=event_type,
        payload_json=_payload_text(payload, "payload_json", "{}", 50000),
        org_id=_payload_text(payload, "org_id", "", 64),
    )
    return {"ingested": True, "call_id": call_id, "platform": platform, "event_type": event_type}
