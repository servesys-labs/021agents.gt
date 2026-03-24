"""Loop detection middleware — Safety P0.

Detects when an agent is stuck in a repetitive tool-call loop and
intervenes with a warning, then a hard stop.

Strategy:
- Hash each set of tool calls (name + normalized args) per turn
- Track hashes in a sliding window (last N tool calls)
- Warn threshold: 3 identical consecutive calls → inject warning message
- Hard limit: 5 identical calls → strip tool_calls, force text output

This prevents runaway agents from burning budget on infinite loops.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections import OrderedDict
from typing import Any

from agentos.core.events import EventType
from agentos.middleware.base import Middleware, MiddlewareContext

logger = logging.getLogger(__name__)


class LoopDetectionMiddleware(Middleware):
    """Detects and breaks repetitive tool-call loops."""

    name = "loop_detection"
    order = 10  # Run early — safety middleware

    def __init__(
        self,
        warn_threshold: int = 3,
        hard_limit: int = 5,
        window_size: int = 20,
        max_tracked_sessions: int = 100,
    ) -> None:
        self.warn_threshold = warn_threshold
        self.hard_limit = hard_limit
        self.window_size = window_size
        self.max_tracked_sessions = max_tracked_sessions

        # Per-session tracking: session_id -> list of tool-call hashes
        self._session_hashes: OrderedDict[str, list[str]] = OrderedDict()
        # Per-session consecutive-repeat counters
        self._repeat_counts: dict[str, int] = {}
        # Stats
        self._total_warnings: int = 0
        self._total_hard_stops: int = 0

    def _hash_tool_calls(self, tool_calls: list[dict[str, Any]]) -> str:
        """Create a stable hash of a set of tool calls."""
        normalized = []
        for tc in sorted(tool_calls, key=lambda t: t.get("name", "")):
            entry = {
                "name": tc.get("name", ""),
                "arguments": tc.get("arguments", {}),
            }
            normalized.append(entry)
        raw = json.dumps(normalized, sort_keys=True, default=str)
        return hashlib.md5(raw.encode()).hexdigest()[:12]

    def _get_hashes(self, session_id: str) -> list[str]:
        """Get or create the hash list for a session."""
        if session_id not in self._session_hashes:
            # Evict oldest if at capacity
            if len(self._session_hashes) >= self.max_tracked_sessions:
                oldest = next(iter(self._session_hashes))
                del self._session_hashes[oldest]
                self._repeat_counts.pop(oldest, None)
            self._session_hashes[session_id] = []
        # Move to end (LRU)
        self._session_hashes.move_to_end(session_id)
        return self._session_hashes[session_id]

    async def after_model(self, ctx: MiddlewareContext) -> None:
        """Check if the LLM response contains a repeated tool-call pattern."""
        if not ctx.llm_response or not ctx.llm_response.tool_calls:
            return

        session_id = ctx.session_id or "default"
        hashes = self._get_hashes(session_id)
        current_hash = self._hash_tool_calls(ctx.llm_response.tool_calls)

        # Add to sliding window
        hashes.append(current_hash)
        if len(hashes) > self.window_size:
            hashes.pop(0)

        # Count consecutive repeats from the end
        consecutive = 0
        for h in reversed(hashes):
            if h == current_hash:
                consecutive += 1
            else:
                break

        self._repeat_counts[session_id] = consecutive

        if consecutive >= self.hard_limit:
            # Hard stop: strip tool calls, force text response
            self._total_hard_stops += 1
            logger.warning(
                "Loop detection HARD STOP: %d identical tool-call sets in session %s",
                consecutive, session_id,
            )
            ctx.force_text_response = True
            ctx.llm_response.tool_calls = []
            ctx.injected_messages.append({
                "role": "system",
                "content": (
                    "LOOP DETECTED: You have made the same tool calls "
                    f"{consecutive} times in a row. This is a hard stop. "
                    "You MUST take a different approach or provide a final "
                    "text response. Do NOT repeat the same tool calls."
                ),
            })
            await ctx.emit(EventType.GOVERNANCE_CHECK, {
                "check": "loop_detection",
                "action": "hard_stop",
                "consecutive_repeats": consecutive,
                "tool_call_hash": current_hash,
                "session_id": session_id,
            })
            # Persist to database
            self._persist_event(session_id, "hard_stop", consecutive, current_hash)

        elif consecutive >= self.warn_threshold:
            # Warning: inject a system message
            self._total_warnings += 1
            logger.warning(
                "Loop detection WARNING: %d identical tool-call sets in session %s",
                consecutive, session_id,
            )
            ctx.injected_messages.append({
                "role": "system",
                "content": (
                    f"WARNING: You have repeated the same tool calls {consecutive} "
                    "times. You may be stuck in a loop. Consider a different "
                    "approach, try alternative parameters, or provide a text "
                    "response if the task cannot be completed."
                ),
            })
            await ctx.emit(EventType.GOVERNANCE_CHECK, {
                "check": "loop_detection",
                "action": "warning",
                "consecutive_repeats": consecutive,
                "tool_call_hash": current_hash,
                "session_id": session_id,
            })
            # Persist to database
            self._persist_event(session_id, "warning", consecutive, current_hash)

    def _persist_event(self, session_id: str, action: str, repeats: int, tool_hash: str) -> None:
        """Persist middleware event to database."""
        try:
            from agentos.core.db_config import get_db, initialize_db
            initialize_db()
            db = get_db()
            db.insert_middleware_event(
                session_id=session_id,
                middleware_name="loop_detection",
                event_type=action,
                details=json.dumps({"consecutive_repeats": repeats, "tool_call_hash": tool_hash}),
            )
        except Exception as exc:
            logger.debug("Could not persist middleware event: %s", exc)

    async def on_session_start(self, ctx: MiddlewareContext) -> None:
        """Reset tracking for a new session."""
        session_id = ctx.session_id or "default"
        self._session_hashes.pop(session_id, None)
        self._repeat_counts.pop(session_id, None)

    def stats(self) -> dict[str, Any]:
        """Return loop detection statistics."""
        return {
            "tracked_sessions": len(self._session_hashes),
            "total_warnings": self._total_warnings,
            "total_hard_stops": self._total_hard_stops,
            "active_repeat_counts": {
                sid: count
                for sid, count in self._repeat_counts.items()
                if count >= 2
            },
        }
