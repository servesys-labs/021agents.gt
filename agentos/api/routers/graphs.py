"""Graph definition dev tooling — compile/validate declarative graphs."""

from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from agentos.api.deps import CurrentUser, _get_db, get_current_user
from agentos.graph.declarative_linear import (
    validate_bounded_dag_declarative_graph,
    validate_linear_declarative_graph,
)
from agentos.graph.contracts import summarize_graph_contracts
from agentos.graph.design_lint import lint_graph_design
from agentos.graph.autofix import lint_and_autofix_graph, lint_payload_from_result
from agentos.graph.validate import validate_graph_definition

router = APIRouter(prefix="/graphs", tags=["graphs"])


class GraphValidateRequest(BaseModel):
    """Body: a single graph object with ``nodes`` and optional ``edges``."""

    graph: dict[str, Any] = Field(
        ...,
        description="Graph spec: optional id, nodes[], edges[] (source/target or from/to)",
    )


class GraphLintRequest(BaseModel):
    """Body: graph plus strictness for no-code publish gating."""

    graph: dict[str, Any] = Field(
        ...,
        description="Graph spec: optional id, nodes[], edges[] (source/target or from/to)",
    )
    strict: bool = Field(
        default=False,
        description="Promote lint warnings to errors when true.",
    )


class GraphAutoFixRequest(GraphLintRequest):
    """Request to auto-fix common no-code lint issues."""

    apply: bool = Field(
        default=True,
        description="When true, return a fixed graph candidate and post-fix lint.",
    )


class GraphContractsValidateRequest(GraphLintRequest):
    """Contract validation request for skills/state safety checks."""

    strict: bool = Field(
        default=True,
        description="Promote contract warnings to errors when true.",
    )


class GraphGatePackRequest(BaseModel):
    """No-code gate pack: graph lint + eval readiness + rollout recommendation."""

    agent_name: str = Field(..., min_length=1)
    graph: dict[str, Any] | None = Field(default=None)
    strict_graph_lint: bool = Field(default=True)
    eval_file: str | None = Field(default=None)
    trials: int = Field(default=3, ge=1, le=20)
    min_eval_pass_rate: float = Field(default=0.85, ge=0.0, le=1.0)
    min_eval_trials: int = Field(default=3, ge=1, le=1000)
    target_channel: str = Field(default="staging", min_length=1)


class GraphIssueResponse(BaseModel):
    code: str
    message: str
    path: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class GraphValidateResponse(BaseModel):
    valid: bool
    errors: list[GraphIssueResponse]
    warnings: list[GraphIssueResponse]
    summary: dict[str, Any] | None = None


def _load_agent_graph(agent_name: str) -> dict[str, Any] | None:
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(agent_name)
    except FileNotFoundError:
        return None
    harness = getattr(agent.config, "harness", {})
    if isinstance(harness, dict):
        for key in ("declarative_graph", "graph"):
            g = harness.get(key)
            if isinstance(g, dict):
                return g
    return None


