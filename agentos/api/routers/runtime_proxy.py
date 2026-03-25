"""Backend runtime proxy for edge workers (centralized provider keys)."""

from __future__ import annotations

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

    # Enable fast-chat path for production runtime proxy.
    # Simple messages skip the full graph runtime for lower latency.
    if hasattr(agent, "_harness") and agent._harness:
        agent._harness._enable_fast_chat = True

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


@router.post("/runnable/invoke")
async def runnable_invoke_proxy(
    payload: RunnableInvokeProxyRequest,
    authorization: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    db: Any = Depends(_get_db_safe),
) -> dict[str, Any]:
    """Invoke-style endpoint compatible with runnable clients."""
    task = _runnable_input_to_task(payload.input)
    run = await agent_run_proxy(
        AgentRunProxyRequest(
            agent_name=payload.agent_name,
            task=task,
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
    return {
        "output": run.get("output", ""),
        "metadata": {
            "success": bool(run.get("success", False)),
            "turns": int(run.get("turns", 0) or 0),
            "tool_calls": int(run.get("tool_calls", 0) or 0),
            "cost_usd": float(run.get("cost_usd", 0.0) or 0.0),
            "latency_ms": int(run.get("latency_ms", 0) or 0),
            "session_id": str(run.get("session_id", "")),
            "trace_id": str(run.get("trace_id", "")),
            "stop_reason": str(run.get("stop_reason", "")),
            "checkpoint_id": str(run.get("checkpoint_id", "")),
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
    outputs: list[Any] = []
    for value in payload.inputs:
        item = await runnable_invoke_proxy(
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
        outputs.append(item)
    return {"outputs": outputs}


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
    events: list[dict[str, Any]] = [
        {"event": "on_chain_start", "name": "agentos_runtime_proxy", "data": {"input": payload.input}},
    ]
    if output:
        events.append({"event": "on_chain_stream", "name": "agentos_runtime_proxy", "data": {"chunk": output}})
    events.append({"event": "on_chain_end", "name": "agentos_runtime_proxy", "data": {"output": output, "metadata": metadata}})
    return {"events": events}


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

