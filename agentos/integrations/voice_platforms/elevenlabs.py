"""ElevenLabs voice platform adapter.

ElevenLabs is a voice AI platform focused on:
- Text-to-speech with voice cloning
- Conversational AI agents (voice agents)
- Real-time streaming audio

This adapter handles:
- Conversational AI session creation and management
- Inbound webhook processing (conversation events, audio generation)
- Voice listing and speech generation
- Webhook signature verification

ElevenLabs webhook events:
  - conversation.initiated: Conversation session created
  - conversation.started: Conversation actively connected
  - conversation.ended: Conversation completed
  - audio.generated: TTS audio chunk generated
  - error: Error during conversation or generation
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
class ElevenLabsConversation:
    """Represents an ElevenLabs conversational AI session."""

    conversation_id: str = ""
    org_id: str = ""
    agent_name: str = ""
    voice_id: str = ""
    status: str = "pending"  # pending/active/ended
    duration_seconds: float = 0.0
    transcript: str = ""
    cost_usd: float = 0.0
    elevenlabs_agent_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    started_at: float = 0.0
    ended_at: float = 0.0
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "org_id": self.org_id,
            "agent_name": self.agent_name,
            "voice_id": self.voice_id,
            "status": self.status,
            "duration_seconds": self.duration_seconds,
            "transcript": self.transcript,
            "cost_usd": self.cost_usd,
            "elevenlabs_agent_id": self.elevenlabs_agent_id,
            "metadata": self.metadata,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "created_at": self.created_at,
        }


@dataclass
class ElevenLabsWebhookEvent:
    """Parsed ElevenLabs webhook event."""

    event_type: str  # conversation.initiated, conversation.started, etc.
    conversation_id: str = ""
    timestamp: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> ElevenLabsWebhookEvent:
        """Parse an ElevenLabs webhook payload into an event."""
        event_type = payload.get("event", payload.get("type", "unknown"))

        # Extract conversation ID from various payload locations
        conversation_id = (
            payload.get("conversation_id", "")
            or payload.get("data", {}).get("conversation_id", "")
            or payload.get("conversation", {}).get("id", "")
            or ""
        )

        return cls(
            event_type=event_type,
            conversation_id=conversation_id,
            timestamp=time.time(),
            data=payload,
        )


class ElevenLabsAdapter:
    """Adapter for ElevenLabs voice AI platform.

    Handles:
    - Webhook verification and event processing
    - Conversation lifecycle management
    - Voice listing and text-to-speech generation
    - Transcript aggregation
    """

    def __init__(
        self,
        api_key: str = "",
        webhook_secret: str = "",
        base_url: str = "https://api.elevenlabs.io/v1",
        db: Any = None,
    ):
        self.api_key = api_key
        self.webhook_secret = webhook_secret
        self.base_url = base_url
        self.db = db

    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        """Verify ElevenLabs webhook signature (HMAC SHA-256)."""
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
        """Process an ElevenLabs webhook event."""
        event = ElevenLabsWebhookEvent.from_payload(payload)

        result: dict[str, Any] = {
            "event_type": event.event_type,
            "conversation_id": event.conversation_id,
            "processed": True,
        }

        if event.event_type == "conversation.initiated":
            result.update(self._handle_conversation_initiated(event, org_id))
        elif event.event_type == "conversation.started":
            result.update(self._handle_conversation_started(event, org_id))
        elif event.event_type == "conversation.ended":
            result.update(self._handle_conversation_ended(event, org_id))
        elif event.event_type == "audio.generated":
            result.update(self._handle_audio_generated(event))
        elif event.event_type == "error":
            result.update(self._handle_error(event))

        # Persist event
        if self.db and event.conversation_id:
            try:
                self.db.insert_voice_event(
                    call_id=event.conversation_id,
                    event_type=event.event_type,
                    payload_json=json.dumps(payload),
                    org_id=org_id,
                    platform="elevenlabs",
                )
            except Exception as exc:
                logger.debug("Failed to persist ElevenLabs event: %s", exc)

        return result

    def _handle_conversation_initiated(
        self, event: ElevenLabsWebhookEvent, org_id: str
    ) -> dict[str, Any]:
        """Handle conversation initiated event."""
        data = event.data.get("data", event.data)
        conversation = ElevenLabsConversation(
            conversation_id=event.conversation_id or uuid.uuid4().hex[:16],
            org_id=org_id,
            agent_name=data.get("agent_name", ""),
            voice_id=data.get("voice_id", ""),
            status="pending",
            elevenlabs_agent_id=data.get("agent_id", ""),
            metadata=data.get("metadata", {}),
        )

        if self.db:
            try:
                self.db.insert_voice_call(
                    **conversation.to_dict(),
                    platform="elevenlabs",
                )
            except Exception as exc:
                logger.debug("Failed to persist ElevenLabs conversation: %s", exc)

        return {"conversation": conversation.to_dict()}

    def _handle_conversation_started(
        self, event: ElevenLabsWebhookEvent, org_id: str
    ) -> dict[str, Any]:
        """Handle conversation started (actively connected) event."""
        if self.db and event.conversation_id:
            try:
                self.db.update_voice_call(
                    event.conversation_id,
                    status="active",
                    started_at=time.time(),
                    platform="elevenlabs",
                )
            except Exception as exc:
                logger.debug("Failed to update ElevenLabs conversation: %s", exc)

        return {"status": "active"}

    def _handle_conversation_ended(
        self, event: ElevenLabsWebhookEvent, org_id: str
    ) -> dict[str, Any]:
        """Handle conversation ended event."""
        data = event.data.get("data", event.data)
        duration = float(data.get("duration_seconds", 0) or 0)
        cost = float(data.get("cost_usd", 0) or data.get("cost", 0) or 0)
        transcript = data.get("transcript", "") or data.get("summary", "")

        if self.db and event.conversation_id:
            try:
                self.db.update_voice_call(
                    event.conversation_id,
                    status="ended",
                    duration_seconds=duration,
                    cost_usd=cost,
                    transcript=transcript[:5000],
                    ended_at=time.time(),
                    platform="elevenlabs",
                )
            except Exception:
                pass

        return {
            "duration_seconds": duration,
            "cost_usd": cost,
            "transcript_length": len(transcript),
        }

    def _handle_audio_generated(self, event: ElevenLabsWebhookEvent) -> dict[str, Any]:
        """Handle audio generated event."""
        data = event.data.get("data", event.data)
        return {
            "audio_format": data.get("format", "mp3"),
            "audio_size_bytes": data.get("size_bytes", 0),
            "voice_id": data.get("voice_id", ""),
        }

    def _handle_error(self, event: ElevenLabsWebhookEvent) -> dict[str, Any]:
        """Handle error event."""
        data = event.data.get("data", event.data)
        error_msg = data.get("message", "") or data.get("error", "unknown error")
        error_code = data.get("code", "")

        logger.warning(
            "ElevenLabs error for conversation %s: [%s] %s",
            event.conversation_id,
            error_code,
            error_msg,
        )

        if self.db and event.conversation_id:
            try:
                self.db.update_voice_call(
                    event.conversation_id,
                    status="ended",
                    ended_at=time.time(),
                    platform="elevenlabs",
                )
            except Exception:
                pass

        return {
            "error": True,
            "error_code": error_code,
            "error_message": error_msg,
        }

    async def create_conversation(
        self,
        agent_id: str,
        first_message: str = "",
        agent_name: str = "",
        org_id: str = "",
    ) -> dict[str, Any]:
        """Create a conversational AI session via ElevenLabs API."""
        if not self.api_key:
            return {"error": "ElevenLabs API key not configured"}

        import httpx

        payload: dict[str, Any] = {
            "agent_id": agent_id,
        }
        if first_message:
            payload["first_message"] = first_message

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.base_url}/convai/conversations",
                    headers={
                        "xi-api-key": self.api_key,
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                if resp.status_code not in (200, 201):
                    return {"error": f"ElevenLabs API error: {resp.status_code} {resp.text[:300]}"}

                data = resp.json()
                conversation_id = data.get("conversation_id", uuid.uuid4().hex[:16])

                # Persist
                if self.db:
                    self.db.insert_voice_call(
                        conversation_id=conversation_id,
                        org_id=org_id,
                        agent_name=agent_name,
                        status="pending",
                        elevenlabs_agent_id=agent_id,
                        platform="elevenlabs",
                    )

                return {
                    "conversation_id": conversation_id,
                    "status": "initiated",
                    "elevenlabs_response": data,
                }
        except Exception as exc:
            return {"error": str(exc)}

    async def end_conversation(self, conversation_id: str) -> dict[str, Any]:
        """End an active conversation via ElevenLabs API."""
        if not self.api_key:
            return {"error": "ElevenLabs API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.delete(
                    f"{self.base_url}/convai/conversations/{conversation_id}",
                    headers={"xi-api-key": self.api_key},
                )
                if resp.status_code not in (200, 204):
                    return {"error": f"ElevenLabs API error: {resp.status_code}"}

                if self.db:
                    self.db.update_voice_call(
                        conversation_id,
                        status="ended",
                        ended_at=time.time(),
                        platform="elevenlabs",
                    )

                return {"ended": True, "conversation_id": conversation_id}
        except Exception as exc:
            return {"error": str(exc)}

    async def list_voices(self) -> dict[str, Any]:
        """List available voices via ElevenLabs API."""
        if not self.api_key:
            return {"error": "ElevenLabs API key not configured"}

        import httpx

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(
                    f"{self.base_url}/voices",
                    headers={"xi-api-key": self.api_key},
                )
                if resp.status_code != 200:
                    return {"error": f"ElevenLabs API error: {resp.status_code} {resp.text[:300]}"}

                data = resp.json()
                voices = data.get("voices", [])
                return {
                    "voices": [
                        {
                            "voice_id": v.get("voice_id", ""),
                            "name": v.get("name", ""),
                            "category": v.get("category", ""),
                            "labels": v.get("labels", {}),
                            "preview_url": v.get("preview_url", ""),
                        }
                        for v in voices
                    ],
                    "count": len(voices),
                }
        except Exception as exc:
            return {"error": str(exc)}

    async def generate_speech(
        self,
        text: str,
        voice_id: str,
        model_id: str = "eleven_multilingual_v2",
    ) -> dict[str, Any]:
        """Generate speech audio via ElevenLabs text-to-speech API."""
        if not self.api_key:
            return {"error": "ElevenLabs API key not configured"}

        import httpx

        payload: dict[str, Any] = {
            "text": text,
            "model_id": model_id,
        }

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{self.base_url}/text-to-speech/{voice_id}",
                    headers={
                        "xi-api-key": self.api_key,
                        "Content-Type": "application/json",
                        "Accept": "audio/mpeg",
                    },
                    json=payload,
                )
                if resp.status_code != 200:
                    return {"error": f"ElevenLabs API error: {resp.status_code} {resp.text[:300]}"}

                return {
                    "audio": resp.content,
                    "content_type": resp.headers.get("content-type", "audio/mpeg"),
                    "size_bytes": len(resp.content),
                    "voice_id": voice_id,
                    "model_id": model_id,
                }
        except Exception as exc:
            return {"error": str(exc)}
