"""Schedules router — CRUD for scheduled agent runs."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user
from agentos.api.schemas import CreateScheduleRequest, ScheduleResponse
from agentos.scheduler import Schedule, load_schedules, save_schedules, parse_cron

router = APIRouter(prefix="/schedules", tags=["schedules"])


@router.get("", response_model=list[ScheduleResponse])
async def list_schedules():
    schedules = load_schedules()
    return [
        ScheduleResponse(
            schedule_id=s.id, agent_name=s.agent_name, cron=s.cron,
            task=s.task, is_enabled=s.enabled, run_count=s.run_count,
            last_run_at=s.last_run if s.last_run else None,
        )
        for s in schedules
    ]


@router.post("", response_model=ScheduleResponse)
async def create_schedule(request: CreateScheduleRequest, user: CurrentUser = Depends(get_current_user)):
    try:
        parse_cron(request.cron)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    schedules = load_schedules()
    sched = Schedule(agent_name=request.agent_name, task=request.task, cron=request.cron)
    schedules.append(sched)
    save_schedules(schedules)

    return ScheduleResponse(
        schedule_id=sched.id, agent_name=sched.agent_name,
        cron=sched.cron, task=sched.task,
    )


@router.put("/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    cron: str = "",
    task: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Update a schedule."""
    schedules = load_schedules()
    for s in schedules:
        if s.id == schedule_id:
            if cron:
                parse_cron(cron)
                s.cron = cron
            if task:
                s.task = task
            save_schedules(schedules)
            return ScheduleResponse(
                schedule_id=s.id, agent_name=s.agent_name,
                cron=s.cron, task=s.task, is_enabled=s.enabled,
                run_count=s.run_count, last_run_at=s.last_run if s.last_run else None,
            )
    raise HTTPException(status_code=404, detail="Schedule not found")


@router.get("/{schedule_id}/history")
async def schedule_history(schedule_id: str):
    """Get run history for a schedule."""
    schedules = load_schedules()
    for s in schedules:
        if s.id == schedule_id:
            return {
                "schedule_id": s.id,
                "run_count": s.run_count,
                "last_run": s.last_run,
                "last_status": s.last_status,
                "last_output": s.last_output,
            }
    raise HTTPException(status_code=404, detail="Schedule not found")


@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: str, user: CurrentUser = Depends(get_current_user)):
    schedules = load_schedules()
    before = len(schedules)
    schedules = [s for s in schedules if s.id != schedule_id]
    if len(schedules) == before:
        raise HTTPException(status_code=404, detail="Schedule not found")
    save_schedules(schedules)
    return {"deleted": schedule_id}


@router.post("/{schedule_id}/enable")
async def enable_schedule(schedule_id: str):
    schedules = load_schedules()
    for s in schedules:
        if s.id == schedule_id:
            s.enabled = True
            save_schedules(schedules)
            return {"enabled": True}
    raise HTTPException(status_code=404, detail="Schedule not found")


@router.post("/{schedule_id}/disable")
async def disable_schedule(schedule_id: str):
    schedules = load_schedules()
    for s in schedules:
        if s.id == schedule_id:
            s.enabled = False
            save_schedules(schedules)
            return {"enabled": False}
    raise HTTPException(status_code=404, detail="Schedule not found")
