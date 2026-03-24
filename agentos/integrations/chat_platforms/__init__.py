"""Chat platform adapters — Telegram, Discord, Slack, WhatsApp.

Each adapter handles:
  - Webhook verification
  - Message parsing (text, media, commands)
  - Reply formatting
  - Platform-specific features (inline keyboards, threads, etc.)
"""

from agentos.integrations.chat_platforms.telegram import TelegramAdapter

__all__ = ["TelegramAdapter"]
