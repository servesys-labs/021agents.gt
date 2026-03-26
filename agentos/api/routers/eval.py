"""Eval router — control-plane evaluation, datasets, and experiments."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from agentos.api.deps import CurrentUser, _get_db, get_current_user
from agentos.api.schemas import EvalRunResponse

router = APIRouter(prefix="/eval", tags=["eval"])


class DatasetUpsertRequest(BaseModel):
    name: str = Field(..., min_length=1)
    items: list[dict[str, Any]] = Field(default_factory=list)


class EvaluatorUpsertRequest(BaseModel):
    name: str = Field(..., min_length=1)
    kind: str = Field(default="rule")
    config: dict[str, Any] = Field(default_factory=dict)


class ExperimentCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    agent_name: str = Field(..., min_length=1)
    dataset: str = Field(..., min_length=1)
    evaluator: str = Field(..., min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


def _datasets_dir() -> Path:
    d = Path.cwd() / "eval" / "datasets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _evaluators_path() -> Path:
    p = Path.cwd() / "data" / "eval_evaluators.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_text("[]\n")
    return p


def _experiments_path() -> Path:
    p = Path.cwd() / "data" / "eval_experiments.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_text("[]\n")
    return p


def _load_json_list(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text() or "[]")
        if isinstance(raw, list):
            return [r for r in raw if isinstance(r, dict)]
    except Exception:
        pass
    return []


def _save_json_list(path: Path, payload: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n")


def _resolve_eval_file_under_cwd(eval_file: str) -> Path:
    """Resolve eval_file to an absolute path confined under cwd (no path escape)."""
    cwd = Path.cwd().resolve()
    raw = Path(eval_file)
    candidate = (cwd / raw).resolve() if not raw.is_absolute() else raw.resolve()
    try:
        candidate.relative_to(cwd)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="eval_file must be under project root") from exc
    return candidate


def _load_tasks_from_eval_path(path: Path) -> list[dict[str, Any]]:
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail=f"Eval task file not found: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Cannot read eval file: {exc}") from exc
    ext = path.suffix.lower()
    rows: list[dict[str, Any]] = []
    if ext == ".jsonl":
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                rows.append(item)
    else:
        try:
            data = json.loads(text or "[]")
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON in eval file: {exc}") from exc
        if isinstance(data, list):
            rows = [r for r in data if isinstance(r, dict)]
        elif isinstance(data, dict):
            rows = [data]
    return rows


def _normalize_task_for_edge(row: dict[str, Any]) -> dict[str, str]:
    return {
        "name": str(row.get("name") or ""),
        "input": str(row.get("input") or ""),
        "expected": str(row.get("expected") or ""),
        "grader": str(row.get("grader") or "contains"),
    }


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
            run_id=r["id"],
            agent_name=r["agent_name"],
            pass_rate=r["pass_rate"],
            avg_score=r["avg_score"],
            avg_latency_ms=r["avg_latency_ms"],
            total_cost_usd=r["total_cost_usd"],
            total_tasks=r["total_tasks"],
            total_trials=r["total_trials"],
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
    """Run eval on edge: load tasks from ``eval_file`` on this host, then POST JSON to the worker."""
    del user
    edge_base = (os.environ.get("EDGE_RUNTIME_URL", "") or "").strip().rstrip("/")
    edge_token = (os.environ.get("EDGE_RUNTIME_TOKEN", "") or "").strip()
    if not edge_base:
        raise HTTPException(
            status_code=410,
            detail=(
                "Eval execution is edge-only. "
                "Set EDGE_RUNTIME_URL for control-plane proxying, "
                "or call worker `/api/v1/eval/run` directly."
            ),
        )
    headers: dict[str, str] = {}
    if edge_token:
        headers["Authorization"] = f"Bearer {edge_token}"
    eval_path = _resolve_eval_file_under_cwd(eval_file)
    raw_tasks = _load_tasks_from_eval_path(eval_path)
    if not raw_tasks:
        raise HTTPException(status_code=400, detail="Eval file contains no tasks")
    edge_tasks = [_normalize_task_for_edge(t) for t in raw_tasks]
    trials_clamped = max(1, min(int(trials), 20))
    eval_name = eval_path.stem or "eval"
    payload: dict[str, Any] = {
        "agent_name": agent_name,
        "eval_name": eval_name,
        "trials": trials_clamped,
        "tasks": edge_tasks,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{edge_base}/api/v1/eval/run",
                json=payload,
                headers=headers,
            )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
        return resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Edge eval proxy failed: {exc}")


@router.post("/tasks")
async def upload_eval_tasks(
    name: str,
    tasks: list[dict[str, Any]],
    user: CurrentUser = Depends(get_current_user),
):
    """Upload eval tasks as JSON."""
    del user
    eval_dir = Path.cwd() / "eval"
    eval_dir.mkdir(parents=True, exist_ok=True)
    path = eval_dir / f"{name}.json"
    path.write_text(json.dumps(tasks, indent=2) + "\n")
    return {"created": str(path), "task_count": len(tasks)}


@router.post("/tasks/upload")
async def upload_eval_tasks_files(
    files: list[UploadFile] = File(default_factory=list),
    user: CurrentUser = Depends(get_current_user),
):
    """Upload one or more eval task files (.json/.jsonl)."""
    del user
    eval_dir = Path.cwd() / "eval"
    eval_dir.mkdir(parents=True, exist_ok=True)
    uploaded: list[dict[str, Any]] = []
    for f in files:
        name = Path(f.filename or "").name
        if not name:
            continue
        ext = Path(name).suffix.lower()
        if ext not in {".json", ".jsonl"}:
            continue
        content = (await f.read()).decode("utf-8", errors="replace")
        target = eval_dir / name
        target.write_text(content)
        task_count = 0
        try:
            if ext == ".json":
                parsed = json.loads(content)
                task_count = len(parsed) if isinstance(parsed, list) else 1
            else:
                task_count = len([ln for ln in content.splitlines() if ln.strip()])
        except Exception:
            pass
        uploaded.append(
            {"file": str(target.relative_to(Path.cwd())), "name": target.stem, "task_count": task_count}
        )
    return {"uploaded": uploaded, "count": len(uploaded)}


@router.delete("/runs/{run_id}")
async def delete_eval_run(run_id: int, user: CurrentUser = Depends(get_current_user)):
    """Delete an eval run."""
    del user
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
    files = sorted(list(eval_dir.glob("*.json")) + list(eval_dir.glob("*.jsonl")))
    tasks = []
    for f in files:
        try:
            text = f.read_text()
            if f.suffix.lower() == ".jsonl":
                count = len([ln for ln in text.splitlines() if ln.strip()])
            else:
                data = json.loads(text)
                count = len(data) if isinstance(data, list) else 1
            tasks.append({"file": str(f.relative_to(Path.cwd())), "name": f.stem, "task_count": count})
        except Exception:
            continue
    return {"tasks": tasks}


@router.get("/datasets")
async def list_datasets():
    datasets = []
    for f in sorted(_datasets_dir().glob("*.json")):
        try:
            parsed = json.loads(f.read_text())
            count = len(parsed) if isinstance(parsed, list) else 1
        except Exception:
            count = 0
        datasets.append({"name": f.stem, "file": str(f.relative_to(Path.cwd())), "items": count})
    return {"datasets": datasets}


@router.post("/datasets")
async def upsert_dataset(
    request: DatasetUpsertRequest,
    user: CurrentUser = Depends(get_current_user),
):
    del user
    path = _datasets_dir() / f"{request.name}.json"
    path.write_text(json.dumps(request.items, indent=2) + "\n")
    return {"saved": request.name, "items": len(request.items), "file": str(path.relative_to(Path.cwd()))}


@router.get("/datasets/{name}")
async def get_dataset(name: str):
    path = _datasets_dir() / f"{name}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Dataset not found")
    return {"name": name, "items": json.loads(path.read_text() or "[]")}


@router.delete("/datasets/{name}")
async def delete_dataset(name: str, user: CurrentUser = Depends(get_current_user)):
    del user
    path = _datasets_dir() / f"{name}.json"
    if path.exists():
        path.unlink()
    return {"deleted": name}


@router.get("/evaluators")
async def list_evaluators():
    return {"evaluators": _load_json_list(_evaluators_path())}


@router.post("/evaluators")
async def upsert_evaluator(
    request: EvaluatorUpsertRequest,
    user: CurrentUser = Depends(get_current_user),
):
    del user
    payload = _load_json_list(_evaluators_path())
    payload = [p for p in payload if p.get("name") != request.name]
    payload.append({"name": request.name, "kind": request.kind, "config": request.config})
    _save_json_list(_evaluators_path(), payload)
    return {"saved": request.name}


@router.delete("/evaluators/{name}")
async def delete_evaluator(name: str, user: CurrentUser = Depends(get_current_user)):
    del user
    payload = _load_json_list(_evaluators_path())
    payload = [p for p in payload if p.get("name") != name]
    _save_json_list(_evaluators_path(), payload)
    return {"deleted": name}


@router.get("/experiments")
async def list_experiments():
    return {"experiments": _load_json_list(_experiments_path())}


@router.post("/experiments")
async def create_experiment(
    request: ExperimentCreateRequest,
    user: CurrentUser = Depends(get_current_user),
):
    del user
    payload = _load_json_list(_experiments_path())
    experiment_id = f"exp_{len(payload) + 1}"
    item = {
        "experiment_id": experiment_id,
        "name": request.name,
        "agent_name": request.agent_name,
        "dataset": request.dataset,
        "evaluator": request.evaluator,
        "metadata": request.metadata,
        "status": "created",
    }
    payload.append(item)
    _save_json_list(_experiments_path(), payload)
    return item
