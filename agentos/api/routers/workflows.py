"""Workflows router — multi-agent DAG pipelines."""

from __future__ import annotations

import json
import logging
import uuid
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/workflows", tags=["workflows"])

# Module-level dict of cancel tokens. The run loop should check
# `_cancel_tokens.get(run_id)` periodically and abort if True.
# NOTE: This only works within a single process. For multi-process
# deployments, a shared store (e.g., Redis, DB polling) is needed.
_cancel_tokens: dict[str, bool] = {}


class CreateWorkflowRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = ""
    steps: list[dict] = Field(default_factory=list, max_length=50)


class RunWorkflowRequest(BaseModel):
    input_text: str = ""
    runtime_mode: Literal["graph"] | None = None


def _derive_run_metadata(
    dag: dict[str, Any],
    reflection: dict[str, Any],
) -> dict[str, Any]:
    nodes = dag.get("nodes", []) if isinstance(dag, dict) else []
    results = dag.get("results", {}) if isinstance(dag, dict) else {}
    node_types = [str(n.get("type", "")) for n in nodes if isinstance(n, dict)]
    execution_mode = "parallel" if "parallel_group" in node_types else "sequential"
    reducer_strategies: list[str] = []
    if isinstance(results, dict):
        for result in results.values():
            if not isinstance(result, dict):
                continue
            metadata = result.get("metadata", {})
            if isinstance(metadata, dict):
                strategy = metadata.get("strategy")
                if strategy:
                    reducer_strategies.append(str(strategy))
    unique_strategies = sorted(set(reducer_strategies))
    reflection_nodes = reflection.get("nodes", {}) if isinstance(reflection, dict) else {}
    confidences: list[float] = []
    revise_count = 0
    continue_count = 0
    if isinstance(reflection_nodes, dict):
        for node in reflection_nodes.values():
            if not isinstance(node, dict):
                continue
            conf = node.get("confidence")
            if isinstance(conf, (float, int)):
                confidences.append(float(conf))
            action = str(node.get("action", ""))
            if action == "revise":
                revise_count += 1
            elif action == "continue":
                continue_count += 1
    avg_confidence = round(sum(confidences) / len(confidences), 4) if confidences else 0.0
    return {
        "execution_mode": execution_mode,
        "reducer_strategies": unique_strategies,
        "reflection_rollup": {
            "avg_confidence": avg_confidence,
            "revise_count": revise_count,
            "continue_count": continue_count,
            "node_count": len(reflection_nodes) if isinstance(reflection_nodes, dict) else 0,
        },
    }


