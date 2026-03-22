"""Webhooks router — CRUD + test delivery + deliveries + secret rotation."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import secrets
import time
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException

from agentos.api.deps import CurrentUser, get_current_user, _get_db
from agentos.api.schemas import CreateWebhookRequest, WebhookResponse

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def _validate_callback_url(url: str) -> None:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme not in {"http", "https"} or not host:
        raise HTTPException(status_code=400, detail="Invalid webhook URL")
    if host in {"localhost"} or host.endswith(".local") or host.endswith(".internal"):
        raise HTTPException(status_code=400, detail="Webhook URL host is not allowed")
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(status_code=400, detail="Webhook URL host is not allowed")
    except ValueError:
        # Non-IP hostnames are allowed; DNS-level filtering can be added upstream.
        pass


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
    url_str = str(request.url)
    _validate_callback_url(url_str)
    db = _get_db()
    webhook_id = uuid.uuid4().hex[:12]
    secret = uuid.uuid4().hex

    db.conn.execute(
        "INSERT INTO webhooks (webhook_id, org_id, url, secret, events) VALUES (?, ?, ?, ?, ?)",
        (webhook_id, user.org_id, url_str, secret, json.dumps(request.events)),
    )
    db.conn.commit()

    return WebhookResponse(
        webhook_id=webhook_id, url=url_str, events=request.events,
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
        _validate_callback_url(url)
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


@router.get("/{webhook_id}/deliveries")
async def list_deliveries(
    webhook_id: str,
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List delivery attempts for a webhook with status codes."""
    db = _get_db()
    # Verify webhook belongs to user's org
    wh = db.conn.execute(
        "SELECT webhook_id FROM webhooks WHERE webhook_id = ? AND org_id = ?",
        (webhook_id, user.org_id),
    ).fetchone()
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")

    rows = db.conn.execute(
        "SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY rowid DESC LIMIT ?",
        (webhook_id, limit),
    ).fetchall()
    return {"deliveries": [dict(r) for r in rows]}


@router.post("/{webhook_id}/deliveries/{delivery_id}/replay")
async def replay_delivery(
    webhook_id: str,
    delivery_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Replay a failed webhook delivery."""
    import httpx

    db = _get_db()
    # Verify webhook ownership
    wh = db.conn.execute(
        "SELECT * FROM webhooks WHERE webhook_id = ? AND org_id = ?",
        (webhook_id, user.org_id),
    ).fetchone()
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")
    webhook = dict(wh)

    # Find original delivery
    delivery = db.conn.execute(
        "SELECT * FROM webhook_deliveries WHERE rowid = ? AND webhook_id = ?",
        (delivery_id, webhook_id),
    ).fetchone()
    if not delivery:
        raise HTTPException(status_code=404, detail="Delivery not found")
    delivery = dict(delivery)

    payload = json.loads(delivery.get("payload_json", "{}"))

    try:
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                webhook["url"],
                json=payload,
                headers={"X-AgentOS-Secret": webhook["secret"]},
            )
        duration = (time.monotonic() - start) * 1000

        # Log the replay delivery
        db.conn.execute(
            """INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json,
            response_status, response_body, duration_ms, success) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (webhook_id, delivery.get("event_type", "replay"), json.dumps(payload),
             resp.status_code, resp.text[:500], duration, 1 if resp.status_code < 400 else 0),
        )
        db.conn.commit()

        return {
            "replayed": delivery_id,
            "status": resp.status_code,
            "duration_ms": round(duration, 1),
            "success": resp.status_code < 400,
        }
    except Exception as exc:
        return {"replayed": delivery_id, "status": 0, "error": str(exc), "success": False}


@router.post("/{webhook_id}/rotate-secret")
async def rotate_secret(
    webhook_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Rotate the signing secret for a webhook."""
    db = _get_db()
    row = db.conn.execute(
        "SELECT webhook_id FROM webhooks WHERE webhook_id = ? AND org_id = ?",
        (webhook_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Webhook not found")

    new_secret = secrets.token_hex(32)
    db.conn.execute(
        "UPDATE webhooks SET secret = ? WHERE webhook_id = ? AND org_id = ?",
        (new_secret, webhook_id, user.org_id),
    )
    db.conn.commit()

    return {"webhook_id": webhook_id, "secret": new_secret, "rotated": True}
