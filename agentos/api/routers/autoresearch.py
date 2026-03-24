"""Autoresearch router — start, stop, monitor autonomous training research."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/autoresearch", tags=["autoresearch"])

# In-memory tracking of running autoresearch sessions
_active_drivers: dict[str, Any] = {}
_active_tasks: dict[str, asyncio.Task] = {}


class AutoResearchStartRequest(BaseModel):
    workspace: str = "."
    model: str = "claude-sonnet-4-6-20250627"
    provider: str = "anthropic"
    max_iterations: int = 0
    time_budget: int = 300
    temperature: float = 0.7
    train_command: str = "uv run train.py"
    git_branch: str = ""
    no_git: bool = False


class AutoResearchStatusResponse(BaseModel):
    running: bool
    workspace: str
    iteration: int = 0
    best_bpb: float | None = None
    total_experiments: int = 0
    kept: int = 0
    discarded: int = 0
    crashed: int = 0


class ExperimentRecordResponse(BaseModel):
    commit: str
    val_bpb: float
    memory_gb: float
    status: str
    description: str


@router.post("/start")
async def start_autoresearch(req: AutoResearchStartRequest) -> dict[str, str]:
    """Start an autonomous research loop."""
    from agentos.autoresearch.driver import (
        AutoResearchDriver,
        DriverConfig,
        LLMProposer,
    )

    workspace = Path(req.workspace).resolve()
    ws_key = str(workspace)

    if ws_key in _active_tasks and not _active_tasks[ws_key].done():
        raise HTTPException(status_code=409, detail="Autoresearch already running for this workspace")

    train_path = workspace / "train.py"
    if not train_path.exists():
        raise HTTPException(status_code=400, detail="train.py not found. Run 'agentos autoresearch init' first.")

    program_path = workspace / "program.md"
    program_md = program_path.read_text() if program_path.exists() else ""

    config = DriverConfig(
        workspace=workspace,
        run_command=req.train_command,
        time_budget=req.time_budget,
        max_iterations=req.max_iterations,
        git_branch=req.git_branch,
        git_auto_commit=not req.no_git,
        git_auto_reset=not req.no_git,
        train_timeout=req.time_budget * 2 + 60,
    )

    proposer = LLMProposer(
        model=req.model,
        provider=req.provider,
        program_md=program_md,
        temperature=req.temperature,
    )

    driver = AutoResearchDriver(config, proposer)
    _active_drivers[ws_key] = driver

    task = asyncio.create_task(driver.run())
    _active_tasks[ws_key] = task

    return {"status": "started", "workspace": ws_key}


@router.post("/stop")
async def stop_autoresearch(workspace: str = ".") -> dict[str, str]:
    """Stop a running autoresearch loop."""
    ws_key = str(Path(workspace).resolve())

    driver = _active_drivers.get(ws_key)
    if not driver:
        raise HTTPException(status_code=404, detail="No active autoresearch for this workspace")

    driver.stop()
    return {"status": "stopping", "workspace": ws_key}


@router.get("/status", response_model=AutoResearchStatusResponse)
async def get_status(workspace: str = ".") -> AutoResearchStatusResponse:
    """Get autoresearch status for a workspace."""
    from agentos.autoresearch.results import ResultsLog

    ws_path = Path(workspace).resolve()
    ws_key = str(ws_path)

    driver = _active_drivers.get(ws_key)
    running = ws_key in _active_tasks and not _active_tasks[ws_key].done()

    results_path = ws_path / "results.tsv"
    if results_path.exists():
        log = ResultsLog(results_path)
        return AutoResearchStatusResponse(
            running=running,
            workspace=ws_key,
            iteration=driver._iteration if driver else 0,
            best_bpb=log.best_bpb,
            total_experiments=log.total_experiments,
            kept=log.kept_count,
            discarded=log.discarded_count,
            crashed=log.crash_count,
        )

    return AutoResearchStatusResponse(running=running, workspace=ws_key)


@router.get("/results", response_model=list[ExperimentRecordResponse])
async def get_results(workspace: str = ".", last: int = 0) -> list[ExperimentRecordResponse]:
    """Get experiment results."""
    from agentos.autoresearch.results import ResultsLog

    ws_path = Path(workspace).resolve()
    results_path = ws_path / "results.tsv"

    if not results_path.exists():
        return []

    log = ResultsLog(results_path)
    records = log.records()

    if last > 0:
        records = records[-last:]

    return [
        ExperimentRecordResponse(
            commit=r.commit,
            val_bpb=r.val_bpb,
            memory_gb=r.memory_gb,
            status=r.status.value,
            description=r.description,
        )
        for r in records
    ]


# ── Database-backed endpoints (for dashboard/UI) ────────────────────────────


@router.get("/runs")
async def list_runs(agent_name: str = "", limit: int = 50) -> list[dict]:
    """List autoresearch runs from the database (for dashboard)."""
    from agentos.api.deps import _get_db

    db = _get_db()
    return db.query_autoresearch_runs(agent_name=agent_name, limit=limit)


@router.get("/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    """Get a single autoresearch run with all its experiments."""
    from agentos.api.deps import _get_db

    db = _get_db()
    runs = db.query_autoresearch_runs(limit=1)
    run = next((r for r in db.query_autoresearch_runs(limit=1000) if r.get("run_id") == run_id), None)
    if not run:
        raise HTTPException(status_code=404, detail="Autoresearch run not found")

    experiments = db.query_autoresearch_experiments(run_id=run_id, limit=500)
    return {**run, "experiments": experiments}


@router.get("/runs/{run_id}/experiments")
async def list_experiments(run_id: str, limit: int = 100) -> list[dict]:
    """List experiments for a specific autoresearch run."""
    from agentos.api.deps import _get_db

    db = _get_db()
    return db.query_autoresearch_experiments(run_id=run_id, limit=limit)


@router.get("/agent/{agent_name}/history")
async def agent_history(agent_name: str, limit: int = 20) -> dict:
    """Full autoresearch history for an agent — runs + experiments.

    This is the endpoint the dashboard uses to show the agent's
    improvement timeline.
    """
    from agentos.api.deps import _get_db

    db = _get_db()
    runs = db.query_autoresearch_runs(agent_name=agent_name, limit=limit)
    experiments = db.query_autoresearch_experiments(agent_name=agent_name, limit=limit * 10)

    return {
        "agent_name": agent_name,
        "total_runs": len(runs),
        "runs": runs,
        "total_experiments": len(experiments),
        "experiments": experiments,
    }
