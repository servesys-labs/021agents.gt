"""Bland AI voice platform adapter.

Bland AI is a phone call AI platform. This adapter handles:
- Outbound call creation
- Inbound webhook processing (call events, transcripts)
- Call management (get, end)

Bland AI webhook events:
  - call.initiated: Call initiated
  - call.answered: Call answered / connected
  - call.ended: Call completed (includes transcript, summary, duration, cost)
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
class BlandCall:
    """Represents a Bland AI call."""

    call_id: str = ""
    org_id: str = ""
    agent_name: str = ""
    phone_number: str = ""
    task: str = ""
    voice: str = ""
    status: str = "pending"  # pending/initiated/answered/ended/failed
    duration_seconds: float = 0.0
    transcript: str = ""
    summary: str = ""
    cost_usd: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)
    started_at: float = 0.0
    ended_at: float = 0.0
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "org_id": self.org_id,
            "agent_name": self.agent_name,
            "phone_number": self.phone_number,
            "task": self.task,
            "voice": self.voice,
            "status": self.status,
            "duration_seconds": self.duration_seconds,
            "transcript": self.transcript,
            "summary": self.summary,
            "cost_usd": self.cost_usd,
            "metadata": self.metadata,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "created_at": self.created_at,
        }


@dataclass
class BlandWebhookEvent:
    """Parsed Bland AI webhook event."""

    event_type: str  # call.initiated, call.answered, call.ended
    call_id: str = ""
    timestamp: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> BlandWebhookEvent:
        """Parse a Bland AI webhook payload into an event."""
        event_type = payload.get("event", payload.get("type", "unknown"))

        call_id = (
            payload.get("call_id", "")
            or payload.get("call", {}).get("id", "")
            or ""
        )

        return cls(
            event_type=event_type,
            call_id=call_id,
            timestamp=time.time(),
            data=payload,
        )


class BlandAdapter:
    """Adapter for Bland AI voice platform.

    Handles:
    - Webhook verification and event processing
    - Call lifecycle management (create, end, get)
    - Transcript and summary extraction
    """

    def __init__(
        self,
        api_key: str = "",
        webhook_secret: str = "",
        base_url: str = "https://api.bland.ai/v1",
        db: Any = None,
    ):
        self.api_key = api_key
        self.webhook_secret = webhook_secret
        self.base_url = base_url
        self.db = db

    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        """Verify Bland AI webhook signature."""
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
        """Process a Bland AI webhook event."""
        event = BlandWebhookEvent.from_payload(payload)

        result: dict[str, Any] = {
            "event_type": event.event_type,
            "call_id": event.call_id,
            "processed": True,
        }

        if event.event_type == "call.initiated":
            result.update(self._handle_call_initiated(event, org_id))
        elif event.event_type == "call.answered":
            result.update(self._handle_call_answered(event, org_id))
        elif event.event_type == "call.ended":
            result.update(self._handle_call_ended(event, org_id))

        # Persist event
        if self.db and event.call_id:
            try:
                self.db.insert_voice_event(
                    call_id=event.call_id,
                    event_type=event.event_type,
                    payload_json=json.dumps(payload),
                    org_id=org_id,
                    platform="bland",
                )
            except Exception as exc:
                logger.debug("Failed to persist Bland event: %s", exc)

        return result

    def _handle_call_initiated(self, event: BlandWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call initiated event."""
        call = BlandCall(
            call_id=event.call_id or uuid.uuid4().hex[:16],
            org_id=org_id,
            phone_number=event.data.get("phone_number", ""),
            task=event.data.get("task", ""),
            voice=event.data.get("voice", ""),
            status="initiated",
            started_at=time.time(),
        )

        if self.db:
            try:
                self.db.insert_voice_call(**call.to_dict(), platform="bland")
            except Exception as exc:
                logger.debug("Failed to persist Bland call: %s", exc)

        return {"call": call.to_dict()}

    def _handle_call_answered(self, event: BlandWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call answered event."""
        if self.db and event.call_id:
            try:
                self.db.update_voice_call(
                    event.call_id,
                    status="answered",
                    platform="bland",
                )
            except Exception:
                pass

        return {"answered": True}

    def _handle_call_ended(self, event: BlandWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call ended event."""
        duration = float(event.data.get("duration", 0) or 0)
        cost = float(event.data.get("cost", 0) or 0)
        transcript = event.data.get("transcript", "") or ""
        summary = event.data.get("summary", "") or ""

        if self.db and event.call_id:
            try:
                self.db.update_voice_call(
                    event.call_id,
                    status="ended",
                    duration_seconds=duration,
                    cost_usd=cost,
                    transcript=transcript[:5000],
                    summary=summary[:2000],
                    ended_at=time.time(),
                    platform="bland",
                )
            except Exception:
                pass

        return {
            "duration_seconds": duration,
            "cost_usd": cost,
            "transcript_length": len(transcript),
            "summary_length": len(summary),
        }

    async def create_call(
        self,
        phone_number: str,
        task: str = "",
        voice: str = "",
        agent_name: str = "",
        org_id: str = "",
        first_sentence: str = "",
        max_duration: int = 0,
    ) -> dict[str, Any]:
        """Create an outbound call via Bland AI API."""
        if not self.api_key:
            return {"error": "Bland AI API key not configured"}

        import httpx

        payload: dict[str, Any] = {
            "phone_number": phone_number,
        }
        if task:
            payload["task"] = task
        if voice:
            payload["voice"] = voice
        if first_sentence:
            payload["first_sentence"] = first_sentence
        if max_duration:
            payload["max_duration"] = max_duration

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.base_url}/calls",
                    headers={
                        "authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                if resp.status_code not in (200, 201):
                    return {"error": f"Bland AI API error: {resp.status_code} {resp.text[:300]}"}

                data = resp.json()
                call_id = data.get("call_id", data.get("id", uuid.uuid4().hex[:16]))

                # Persist
                if self.db:
                    self.db.insert_voice_call(
                        call_id=call_id,
                        org_id=org_id,
                        agent_name=agent_name,
                        phone_number=phone_number,
                        task=task,
                        voice=voice,
                        status="pending",
                        platform="bland",
                    )

                return {"call_id": call_id, "status": "initiated", "bland_response": data}
        except Exception as exc:
            return {"error": str(exc)}

    async def end_call(self, call_id: str) -> dict[str, Any]:
        """End an active call via Bland AI API."""
        if not self.api_key:
            return {"error": "Bland AI API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{self.base_url}/calls/{call_id}/stop",
                    headers={"authorization": f"Bearer {self.api_key}"},
                )
                if resp.status_code not in (200, 204):
                    return {"error": f"Bland AI API error: {resp.status_code}"}

                if self.db:
                    self.db.update_voice_call(
                        call_id, status="ended", ended_at=time.time(), platform="bland",
                    )

                return {"ended": True, "call_id": call_id}
        except Exception as exc:
            return {"error": str(exc)}

    async def get_call(self, call_id: str) -> dict[str, Any]:
        """Get call details via Bland AI API."""
        if not self.api_key:
            return {"error": "Bland AI API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{self.base_url}/calls/{call_id}",
                    headers={"authorization": f"Bearer {self.api_key}"},
                )
                if resp.status_code != 200:
                    return {"error": f"Bland AI API error: {resp.status_code}"}

                return resp.json()
        except Exception as exc:
            return {"error": str(exc)}
