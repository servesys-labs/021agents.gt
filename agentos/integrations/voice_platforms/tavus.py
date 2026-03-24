"""Tavus video AI platform adapter.

Tavus is a video AI platform for creating personalized video agents. This adapter handles:
- Conversation creation with video personas
- Inbound webhook processing (conversation events)
- Conversation management (get, end)

Tavus webhook events:
  - conversation.started: Conversation initiated
  - conversation.ended: Conversation completed (includes duration, transcript)
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
class TavusConversation:
    """Represents a Tavus video conversation."""

    conversation_id: str = ""
    org_id: str = ""
    agent_name: str = ""
    persona_id: str = ""
    status: str = "pending"  # pending/started/ended/failed
    duration_seconds: float = 0.0
    transcript: str = ""
    cost_usd: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)
    started_at: float = 0.0
    ended_at: float = 0.0
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "org_id": self.org_id,
            "agent_name": self.agent_name,
            "persona_id": self.persona_id,
            "status": self.status,
            "duration_seconds": self.duration_seconds,
            "transcript": self.transcript,
            "cost_usd": self.cost_usd,
            "metadata": self.metadata,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "created_at": self.created_at,
        }


@dataclass
class TavusWebhookEvent:
    """Parsed Tavus webhook event."""

    event_type: str  # conversation.started, conversation.ended
    conversation_id: str = ""
    timestamp: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> TavusWebhookEvent:
        """Parse a Tavus webhook payload into an event."""
        event_type = payload.get("event", payload.get("type", "unknown"))

        conversation_id = (
            payload.get("conversation_id", "")
            or payload.get("conversation", {}).get("id", "")
            or ""
        )

        return cls(
            event_type=event_type,
            conversation_id=conversation_id,
            timestamp=time.time(),
            data=payload,
        )


class TavusAdapter:
    """Adapter for Tavus video AI platform.

    Handles:
    - Webhook verification and event processing
    - Conversation lifecycle management (create, end, get)
    - Transcript extraction
    """

    def __init__(
        self,
        api_key: str = "",
        webhook_secret: str = "",
        base_url: str = "https://api.tavus.io/v2",
        db: Any = None,
    ):
        self.api_key = api_key
        self.webhook_secret = webhook_secret
        self.base_url = base_url
        self.db = db

    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        """Verify Tavus webhook signature."""
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
        """Process a Tavus webhook event."""
        event = TavusWebhookEvent.from_payload(payload)

        result: dict[str, Any] = {
            "event_type": event.event_type,
            "conversation_id": event.conversation_id,
            "processed": True,
        }

        if event.event_type == "conversation.started":
            result.update(self._handle_conversation_started(event, org_id))
        elif event.event_type == "conversation.ended":
            result.update(self._handle_conversation_ended(event, org_id))

        # Persist event
        if self.db and event.conversation_id:
            try:
                self.db.insert_voice_event(
                    call_id=event.conversation_id,
                    event_type=event.event_type,
                    payload_json=json.dumps(payload),
                    org_id=org_id,
                    platform="tavus",
                )
            except Exception as exc:
                logger.debug("Failed to persist Tavus event: %s", exc)

        return result

    def _handle_conversation_started(
        self, event: TavusWebhookEvent, org_id: str,
    ) -> dict[str, Any]:
        """Handle conversation started event."""
        conversation = TavusConversation(
            conversation_id=event.conversation_id or uuid.uuid4().hex[:16],
            org_id=org_id,
            persona_id=event.data.get("persona_id", ""),
            status="started",
            started_at=time.time(),
        )

        if self.db:
            try:
                self.db.insert_voice_call(**conversation.to_dict(), platform="tavus")
            except Exception as exc:
                logger.debug("Failed to persist Tavus conversation: %s", exc)

        return {"conversation": conversation.to_dict()}

    def _handle_conversation_ended(
        self, event: TavusWebhookEvent, org_id: str,
    ) -> dict[str, Any]:
        """Handle conversation ended event."""
        duration = float(event.data.get("duration", 0) or 0)
        transcript = event.data.get("transcript", "") or ""

        if self.db and event.conversation_id:
            try:
                self.db.update_voice_call(
                    event.conversation_id,
                    status="ended",
                    duration_seconds=duration,
                    transcript=transcript[:5000],
                    ended_at=time.time(),
                    platform="tavus",
                )
            except Exception:
                pass

        return {
            "duration_seconds": duration,
            "transcript_length": len(transcript),
        }

    async def create_conversation(
        self,
        persona_id: str,
        context: str = "",
        agent_name: str = "",
        org_id: str = "",
        properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a video conversation via Tavus API."""
        if not self.api_key:
            return {"error": "Tavus API key not configured"}

        import httpx

        payload: dict[str, Any] = {
            "persona_id": persona_id,
        }
        if context:
            payload["conversational_context"] = context
        if properties:
            payload["properties"] = properties

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.base_url}/conversations",
                    headers={
                        "x-api-key": self.api_key,
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                if resp.status_code not in (200, 201):
                    return {"error": f"Tavus API error: {resp.status_code} {resp.text[:300]}"}

                data = resp.json()
                conversation_id = data.get(
                    "conversation_id", data.get("id", uuid.uuid4().hex[:16]),
                )

                # Persist
                if self.db:
                    self.db.insert_voice_call(
                        call_id=conversation_id,
                        org_id=org_id,
                        agent_name=agent_name,
                        persona_id=persona_id,
                        status="pending",
                        platform="tavus",
                    )

                return {
                    "conversation_id": conversation_id,
                    "status": "initiated",
                    "tavus_response": data,
                }
        except Exception as exc:
            return {"error": str(exc)}

    async def end_conversation(self, conversation_id: str) -> dict[str, Any]:
        """End an active conversation via Tavus API."""
        if not self.api_key:
            return {"error": "Tavus API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{self.base_url}/conversations/{conversation_id}/end",
                    headers={"x-api-key": self.api_key},
                )
                if resp.status_code not in (200, 204):
                    return {"error": f"Tavus API error: {resp.status_code}"}

                if self.db:
                    self.db.update_voice_call(
                        conversation_id,
                        status="ended",
                        ended_at=time.time(),
                        platform="tavus",
                    )

                return {"ended": True, "conversation_id": conversation_id}
        except Exception as exc:
            return {"error": str(exc)}

    async def get_conversation(self, conversation_id: str) -> dict[str, Any]:
        """Get conversation details via Tavus API."""
        if not self.api_key:
            return {"error": "Tavus API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{self.base_url}/conversations/{conversation_id}",
                    headers={"x-api-key": self.api_key},
                )
                if resp.status_code != 200:
                    return {"error": f"Tavus API error: {resp.status_code}"}

                return resp.json()
        except Exception as exc:
            return {"error": str(exc)}
