"""Jobs router — async job queue with retries, idempotency, dead-letter."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post("")
async def enqueue_job(
    agent_name: str,
    task: str,
    idempotency_key: str = "",
    max_retries: int = 3,
    priority: int = 0,
    scheduled_at: float | None = None,
    user: CurrentUser = Depends(get_current_user),
):
    """Enqueue an async agent job."""
    db = _get_db()
    job_id = uuid.uuid4().hex[:16]
    db.enqueue_job(
        job_id=job_id, agent_name=agent_name, task=task,
        org_id=user.org_id, idempotency_key=idempotency_key,
        max_retries=max_retries, priority=priority, scheduled_at=scheduled_at,
    )
    return {"job_id": job_id, "status": "pending"}


@router.get("")
async def list_jobs(
    status: str = "",
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    db = _get_db()
    return {"jobs": db.list_jobs(status=status, limit=limit, org_id=user.org_id)}


@router.get("/dlq")
async def dead_letter_queue(
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List dead-letter (permanently failed) jobs."""
    db = _get_db()
    return {"jobs": db.list_jobs(status="dead", limit=limit, org_id=user.org_id)}


@router.get("/{job_id}")
async def get_job(job_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM job_queue WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    return dict(row)


@router.post("/{job_id}/retry")
async def retry_job(job_id: str, user: CurrentUser = Depends(get_current_user)):
    """Retry a failed or dead-letter job."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT job_id FROM job_queue WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    db.conn.execute(
        "UPDATE job_queue SET status = 'pending', retries = 0 WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    )
    db.conn.commit()
    return {"retried": job_id}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str, user: CurrentUser = Depends(get_current_user)):
    """Cancel a running or pending job."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT status FROM job_queue WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    if row["status"] not in ("pending", "running"):
        raise HTTPException(status_code=409, detail=f"Cannot cancel job with status '{row['status']}'")
    db.conn.execute(
        "UPDATE job_queue SET status = 'cancelled' WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    )
    db.conn.commit()
    return {"cancelled": job_id}


@router.post("/{job_id}/pause")
async def pause_job(job_id: str, user: CurrentUser = Depends(get_current_user)):
    """Pause a pending job."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT status FROM job_queue WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Cannot pause job with status '{row['status']}' — only pending jobs can be paused")
    db.conn.execute(
        "UPDATE job_queue SET status = 'paused' WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    )
    db.conn.commit()
    return {"paused": job_id}


@router.post("/{job_id}/resume")
async def resume_job(job_id: str, user: CurrentUser = Depends(get_current_user)):
    """Resume a paused job."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT status FROM job_queue WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    if row["status"] != "paused":
        raise HTTPException(status_code=409, detail=f"Cannot resume job with status '{row['status']}' — only paused jobs can be resumed")
    db.conn.execute(
        "UPDATE job_queue SET status = 'pending' WHERE job_id = ? AND org_id = ?",
        (job_id, user.org_id),
    )
    db.conn.commit()
    return {"resumed": job_id}


