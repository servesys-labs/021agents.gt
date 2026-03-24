"""Telegram Bot adapter for AgentOS agents.

Handles:
- Webhook setup and verification
- Incoming message parsing (text, photos, documents, voice)
- Reply sending (text, markdown, inline keyboards)
- Agent session management per chat ID
- File upload to R2 for RAG ingestion

Usage:
  1. Create a bot via @BotFather on Telegram
  2. Set TELEGRAM_BOT_TOKEN in your env
  3. Register webhook: POST /chat/telegram/setup?webhook_url=https://your-worker/chat/telegram/webhook
  4. Users message the bot → agent responds
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org"


@dataclass
class TelegramMessage:
    """Parsed Telegram message."""
    chat_id: int
    user_id: int
    username: str = ""
    first_name: str = ""
    text: str = ""
    message_id: int = 0
    is_command: bool = False
    command: str = ""
    command_args: str = ""
    has_photo: bool = False
    has_document: bool = False
    has_voice: bool = False
    file_id: str = ""
    caption: str = ""
    reply_to_message_id: int = 0
    timestamp: float = field(default_factory=time.time)

    @classmethod
    def from_update(cls, update: dict[str, Any]) -> TelegramMessage | None:
        """Parse a Telegram update into a message."""
        msg = update.get("message") or update.get("edited_message")
        if not msg:
            return None

        chat = msg.get("chat", {})
        user = msg.get("from", {})
        text = msg.get("text", "")

        result = cls(
            chat_id=chat.get("id", 0),
            user_id=user.get("id", 0),
            username=user.get("username", ""),
            first_name=user.get("first_name", ""),
            text=text,
            message_id=msg.get("message_id", 0),
            caption=msg.get("caption", ""),
            reply_to_message_id=msg.get("reply_to_message", {}).get("message_id", 0),
            timestamp=msg.get("date", time.time()),
        )

        # Parse commands (/start, /help, /ask <question>)
        if text.startswith("/"):
            parts = text.split(" ", 1)
            result.is_command = True
            result.command = parts[0].split("@")[0]  # Remove @botname suffix
            result.command_args = parts[1] if len(parts) > 1 else ""

        # Media
        if msg.get("photo"):
            result.has_photo = True
            result.file_id = msg["photo"][-1]["file_id"]  # Highest res
        if msg.get("document"):
            result.has_document = True
            result.file_id = msg["document"]["file_id"]
        if msg.get("voice"):
            result.has_voice = True
            result.file_id = msg["voice"]["file_id"]

        return result


class TelegramAdapter:
    """Telegram Bot API adapter.

    Handles webhook processing, message parsing, and reply sending.
    Each chat_id maps to an agent session for persistent context.
    """

    def __init__(self, bot_token: str = "", webhook_secret: str = ""):
        self.bot_token = bot_token
        self.webhook_secret = webhook_secret
        self._api_base = f"{TELEGRAM_API}/bot{bot_token}"

    def verify_webhook(self, request_body: bytes, secret_token: str) -> bool:
        """Verify Telegram webhook secret token header."""
        if not self.webhook_secret:
            return True
        return secret_token == self.webhook_secret

    def parse_update(self, payload: dict[str, Any]) -> TelegramMessage | None:
        """Parse an incoming Telegram update."""
        return TelegramMessage.from_update(payload)

    async def send_message(
        self,
        chat_id: int,
        text: str,
        reply_to: int = 0,
        parse_mode: str = "Markdown",
        keyboard: list[list[dict]] | None = None,
    ) -> dict[str, Any]:
        """Send a text message to a Telegram chat."""
        import httpx

        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text[:4096],  # Telegram limit
            "parse_mode": parse_mode,
        }
        if reply_to:
            payload["reply_to_message_id"] = reply_to
        if keyboard:
            payload["reply_markup"] = json.dumps({"inline_keyboard": keyboard})

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(f"{self._api_base}/sendMessage", json=payload)
                data = resp.json()
                if not data.get("ok"):
                    # Retry without markdown if parse fails
                    if "can't parse" in str(data.get("description", "")).lower():
                        payload["parse_mode"] = ""
                        resp = await client.post(f"{self._api_base}/sendMessage", json=payload)
                        data = resp.json()
                return data
        except Exception as exc:
            logger.error("Telegram send failed: %s", exc)
            return {"ok": False, "error": str(exc)}

    async def send_typing(self, chat_id: int) -> None:
        """Send typing indicator."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    f"{self._api_base}/sendChatAction",
                    json={"chat_id": chat_id, "action": "typing"},
                )
        except Exception:
            pass

    async def get_file_url(self, file_id: str) -> str | None:
        """Get download URL for a file by file_id."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{self._api_base}/getFile", params={"file_id": file_id})
                data = resp.json()
                if data.get("ok"):
                    file_path = data["result"]["file_path"]
                    return f"{TELEGRAM_API}/file/bot{self.bot_token}/{file_path}"
        except Exception as exc:
            logger.error("Get file failed: %s", exc)
        return None

    async def download_file(self, file_id: str) -> bytes | None:
        """Download a file from Telegram servers."""
        import httpx
        url = await self.get_file_url(file_id)
        if not url:
            return None
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(url)
                return resp.content
        except Exception as exc:
            logger.error("File download failed: %s", exc)
            return None

    async def setup_webhook(self, webhook_url: str, secret_token: str = "") -> dict[str, Any]:
        """Register a webhook URL with Telegram."""
        import httpx
        payload: dict[str, Any] = {
            "url": webhook_url,
            "allowed_updates": ["message", "edited_message", "callback_query"],
        }
        if secret_token:
            payload["secret_token"] = secret_token
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(f"{self._api_base}/setWebhook", json=payload)
                return resp.json()
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def delete_webhook(self) -> dict[str, Any]:
        """Remove the webhook."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(f"{self._api_base}/deleteWebhook")
                return resp.json()
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
