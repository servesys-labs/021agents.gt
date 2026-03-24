"""Voice webhooks router — Vapi, ElevenLabs, Retell, Bland, Tavus."""

from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/voice", tags=["voice"])

PLATFORM_CONFIGS = {
    "elevenlabs": {
        "adapter_cls": "agentos.integrations.voice_platforms.elevenlabs.ElevenLabsAdapter",
        "api_key_env": "ELEVENLABS_API_KEY",
        "webhook_secret_env": "ELEVENLABS_WEBHOOK_SECRET",
        "signature_header": "x-elevenlabs-signature",
    },
    "retell": {
        "adapter_cls": "agentos.integrations.voice_platforms.retell.RetellAdapter",
        "api_key_env": "RETELL_API_KEY",
        "webhook_secret_env": "RETELL_WEBHOOK_SECRET",
        "signature_header": "x-retell-signature",
    },
    "bland": {
        "adapter_cls": "agentos.integrations.voice_platforms.bland.BlandAdapter",
        "api_key_env": "BLAND_API_KEY",
        "webhook_secret_env": "BLAND_WEBHOOK_SECRET",
        "signature_header": "x-bland-signature",
    },
    "tavus": {
        "adapter_cls": "agentos.integrations.voice_platforms.tavus.TavusAdapter",
        "api_key_env": "TAVUS_API_KEY",
        "webhook_secret_env": "TAVUS_WEBHOOK_SECRET",
        "signature_header": "x-tavus-signature",
    },
}


def _load_adapter(platform: str, db: Any = None, need_api_key: bool = False):
    """Dynamically load a voice platform adapter."""
    cfg = PLATFORM_CONFIGS.get(platform)
    if not cfg:
        raise HTTPException(status_code=400, detail=f"Unknown platform: {platform}")

    api_key = os.environ.get(cfg["api_key_env"], "") if need_api_key else ""
    webhook_secret = os.environ.get(cfg["webhook_secret_env"], "")

    import importlib
    module_path, cls_name = cfg["adapter_cls"].rsplit(".", 1)
    mod = importlib.import_module(module_path)
    adapter_cls = getattr(mod, cls_name)
    return adapter_cls(api_key=api_key, webhook_secret=webhook_secret, db=db)


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


# ── Generic platform webhook (ElevenLabs, Retell, Bland, Tavus) ────


@router.post("/{platform}/webhook")
async def platform_webhook(platform: str, request: Request):
    """Receive webhook events for any voice platform."""
    cfg = PLATFORM_CONFIGS.get(platform)
    if not cfg:
        raise HTTPException(status_code=404, detail=f"Unknown platform: {platform}")

    body = await request.body()
    signature = request.headers.get(cfg["signature_header"], "")
    db = _get_db()
    adapter = _load_adapter(platform, db=db)

    webhook_secret = os.environ.get(cfg["webhook_secret_env"], "")
    if webhook_secret and not adapter.verify_webhook(body, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = json.loads(body)
    result = adapter.process_webhook(payload)
    return result


# ── Generic platform call management ───────────────────────────────


@router.get("/{platform}/calls")
async def list_platform_calls(
    platform: str,
    agent_name: str = "",
    status: str = "",
    limit: int = 50,
    user: CurrentUser = Depends(get_current_user),
):
    """List calls for a specific platform."""
    if platform not in PLATFORM_CONFIGS:
        raise HTTPException(status_code=404, detail=f"Unknown platform: {platform}")
    db = _get_db()
    calls = db.list_voice_calls(
        platform=platform, org_id=user.org_id, agent_name=agent_name,
        status=status, limit=limit,
    )
    return {"calls": calls, "platform": platform}


@router.get("/{platform}/calls/summary")
async def platform_call_summary(
    platform: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get call summary stats for a specific platform."""
    if platform not in PLATFORM_CONFIGS:
        raise HTTPException(status_code=404, detail=f"Unknown platform: {platform}")
    db = _get_db()
    return db.voice_call_summary(platform=platform, org_id=user.org_id)


@router.get("/{platform}/calls/{call_id}")
async def get_platform_call(
    platform: str,
    call_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get a specific call from any platform."""
    if platform not in PLATFORM_CONFIGS:
        raise HTTPException(status_code=404, detail=f"Unknown platform: {platform}")
    db = _get_db()
    call = db.get_voice_call(call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    return call


@router.get("/{platform}/calls/{call_id}/events")
async def get_platform_call_events(
    platform: str,
    call_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Get events for a specific call from any platform."""
    if platform not in PLATFORM_CONFIGS:
        raise HTTPException(status_code=404, detail=f"Unknown platform: {platform}")
    db = _get_db()
    events = db.list_voice_events(call_id)
    return {"events": events, "platform": platform}


@router.post("/{platform}/calls")
async def create_platform_call(
    platform: str,
    body: dict[str, Any],
    user: CurrentUser = Depends(get_current_user),
):
    """Create an outbound call via any voice platform."""
    cfg = PLATFORM_CONFIGS.get(platform)
    if not cfg:
        raise HTTPException(status_code=404, detail=f"Unknown platform: {platform}")

    api_key = os.environ.get(cfg["api_key_env"], "")
    if not api_key:
        raise HTTPException(status_code=400, detail=f"{cfg['api_key_env']} not configured")

    db = _get_db()
    adapter = _load_adapter(platform, db=db, need_api_key=True)

    # Route to the platform-specific create method
    if platform == "elevenlabs":
        result = await adapter.create_conversation(
            agent_id=body.get("agent_id", ""),
            first_message=body.get("first_message", ""),
            agent_name=body.get("agent_name", ""),
            org_id=user.org_id,
        )
    elif platform == "retell":
        result = await adapter.create_call(
            from_number=body.get("from_number", ""),
            to_number=body.get("to_number", ""),
            agent_id=body.get("agent_id", ""),
            agent_name=body.get("agent_name", ""),
            org_id=user.org_id,
        )
    elif platform == "bland":
        result = await adapter.create_call(
            phone_number=body.get("phone_number", ""),
            task=body.get("task", ""),
            voice=body.get("voice", ""),
            agent_name=body.get("agent_name", ""),
            org_id=user.org_id,
            first_sentence=body.get("first_sentence", ""),
            max_duration=body.get("max_duration", 300),
        )
    elif platform == "tavus":
        result = await adapter.create_conversation(
            persona_id=body.get("persona_id", ""),
            context=body.get("context", ""),
            agent_name=body.get("agent_name", ""),
            org_id=user.org_id,
            properties=body.get("properties", {}),
        )
    else:
        raise HTTPException(status_code=400, detail=f"Create not supported for {platform}")

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── Cross-platform summary ─────────────────────────────────────────


@router.get("/all/summary")
async def all_platforms_summary(user: CurrentUser = Depends(get_current_user)):
    """Get call summary across all voice platforms (Vapi + generic)."""
    db = _get_db()
    vapi_summary = db.vapi_call_summary(org_id=user.org_id)
    voice_summary = db.voice_call_summary(org_id=user.org_id)
    return {
        "vapi": vapi_summary,
        "platforms": voice_summary,
        "total_calls": vapi_summary.get("total_calls", 0) + voice_summary.get("total_calls", 0),
        "total_cost_usd": round(
            vapi_summary.get("total_cost_usd", 0) + voice_summary.get("total_cost_usd", 0), 4
        ),
        "total_duration_seconds": round(
            vapi_summary.get("total_duration_seconds", 0) + voice_summary.get("total_duration_seconds", 0), 1
        ),
    }
