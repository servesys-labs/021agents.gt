"""Context summarization middleware.

When conversation messages grow beyond a token threshold, this middleware
compresses older messages into a summary to prevent context window overflow.

Strategy:
- Track estimated token count of messages
- When approaching the limit, summarize older turns (keep recent N)
- Replace summarized messages with a single system message containing the summary
- Preserve the system prompt and most recent messages
"""

from __future__ import annotations

import logging
from typing import Any

from agentos.middleware.base import Middleware, MiddlewareContext

logger = logging.getLogger(__name__)


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English."""
    return max(1, len(text) // 4)


def _messages_token_count(messages: list[dict[str, Any]]) -> int:
    """Estimate total tokens across all messages."""
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total += _estimate_tokens(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    total += _estimate_tokens(str(part.get("text", "")))
    return total


class SummarizationMiddleware(Middleware):
    """Summarizes older context when approaching token limits."""

    name = "summarization"
    order = 50  # Mid-priority — after safety, before content injection

    def __init__(
        self,
        max_context_tokens: int = 100_000,
        summarize_threshold_ratio: float = 0.75,
        keep_recent_turns: int = 6,
    ) -> None:
        self.max_context_tokens = max_context_tokens
        self.summarize_threshold = int(max_context_tokens * summarize_threshold_ratio)
        self.keep_recent_turns = keep_recent_turns
        self._total_summarizations: int = 0
        self._total_tokens_saved: int = 0

    async def before_model(self, ctx: MiddlewareContext) -> None:
        """Check token count and summarize if needed."""
        current_tokens = _messages_token_count(ctx.messages)
        if current_tokens < self.summarize_threshold:
            return

        # Split messages: system prompt + conversation
        system_msgs = [m for m in ctx.messages if m.get("role") == "system" and ctx.messages.index(m) == 0]
        convo_msgs = [m for m in ctx.messages if m not in system_msgs]

        if len(convo_msgs) <= self.keep_recent_turns * 2:
            return  # Not enough messages to summarize

        # Keep the most recent messages, summarize the rest
        keep_count = self.keep_recent_turns * 2  # user + assistant pairs
        to_summarize = convo_msgs[:-keep_count]
        to_keep = convo_msgs[-keep_count:]

        if not to_summarize:
            return

        # Build summary from older messages
        summary_parts = []
        for msg in to_summarize:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            if isinstance(content, str) and content.strip():
                truncated = content[:200] + ("..." if len(content) > 200 else "")
                summary_parts.append(f"[{role}] {truncated}")

        summary_text = (
            "[Context Summary — older messages compressed to save context space]\n"
            + "\n".join(summary_parts[:20])  # Cap at 20 entries
        )

        before_tokens = current_tokens
        # Rebuild messages: system + summary + recent
        new_messages = list(system_msgs)
        new_messages.append({"role": "system", "content": summary_text})
        new_messages.extend(to_keep)

        after_tokens = _messages_token_count(new_messages)
        saved = before_tokens - after_tokens

        ctx.messages.clear()
        ctx.messages.extend(new_messages)

        self._total_summarizations += 1
        self._total_tokens_saved += saved

        logger.info(
            "Summarized %d messages, saved ~%d tokens (%d → %d)",
            len(to_summarize), saved, before_tokens, after_tokens,
        )

    def stats(self) -> dict[str, Any]:
        return {
            "total_summarizations": self._total_summarizations,
            "total_tokens_saved": self._total_tokens_saved,
            "max_context_tokens": self.max_context_tokens,
        }
