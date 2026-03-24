"""Voice webhooks router — Vapi call management and webhook ingestion."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/voice", tags=["voice"])


# ── Webhook endpoint (unauthenticated — uses signature verification) ──


@router.post("/vapi/webhook")
async def vapi_webhook(request: Request):
    """Receive Vapi webhook events. Verifies signature if secret is configured."""
    from agentos.integrations.voice_platforms.vapi import VapiAdapter

    body = await request.body()
    signature = request.headers.get("x-vapi-signature", "")
    webhook_secret = os.environ.get("VAPI_WEBHOOK_SECRET", "")

    adapter = VapiAdapter(
        webhook_secret=webhook_secret,
        db=_get_db(),
    )

    if webhook_secret and not adapter.verify_webhook(body, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    import json
    payload = json.loads(body)
    result = adapter.process_webhook(payload)
    return result


# ── Authenticated call management endpoints ──────────────────────


@router.get("/vapi/calls")
async def list_vapi_calls(
    agent_name: str = "",
    status: str = "",
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List Vapi calls."""
    db = _get_db()
    calls = db.list_vapi_calls(
        org_id=user.org_id, agent_name=agent_name, status=status, limit=limit,
    )
    return {"calls": calls}


@router.get("/vapi/calls/summary")
async def vapi_call_summary(user: CurrentUser = Depends(get_current_user)):
    """Get Vapi call summary stats."""
    db = _get_db()
    return db.vapi_call_summary(org_id=user.org_id)


@router.get("/vapi/calls/{call_id}")
async def get_vapi_call(call_id: str, user: CurrentUser = Depends(get_current_user)):
    """Get a specific Vapi call."""
    db = _get_db()
    call = db.get_vapi_call(call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    return call


@router.get("/vapi/calls/{call_id}/events")
async def get_call_events(call_id: str, user: CurrentUser = Depends(get_current_user)):
    """Get events for a specific call."""
    db = _get_db()
    events = db.list_vapi_events(call_id)
    return {"events": events}


@router.post("/vapi/calls")
async def create_vapi_call(
    body: dict[str, Any],
    user: CurrentUser = Depends(get_current_user),
):
    """Create an outbound Vapi call."""
    import os
    from agentos.integrations.voice_platforms.vapi import VapiAdapter

    api_key = os.environ.get("VAPI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="VAPI_API_KEY not configured")

    db = _get_db()
    adapter = VapiAdapter(api_key=api_key, db=db)
    result = await adapter.create_call(
        phone_number=body.get("phone_number", ""),
        assistant_id=body.get("assistant_id", ""),
        agent_name=body.get("agent_name", ""),
        first_message=body.get("first_message", ""),
        org_id=user.org_id,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.delete("/vapi/calls/{call_id}")
async def end_vapi_call(call_id: str, user: CurrentUser = Depends(get_current_user)):
    """End an active Vapi call."""
    import os
    from agentos.integrations.voice_platforms.vapi import VapiAdapter

    api_key = os.environ.get("VAPI_API_KEY", "")
    adapter = VapiAdapter(api_key=api_key, db=_get_db())
    result = await adapter.end_call(call_id)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result
