"""Eval router — run evaluations, view results."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.api.schemas import EvalRunResponse

router = APIRouter(prefix="/eval", tags=["eval"])


@router.get("/runs", response_model=list[EvalRunResponse])
async def list_eval_runs(agent_name: str = "", limit: int = 20):
    """List eval runs."""
    db = _get_db()
    sql = "SELECT * FROM eval_runs WHERE 1=1"
    params: list[Any] = []
    if agent_name:
        sql += " AND agent_name = ?"
        params.append(agent_name)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    rows = db.conn.execute(sql, params).fetchall()
    return [
        EvalRunResponse(
            run_id=r["id"], agent_name=r["agent_name"],
            pass_rate=r["pass_rate"], avg_score=r["avg_score"],
            avg_latency_ms=r["avg_latency_ms"],
            total_cost_usd=r["total_cost_usd"],
            total_tasks=r["total_tasks"], total_trials=r["total_trials"],
        )
        for r in rows
    ]


@router.get("/runs/{run_id}")
async def get_eval_run(run_id: int):
    """Get detailed eval run results."""
    db = _get_db()
    row = db.conn.execute("SELECT * FROM eval_runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Eval run not found")
    data = dict(row)
    try:
        data["eval_conditions"] = json.loads(data.get("eval_conditions_json", "{}"))
    except Exception:
        data["eval_conditions"] = {}
    try:
        data["trials"] = db.get_eval_trials(run_id)
    except Exception:
        data["trials"] = []
    return data


@router.get("/runs/{run_id}/trials")
async def list_eval_trials(run_id: int):
    """Get per-trial details (with session/trace linkage) for an eval run."""
    db = _get_db()
    row = db.conn.execute("SELECT id FROM eval_runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Eval run not found")
    try:
        trials = db.get_eval_trials(run_id)
    except Exception:
        trials = []
    return {"run_id": run_id, "trials": trials}


@router.post("/run")
async def run_eval(
    agent_name: str,
    eval_file: str,
    trials: int = 3,
    user: CurrentUser = Depends(get_current_user),
):
    """Run an evaluation from the API."""
    from agentos.agent import Agent
    from agentos.eval.gym import EvalGym, EvalTask
    from agentos.eval.grader import ContainsGrader, LLMGrader

    # Load agent
    try:
        agent = Agent.from_name(agent_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

    # Load eval tasks
    eval_path = Path(eval_file)
    if not eval_path.exists():
        raise HTTPException(status_code=404, detail=f"Eval file not found: {eval_file}")

    tasks_data = json.loads(eval_path.read_text())
    gym = EvalGym()
    gym.trials_per_task = trials

    for t in tasks_data:
        grader_type = t.get("grader", "contains")
        if grader_type == "llm":
            grader = LLMGrader(criteria=t.get("criteria", t.get("expected", "")))
        else:
            grader = ContainsGrader()
        gym.add_task(EvalTask(
            name=t.get("name", ""), input=t["input"],
            expected=t["expected"], grader=grader,
        ))

    # Run eval
    from agentos.eval.gym import AgentResult

    async def agent_fn(task_input: str) -> AgentResult:
        results = await agent.run(task_input)
        output = ""
        cost = 0.0
        total_tool_calls = 0
        stop_reason = ""
        for r in results:
            if r.llm_response:
                output = r.llm_response.content
                cost += r.cost_usd
            if r.tool_results:
                total_tool_calls += len(r.tool_results)
            if r.stop_reason:
                stop_reason = r.stop_reason
        session_id = ""
        trace_id = ""
        if getattr(agent, "_observer", None) and agent._observer.records:
            rec = agent._observer.records[-1]
            session_id = getattr(rec, "session_id", "")
            trace_id = getattr(rec, "trace_id", "")
        return AgentResult(
            output=output,
            cost_usd=cost,
            tool_calls_count=total_tool_calls,
            metadata={
                "session_id": session_id,
                "trace_id": trace_id,
                "stop_reason": stop_reason,
            },
        )

    report = await gym.run(agent_fn)
    report.agent_name = agent.config.name
    report.agent_version = agent.config.version
    report.model = agent.config.model
    eval_run_id = 0
    db = _get_db()
    try:
        eval_run_id = db.insert_eval_run(report.to_dict())
        trial_rows = []
        for tr in report.trial_results:
            meta = tr.metadata if isinstance(tr.metadata, dict) else {}
            trial_rows.append({
                "task_name": tr.task_name,
                "trial": tr.trial,
                "score": tr.grade.score,
                "passed": tr.grade.passed,
                "latency_ms": tr.latency_ms,
                "cost_usd": tr.cost_usd,
                "tool_calls_count": tr.tool_calls_count,
                "error": tr.error or "",
                "stop_reason": tr.stop_reason or str(meta.get("stop_reason", "")),
                "session_id": str(meta.get("session_id", "")),
                "trace_id": str(meta.get("trace_id", "")),
                "metadata": meta,
            })
        db.insert_eval_trials(eval_run_id, trial_rows)
    except Exception:
        # Backward compatibility: eval API should still return report even if persistence fails.
        eval_run_id = 0

    return {
        "run_id": eval_run_id,
        "pass_rate": report.pass_rate,
        "avg_score": report.avg_score,
        "avg_latency_ms": report.avg_latency_ms,
        "total_cost_usd": report.total_cost_usd,
        "total_tasks": report.total_tasks,
        "total_trials": report.total_trials,
        "pass_count": report.pass_count,
    }


@router.post("/tasks")
async def upload_eval_tasks(
    name: str,
    tasks: list[dict[str, Any]],
    user: CurrentUser = Depends(get_current_user),
):
    """Upload eval tasks as JSON."""
    eval_dir = Path.cwd() / "eval"
    eval_dir.mkdir(parents=True, exist_ok=True)
    path = eval_dir / f"{name}.json"
    path.write_text(json.dumps(tasks, indent=2) + "\n")
    return {"created": str(path), "task_count": len(tasks)}


@router.delete("/runs/{run_id}")
async def delete_eval_run(run_id: int, user: CurrentUser = Depends(get_current_user)):
    """Delete an eval run."""
    db = _get_db()
    db.conn.execute("DELETE FROM eval_runs WHERE id = ?", (run_id,))
    db.conn.commit()
    return {"deleted": run_id}


@router.get("/tasks")
async def list_eval_tasks():
    """List available eval task files."""
    eval_dir = Path.cwd() / "eval"
    if not eval_dir.exists():
        return {"tasks": []}
    files = sorted(eval_dir.glob("*.json"))
    tasks = []
    for f in files:
        try:
            data = json.loads(f.read_text())
            tasks.append({
                "file": str(f.relative_to(Path.cwd())),
                "name": f.stem,
                "task_count": len(data),
            })
        except Exception:
            continue
    return {"tasks": tasks}