@router.post("/validate", response_model=GraphValidateResponse)
async def validate_graph(
    body: GraphValidateRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> GraphValidateResponse:
    """Validate a declarative graph (DAG): schema, references, cycles; return summary if valid."""
    result = validate_graph_definition(body.graph)
    return GraphValidateResponse(
        valid=result.valid,
        errors=[GraphIssueResponse(**e.to_dict()) for e in result.errors],
        warnings=[GraphIssueResponse(**w.to_dict()) for w in result.warnings],
        summary=result.summary,
    )


@router.post("/lint", response_model=GraphValidateResponse)
async def lint_graph(
    body: GraphLintRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> GraphValidateResponse:
    """Lint a declarative graph for no-code runtime semantics and async safety."""
    result = lint_graph_design(body.graph, strict=body.strict)
    return GraphValidateResponse(
        valid=result.valid,
        errors=[GraphIssueResponse(**e.to_dict()) for e in result.errors],
        warnings=[GraphIssueResponse(**w.to_dict()) for w in result.warnings],
        summary=result.summary,
    )


@router.post("/autofix")
async def autofix_graph(
    body: GraphAutoFixRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Apply deterministic auto-fixes for common no-code lint issues."""
    return lint_and_autofix_graph(body.graph, strict=body.strict, apply=body.apply)


@router.post("/contracts/validate", response_model=GraphValidateResponse)
async def validate_graph_contracts(
    body: GraphContractsValidateRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> GraphValidateResponse:
    """Validate skill/state contracts used by no-code graph execution."""
    result = lint_graph_design(body.graph, strict=body.strict)
    summary = dict(result.summary or {})
    summary["contracts"] = summarize_graph_contracts(body.graph)
    return GraphValidateResponse(
        valid=result.valid,
        errors=[GraphIssueResponse(**e.to_dict()) for e in result.errors],
        warnings=[GraphIssueResponse(**w.to_dict()) for w in result.warnings],
        summary=summary,
    )


@router.post("/gate-pack")
async def graph_gate_pack(
    body: GraphGatePackRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Run no-code gate pack: lint + eval posture + rollout recommendation."""
    # Verify org ownership whenever agent_name is provided — even with inline graph,
    # the eval gate query uses agent_name and would leak cross-org pass-rate data.
    if body.agent_name:
        db = _get_db()
        row = db.conn.execute(
            "SELECT 1 FROM agents WHERE name = ? AND org_id = ? AND is_active = 1",
            (body.agent_name, _user.org_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Agent not found or not owned by your organization")
    graph = body.graph if isinstance(body.graph, dict) else _load_agent_graph(body.agent_name)
    if not isinstance(graph, dict):
        raise HTTPException(
            status_code=404,
            detail="No declarative graph found for agent (provide graph or store harness.declarative_graph).",
        )
    lint_result = lint_graph_design(graph, strict=body.strict_graph_lint)
    lint_payload = {
        **lint_payload_from_result(lint_result),
    }
    db = _get_db()
    row = db.conn.execute(
        "SELECT id, pass_rate, total_trials, total_tasks, created_at FROM eval_runs WHERE agent_name = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1",
        (body.agent_name, _user.org_id),
    ).fetchone()
    latest_eval = dict(row) if row else None
    eval_gate_pass = False
    if latest_eval is not None:
        pass_rate = float(latest_eval.get("pass_rate") or 0.0)
        total_trials = int(latest_eval.get("total_trials") or 0)
        eval_gate_pass = pass_rate >= body.min_eval_pass_rate and total_trials >= body.min_eval_trials

    rollout = {
        "decision": "hold",
        "target_channel": body.target_channel,
        "reason": "",
        "recommended_action": "",
        "release_endpoint": f"/api/v1/releases/{body.agent_name}/promote?from_channel=draft&to_channel={body.target_channel}",
    }
    if not lint_payload["valid"]:
        rollout["reason"] = "Graph lint failed."
        rollout["recommended_action"] = "Run /api/v1/graphs/autofix then re-lint."
    elif latest_eval is None:
        rollout["reason"] = "No eval run found for agent."
        rollout["recommended_action"] = (
            "Run /api/v1/eval/run before promotion."
            if body.eval_file
            else "Provide eval_file and run /api/v1/eval/run before promotion."
        )
    elif not eval_gate_pass:
        rollout["reason"] = (
            f"Eval gate failed (pass_rate={float(latest_eval.get('pass_rate') or 0.0):.2f}, "
            f"trials={int(latest_eval.get('total_trials') or 0)})."
        )
        rollout["recommended_action"] = "Run targeted eval/experiments and iterate before promotion."
    else:
        rollout["decision"] = "promote_candidate"
        rollout["reason"] = "Lint and eval gates passed."
        rollout["recommended_action"] = "Promote to target channel and optionally start canary."

    return {
        "agent_name": body.agent_name,
        "graph_lint": lint_payload,
        "eval_gate": {
            "latest_eval_run": latest_eval,
            "min_eval_pass_rate": body.min_eval_pass_rate,
            "min_eval_trials": body.min_eval_trials,
            "passed": eval_gate_pass,
            "eval_run_endpoint": (
                f"/api/v1/eval/run?agent_name={body.agent_name}&eval_file={body.eval_file}&trials={body.trials}"
                if body.eval_file
                else "/api/v1/eval/run"
            ),
        },
        "rollout": rollout,
    }


class GraphAgentContext(BaseModel):
    """Agent identity and routing context forwarded to the edge runtime."""

    agent_name: str = Field(..., min_length=1)
    org_id: str | None = None
    project_id: str | None = None
    channel: str | None = None
    channel_user_id: str | None = None


class GraphLinearRunRequest(BaseModel):
    """Validated linear graph + task + agent context for edge execution."""

    graph: dict[str, Any] = Field(..., description="Declarative graph (nodes, edges)")
    task: str | None = Field(default=None, description="Primary task text")
    input: str | None = Field(default=None, description="Alias for task")
    agent_context: GraphAgentContext
    initial_state: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _require_task_text(self) -> GraphLinearRunRequest:
        t = (self.task or "").strip()
        i = (self.input or "").strip()
        if not t and not i:
            raise ValueError("task or input is required")
        return self


class GraphDagRunRequest(GraphLinearRunRequest):
    """Deterministic bounded DAG run request forwarded to the edge runtime."""

    max_branching: int = Field(default=4, ge=1, le=8)
    max_fanin: int = Field(default=4, ge=1, le=8)


def _resolved_task(body: GraphLinearRunRequest) -> str:
    t = (body.task or "").strip()
    if t:
        return t
    return (body.input or "").strip()


@router.post("/linear-run")
async def linear_graph_run(
    body: GraphLinearRunRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Validate a linear declarative graph, then forward the run to the edge worker (edge-first)."""
    try:
        vr = validate_linear_declarative_graph(body.graph)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Graph validation error: {exc}") from exc

    if not vr.valid:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Graph is not a valid linear declarative graph",
                "errors": [e.to_dict() for e in vr.errors],
                "warnings": [w.to_dict() for w in vr.warnings],
            },
        )

    edge_base = (os.environ.get("EDGE_RUNTIME_URL", "") or "").strip().rstrip("/")
    edge_token = (os.environ.get("EDGE_RUNTIME_TOKEN", "") or "").strip()
    if not edge_base:
        raise HTTPException(
            status_code=503,
            detail=(
                "EDGE_RUNTIME_URL is not configured. "
                "Set it to your worker origin to proxy graph runs, "
                "or call worker POST /api/v1/graphs/linear-run directly."
            ),
        )
    if not edge_token:
        raise HTTPException(
            status_code=503,
            detail="EDGE_RUNTIME_TOKEN is not configured (required for control-plane → edge graph proxy).",
        )

    summary = vr.summary or {}
    linear_path = summary.get("linear_path")
    if not isinstance(linear_path, list):
        raise HTTPException(status_code=500, detail="Linear validation missing linear_path in summary")

    forward_payload: dict[str, Any] = {
        "graph": body.graph,
        "task": _resolved_task(body),
        "agent_context": body.agent_context.model_dump(exclude_none=True),
        "initial_state": dict(body.initial_state or {}),
        "validation": {
            "linear_path": linear_path,
            "graph_id": summary.get("graph_id"),
        },
    }

    headers = {"Authorization": f"Bearer {edge_token}", "Content-Type": "application/json"}
    url = f"{edge_base}/api/v1/graphs/linear-run"
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, json=forward_payload, headers=headers)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Edge graph proxy failed: {exc}") from exc

    if resp.status_code >= 400:
        detail: str | dict[str, Any]
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text[:2000] if resp.text else resp.reason_phrase
        raise HTTPException(status_code=resp.status_code, detail=detail)

    try:
        return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Edge returned non-JSON body: {exc}") from exc


@router.post("/dag-run")
async def dag_graph_run(
    body: GraphDagRunRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Validate a bounded DAG and forward deterministic execution to the edge worker."""
    try:
        vr = validate_bounded_dag_declarative_graph(
            body.graph,
            max_branching=body.max_branching,
            max_fanin=body.max_fanin,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Graph validation error: {exc}") from exc

    if not vr.valid:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Graph is not a valid bounded DAG",
                "errors": [e.to_dict() for e in vr.errors],
                "warnings": [w.to_dict() for w in vr.warnings],
            },
        )

    edge_base = (os.environ.get("EDGE_RUNTIME_URL", "") or "").strip().rstrip("/")
    edge_token = (os.environ.get("EDGE_RUNTIME_TOKEN", "") or "").strip()
    if not edge_base:
        raise HTTPException(
            status_code=503,
            detail=(
                "EDGE_RUNTIME_URL is not configured. "
                "Set it to your worker origin to proxy graph runs, "
                "or call worker POST /api/v1/graphs/dag-run directly."
            ),
        )
    if not edge_token:
        raise HTTPException(
            status_code=503,
            detail="EDGE_RUNTIME_TOKEN is not configured (required for control-plane → edge graph proxy).",
        )

    summary = vr.summary or {}
    execution_order = summary.get("execution_order")
    if not isinstance(execution_order, list):
        raise HTTPException(status_code=500, detail="DAG validation missing execution_order in summary")

    forward_payload: dict[str, Any] = {
        "graph": body.graph,
        "task": _resolved_task(body),
        "agent_context": body.agent_context.model_dump(exclude_none=True),
        "initial_state": dict(body.initial_state or {}),
        "max_branching": body.max_branching,
        "max_fanin": body.max_fanin,
        "validation": {
            "execution_order": execution_order,
            "graph_id": summary.get("graph_id"),
        },
    }

    headers = {"Authorization": f"Bearer {edge_token}", "Content-Type": "application/json"}
    url = f"{edge_base}/api/v1/graphs/dag-run"
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, json=forward_payload, headers=headers)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Edge graph proxy failed: {exc}") from exc

    if resp.status_code >= 400:
        detail: str | dict[str, Any]
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text[:2000] if resp.text else resp.reason_phrase
        raise HTTPException(status_code=resp.status_code, detail=detail)

    try:
        return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Edge returned non-JSON body: {exc}") from exc