def _decode_run_row(row: dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    try:
        item["steps"] = json.loads(item.pop("steps_status_json", "{}"))
    except Exception:
        item["steps"] = {}
    try:
        item["dag"] = json.loads(item.pop("dag_json", "{}"))
    except Exception:
        item["dag"] = {}
    try:
        item["reflection"] = json.loads(item.pop("reflection_json", "{}"))
    except Exception:
        item["reflection"] = {}
    item["run_metadata"] = _derive_run_metadata(
        item.get("dag", {}),
        item.get("reflection", {}),
    )
    return item


def _normalize_steps(steps: list[dict]) -> list[dict]:
    """Normalize legacy workflow steps into typed nodes."""
    normalized: list[dict] = []
    for idx, raw in enumerate(steps):
        step = dict(raw)
        step_id = step.get("id") or step.get("agent") or f"step_{idx + 1}"
        node_type = step.get("type")
        if not node_type:
            # Backward compatibility: agent/task step becomes llm node.
            node_type = "llm" if step.get("agent") else "task"
        if node_type == "parallel":
            node_type = "parallel_group"
        if node_type == "task":
            node_type = "llm"
        retries = min(10, max(0, int(step.get("retries", 0) or 0)))
        budget_usd = max(0.0, float(step.get("budget_usd", 0) or 0))
        normalized.append({
            "id": step_id,
            "type": node_type,
            "agent": step.get("agent", ""),
            "task": step.get("task", ""),
            "depends_on": step.get("depends_on", []),
            "branches": step.get("branches", []),
            "config": step.get("config", {}),
            "retries": retries,
            "timeout_ms": int(step.get("timeout_ms", 30000) or 30000),
            "budget_usd": budget_usd,
        })
    return normalized


@router.get("")
async def list_workflows(user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM workflows WHERE org_id = ? ORDER BY created_at DESC", (user.org_id,)
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["steps"] = json.loads(d.pop("steps_json", "[]"))
        result.append(d)
    return {"workflows": result}


@router.post("")
async def create_workflow(
    request: CreateWorkflowRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Create a multi-agent workflow.

    Steps format:
    [
        {"agent": "researcher", "task": "Find info about {{input}}", "id": "step1"},
        {"agent": "writer", "task": "Write report using {{step1.output}}", "id": "step2", "depends_on": ["step1"]},
    ]
    """
    db = _get_db()
    workflow_id = uuid.uuid4().hex[:16]
    normalized_steps = _normalize_steps(request.steps)
    db.conn.execute(
        "INSERT INTO workflows (workflow_id, org_id, name, description, steps_json) VALUES (?, ?, ?, ?, ?)",
        (workflow_id, user.org_id, request.name, request.description, json.dumps(normalized_steps)),
    )
    db.conn.commit()
    return {"workflow_id": workflow_id, "name": request.name, "steps": len(normalized_steps)}


@router.post("/{workflow_id}/run")
async def run_workflow(workflow_id: str, request: RunWorkflowRequest | None = None, user: CurrentUser = Depends(get_current_user)):
    """Workflow runtime execution is edge-only."""
    raise HTTPException(
        status_code=410,
        detail=(
            "Workflow runtime execution is edge-only. "
            "Dispatch workflow execution to worker runtime endpoints."
        ),
    )


@router.get("/{workflow_id}/runs")
async def list_workflow_runs(
    workflow_id: str,
    limit: int = 20,
    user: CurrentUser = Depends(get_current_user),
):
    db = _get_db()
    wf = db.conn.execute(
        "SELECT workflow_id FROM workflows WHERE workflow_id = ? AND org_id = ?",
        (workflow_id, user.org_id),
    ).fetchone()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    rows = db.conn.execute(
        "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?",
        (workflow_id, limit),
    ).fetchall()
    runs = [_decode_run_row(dict(row)) for row in rows]
    return {"runs": runs}


@router.get("/{workflow_id}/runs/{run_id}")
async def get_workflow_run(
    workflow_id: str,
    run_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get run detail with step-level status."""
    db = _get_db()
    wf = db.conn.execute(
        "SELECT workflow_id FROM workflows WHERE workflow_id = ? AND org_id = ?",
        (workflow_id, user.org_id),
    ).fetchone()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    row = db.conn.execute(
        "SELECT * FROM workflow_runs WHERE run_id = ? AND workflow_id = ?",
        (run_id, workflow_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    return _decode_run_row(dict(row))


@router.post("/{workflow_id}/runs/{run_id}/cancel")
async def cancel_workflow_run(
    workflow_id: str,
    run_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Cancel a running workflow."""
    db = _get_db()
    wf = db.conn.execute(
        "SELECT workflow_id FROM workflows WHERE workflow_id = ? AND org_id = ?",
        (workflow_id, user.org_id),
    ).fetchone()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    row = db.conn.execute(
        "SELECT status FROM workflow_runs WHERE run_id = ? AND workflow_id = ?",
        (run_id, workflow_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Workflow run not found")
    if row["status"] not in ("running", "pending"):
        raise HTTPException(status_code=409, detail=f"Cannot cancel run with status '{row['status']}'")
    # Signal the run loop to stop (best-effort, single-process only).
    _cancel_tokens[run_id] = True
    db.conn.execute(
        "UPDATE workflow_runs SET status = 'cancelled', completed_at = ? WHERE run_id = ?",
        (time.time(), run_id),
    )
    db.conn.commit()
    return {"cancelled": run_id}


@router.post("/validate")
async def validate_workflow(
    request: CreateWorkflowRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Validate a workflow DAG — check agent references and circular dependencies."""
    from agentos.agent import list_agents as _list_agents

    errors: list[str] = []
    steps = request.steps

    # Build lookup of step IDs
    step_ids = set()
    for step in steps:
        step_id = step.get("id", "")
        if not step_id:
            errors.append("Every step must have an 'id' field")
            continue
        if step_id in step_ids:
            errors.append(f"Duplicate step id: '{step_id}'")
        step_ids.add(step_id)

    # Check agent references exist
    available_agents = {a.name for a in _list_agents()}
    for step in steps:
        agent_name = step.get("agent", "")
        if agent_name and agent_name not in available_agents:
            errors.append(f"Step '{step.get('id', '?')}' references unknown agent '{agent_name}'")

    # Check depends_on references and detect circular dependencies
    graph: dict[str, list[str]] = {}
    for step in steps:
        step_id = step.get("id", "")
        step_type = step.get("type", "")
        if step_type and step_type not in {
            "llm",
            "tool",
            "task",
            "parallel",
            "parallel_group",
            "join",
            "reflect",
            "verify",
            "finalize",
            "plan",
        }:
            errors.append(f"Step '{step_id}' has unsupported type '{step_type}'")
        deps = step.get("depends_on", [])
        graph[step_id] = deps
        for dep in deps:
            if dep not in step_ids:
                errors.append(f"Step '{step_id}' depends on unknown step '{dep}'")

    # Topological sort to detect cycles
    visited: set[str] = set()
    in_stack: set[str] = set()

    def _has_cycle(node: str) -> bool:
        if node in in_stack:
            return True
        if node in visited:
            return False
        visited.add(node)
        in_stack.add(node)
        for dep in graph.get(node, []):
            if _has_cycle(dep):
                return True
        in_stack.discard(node)
        return False

    for step_id in step_ids:
        if _has_cycle(step_id):
            errors.append("Circular dependency detected in workflow DAG")
            break

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "step_count": len(steps),
    }


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    result = db.conn.execute("DELETE FROM workflows WHERE workflow_id = ? AND org_id = ?", (workflow_id, user.org_id))
    db.conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {"deleted": workflow_id}
