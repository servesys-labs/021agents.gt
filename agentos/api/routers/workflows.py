"""Workflows router — multi-agent DAG pipelines."""

from __future__ import annotations

import json
import logging
import uuid
import asyncio
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.core.runtime_dag import (
    JoinStrategy,
    NodePolicy,
    NodeResult,
    NodeSpec,
    NodeType,
    RuntimeDAGRunner,
    reduce_join_outputs,
)

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
    """Execute a workflow with typed DAG runner and node policies."""
    from agentos.agent import Agent

    input_text = request.input_text if request else ""
    requested_runtime_mode = request.runtime_mode if request else None

    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM workflows WHERE workflow_id = ? AND org_id = ?",
        (workflow_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Workflow not found")

    workflow = dict(row)
    steps = _normalize_steps(json.loads(workflow.get("steps_json", "[]")))

    run_id = uuid.uuid4().hex[:16]
    trace_id = uuid.uuid4().hex[:16]
    db.conn.execute(
        "INSERT INTO workflow_runs (run_id, workflow_id, trace_id, dag_json, reflection_json) VALUES (?, ?, ?, ?, ?)",
        (run_id, workflow_id, trace_id, "{}", "{}"),
    )
    db.conn.commit()

    step_outputs: dict[str, Any] = {"input": input_text}

    async def _run_llm_step(step: dict, resolved_task: str) -> tuple[str, float]:
        agent_name = step.get("agent", "")
        if not agent_name:
            raise ValueError(f"Step '{step.get('id', '?')}' missing agent")
        agent = Agent.from_name(agent_name)
        if requested_runtime_mode == "graph":
            harness_cfg = agent.config.harness if isinstance(agent.config.harness, dict) else {}
            harness_cfg["runtime_mode"] = requested_runtime_mode
            agent.config.harness = harness_cfg
        agent._harness.trace_id = trace_id
        results = await agent.run(resolved_task)
        output = ""
        step_cost = 0.0
        for r in results:
            if r.llm_response and r.llm_response.content:
                output = r.llm_response.content
            step_cost += r.cost_usd
        return output, step_cost

    def _resolve_template(text: str, prior_results: dict[str, NodeResult]) -> str:
        rendered = text
        for key, value in step_outputs.items():
            rendered = rendered.replace(f"{{{{{key}.output}}}}", str(value)).replace(f"{{{{{key}}}}}", str(value))
        for key, result in prior_results.items():
            rendered = rendered.replace(f"{{{{{key}.output}}}}", str(result.output)).replace(f"{{{{{key}}}}}", str(result.output))
        return rendered

    specs: list[NodeSpec] = []
    if not steps:
        steps = [{
            "id": "finalize_input",
            "type": "finalize",
            "depends_on": [],
            "config": {"target": "input"},
            "retries": 0,
            "timeout_ms": 30000,
            "budget_usd": 0.0,
        }]
    for step in steps:
        step_type = step.get("type", "llm")
        try:
            node_type = NodeType(step_type)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unsupported node type '{step_type}'")
        specs.append(
            NodeSpec(
                node_id=step.get("id", ""),
                node_type=node_type,
                depends_on=list(step.get("depends_on", [])),
                policy=NodePolicy(
                    retries=int(step.get("retries", 0) or 0),
                    timeout_ms=int(step.get("timeout_ms", 30000) or 30000),
                    budget_usd=float(step.get("budget_usd", 0) or 0),
                ),
                config=step,
            )
        )

    async def _execute_node(spec: NodeSpec, prior_results: dict[str, NodeResult]) -> NodeResult:
        node = spec.config
        node_type = spec.node_type
        node_id = spec.node_id
        if node_type == NodeType.PLAN:
            output = {
                "goal": input_text[:400],
                "node_id": node_id,
                "depends_on": spec.depends_on,
                "strategy": node.get("config", {}).get("strategy", "direct"),
            }
            step_outputs[node_id] = output
            return NodeResult(node_id=node_id, status="completed", output=output)

        if node_type in (NodeType.LLM, NodeType.TOOL):
            task = _resolve_template(node.get("task", ""), prior_results)
            output, cost = await _run_llm_step(node, task)
            step_outputs[node_id] = output
            return NodeResult(node_id=node_id, status="completed", output=output, cost_usd=cost)

        if node_type == NodeType.PARALLEL_GROUP:
            branches = _normalize_steps(node.get("branches", []))
            async_calls = []
            branch_ids: list[str] = []
            for branch in branches:
                if branch.get("type") not in {"llm", "tool"}:
                    continue
                branch_task = _resolve_template(branch.get("task", ""), prior_results)
                async_calls.append(_run_llm_step(branch, branch_task))
                branch_ids.append(branch.get("id", "branch"))
            branch_results = await asyncio.gather(*async_calls)
            outputs: list[str] = []
            total_cost = 0.0
            for branch_id, (branch_output, branch_cost) in zip(branch_ids, branch_results):
                step_outputs[branch_id] = branch_output
                outputs.append(branch_output)
                total_cost += branch_cost
            step_outputs[node_id] = outputs
            return NodeResult(
                node_id=node_id,
                status="completed",
                output=outputs,
                cost_usd=total_cost,
                metadata={"branch_ids": branch_ids},
            )

        if node_type == NodeType.JOIN:
            dep_outputs = [prior_results[d].output for d in spec.depends_on if d in prior_results]
            strategy_raw = str(node.get("config", {}).get("strategy", "merge"))
            try:
                strategy = JoinStrategy(strategy_raw)
            except ValueError:
                strategy = JoinStrategy.MERGE
            reduced = reduce_join_outputs(strategy, dep_outputs)
            step_outputs[node_id] = reduced
            return NodeResult(
                node_id=node_id,
                status="completed",
                output=reduced,
                metadata={"strategy": strategy.value, "input_count": len(dep_outputs)},
            )

        if node_type == NodeType.REFLECT:
            target = node.get("config", {}).get("target", "")
            prior = ""
            if target and target in prior_results:
                prior = str(prior_results[target].output)
            if not prior and spec.depends_on:
                first_dep = spec.depends_on[-1]
                prior = str(prior_results.get(first_dep, NodeResult(node_id=first_dep, status="missing")).output or "")
            if not prior:
                prior = str(step_outputs.get("input", ""))
            issues = [] if prior else ["No prior output to reflect on"]
            confidence = 0.75 if prior else 0.2
            action = "continue" if confidence >= 0.6 else "revise"
            reflection = {
                "summary": prior[:500],
                "issues": issues,
                "confidence": confidence,
                "action": action,
            }
            step_outputs[node_id] = reflection
            return NodeResult(node_id=node_id, status="completed", output=reflection)

        if node_type == NodeType.VERIFY:
            dep = spec.depends_on[-1] if spec.depends_on else ""
            output = str(prior_results.get(dep, NodeResult(node_id=dep, status="missing")).output or "")
            verdict = {
                "passed": bool(output.strip()),
                "reason": "non_empty_output" if output.strip() else "empty_output",
            }
            step_outputs[node_id] = verdict
            return NodeResult(node_id=node_id, status="completed", output=verdict)

        if node_type == NodeType.FINALIZE:
            target = node.get("config", {}).get("target", "")
            if target and target in prior_results:
                final = prior_results[target].output
            elif spec.depends_on:
                final = prior_results[spec.depends_on[-1]].output
            else:
                final = step_outputs.get("input", "")
            step_outputs[node_id] = final
            return NodeResult(node_id=node_id, status="completed", output=final)

        return NodeResult(node_id=node_id, status="skipped", output="")

    runner = RuntimeDAGRunner(max_parallel=8)
    try:
        dag_results = await runner.run(
            nodes=specs,
            execute_node=_execute_node,
            total_budget_usd=0.0,
        )
    except Exception as exc:
        logger.exception("Workflow run %s failed: %s", run_id, exc)
        db.conn.execute(
            "UPDATE workflow_runs SET status = 'failed', steps_status_json = ?, dag_json = ?, reflection_json = ?, total_cost_usd = ?, completed_at = ? WHERE run_id = ?",
            (json.dumps({"error": "internal_error"}), "{}", "{}", 0.0, time.time(), run_id),
        )
        db.conn.commit()
        return {
            "run_id": run_id,
            "status": "failed",
            "trace_id": trace_id,
            "error": "An internal error occurred while executing the workflow.",
        }

    step_status = {node_id: result.status for node_id, result in dag_results.items()}
    total_cost = sum(float(r.cost_usd) for r in dag_results.values())
    final_output = ""
    if specs:
        last_id = specs[-1].node_id
        final_output = str(dag_results.get(last_id, NodeResult(node_id=last_id, status="missing")).output or "")
    dag_artifact = {
        "nodes": [
            {
                "id": spec.node_id,
                "type": spec.node_type.value,
                "depends_on": spec.depends_on,
                "policy": {
                    "retries": spec.policy.retries,
                    "timeout_ms": spec.policy.timeout_ms,
                    "budget_usd": spec.policy.budget_usd,
                },
            }
            for spec in specs
        ],
        "results": {
            node_id: {
                "status": result.status,
                "cost_usd": result.cost_usd,
                "attempts": result.attempts,
                "metadata": result.metadata,
            }
            for node_id, result in dag_results.items()
        },
    }
    reflection_nodes = {
        node_id: result.output
        for node_id, result in dag_results.items()
        if isinstance(result.output, dict)
        and {"confidence", "action"}.issubset(set(result.output.keys()))
    }
    reflection_artifact = {
        "node_count": len(reflection_nodes),
        "nodes": reflection_nodes,
    }
    run_metadata = _derive_run_metadata(dag_artifact, reflection_artifact)

    db.conn.execute(
        "UPDATE workflow_runs SET status = 'completed', steps_status_json = ?, dag_json = ?, reflection_json = ?, total_cost_usd = ?, completed_at = ? WHERE run_id = ?",
        (
            json.dumps(step_status),
            json.dumps(dag_artifact),
            json.dumps(reflection_artifact),
            total_cost,
            time.time(),
            run_id,
        ),
    )
    db.conn.commit()

    return {
        "run_id": run_id,
        "status": "completed",
        "trace_id": trace_id,
        "total_cost_usd": total_cost,
        "steps": step_status,
        "final_output": final_output,
        "dag": dag_artifact,
        "reflection": reflection_artifact,
        "run_metadata": run_metadata,
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
