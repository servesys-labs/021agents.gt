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
MAX_MESSAGE_LENGTH = 4096
MAX_CAPTION_LENGTH = 1024

# Text-readable document extensions (content injected into message for agent)
TEXT_DOC_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".log", ".py", ".js", ".ts", ".html", ".css"}
SUPPORTED_DOC_EXTENSIONS = {".pdf", ".md", ".docx", ".xlsx", ".pptx", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml"}
MAX_TEXT_INJECT_SIZE = 100_000  # 100KB


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
    has_audio: bool = False
    has_video: bool = False
    has_sticker: bool = False
    file_id: str = ""
    file_name: str = ""
    mime_type: str = ""
    caption: str = ""
    reply_to_message_id: int = 0
    chat_type: str = "private"
    media_group_id: str = ""
    timestamp: float = field(default_factory=time.time)

    @property
    def has_media(self) -> bool:
        return self.has_photo or self.has_document or self.has_voice or self.has_audio or self.has_video

    @property
    def content_text(self) -> str:
        """Return text or caption, whichever is available."""
        return self.text or self.caption

    @property
    def is_group(self) -> bool:
        return self.chat_type in ("group", "supergroup")

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
            chat_type=chat.get("type", "private"),
            media_group_id=msg.get("media_group_id", ""),
            timestamp=msg.get("date", time.time()),
        )

        # Parse commands (/start, /help, /ask <question>)
        if text.startswith("/"):
            parts = text.split(" ", 1)
            result.is_command = True
            result.command = parts[0].split("@")[0]  # Remove @botname suffix
            result.command_args = parts[1] if len(parts) > 1 else ""

        # Media — photos
        if msg.get("photo"):
            result.has_photo = True
            result.file_id = msg["photo"][-1]["file_id"]  # Highest res

        # Documents
        if msg.get("document"):
            result.has_document = True
            result.file_id = msg["document"]["file_id"]
            result.file_name = msg["document"].get("file_name", "")
            result.mime_type = msg["document"].get("mime_type", "")

        # Voice messages
        if msg.get("voice"):
            result.has_voice = True
            result.file_id = msg["voice"]["file_id"]
            result.mime_type = msg["voice"].get("mime_type", "audio/ogg")

        # Audio files
        if msg.get("audio"):
            result.has_audio = True
            result.file_id = msg["audio"]["file_id"]
            result.file_name = msg["audio"].get("file_name", "")
            result.mime_type = msg["audio"].get("mime_type", "audio/mpeg")

        # Video
        if msg.get("video"):
            result.has_video = True
            result.file_id = msg["video"]["file_id"]
            result.mime_type = msg["video"].get("mime_type", "video/mp4")

        # Sticker
        if msg.get("sticker"):
            result.has_sticker = True
            result.file_id = msg["sticker"]["file_id"]

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
        self._bot_info: dict[str, Any] | None = None

    def verify_webhook(self, request_body: bytes, secret_token: str) -> bool:
        """Verify Telegram webhook secret token header."""
        if not self.webhook_secret:
            return True
        return secret_token == self.webhook_secret

    def parse_update(self, payload: dict[str, Any]) -> TelegramMessage | None:
        """Parse an incoming Telegram update."""
        return TelegramMessage.from_update(payload)

    # ── Bot info ──────────────────────────────────────────────────────

    async def get_bot_info(self) -> dict[str, Any]:
        """Get bot info (cached). Returns {id, username, first_name}."""
        if self._bot_info:
            return self._bot_info
        import httpx
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{self._api_base}/getMe")
                data = resp.json()
                if data.get("ok"):
                    self._bot_info = data["result"]
                    return self._bot_info
        except Exception as exc:
            logger.error("getMe failed: %s", exc)
        return {"id": 0, "username": "", "first_name": ""}

    # ── Group message filtering ───────────────────────────────────────

    async def should_process_group_message(
        self,
        message: TelegramMessage,
        raw_message: dict[str, Any],
    ) -> bool:
        """Check if a group message is addressed to the bot.

        Returns True if the message should be processed:
        - Always True for DMs
        - True for commands
        - True if replying to the bot
        - True if @mentioning the bot
        """
        if not message.is_group:
            return True
        if message.is_command:
            return True

        bot_info = await self.get_bot_info()
        bot_id = bot_info.get("id", 0)
        bot_username = bot_info.get("username", "")

        # Check reply-to-bot
        reply_to = raw_message.get("reply_to_message", {})
        if reply_to.get("from", {}).get("id") == bot_id:
            return True

        # Check @mention in text
        text = message.content_text.lower()
        if bot_username and f"@{bot_username.lower()}" in text:
            return True

        # Check entities for mentions
        entities = raw_message.get("entities", []) or raw_message.get("caption_entities", [])
        full_text = message.content_text
        for ent in entities:
            if ent.get("type") == "mention":
                mention = full_text[ent["offset"]:ent["offset"] + ent["length"]]
                if bot_username and mention.lower() == f"@{bot_username.lower()}":
                    return True
            if ent.get("type") == "text_mention" and ent.get("user", {}).get("id") == bot_id:
                return True

        return False

    def strip_bot_mention(self, text: str) -> str:
        """Remove @botname from text for cleaner agent input."""
        import re
        if self._bot_info and self._bot_info.get("username"):
            username = self._bot_info["username"]
            text = re.sub(rf"@{re.escape(username)}\b", "", text, flags=re.IGNORECASE).strip()
        return text

    # ── Message sending ───────────────────────────────────────────────

    @staticmethod
    def chunk_message(text: str, max_len: int = MAX_MESSAGE_LENGTH) -> list[str]:
        """Split a long message into chunks, preserving code blocks."""
        if len(text) <= max_len:
            return [text]

        chunks: list[str] = []
        remaining = text
        inside_code = False
        code_lang = ""

        while remaining:
            if len(remaining) <= max_len:
                chunks.append(remaining)
                break

            reserve = 20
            split_at = max_len - reserve

            # Find natural split point
            best = -1
            double_nl = remaining.rfind("\n\n", 0, split_at)
            if double_nl > max_len * 0.3:
                best = double_nl + 1
            if best == -1:
                nl = remaining.rfind("\n", 0, split_at)
                if nl > max_len * 0.3:
                    best = nl + 1
            if best == -1:
                sp = remaining.rfind(" ", 0, split_at)
                if sp > max_len * 0.3:
                    best = sp + 1
            if best == -1:
                best = split_at

            chunk = remaining[:best]
            remaining = remaining[best:]

            # Track code fences
            fence_count = chunk.count("```")
            if inside_code:
                chunk = f"```{code_lang}\n{chunk}"

            total = (1 if inside_code else 0) + fence_count
            if total % 2 == 1:
                chunk += "\n```"
                inside_code = True
                import re
                lang_match = re.search(r"```(\w+)", chunk)
                code_lang = lang_match.group(1) if lang_match else ""
            else:
                inside_code = False
                code_lang = ""

            chunks.append(chunk)

        if len(chunks) > 1:
            chunks = [f"{c}\n({i+1}/{len(chunks)})" for i, c in enumerate(chunks)]
        return chunks

    async def send_message(
        self,
        chat_id: int,
        text: str,
        reply_to: int = 0,
        parse_mode: str = "Markdown",
        keyboard: list[list[dict]] | None = None,
    ) -> list[dict[str, Any]]:
        """Send a text message with auto-chunking for long messages."""
        import httpx

        chunks = self.chunk_message(text)
        results = []

        for i, chunk in enumerate(chunks):
            payload: dict[str, Any] = {
                "chat_id": chat_id,
                "text": chunk,
                "parse_mode": parse_mode,
            }
            # Reply-to only on first chunk
            if i == 0 and reply_to:
                payload["reply_to_message_id"] = reply_to
            if keyboard and i == len(chunks) - 1:
                payload["reply_markup"] = json.dumps({"inline_keyboard": keyboard})

            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.post(f"{self._api_base}/sendMessage", json=payload)
                    data = resp.json()
                    if not data.get("ok"):
                        if "can't parse" in str(data.get("description", "")).lower():
                            payload["parse_mode"] = ""
                            resp = await client.post(f"{self._api_base}/sendMessage", json=payload)
                            data = resp.json()
                    results.append(data)
            except Exception as exc:
                logger.error("Telegram send failed (chunk %d): %s", i, exc)
                results.append({"ok": False, "error": str(exc)})

        return results

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

    # ── Media sending ─────────────────────────────────────────────────

    async def send_photo(
        self,
        chat_id: int,
        photo: str,
        caption: str = "",
        reply_to: int = 0,
    ) -> dict[str, Any]:
        """Send a photo (URL or file_id)."""
        import httpx
        payload: dict[str, Any] = {"chat_id": chat_id, "photo": photo}
        if caption:
            payload["caption"] = caption[:MAX_CAPTION_LENGTH]
        if reply_to:
            payload["reply_to_message_id"] = reply_to
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(f"{self._api_base}/sendPhoto", json=payload)
                data = resp.json()
                if not data.get("ok"):
                    logger.warning("sendPhoto failed: %s", data.get("description"))
                return data
        except Exception as exc:
            logger.error("sendPhoto failed: %s", exc)
            return {"ok": False, "error": str(exc)}

    async def send_photo_file(
        self,
        chat_id: int,
        photo_bytes: bytes,
        filename: str = "photo.jpg",
        caption: str = "",
        reply_to: int = 0,
    ) -> dict[str, Any]:
        """Send a photo from bytes (up to 10MB)."""
        import httpx
        data: dict[str, Any] = {"chat_id": str(chat_id)}
        if caption:
            data["caption"] = caption[:MAX_CAPTION_LENGTH]
        if reply_to:
            data["reply_to_message_id"] = str(reply_to)
        files = {"photo": (filename, photo_bytes)}
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(f"{self._api_base}/sendPhoto", data=data, files=files)
                return resp.json()
        except Exception as exc:
            logger.error("sendPhoto (file) failed: %s", exc)
            return {"ok": False, "error": str(exc)}

    async def send_document(
        self,
        chat_id: int,
        document: str,
        caption: str = "",
        filename: str = "",
        reply_to: int = 0,
    ) -> dict[str, Any]:
        """Send a document (URL or file_id)."""
        import httpx
        payload: dict[str, Any] = {"chat_id": chat_id, "document": document}
        if caption:
            payload["caption"] = caption[:MAX_CAPTION_LENGTH]
        if reply_to:
            payload["reply_to_message_id"] = reply_to
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(f"{self._api_base}/sendDocument", json=payload)
                return resp.json()
        except Exception as exc:
            logger.error("sendDocument failed: %s", exc)
            return {"ok": False, "error": str(exc)}

    async def send_voice(
        self,
        chat_id: int,
        voice: str,
        caption: str = "",
        reply_to: int = 0,
    ) -> dict[str, Any]:
        """Send a voice message (OGG/opus for native bubble, else audio)."""
        import httpx
        # OGG/Opus → voice bubble; others → audio file
        is_ogg = voice.lower().endswith((".ogg", ".opus"))
        method = "sendVoice" if is_ogg else "sendAudio"
        key = "voice" if is_ogg else "audio"

        payload: dict[str, Any] = {"chat_id": chat_id, key: voice}
        if caption:
            payload["caption"] = caption[:MAX_CAPTION_LENGTH]
        if reply_to:
            payload["reply_to_message_id"] = reply_to
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(f"{self._api_base}/{method}", json=payload)
                return resp.json()
        except Exception as exc:
            logger.error("%s failed: %s", method, exc)
            return {"ok": False, "error": str(exc)}

    # ── File handling ─────────────────────────────────────────────────

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

    async def get_file_info(self, file_id: str) -> dict[str, Any] | None:
        """Get file info including path and size."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{self._api_base}/getFile", params={"file_id": file_id})
                data = resp.json()
                if data.get("ok"):
                    return data["result"]
        except Exception as exc:
            logger.error("Get file info failed: %s", exc)
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

    async def download_file_with_info(self, file_id: str) -> tuple[bytes | None, str]:
        """Download a file and return (bytes, file_path)."""
        import httpx
        info = await self.get_file_info(file_id)
        if not info:
            return None, ""
        file_path = info.get("file_path", "")
        url = f"{TELEGRAM_API}/file/bot{self.bot_token}/{file_path}"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(url)
                return resp.content, file_path
        except Exception as exc:
            logger.error("File download failed: %s", exc)
            return None, file_path

    # ── Message building helpers ──────────────────────────────────────

    async def build_agent_input(self, message: TelegramMessage) -> tuple[str, list[str], list[str]]:
        """Build agent input text from a message, handling media.

        Returns (input_text, media_urls, media_types).
        """
        parts: list[str] = []
        media_urls: list[str] = []
        media_types: list[str] = []

        # Text content (strip bot mention)
        text = message.content_text
        if message.is_command and message.command == "/ask":
            text = message.command_args
        text = self.strip_bot_mention(text)
        if text:
            parts.append(text)

        # Handle media
        if message.has_media and message.file_id:
            file_url = await self.get_file_url(message.file_id)
            if file_url:
                media_urls.append(file_url)

                if message.has_photo:
                    media_types.append("image")
                    parts.append("[User sent a photo]")

                elif message.has_voice:
                    media_types.append("audio/ogg")
                    parts.append("[User sent a voice message]")

                elif message.has_audio:
                    media_types.append(message.mime_type or "audio/mpeg")
                    label = f"[User sent audio: {message.file_name}]" if message.file_name else "[User sent audio]"
                    parts.append(label)

                elif message.has_document:
                    media_types.append(message.mime_type or "application/octet-stream")
                    parts.append(f"[User sent document: {message.file_name or 'file'}]")

                    # Inject text content for readable documents
                    ext = ""
                    if message.file_name:
                        import os
                        ext = os.path.splitext(message.file_name)[1].lower()
                    if ext in TEXT_DOC_EXTENSIONS or (message.mime_type and message.mime_type.startswith("text/")):
                        content = await self.download_file(message.file_id)
                        if content and len(content) < MAX_TEXT_INJECT_SIZE:
                            try:
                                text_content = content.decode("utf-8")
                                parts.append(f"[Content of {message.file_name}]:\n{text_content}")
                            except UnicodeDecodeError:
                                pass

                elif message.has_video:
                    media_types.append(message.mime_type or "video/mp4")
                    parts.append("[User sent a video]")

        return "\n".join(parts), media_urls, media_types

    # ── Webhook management ────────────────────────────────────────────

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
