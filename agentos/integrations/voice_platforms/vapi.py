"""Vapi voice platform adapter.

Vapi is a voice AI platform for building phone agents. This adapter handles:
- Outbound call creation
- Inbound webhook processing (call events, transcript updates)
- Call management (get, list, end)
- Agent handoff (route Vapi calls to AgentOS agents)

Vapi webhook events:
  - call.started: Call initiated
  - call.ringing: Phone ringing
  - call.connected: Call connected
  - call.ended: Call completed
  - transcript.partial: Partial transcript update
  - transcript.final: Final transcript segment
  - function.call: Vapi requesting a function call (agent handoff)
  - hang: Call hung up
  - speech.started / speech.ended: Voice activity detection
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
class VapiCall:
    """Represents a Vapi call."""

    call_id: str = ""
    org_id: str = ""
    agent_name: str = ""
    phone_number: str = ""
    direction: str = "outbound"  # inbound/outbound
    status: str = "pending"  # pending/ringing/connected/ended/failed
    duration_seconds: float = 0.0
    transcript: str = ""
    cost_usd: float = 0.0
    vapi_assistant_id: str = ""
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
            "direction": self.direction,
            "status": self.status,
            "duration_seconds": self.duration_seconds,
            "transcript": self.transcript,
            "cost_usd": self.cost_usd,
            "vapi_assistant_id": self.vapi_assistant_id,
            "metadata": self.metadata,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "created_at": self.created_at,
        }


@dataclass
class VapiWebhookEvent:
    """Parsed Vapi webhook event."""

    event_type: str  # call.started, call.ended, transcript.final, etc.
    call_id: str = ""
    timestamp: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> VapiWebhookEvent:
        """Parse a Vapi webhook payload into an event."""
        message = payload.get("message", {})
        event_type = message.get("type", payload.get("type", "unknown"))

        # Extract call ID from various payload locations
        call_id = (
            message.get("call", {}).get("id", "")
            or message.get("callId", "")
            or payload.get("call", {}).get("id", "")
            or ""
        )

        return cls(
            event_type=event_type,
            call_id=call_id,
            timestamp=time.time(),
            data=payload,
        )


class VapiAdapter:
    """Adapter for Vapi voice AI platform.

    Handles:
    - Webhook verification and event processing
    - Call lifecycle management
    - Transcript aggregation
    - Agent handoff (function calls from Vapi → AgentOS agent execution)
    """

    def __init__(
        self,
        api_key: str = "",
        webhook_secret: str = "",
        base_url: str = "https://api.vapi.ai",
        db: Any = None,
    ):
        self.api_key = api_key
        self.webhook_secret = webhook_secret
        self.base_url = base_url
        self.db = db

    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        """Verify Vapi webhook signature."""
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
        """Process a Vapi webhook event."""
        event = VapiWebhookEvent.from_payload(payload)

        result = {
            "event_type": event.event_type,
            "call_id": event.call_id,
            "processed": True,
        }

        if event.event_type == "call.started" or event.event_type == "assistant-request":
            result.update(self._handle_call_started(event, org_id))
        elif event.event_type == "call.ended" or event.event_type == "end-of-call-report":
            result.update(self._handle_call_ended(event, org_id))
        elif event.event_type in ("transcript.partial", "transcript.final", "transcript"):
            result.update(self._handle_transcript(event))
        elif event.event_type == "function-call":
            result.update(self._handle_function_call(event))
        elif event.event_type == "hang":
            result.update(self._handle_hang(event))

        # Persist event
        if self.db and event.call_id:
            try:
                self.db.insert_vapi_event(
                    call_id=event.call_id,
                    event_type=event.event_type,
                    payload_json=json.dumps(payload),
                    org_id=org_id,
                )
            except Exception as exc:
                logger.debug("Failed to persist Vapi event: %s", exc)

        return result

    def _handle_call_started(self, event: VapiWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call started event."""
        call_data = event.data.get("message", {}).get("call", event.data.get("call", {}))
        call = VapiCall(
            call_id=event.call_id or uuid.uuid4().hex[:16],
            org_id=org_id,
            phone_number=call_data.get("customer", {}).get("number", ""),
            direction="inbound" if call_data.get("type") == "inboundPhoneCall" else "outbound",
            status="connected",
            vapi_assistant_id=call_data.get("assistantId", ""),
            started_at=time.time(),
        )

        if self.db:
            try:
                self.db.insert_vapi_call(**call.to_dict())
            except Exception as exc:
                logger.debug("Failed to persist Vapi call: %s", exc)

        return {"call": call.to_dict()}

    def _handle_call_ended(self, event: VapiWebhookEvent, org_id: str) -> dict[str, Any]:
        """Handle call ended event."""
        message = event.data.get("message", event.data)
        call_data = message.get("call", {})
        duration = float(message.get("durationSeconds", 0) or call_data.get("duration", 0) or 0)
        cost = float(message.get("cost", 0) or 0)
        transcript = message.get("transcript", "") or message.get("summary", "")

        if self.db and event.call_id:
            try:
                self.db.update_vapi_call(
                    event.call_id,
                    status="ended",
                    duration_seconds=duration,
                    cost_usd=cost,
                    transcript=transcript[:5000],
                    ended_at=time.time(),
                )
            except Exception:
                pass

        return {
            "duration_seconds": duration,
            "cost_usd": cost,
            "transcript_length": len(transcript),
        }

    def _handle_transcript(self, event: VapiWebhookEvent) -> dict[str, Any]:
        """Handle transcript update."""
        message = event.data.get("message", event.data)
        text = message.get("transcript", "") or message.get("text", "")
        role = message.get("role", "unknown")
        is_final = message.get("transcriptType") == "final" or event.event_type == "transcript.final"

        return {
            "text": text,
            "role": role,
            "is_final": is_final,
        }

    def _handle_function_call(self, event: VapiWebhookEvent) -> dict[str, Any]:
        """Handle Vapi function call (agent handoff)."""
        message = event.data.get("message", event.data)
        fn_call = message.get("functionCall", {})
        return {
            "function_name": fn_call.get("name", ""),
            "parameters": fn_call.get("parameters", {}),
            "needs_response": True,
        }

    def _handle_hang(self, event: VapiWebhookEvent) -> dict[str, Any]:
        """Handle call hang up."""
        if self.db and event.call_id:
            try:
                self.db.update_vapi_call(event.call_id, status="ended", ended_at=time.time())
            except Exception:
                pass
        return {"hung_up": True}

    async def create_call(
        self,
        phone_number: str,
        assistant_id: str = "",
        agent_name: str = "",
        first_message: str = "",
        org_id: str = "",
    ) -> dict[str, Any]:
        """Create an outbound call via Vapi API."""
        if not self.api_key:
            return {"error": "Vapi API key not configured"}

        import httpx

        payload: dict[str, Any] = {
            "phoneNumberId": phone_number,
        }
        if assistant_id:
            payload["assistantId"] = assistant_id
        if first_message:
            payload["firstMessage"] = first_message

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.base_url}/call/phone",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                if resp.status_code not in (200, 201):
                    return {"error": f"Vapi API error: {resp.status_code} {resp.text[:300]}"}

                data = resp.json()
                call_id = data.get("id", uuid.uuid4().hex[:16])

                # Persist
                if self.db:
                    self.db.insert_vapi_call(
                        call_id=call_id,
                        org_id=org_id,
                        agent_name=agent_name,
                        phone_number=phone_number,
                        direction="outbound",
                        status="pending",
                        vapi_assistant_id=assistant_id,
                    )

                return {"call_id": call_id, "status": "initiated", "vapi_response": data}
        except Exception as exc:
            return {"error": str(exc)}

    async def end_call(self, call_id: str) -> dict[str, Any]:
        """End an active call via Vapi API."""
        if not self.api_key:
            return {"error": "Vapi API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.delete(
                    f"{self.base_url}/call/{call_id}",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                if resp.status_code not in (200, 204):
                    return {"error": f"Vapi API error: {resp.status_code}"}

                if self.db:
                    self.db.update_vapi_call(call_id, status="ended", ended_at=time.time())

                return {"ended": True, "call_id": call_id}
        except Exception as exc:
            return {"error": str(exc)}
