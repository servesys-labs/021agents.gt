"""Backend runtime proxy for edge workers (centralized provider keys)."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from agentos.api.deps import _get_db_safe
from agentos.llm.tokens import estimate_cost

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runtime-proxy", tags=["runtime-proxy"])

# Agent cache — avoids reconstructing Agent + LLM router on every request.
# Bounded to 50 agents (LRU eviction). Each Agent holds its configured
# providers, router, tools — first request is slow, subsequent are instant.
_agent_cache: dict[str, Any] = {}
_AGENT_CACHE_MAX = 50


def _get_request_scoped_agent(name: str) -> Any:
    """Create a fresh agent instance for request-scoped overrides/resume."""
    from agentos.agent import Agent
    return Agent.from_name(name)


def _get_cached_agent(name: str) -> Any:
    """Get or create a cached Agent instance."""
    from agentos.agent import Agent

    if name in _agent_cache:
        return _agent_cache[name]

    agent = Agent.from_name(name)

    # Evict oldest if over limit
    if len(_agent_cache) >= _AGENT_CACHE_MAX:
        oldest = next(iter(_agent_cache))
        del _agent_cache[oldest]

    _agent_cache[name] = agent
    return agent


def _require_edge_token(authorization: str | None = None, x_edge_token: str | None = None) -> None:
    expected = (os.environ.get("EDGE_INGEST_TOKEN", "") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="EDGE_INGEST_TOKEN not configured")

    presented = (x_edge_token or "").strip()
    if not presented and authorization and authorization.lower().startswith("bearer "):
        presented = authorization.split(" ", 1)[1].strip()

    if presented != expected:
        raise HTTPException(status_code=401, detail="invalid edge token")


def _env_price(name: str, default: float) -> float:
    raw = (os.environ.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        return max(0.0, float(raw))
    except Exception:
        return default


def _resolve_catalog_rate(
    db: Any,
    *,
    resource_type: str,
    operation: str,
    unit: str,
    provider: str = "",
    model: str = "",
    fallback_unit_price: float = 0.0,
) -> dict[str, Any]:
    """Resolve active pricing rate from DB catalog with fallback."""
    if db is not None and hasattr(db, "get_active_pricing_rate"):
        try:
            row = db.get_active_pricing_rate(
                resource_type=resource_type,
                operation=operation,
                unit=unit,
                provider=provider,
                model=model,
            )
            if row:
                return {
                    "source": "catalog",
                    "key": f"{resource_type}:{provider}:{model}:{operation}:{unit}",
                    "unit_price_usd": float(row.get("unit_price_usd", 0.0) or 0.0),
                    "version": str(row.get("pricing_version", "") or ""),
                }
        except Exception:
            logger.warning("pricing catalog lookup failed", exc_info=True)
    return {
        "source": "fallback_env",
        "key": f"{resource_type}:{provider}:{model}:{operation}:{unit}",
        "unit_price_usd": float(fallback_unit_price),
        "version": "env-default",
    }


class AgentRunProxyRequest(BaseModel):
    """Edge-token-authenticated agent run — same harness as /agents/{name}/run."""
    agent_name: str
    task: str
    org_id: str = ""
    project_id: str = ""
    channel: str = ""          # e.g. "telegram", "discord", "portal"
    channel_user_id: str = ""  # e.g. Telegram chat_id
    runtime_mode: Literal["graph"] | None = None
    require_human_approval: bool | None = None
    enable_checkpoints: bool | None = None


@router.post("/agent/run")
async def agent_run_proxy(
    payload: AgentRunProxyRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Run an agent via edge token auth — same code path as /agents/{name}/run.

    This is the single entry point for ALL channels (Telegram, Discord, portal
    WebSocket, CLI) that route through the Cloudflare worker.  The worker
    authenticates with the shared edge token; the backend runs the full agent
    harness (tools, memory, governance, compliance, observability).
    """
    _require_edge_token(authorization=authorization, x_edge_token=x_edge_token)

    name = (payload.agent_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="agent_name is required")

    try:
        agent = _get_cached_agent(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    # Graph runtime is the only mode — no override needed.
    # Request-scoped instance only needed for enterprise features.
    run_agent_instance = agent
    if isinstance(payload.require_human_approval, bool) or isinstance(payload.enable_checkpoints, bool):
        run_agent_instance = _get_request_scoped_agent(name)
        harness_cfg = (
            run_agent_instance.config.harness
            if isinstance(run_agent_instance.config.harness, dict)
            else {}
        )
        if isinstance(payload.require_human_approval, bool):
            harness_cfg["require_human_approval"] = payload.require_human_approval
        if isinstance(payload.enable_checkpoints, bool):
            harness_cfg["enable_checkpoints"] = payload.enable_checkpoints

    # Set runtime context (org/project) so billing, telemetry, and scoping work
    if hasattr(run_agent_instance, "set_runtime_context"):
        run_agent_instance.set_runtime_context(
            org_id=payload.org_id or "",
            project_id=payload.project_id or "",
            user_id=f"channel:{payload.channel}:{payload.channel_user_id}" if payload.channel else "",
        )

    # Channel-aware formatting — tell the agent how to respond
    task = payload.task
    channel = (payload.channel or "").lower()
    if channel in ("telegram", "discord", "whatsapp", "sms"):
        task = (
            f"[Channel: {channel} — IMPORTANT RULES: "
            f"1) Use AT MOST 2 tool calls then give your answer. "
            f"2) Keep response under 500 characters. "
            f"3) Use short paragraphs with bold key facts. "
            f"4) No long essays or multiple searches.]\n\n"
            f"{payload.task}"
        )

    started = time.time()
    try:
        results = await run_agent_instance.run(task)
    except Exception as exc:
        logger.exception("agent run proxy error for %s", name)
        raise HTTPException(status_code=502, detail=f"agent run failed: {exc}") from exc

    elapsed_ms = int((time.time() - started) * 1000)

    output = ""
    total_cost = 0.0
    total_tools = 0
    session_id = ""
    trace_id = ""
    stop_reason = ""
    checkpoint_id = ""

    for r in results:
        if r.llm_response and r.llm_response.content:
            output = r.llm_response.content
        total_cost += r.cost_usd
        total_tools += len(r.tool_results)
        stop_reason = r.stop_reason or stop_reason

    if hasattr(run_agent_instance, "_observer") and run_agent_instance._observer and run_agent_instance._observer.records:
        last_rec = run_agent_instance._observer.records[-1]
        session_id = last_rec.session_id
        trace_id = last_rec.trace_id

    pending_checkpoint = getattr(
        getattr(run_agent_instance, "_harness", None),
        "_pending_graph_resume_payload",
        None,
    )
    if stop_reason == "human_approval_required" and isinstance(pending_checkpoint, dict):
        candidate_id = str(pending_checkpoint.get("checkpoint_id", ""))
        if candidate_id and db is not None:
            try:
                db.upsert_graph_checkpoint(
                    checkpoint_id=candidate_id,
                    agent_name=name,
                    session_id=str(pending_checkpoint.get("session_id", "")),
                    trace_id=str(pending_checkpoint.get("trace_id", "")),
                    status="pending_approval",
                    payload=pending_checkpoint,
                    metadata={
                        "created_by": f"channel:{payload.channel}:{payload.channel_user_id}" if payload.channel else "runtime_proxy",
                        "org_id": payload.org_id or "",
                        "project_id": payload.project_id or "",
                        "source": "runtime_proxy",
                    },
                )
                checkpoint_id = candidate_id
            except Exception:
                logger.warning("runtime proxy checkpoint persistence failed", exc_info=True)

    return {
        "success": not any(r.error for r in results),
        "output": output,
        "turns": len(results),
        "tool_calls": total_tools,
        "cost_usd": round(total_cost, 6),
        "latency_ms": elapsed_ms,
        "session_id": session_id,
        "trace_id": trace_id,
        "stop_reason": stop_reason,
        "checkpoint_id": checkpoint_id,
    }


class AgentResumeProxyRequest(BaseModel):
    """Resume an approval-gated run via a persisted checkpoint."""

    agent_name: str
    org_id: str = ""
    project_id: str = ""
    channel: str = ""
    channel_user_id: str = ""


@router.post("/agent/run/checkpoints/{checkpoint_id}/resume")
async def agent_resume_proxy(
    checkpoint_id: str,
    payload: AgentResumeProxyRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Resume a previously paused approval-gated run via runtime proxy."""
    _require_edge_token(authorization=authorization, x_edge_token=x_edge_token)
    if db is None:
        raise HTTPException(status_code=503, detail="database unavailable for checkpoint resume")
    name = (payload.agent_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="agent_name is required")

    row = db.get_graph_checkpoint(checkpoint_id)
    if not row or str(row.get("agent_name", "")) != name:
        raise HTTPException(status_code=404, detail=f"Checkpoint '{checkpoint_id}' not found for agent '{name}'")
    status = str(row.get("status", ""))
    if status == "resumed":
        raise HTTPException(status_code=409, detail=f"Checkpoint '{checkpoint_id}' was already resumed")
    if status != "pending_approval":
        raise HTTPException(status_code=409, detail=f"Checkpoint '{checkpoint_id}' is not resumable (status={status})")

    resume_payload = row.get("payload", {})
    if not isinstance(resume_payload, dict):
        raise HTTPException(status_code=400, detail=f"Checkpoint '{checkpoint_id}' payload is invalid")

    try:
        run_agent_instance = _get_request_scoped_agent(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    if hasattr(run_agent_instance, "set_runtime_context"):
        run_agent_instance.set_runtime_context(
            org_id=payload.org_id or "",
            project_id=payload.project_id or "",
            user_id=f"channel:{payload.channel}:{payload.channel_user_id}" if payload.channel else "",
        )

    started = time.time()
    try:
        results = await run_agent_instance.resume_from_checkpoint(resume_payload)
    except Exception as exc:
        logger.exception("agent resume proxy error for %s", name)
        raise HTTPException(status_code=502, detail=f"agent resume failed: {exc}") from exc
    elapsed_ms = int((time.time() - started) * 1000)
    db.mark_graph_checkpoint_resumed(checkpoint_id)

    output = ""
    total_cost = 0.0
    total_tools = 0
    session_id = ""
    trace_id = ""
    stop_reason = ""

    for r in results:
        if r.llm_response and r.llm_response.content:
            output = r.llm_response.content
        total_cost += r.cost_usd
        total_tools += len(r.tool_results)
        stop_reason = r.stop_reason or stop_reason

    if hasattr(run_agent_instance, "_observer") and run_agent_instance._observer and run_agent_instance._observer.records:
        last_rec = run_agent_instance._observer.records[-1]
        session_id = last_rec.session_id
        trace_id = last_rec.trace_id

    return {
        "success": not any(r.error for r in results),
        "output": output,
        "turns": len(results),
        "tool_calls": total_tools,
        "cost_usd": round(total_cost, 6),
        "latency_ms": elapsed_ms,
        "session_id": session_id,
        "trace_id": trace_id,
        "stop_reason": stop_reason,
        "checkpoint_id": checkpoint_id,
    }


def _runnable_input_to_task(value: Any) -> str:
    """Normalize runnable-style input payloads into AgentOS task text."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("input", "question", "query", "text", "task"):
            if key in value:
                return str(value[key])
    if value is None:
        return ""
    return str(value)


def _extract_runnable_config(config: dict[str, Any] | None) -> dict[str, Any]:
    raw = config if isinstance(config, dict) else {}
    tags = raw.get("tags", [])
    metadata = raw.get("metadata", {})
    return {
        "run_name": str(raw.get("run_name", "agentos_runnable")),
        "tags": list(tags) if isinstance(tags, list) else [],
        "metadata": dict(metadata) if isinstance(metadata, dict) else {},
        "max_concurrency": int(raw.get("max_concurrency", 1) or 1),
    }


def _runnable_events_from_runtime_events(
    runtime_events: list[dict[str, Any]],
    *,
    input_value: Any,
    output: str,
    metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    type_map = {
        "session_start": "on_chain_start",
        "session_end": "on_chain_end",
        "turn_start": "on_turn_start",
        "turn_end": "on_turn_end",
        "llm_request": "on_llm_start",
        "llm_response": "on_llm_end",
        "tool_call": "on_tool_start",
        "tool_result": "on_tool_end",
        "node_start": "on_node_start",
        "node_end": "on_node_end",
        "node_error": "on_node_error",
        "error": "on_chain_error",
    }
    for row in runtime_events:
        event_type = str(row.get("event_type", ""))
        payload = row.get("payload", {})
        if not isinstance(payload, dict):
            payload = {}
        events.append(
            {
                "event": type_map.get(event_type, f"on_{event_type}"),
                "name": str(row.get("node_id", "") or row.get("event_source", "") or "agentos_runtime_proxy"),
                "ts": float(row.get("event_ts", 0.0) or 0.0),
                "data": payload,
            }
        )
    if events:
        return events
    fallback: list[dict[str, Any]] = [
        {"event": "on_chain_start", "name": "agentos_runtime_proxy", "data": {"input": input_value}},
    ]
    if output:
        fallback.append({"event": "on_chain_stream", "name": "agentos_runtime_proxy", "data": {"chunk": output}})
    fallback.append({"event": "on_chain_end", "name": "agentos_runtime_proxy", "data": {"output": output, "metadata": metadata}})
    return fallback


def _compute_latency_breakdown(
    runtime_events: list[dict[str, Any]],
    *,
    trace_id: str,
    session_id: str = "",
) -> dict[str, Any]:
    if not runtime_events:
        return {
            "trace_id": trace_id,
            "session_id": session_id,
            "event_count": 0,
            "window_ms": 0.0,
            "llm_ms": 0.0,
            "tool_ms": 0.0,
            "node_reported_ms": 0.0,
            "non_llm_tool_ms": 0.0,
            "llm_calls": 0,
            "tool_calls": 0,
            "top_nodes": [],
            "diagnosis": "insufficient_data",
            "diagnosis_reasons": ["No runtime events found for the requested trace/session."],
        }

    llm_pending: list[float] = []
    tool_pending: list[float] = []
    llm_ms = 0.0
    tool_ms = 0.0
    llm_calls = 0
    tool_calls = 0
    node_total_ms = 0.0
    node_buckets: dict[str, dict[str, float]] = {}

    first_ts = float(runtime_events[0].get("event_ts", 0.0) or 0.0)
    last_ts = first_ts

    for row in runtime_events:
        event_type = str(row.get("event_type", ""))
        ts = float(row.get("event_ts", 0.0) or 0.0)
        last_ts = max(last_ts, ts)
        if event_type == "llm_request":
            llm_pending.append(ts)
        elif event_type == "llm_response":
            if llm_pending:
                start = llm_pending.pop(0)
                llm_ms += max(0.0, (ts - start) * 1000.0)
                llm_calls += 1
        elif event_type == "tool_call":
            tool_pending.append(ts)
        elif event_type == "tool_result":
            if tool_pending:
                start = tool_pending.pop(0)
                tool_ms += max(0.0, (ts - start) * 1000.0)
                tool_calls += 1

        if event_type in ("node_end", "node_error"):
            raw_node_ms = float(row.get("latency_ms", 0.0) or 0.0)
            payload = row.get("payload", {})
            if isinstance(payload, dict):
                raw_node_ms = float(payload.get("latency_ms", raw_node_ms) or raw_node_ms)
            node_id = str(row.get("node_id", "") or "unknown")
            node_total_ms += raw_node_ms
            bucket = node_buckets.setdefault(node_id, {"count": 0.0, "total_ms": 0.0})
            bucket["count"] += 1.0
            bucket["total_ms"] += raw_node_ms

    window_ms = max(0.0, (last_ts - first_ts) * 1000.0)
    non_llm_tool_ms = max(0.0, window_ms - llm_ms - tool_ms)

    top_nodes = sorted(
        (
            {
                "node_id": node_id,
                "count": int(stats["count"]),
                "total_ms": round(float(stats["total_ms"]), 3),
                "avg_ms": round(float(stats["total_ms"]) / max(1, int(stats["count"])), 3),
            }
            for node_id, stats in node_buckets.items()
        ),
        key=lambda x: x["total_ms"],
        reverse=True,
    )[:10]

    diagnosis = "mixed"
    diagnosis_reasons: list[str] = []
    if window_ms <= 0.0:
        diagnosis = "insufficient_data"
        diagnosis_reasons.append("Event window is zero; unable to infer bottleneck.")
    else:
        llm_ratio = llm_ms / window_ms
        tool_ratio = tool_ms / window_ms
        other_ratio = non_llm_tool_ms / window_ms
        if llm_ratio >= 0.5 and llm_ms >= 250.0:
            diagnosis = "llm_bound"
            diagnosis_reasons.append(
                f"LLM time dominates runtime ({llm_ms:.1f}ms, {llm_ratio:.0%} of window)."
            )
        elif tool_ratio >= 0.45 and tool_ms >= 200.0:
            diagnosis = "tool_bound"
            diagnosis_reasons.append(
                f"Tool execution dominates runtime ({tool_ms:.1f}ms, {tool_ratio:.0%} of window)."
            )
        elif other_ratio >= 0.45:
            diagnosis = "orchestration_bound"
            diagnosis_reasons.append(
                f"Non-LLM/tool overhead is high ({non_llm_tool_ms:.1f}ms, {other_ratio:.0%} of window)."
            )
            if top_nodes:
                diagnosis_reasons.append(
                    f"Top node contributor: {top_nodes[0]['node_id']} ({top_nodes[0]['total_ms']:.1f}ms)."
                )
        else:
            diagnosis = "mixed"
            diagnosis_reasons.append(
                "Latency is distributed across LLM, tools, and orchestration."
            )

    return {
        "trace_id": trace_id,
        "session_id": session_id,
        "event_count": len(runtime_events),
        "window_ms": round(window_ms, 3),
        "llm_ms": round(llm_ms, 3),
        "tool_ms": round(tool_ms, 3),
        "node_reported_ms": round(node_total_ms, 3),
        "non_llm_tool_ms": round(non_llm_tool_ms, 3),
        "llm_calls": llm_calls,
        "tool_calls": tool_calls,
        "top_nodes": top_nodes,
        "diagnosis": diagnosis,
        "diagnosis_reasons": diagnosis_reasons,
    }


class RunnableInvokeProxyRequest(BaseModel):
    """Runnable-style invoke contract over runtime proxy."""

    agent_name: str
    input: Any = ""
    config: dict[str, Any] = Field(default_factory=dict)
    org_id: str = ""
    project_id: str = ""
    channel: str = ""
    channel_user_id: str = ""
    require_human_approval: bool | None = None
    enable_checkpoints: bool | None = None


class RunnableBatchProxyRequest(BaseModel):
    """Runnable-style batch contract over runtime proxy."""

    agent_name: str
    inputs: list[Any] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)
    org_id: str = ""
    project_id: str = ""
    channel: str = ""
    channel_user_id: str = ""
    require_human_approval: bool | None = None
    enable_checkpoints: bool | None = None


class RunnableLatencyBreakdownRequest(BaseModel):
    """Latency diagnostics for runnable traces."""

    trace_id: str = ""
    session_id: str = ""
    limit: int = 3000


@router.post("/runnable/invoke")
async def runnable_invoke_proxy(
    payload: RunnableInvokeProxyRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Invoke-style endpoint compatible with runnable clients."""
    _require_edge_token(authorization=authorization, x_edge_token=x_edge_token)
    name = (payload.agent_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="agent_name is required")
    runnable_cfg = _extract_runnable_config(payload.config)
    task = _runnable_input_to_task(payload.input)

    # Runnable endpoints always use request-scoped agents for isolation.
    try:
        run_agent_instance = _get_request_scoped_agent(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    if isinstance(payload.require_human_approval, bool) or isinstance(payload.enable_checkpoints, bool):
        harness_cfg = (
            run_agent_instance.config.harness
            if isinstance(run_agent_instance.config.harness, dict)
            else {}
        )
        if isinstance(payload.require_human_approval, bool):
            harness_cfg["require_human_approval"] = payload.require_human_approval
        if isinstance(payload.enable_checkpoints, bool):
            harness_cfg["enable_checkpoints"] = payload.enable_checkpoints

    if hasattr(run_agent_instance, "set_runtime_context"):
        run_agent_instance.set_runtime_context(
            org_id=payload.org_id or "",
            project_id=payload.project_id or "",
            user_id=f"channel:{payload.channel}:{payload.channel_user_id}" if payload.channel else "",
        )
    if hasattr(run_agent_instance, "_harness") and run_agent_instance._harness is not None:
        setattr(
            run_agent_instance._harness,
            "_runtime_proxy_runnable_config",
            {
                "run_name": runnable_cfg["run_name"],
                "tags": runnable_cfg["tags"],
                "metadata": runnable_cfg["metadata"],
                "input_raw": payload.input,
            },
        )

    started = time.time()
    try:
        results = await run_agent_instance.run(task)
    except Exception as exc:
        logger.exception("runnable invoke proxy error for %s", name)
        raise HTTPException(status_code=502, detail=f"agent run failed: {exc}") from exc
    elapsed_ms = int((time.time() - started) * 1000)

    output = ""
    total_cost = 0.0
    total_tools = 0
    session_id = ""
    trace_id = ""
    stop_reason = ""
    checkpoint_id = ""
    for r in results:
        if r.llm_response and r.llm_response.content:
            output = r.llm_response.content
        total_cost += r.cost_usd
        total_tools += len(r.tool_results)
        stop_reason = r.stop_reason or stop_reason
    if hasattr(run_agent_instance, "_observer") and run_agent_instance._observer and run_agent_instance._observer.records:
        last_rec = run_agent_instance._observer.records[-1]
        session_id = last_rec.session_id
        trace_id = last_rec.trace_id
    pending_checkpoint = getattr(
        getattr(run_agent_instance, "_harness", None),
        "_pending_graph_resume_payload",
        None,
    )
    if stop_reason == "human_approval_required" and isinstance(pending_checkpoint, dict):
        candidate_id = str(pending_checkpoint.get("checkpoint_id", ""))
        if candidate_id and db is not None:
            try:
                db.upsert_graph_checkpoint(
                    checkpoint_id=candidate_id,
                    agent_name=name,
                    session_id=str(pending_checkpoint.get("session_id", "")),
                    trace_id=str(pending_checkpoint.get("trace_id", "")),
                    status="pending_approval",
                    payload=pending_checkpoint,
                    metadata={
                        "created_by": f"channel:{payload.channel}:{payload.channel_user_id}" if payload.channel else "runtime_proxy_runnable",
                        "org_id": payload.org_id or "",
                        "project_id": payload.project_id or "",
                        "source": "runtime_proxy_runnable",
                        "run_name": runnable_cfg["run_name"],
                        "tags": runnable_cfg["tags"],
                        "metadata": runnable_cfg["metadata"],
                    },
                )
                checkpoint_id = candidate_id
            except Exception:
                logger.warning("runtime runnable checkpoint persistence failed", exc_info=True)

    return {
        "output": output,
        "metadata": {
            "success": not any(r.error for r in results),
            "turns": len(results),
            "tool_calls": total_tools,
            "cost_usd": round(total_cost, 6),
            "latency_ms": elapsed_ms,
            "session_id": session_id,
            "trace_id": trace_id,
            "stop_reason": stop_reason,
            "checkpoint_id": checkpoint_id,
            "run_name": runnable_cfg["run_name"],
            "tags": runnable_cfg["tags"],
            "metadata": runnable_cfg["metadata"],
            "input_raw": payload.input,
        },
    }


@router.post("/runnable/batch")
async def runnable_batch_proxy(
    payload: RunnableBatchProxyRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Batch-style endpoint compatible with runnable clients."""
    cfg = _extract_runnable_config(payload.config)
    max_concurrency = max(1, int(cfg.get("max_concurrency", 1) or 1))
    semaphore = asyncio.Semaphore(max_concurrency)

    async def _run_one(value: Any) -> dict[str, Any]:
        async with semaphore:
            try:
                result = await runnable_invoke_proxy(
                    RunnableInvokeProxyRequest(
                        agent_name=payload.agent_name,
                        input=value,
                        config=payload.config,
                        org_id=payload.org_id,
                        project_id=payload.project_id,
                        channel=payload.channel,
                        channel_user_id=payload.channel_user_id,
                        require_human_approval=payload.require_human_approval,
                        enable_checkpoints=payload.enable_checkpoints,
                    ),
                    authorization=authorization,
                    x_edge_token=x_edge_token,
                    db=db,
                )
                return {"ok": True, "error": "", **result}
            except HTTPException as exc:
                return {"ok": False, "error": str(exc.detail), "output": "", "metadata": {}}
            except Exception as exc:
                return {"ok": False, "error": str(exc), "output": "", "metadata": {}}

    outputs = await asyncio.gather(*(_run_one(value) for value in payload.inputs))
    return {"outputs": outputs, "batch_metadata": {"count": len(outputs), "max_concurrency": max_concurrency}}


@router.post("/runnable/stream-events")
async def runnable_stream_events_proxy(
    payload: RunnableInvokeProxyRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Return a runnable-style event timeline for one invoke."""
    invoke = await runnable_invoke_proxy(
        payload,
        authorization=authorization,
        x_edge_token=x_edge_token,
        db=db,
    )
    output = str(invoke.get("output", ""))
    metadata = dict(invoke.get("metadata", {}))
    trace_id = str(metadata.get("trace_id", ""))
    runtime_events: list[dict[str, Any]] = []
    if db is not None and trace_id:
        try:
            runtime_events = db.query_runtime_events(trace_id=trace_id, limit=3000)
        except Exception:
            runtime_events = []
    events = _runnable_events_from_runtime_events(
        runtime_events,
        input_value=payload.input,
        output=output,
        metadata=metadata,
    )
    return {"events": events, "metadata": metadata}


@router.post("/runnable/latency-breakdown")
async def runnable_latency_breakdown_proxy(
    payload: RunnableLatencyBreakdownRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Compute latency breakdown for a runnable trace/session."""
    _require_edge_token(authorization=authorization, x_edge_token=x_edge_token)
    if db is None:
        raise HTTPException(status_code=503, detail="database unavailable")
    trace_id = str(payload.trace_id or "").strip()
    session_id = str(payload.session_id or "").strip()
    if not trace_id and not session_id:
        raise HTTPException(status_code=400, detail="trace_id or session_id is required")
    limit = max(100, min(int(payload.limit or 3000), 10000))
    try:
        runtime_events = db.query_runtime_events(
            trace_id=trace_id,
            session_id=session_id,
            limit=limit,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to query runtime events: {exc}") from exc
    breakdown = _compute_latency_breakdown(
        runtime_events,
        trace_id=trace_id,
        session_id=session_id,
    )
    breakdown["limit"] = limit
    return breakdown


class LLMInferRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)
    provider: str = "gmi"
    model: str
    max_tokens: int = 4096
    temperature: float = 0.0
    plan: str = ""
    tier: str = ""
    session_id: str = ""
    turn: int = 0
    org_id: str = ""
    project_id: str = ""
    agent_name: str = ""


class ToolCallRequest(BaseModel):
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    session_id: str = ""
    turn: int = 0
    org_id: str = ""
    project_id: str = ""
    agent_name: str = ""


class SandboxExecRequest(BaseModel):
    command: str
    timeout_seconds: int = 30
    session_id: str = ""
    turn: int = 0
    org_id: str = ""
    project_id: str = ""
    agent_name: str = ""


@router.post("/llm/infer")
async def llm_infer(
    payload: LLMInferRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Run provider inference from backend-held credentials for edge workers."""
    _require_edge_token(authorization=authorization, x_edge_token=x_edge_token)

    provider = (payload.provider or "gmi").strip().lower()
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    started = time.time()
    content = ""
    tool_calls: list[Any] = []
    in_tokens = 0
    out_tokens = 0
    resolved_model = model

    # Route ALL LLM calls through the CF worker — backend holds ZERO API keys.
    # The worker's /cf/llm/infer handles: @cf/* → Workers AI, else → OpenRouter.
    try:
        from agentos.infra.cloudflare_client import get_cf_client

        cf = get_cf_client()
        if cf is None:
            raise HTTPException(
                status_code=503,
                detail="AGENTOS_WORKER_URL not configured — cannot route LLM inference",
            )

        result = await cf.llm_infer(
            model=model,
            messages=list(payload.messages),
            max_tokens=int(max(1, payload.max_tokens)),
            temperature=float(payload.temperature),
        )
        content = str(result.get("content", "") or "")
        tool_calls = list(result.get("tool_calls", []) or [])
        in_tokens = int(result.get("input_tokens", 0) or 0)
        out_tokens = int(result.get("output_tokens", 0) or 0)
        resolved_model = str(result.get("model", "") or model)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("runtime proxy llm error")
        raise HTTPException(status_code=502, detail=f"runtime proxy failure: {exc}") from exc

    in_rate = _resolve_catalog_rate(
        db,
        resource_type="llm",
        operation="infer",
        unit="input_token",
        provider=provider,
        model=resolved_model,
        fallback_unit_price=0.0,
    )
    out_rate = _resolve_catalog_rate(
        db,
        resource_type="llm",
        operation="infer",
        unit="output_token",
        provider=provider,
        model=resolved_model,
        fallback_unit_price=0.0,
    )
    if (in_rate["source"] == "catalog") or (out_rate["source"] == "catalog"):
        cost_usd = (in_tokens * float(in_rate["unit_price_usd"])) + (out_tokens * float(out_rate["unit_price_usd"]))
        pricing_source = "catalog"
        pricing_key = f"llm:{provider}:{resolved_model}:infer"
        unit = "token"
        unit_price_usd = float(in_rate["unit_price_usd"]) + float(out_rate["unit_price_usd"])
        quantity = float(in_tokens + out_tokens)
        pricing_version = str(out_rate["version"] or in_rate["version"] or "")
    else:
        cost_usd = float(estimate_cost(in_tokens, out_tokens, resolved_model))
        pricing_source = "fallback_env"
        pricing_key = f"llm:{provider}:{resolved_model}:infer"
        unit = "token"
        unit_price_usd = 0.0
        quantity = float(in_tokens + out_tokens)
        pricing_version = "estimate_cost_fallback"
    latency_ms = int((time.time() - started) * 1000)

    # Fire-and-forget billing — never block the response on DB writes.
    import asyncio

    async def _persist_billing() -> None:
        if db is None:
            return
        try:
            if payload.session_id:
                db.record_cost(
                    session_id=payload.session_id,
                    agent_name=payload.agent_name,
                    model=resolved_model,
                    input_tokens=in_tokens,
                    output_tokens=out_tokens,
                    cost_usd=cost_usd,
                )
            db.record_billing(
                org_id=payload.org_id,
                cost_type="inference",
                total_cost_usd=cost_usd,
                agent_name=payload.agent_name,
                model=resolved_model,
                provider=provider,
                input_tokens=in_tokens,
                output_tokens=out_tokens,
                inference_cost_usd=cost_usd,
                session_id=payload.session_id,
                description=f"edge worker proxy ({payload.plan}/{payload.tier});project_id={payload.project_id}",
                pricing_source=pricing_source,
                pricing_key=pricing_key,
                unit=unit,
                unit_price_usd=unit_price_usd,
                quantity=quantity,
                pricing_version=pricing_version,
            )
        except Exception:
            logger.warning("runtime proxy billing persistence failed", exc_info=True)

    asyncio.create_task(_persist_billing())

    return {
        "content": content,
        "model": resolved_model,
        "provider": provider,
        "tier": payload.tier,
        "tool_calls": tool_calls,
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "cost_usd": cost_usd,
        "latency_ms": latency_ms,
    }


@router.post("/tool/call")
async def tool_call(
    payload: ToolCallRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Execute selected built-in tools on backend (proxy-only mode)."""
    _require_edge_token(authorization=authorization, x_edge_token=x_edge_token)

    from agentos.tools import builtins as builtin_tools

    name = (payload.tool or "").strip().lower()
    args = payload.args or {}
    started = time.time()

    try:
        if name in {"web_search", "web-search"}:
            output = await builtin_tools.web_search(
                query=str(args.get("query", "")),
                max_results=int(args.get("max_results", 5) or 5),
            )
        elif name in {"knowledge_search", "knowledge-search", "vectorize_query"}:
            output = await builtin_tools.knowledge_search(
                query=str(args.get("query", "")),
                top_k=int(args.get("top_k", 5) or 5),
            )
        elif name in {"bash", "bash_exec"}:
            output = await builtin_tools.bash_exec(
                command=str(args.get("command", "")),
                timeout_seconds=int(args.get("timeout_seconds", 30) or 30),
            )
        elif name in {"http_request", "http-request"}:
            output = await builtin_tools.http_request(
                url=str(args.get("url", "")),
                method=str(args.get("method", "GET")),
                headers=dict(args.get("headers", {}) or {}),
                body=str(args.get("body", "")),
                timeout_seconds=int(args.get("timeout_seconds", 30) or 30),
            )
        else:
            raise HTTPException(status_code=400, detail=f"unsupported proxied tool: {payload.tool}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("runtime proxy tool call error")
        raise HTTPException(status_code=502, detail=f"tool proxy failure: {exc}") from exc

    latency_ms = int((time.time() - started) * 1000)

    # Fallback usage pricing from env if no catalog rate is present.
    default_per_call = _env_price("PRICE_TOOL_DEFAULT_PER_CALL_USD", 0.0010)
    price_map = {
        "web_search": _env_price("PRICE_TOOL_WEB_SEARCH_PER_CALL_USD", 0.0015),
        "web-search": _env_price("PRICE_TOOL_WEB_SEARCH_PER_CALL_USD", 0.0015),
        "knowledge_search": _env_price("PRICE_TOOL_KNOWLEDGE_SEARCH_PER_CALL_USD", 0.0010),
        "knowledge-search": _env_price("PRICE_TOOL_KNOWLEDGE_SEARCH_PER_CALL_USD", 0.0010),
        "vectorize_query": _env_price("PRICE_TOOL_KNOWLEDGE_SEARCH_PER_CALL_USD", 0.0010),
        "http_request": _env_price("PRICE_TOOL_HTTP_REQUEST_PER_CALL_USD", 0.0012),
        "http-request": _env_price("PRICE_TOOL_HTTP_REQUEST_PER_CALL_USD", 0.0012),
        "bash": _env_price("PRICE_TOOL_BASH_PER_CALL_USD", 0.0008),
        "bash_exec": _env_price("PRICE_TOOL_BASH_PER_CALL_USD", 0.0008),
    }
    rate = _resolve_catalog_rate(
        db,
        resource_type="tool",
        operation=name,
        unit="call",
        provider="backend-tool-proxy",
        model="",
        fallback_unit_price=float(price_map.get(name, default_per_call)),
    )
    tool_cost_usd = float(rate["unit_price_usd"]) * 1.0

    import asyncio

    async def _persist_tool_billing() -> None:
        if db is None:
            return
        try:
            if payload.session_id:
                db.record_cost(
                    session_id=payload.session_id,
                    agent_name=payload.agent_name,
                    model=f"tool:{name}",
                    input_tokens=0,
                    output_tokens=0,
                    cost_usd=tool_cost_usd,
                )
            db.record_billing(
                org_id=payload.org_id,
                cost_type="tool_execution",
                total_cost_usd=tool_cost_usd,
                agent_name=payload.agent_name,
                model="",
                provider="backend-tool-proxy",
                input_tokens=0,
                output_tokens=0,
                inference_cost_usd=0.0,
                session_id=payload.session_id,
                description=f"tool={name};project_id={payload.project_id}",
                pricing_source=str(rate["source"]),
                pricing_key=str(rate["key"]),
                unit="call",
                unit_price_usd=float(rate["unit_price_usd"]),
                quantity=1.0,
                pricing_version=str(rate["version"]),
            )
        except Exception:
            logger.warning("runtime proxy tool billing persistence failed", exc_info=True)

    asyncio.create_task(_persist_tool_billing())

    return {
        "tool": name,
        "output": output,
        "latency_ms": latency_ms,
        "cost_usd": tool_cost_usd,
    }


@router.post("/sandbox/exec")
async def sandbox_exec(
    payload: SandboxExecRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Execute shell command via backend sandbox proxy."""
    _require_edge_token(authorization=authorization, x_edge_token=x_edge_token)

    from agentos.tools.builtins import bash_exec

    started = time.time()
    output = await bash_exec(
        command=payload.command,
        timeout_seconds=int(max(1, min(payload.timeout_seconds, 120))),
    )
    latency_ms = int((time.time() - started) * 1000)
    # Fallback usage pricing from env if no catalog rates are present.
    base_usd = _env_price("PRICE_SANDBOX_EXEC_BASE_USD", 0.0005)
    per_second_usd = _env_price("PRICE_SANDBOX_EXEC_PER_SECOND_USD", 0.0002)
    min_usd = _env_price("PRICE_SANDBOX_EXEC_MIN_USD", 0.0005)
    elapsed_sec = max(0.0, latency_ms / 1000.0)
    base_rate = _resolve_catalog_rate(
        db,
        resource_type="sandbox",
        operation="exec_base",
        unit="call",
        provider="backend-sandbox-proxy",
        model="",
        fallback_unit_price=base_usd,
    )
    second_rate = _resolve_catalog_rate(
        db,
        resource_type="sandbox",
        operation="exec",
        unit="second",
        provider="backend-sandbox-proxy",
        model="",
        fallback_unit_price=per_second_usd,
    )
    sandbox_cost_usd = max(min_usd, float(base_rate["unit_price_usd"]) + (elapsed_sec * float(second_rate["unit_price_usd"])))

    import asyncio

    async def _persist_sandbox_billing() -> None:
        if db is None:
            return
        try:
            if payload.session_id:
                db.record_cost(
                    session_id=payload.session_id,
                    agent_name=payload.agent_name,
                    model="tool:sandbox_exec",
                    input_tokens=0,
                    output_tokens=0,
                    cost_usd=sandbox_cost_usd,
                )
            db.record_billing(
                org_id=payload.org_id,
                cost_type="tool_execution",
                total_cost_usd=sandbox_cost_usd,
                agent_name=payload.agent_name,
                model="",
                provider="backend-sandbox-proxy",
                input_tokens=0,
                output_tokens=0,
                inference_cost_usd=0.0,
                session_id=payload.session_id,
                description=f"sandbox_exec;project_id={payload.project_id};elapsed_sec={elapsed_sec:.3f}",
                pricing_source=("catalog" if (base_rate["source"] == "catalog" or second_rate["source"] == "catalog") else "fallback_env"),
                pricing_key="sandbox:backend-sandbox-proxy::exec",
                unit="second",
                unit_price_usd=float(second_rate["unit_price_usd"]),
                quantity=float(elapsed_sec),
                pricing_version=str(second_rate["version"] or base_rate["version"] or ""),
            )
        except Exception:
            logger.warning("runtime proxy sandbox billing persistence failed", exc_info=True)

    asyncio.create_task(_persist_sandbox_billing())

    return {"output": output, "latency_ms": latency_ms, "cost_usd": sandbox_cost_usd}

