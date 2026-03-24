"""Retell AI voice platform adapter.

Retell AI is a voice agent platform for building phone-based AI agents.
This adapter handles:
- Outbound call creation
- Inbound webhook processing (call events, transcripts, analysis)
- Call management (get, end)

Retell webhook events:
  - call_started: Call initiated
  - call_ended: Call completed
  - call_analyzed: Post-call analysis with transcript, sentiment, summary
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class RetellCall:
    """Represents a Retell AI call."""

    call_id: str = ""
    org_id: str = ""
    agent_name: str = ""
    from_number: str = ""
    to_number: str = ""
    direction: str = "outbound"  # inbound/outbound
    status: str = "pending"  # pending/in_progress/ended/failed
    duration_seconds: float = 0.0
    transcript: str = ""
    sentiment: str = ""  # positive/negative/neutral
    call_summary: str = ""
    cost_usd: float = 0.0
    retell_agent_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    started_at: float = 0.0
    ended_at: float = 0.0
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "org_id": self.org_id,
            "agent_name": self.agent_name,
            "from_number": self.from_number,
            "to_number": self.to_number,
            "direction": self.direction,
            "status": self.status,
            "duration_seconds": self.duration_seconds,
            "transcript": self.transcript,
            "sentiment": self.sentiment,
            "call_summary": self.call_summary,
            "cost_usd": self.cost_usd,
            "retell_agent_id": self.retell_agent_id,
            "metadata": self.metadata,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "created_at": self.created_at,
        }


@dataclass
class RetellWebhookEvent:
    """Parsed Retell AI webhook event."""

    event_type: str  # call_started, call_ended, call_analyzed
    call_id: str = ""
    timestamp: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> RetellWebhookEvent:
        """Parse a Retell webhook payload into an event."""
        event_type = payload.get("event", payload.get("type", "unknown"))

        # Extract call ID from various payload locations
        call_id = (
            payload.get("call", {}).get("call_id", "")
            or payload.get("call_id", "")
            or payload.get("data", {}).get("call_id", "")
            or ""
        )

        return cls(
            event_type=event_type,
            call_id=call_id,
            timestamp=time.time(),
            data=payload,
        )


class RetellAdapter:
    """Adapter for Retell AI voice platform.

    Handles:
    - Webhook verification and event processing
    - Call lifecycle management
    - Transcript and sentiment aggregation from call_analyzed events
    """

    def __init__(
        self,
        api_key: str = "",
        webhook_secret: str = "",
        base_url: str = "https://api.retellai.com",
        db: Any = None,
    ):
        self.api_key = api_key
        self.webhook_secret = webhook_secret
        self.base_url = base_url
        self.db = db

    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        """Verify Retell webhook signature using HMAC SHA-256."""
        if not self.webhook_secret:
            return True  # No secret configured, skip verification

        expected = hmac.new(
            self.webhook_secret.encode(),
            payload,
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, signature)

    def process_webhook(
        self,
        payload: dict[str, Any],
        org_id: str = "",
    ) -> dict[str, Any]:
        """Process a Retell webhook event."""
        event = RetellWebhookEvent.from_payload(payload)

        result: dict[str, Any] = {
            "event_type": event.event_type,
            "call_id": event.call_id,
            "processed": True,
        }

        if event.event_type == "call_started":
            result.update(self._handle_call_started(event, org_id))
        elif event.event_type == "call_ended":
            result.update(self._handle_call_ended(event, org_id))
        elif event.event_type == "call_analyzed":
            result.update(self._handle_call_analyzed(event, org_id))

        # Persist event
        if self.db and event.call_id:
            try:
                self.db.insert_voice_event(
                    call_id=event.call_id,
                    event_type=event.event_type,
                    payload_json=json.dumps(payload),
                    org_id=org_id,
                    platform="retell",
                )
            except Exception as exc:
                logger.debug("Failed to persist Retell event: %s", exc)

        return result

    def _handle_call_started(self, event: RetellWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call_started event."""
        call_data = event.data.get("call", event.data.get("data", {}))
        call = RetellCall(
            call_id=event.call_id or uuid.uuid4().hex[:16],
            org_id=org_id,
            from_number=call_data.get("from_number", ""),
            to_number=call_data.get("to_number", ""),
            direction=call_data.get("direction", "outbound"),
            status="in_progress",
            retell_agent_id=call_data.get("agent_id", ""),
            started_at=time.time(),
        )

        if self.db:
            try:
                self.db.insert_voice_call(**call.to_dict(), platform="retell")
            except Exception as exc:
                logger.debug("Failed to persist Retell call: %s", exc)

        return {"call": call.to_dict()}

    def _handle_call_ended(self, event: RetellWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call_ended event."""
        call_data = event.data.get("call", event.data.get("data", {}))
        duration = float(call_data.get("duration_seconds", 0) or call_data.get("duration", 0) or 0)
        cost = float(call_data.get("cost", 0) or 0)

        if self.db and event.call_id:
            try:
                self.db.update_voice_call(
                    event.call_id,
                    status="ended",
                    duration_seconds=duration,
                    cost_usd=cost,
                    ended_at=time.time(),
                    platform="retell",
                )
            except Exception:
                pass

        return {
            "duration_seconds": duration,
            "cost_usd": cost,
        }

    def _handle_call_analyzed(self, event: RetellWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call_analyzed event with transcript, sentiment, and summary."""
        call_data = event.data.get("call", event.data.get("data", {}))
        transcript = call_data.get("transcript", "")
        sentiment = call_data.get("sentiment", "")
        call_summary = call_data.get("call_summary", "") or call_data.get("summary", "")

        if self.db and event.call_id:
            try:
                self.db.update_voice_call(
                    event.call_id,
                    transcript=transcript[:5000],
                    sentiment=sentiment,
                    call_summary=call_summary[:2000],
                    platform="retell",
                )
            except Exception:
                pass

        return {
            "transcript_length": len(transcript),
            "sentiment": sentiment,
            "has_summary": bool(call_summary),
        }

    async def create_call(
        self,
        from_number: str,
        to_number: str,
        agent_id: str = "",
        agent_name: str = "",
        org_id: str = "",
    ) -> dict[str, Any]:
        """Create an outbound phone call via Retell API."""
        if not self.api_key:
            return {"error": "Retell API key not configured"}

        import httpx

        payload: dict[str, Any] = {
            "from_number": from_number,
            "to_number": to_number,
        }
        if agent_id:
            payload["agent_id"] = agent_id

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.base_url}/v2/create-phone-call",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                if resp.status_code not in (200, 201):
                    return {"error": f"Retell API error: {resp.status_code} {resp.text[:300]}"}

                data = resp.json()
                call_id = data.get("call_id", uuid.uuid4().hex[:16])

                # Persist
                if self.db:
                    self.db.insert_voice_call(
                        call_id=call_id,
                        org_id=org_id,
                        agent_name=agent_name,
                        from_number=from_number,
                        to_number=to_number,
                        direction="outbound",
                        status="pending",
                        retell_agent_id=agent_id,
                        platform="retell",
                    )

                return {"call_id": call_id, "status": "initiated", "retell_response": data}
        except Exception as exc:
            return {"error": str(exc)}

    async def end_call(self, call_id: str) -> dict[str, Any]:
        """End an active call via Retell API."""
        if not self.api_key:
            return {"error": "Retell API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{self.base_url}/v2/end-call/{call_id}",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                )
                if resp.status_code not in (200, 204):
                    return {"error": f"Retell API error: {resp.status_code}"}

                if self.db:
                    self.db.update_voice_call(
                        call_id, status="ended", ended_at=time.time(), platform="retell",
                    )

                return {"ended": True, "call_id": call_id}
        except Exception as exc:
            return {"error": str(exc)}

    async def get_call(self, call_id: str) -> dict[str, Any]:
        """Get call details via Retell API."""
        if not self.api_key:
            return {"error": "Retell API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{self.base_url}/v2/get-call/{call_id}",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                if resp.status_code != 200:
                    return {"error": f"Retell API error: {resp.status_code}"}

                return {"call_id": call_id, "retell_response": resp.json()}
        except Exception as exc:
            return {"error": str(exc)}
