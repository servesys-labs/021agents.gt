"""Graph definition dev tooling — compile/validate declarative graphs."""

from __future__ import annotations

import os
from copy import deepcopy
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from agentos.api.deps import CurrentUser, _get_db, get_current_user
from agentos.graph.declarative_linear import (
    validate_bounded_dag_declarative_graph,
    validate_linear_declarative_graph,
)
from agentos.graph.design_lint import lint_graph_design
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


def _node_id_from_issue(issue: dict[str, Any]) -> str:
    details = issue.get("details")
    if isinstance(details, dict):
        nid = details.get("node_id")
        if isinstance(nid, str) and nid.strip():
            return nid.strip()
    path = issue.get("path")
    if isinstance(path, str) and path.startswith("nodes[") and path.endswith("]"):
        return path[len("nodes[") : -1]
    return ""


def _autofix_graph_common_issues(
    graph: dict[str, Any],
    issues: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    fixed = deepcopy(graph)
    nodes_raw = fixed.get("nodes")
    edges_raw = fixed.get("edges")
    if not isinstance(nodes_raw, list) or not isinstance(edges_raw, list):
        return fixed, []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    for node in nodes_raw:
        if isinstance(node, dict) and isinstance(node.get("id"), str):
            nid = node["id"].strip()
            if nid:
                nodes_by_id[nid] = node
    applied: list[dict[str, Any]] = []
    for issue in issues:
        code = str(issue.get("code", "")).strip()
        if code == "ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY":
            nid = _node_id_from_issue(issue)
            node = nodes_by_id.get(nid)
            if isinstance(node, dict):
                node["idempotency_key"] = (
                    node.get("idempotency_key")
                    or f"session:${{session_id}}:turn:${{turn}}:{nid or 'side_effect'}"
                )
                applied.append({"code": code, "node_id": nid, "action": "set_idempotency_key"})
        elif code == "BACKGROUND_ON_CRITICAL_PATH":
            nid = _node_id_from_issue(issue)
            before = len(edges_raw)
            edges_raw[:] = [
                e
                for e in edges_raw
                if not (
                    isinstance(e, dict)
                    and isinstance(e.get("source", e.get("from")), str)
                    and e.get("source", e.get("from")).strip() == nid
                )
            ]
            if len(edges_raw) != before:
                applied.append({"code": code, "node_id": nid, "action": "remove_outgoing_edges"})
        elif code == "FANIN_FROM_ASYNC_BRANCH":
            details = issue.get("details")
            async_preds = []
            if isinstance(details, dict):
                raw_preds = details.get("async_predecessors")
                if isinstance(raw_preds, list):
                    async_preds = [str(p).strip() for p in raw_preds if isinstance(p, str) and p.strip()]
            changed = []
            for pred in async_preds:
                node = nodes_by_id.get(pred)
                if isinstance(node, dict):
                    node["async"] = False
                    changed.append(pred)
            if changed:
                applied.append({"code": code, "node_ids": changed, "action": "set_async_false"})
    return fixed, applied


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
    before = lint_graph_design(body.graph, strict=body.strict)
    before_payload = {
        "valid": before.valid,
        "errors": [e.to_dict() for e in before.errors],
        "warnings": [w.to_dict() for w in before.warnings],
        "summary": before.summary,
    }
    if not body.apply or before.valid:
        return {
            "autofix_applied": False,
            "applied_fixes": [],
            "lint_before": before_payload,
            "graph": body.graph,
            "lint_after": before_payload,
        }
    fixed_graph, applied = _autofix_graph_common_issues(body.graph, before_payload["errors"])
    after = lint_graph_design(fixed_graph, strict=body.strict)
    return {
        "autofix_applied": len(applied) > 0,
        "applied_fixes": applied,
        "lint_before": before_payload,
        "graph": fixed_graph,
        "lint_after": {
            "valid": after.valid,
            "errors": [e.to_dict() for e in after.errors],
            "warnings": [w.to_dict() for w in after.warnings],
            "summary": after.summary,
        },
    }


@router.post("/gate-pack")
async def graph_gate_pack(
    body: GraphGatePackRequest,
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Run no-code gate pack: lint + eval posture + rollout recommendation."""
    graph = body.graph if isinstance(body.graph, dict) else _load_agent_graph(body.agent_name)
    if not isinstance(graph, dict):
        raise HTTPException(
            status_code=404,
            detail="No declarative graph found for agent (provide graph or store harness.declarative_graph).",
        )
    lint_result = lint_graph_design(graph, strict=body.strict_graph_lint)
    lint_payload = {
        "valid": lint_result.valid,
        "errors": [e.to_dict() for e in lint_result.errors],
        "warnings": [w.to_dict() for w in lint_result.warnings],
        "summary": lint_result.summary,
    }
    db = _get_db()
    row = db.conn.execute(
        "SELECT id, pass_rate, total_trials, total_tasks, created_at FROM eval_runs WHERE agent_name = ? ORDER BY created_at DESC LIMIT 1",
        (body.agent_name,),
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
