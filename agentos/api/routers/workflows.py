"""Workflows router — multi-agent DAG pipelines."""

from __future__ import annotations

import json
import uuid
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/workflows", tags=["workflows"])


class CreateWorkflowRequest(BaseModel):
    name: str
    description: str = ""
    steps: list[dict] = Field(default_factory=list)


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
        normalized.append({
            "id": step_id,
            "type": node_type,
            "agent": step.get("agent", ""),
            "task": step.get("task", ""),
            "depends_on": step.get("depends_on", []),
            "branches": step.get("branches", []),
            "config": step.get("config", {}),
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
async def run_workflow(workflow_id: str, input_text: str = "", user: CurrentUser = Depends(get_current_user)):
    """Execute a workflow — runs each step in order, passing outputs between agents."""
    from agentos.agent import Agent
    import time

    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM workflows WHERE workflow_id = ? AND org_id = ?",
        (workflow_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Workflow not found")

    workflow = dict(row)
    steps = json.loads(workflow.get("steps_json", "[]"))

    run_id = uuid.uuid4().hex[:16]
    trace_id = uuid.uuid4().hex[:16]
    db.conn.execute(
        "INSERT INTO workflow_runs (run_id, workflow_id, trace_id) VALUES (?, ?, ?)",
        (run_id, workflow_id, trace_id),
    )
    db.conn.commit()

    step_outputs: dict[str, str] = {"input": input_text}
    step_status: dict[str, str] = {}
    total_cost = 0.0

    async def _run_llm_step(step: dict, resolved_task: str) -> tuple[str, float]:
        agent_name = step.get("agent", "")
        agent = Agent.from_name(agent_name)
        agent._harness.trace_id = trace_id
        results = await agent.run(resolved_task)
        output = ""
        step_cost = 0.0
        for r in results:
            if r.llm_response and r.llm_response.content:
                output = r.llm_response.content
            step_cost += r.cost_usd
        return output, step_cost

    for step in steps:
        step_id = step.get("id", step.get("agent", ""))
        step_type = step.get("type", "llm")
        task_template = step.get("task", "")

        # Resolve template variables
        task = task_template
        for key, val in step_outputs.items():
            task = task.replace(f"{{{{{key}.output}}}}", val).replace(f"{{{{{key}}}}}", val)

        try:
            if step_type == "parallel":
                branches = step.get("branches", [])
                normalized_branches = _normalize_steps(branches)
                async_calls = []
                branch_ids: list[str] = []
                for branch in normalized_branches:
                    if branch.get("type") != "llm":
                        continue
                    branch_task = branch.get("task", "")
                    for key, val in step_outputs.items():
                        branch_task = branch_task.replace(f"{{{{{key}.output}}}}", val).replace(f"{{{{{key}}}}}", val)
                    async_calls.append(_run_llm_step(branch, branch_task))
                    branch_ids.append(branch.get("id", "branch"))
                branch_results = await asyncio.gather(*async_calls)
                merged = []
                for bid, (output, cost) in zip(branch_ids, branch_results):
                    merged.append(f"[{bid}] {output}".strip())
                    step_outputs[bid] = output
                    total_cost += cost
                step_outputs[step_id] = "\n\n".join(merged).strip()
            elif step_type == "reflect":
                prior = step_outputs.get(step.get("config", {}).get("target", ""), "")
                if not prior:
                    prior = step_outputs.get("input", "")
                reflection = {
                    "summary": prior[:500],
                    "issues": [] if prior else ["No prior output to reflect on"],
                    "confidence": 0.75 if prior else 0.2,
                    "next_action": "continue" if prior else "recover",
                }
                step_outputs[step_id] = json.dumps(reflection)
            else:
                output, step_cost = await _run_llm_step(step, task)
                total_cost += step_cost
                step_outputs[step_id] = output
            step_status[step_id] = "completed"

        except Exception as exc:
            step_status[step_id] = f"failed: {exc}"
            db.conn.execute(
                "UPDATE workflow_runs SET status = 'failed', steps_status_json = ?, total_cost_usd = ?, completed_at = ? WHERE run_id = ?",
                (json.dumps(step_status), total_cost, time.time(), run_id),
            )
            db.conn.commit()
            return {"run_id": run_id, "status": "failed", "failed_step": step_id, "error": str(exc), "step_outputs": step_outputs}

    # All steps completed
    db.conn.execute(
        "UPDATE workflow_runs SET status = 'completed', steps_status_json = ?, total_cost_usd = ?, completed_at = ? WHERE run_id = ?",
        (json.dumps(step_status), total_cost, time.time(), run_id),
    )
    db.conn.commit()

    return {
        "run_id": run_id,
        "status": "completed",
        "trace_id": trace_id,
        "total_cost_usd": total_cost,
        "steps": step_status,
        "final_output": (
            step_outputs.get(steps[-1].get("id", ""), "")
            if steps
            else step_outputs.get("input", "")
        ),
    }


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
    return {"runs": [dict(r) for r in rows]}


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
    result = dict(row)
    result["steps"] = json.loads(result.pop("steps_status_json", "{}"))
    return result


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
    import time
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
        if step_type and step_type not in {"llm", "task", "parallel", "reflect"}:
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
    db.conn.execute("DELETE FROM workflows WHERE workflow_id = ? AND org_id = ?", (workflow_id, user.org_id))
    db.conn.commit()
    return {"deleted": workflow_id}
