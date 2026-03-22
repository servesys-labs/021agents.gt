"""Webhooks router — CRUD + test delivery."""

from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.api.schemas import CreateWebhookRequest, WebhookResponse

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.get("", response_model=list[WebhookResponse])
async def list_webhooks(user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    rows = db.conn.execute(
        "SELECT * FROM webhooks WHERE org_id = ? ORDER BY created_at DESC", (user.org_id,)
    ).fetchall()
    return [
        WebhookResponse(
            webhook_id=r["webhook_id"], url=r["url"],
            events=json.loads(r["events"]), is_active=bool(r["is_active"]),
            failure_count=r["failure_count"], last_triggered_at=r["last_triggered_at"],
        )
        for r in rows
    ]


@router.post("", response_model=WebhookResponse)
async def create_webhook(request: CreateWebhookRequest, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    webhook_id = uuid.uuid4().hex[:12]
    secret = uuid.uuid4().hex

    db.conn.execute(
        "INSERT INTO webhooks (webhook_id, org_id, url, secret, events) VALUES (?, ?, ?, ?, ?)",
        (webhook_id, user.org_id, request.url, secret, json.dumps(request.events)),
    )
    db.conn.commit()

    return WebhookResponse(
        webhook_id=webhook_id, url=request.url, events=request.events,
    )


@router.put("/{webhook_id}")
async def update_webhook(
    webhook_id: str,
    url: str = "",
    events: list[str] | None = None,
    is_active: bool | None = None,
    user: CurrentUser = Depends(get_current_user),
):
    """Update a webhook."""
    db = _get_db()
    updates, params = [], []
    if url:
        updates.append("url = ?")
        params.append(url)
    if events is not None:
        updates.append("events = ?")
        params.append(json.dumps(events))
    if is_active is not None:
        updates.append("is_active = ?")
        params.append(1 if is_active else 0)
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    params.extend([webhook_id, user.org_id])
    db.conn.execute(f"UPDATE webhooks SET {', '.join(updates)} WHERE webhook_id = ? AND org_id = ?", params)
    db.conn.commit()
    return {"updated": webhook_id}


@router.delete("/{webhook_id}")
async def delete_webhook(webhook_id: str, user: CurrentUser = Depends(get_current_user)):
    db = _get_db()
    result = db.conn.execute(
        "DELETE FROM webhooks WHERE webhook_id = ? AND org_id = ?", (webhook_id, user.org_id)
    )
    db.conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Webhook not found")
    return {"deleted": webhook_id}


@router.post("/{webhook_id}/test")
async def test_webhook(webhook_id: str, user: CurrentUser = Depends(get_current_user)):
    """Send a test event to a webhook."""
    import httpx

    db = _get_db()
    row = db.conn.execute(
        "SELECT * FROM webhooks WHERE webhook_id = ? AND org_id = ?", (webhook_id, user.org_id)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Webhook not found")

    webhook = dict(row)
    payload = {
        "event": "test",
        "timestamp": time.time(),
        "data": {"message": "This is a test webhook delivery from AgentOS"},
    }

    try:
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                webhook["url"],
                json=payload,
                headers={"X-AgentOS-Secret": webhook["secret"]},
            )
        duration = (time.monotonic() - start) * 1000

        # Log delivery
        db.conn.execute(
            """INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json,
            response_status, response_body, duration_ms, success) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (webhook_id, "test", json.dumps(payload), resp.status_code,
             resp.text[:500], duration, 1 if resp.status_code < 400 else 0),
        )
        db.conn.commit()

        return {"status": resp.status_code, "duration_ms": round(duration, 1), "success": resp.status_code < 400}
    except Exception as exc:
        return {"status": 0, "error": str(exc), "success": False}
