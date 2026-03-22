"""Middleware base classes and chain executor.

The middleware chain wraps the agent's LLM call with composable hooks:

    ┌──────────────────────────────────┐
    │ Middleware 1: before_model()      │
    │   Middleware 2: before_model()    │
    │     Middleware 3: before_model()  │
    │       ── LLM CALL ──             │
    │     Middleware 3: after_model()   │
    │   Middleware 2: after_model()     │
    │ Middleware 1: after_model()       │
    └──────────────────────────────────┘

Each middleware can:
- Modify messages before they reach the LLM (before_model)
- Inspect/modify the LLM response (after_model)
- Short-circuit execution by setting context.halt = True
- Emit events via context.event_bus
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from agentos.core.events import Event, EventBus, EventType
from agentos.llm.provider import LLMResponse

logger = logging.getLogger(__name__)


@dataclass
class MiddlewareContext:
    """Shared state passed through the middleware chain on each turn.

    Middlewares read and mutate this context to affect the agent loop.
    """

    # Current conversation messages — middlewares can append/modify
    messages: list[dict[str, Any]] = field(default_factory=list)

    # Turn metadata
    turn_number: int = 0
    session_id: str = ""
    trace_id: str = ""

    # LLM response (populated after the LLM call, available in after_model)
    llm_response: LLMResponse | None = None

    # Tool call results from the current turn
    tool_results: list[dict[str, Any]] = field(default_factory=list)

    # Control flags
    halt: bool = False  # Set True to stop the agent loop
    halt_reason: str = ""
    skip_llm_call: bool = False  # Set True to skip the LLM call this turn
    force_text_response: bool = False  # Strip tool_calls, force text output

    # Accumulated warnings/info injected by middlewares
    injected_messages: list[dict[str, Any]] = field(default_factory=list)

    # Event bus reference for middleware to emit events
    event_bus: EventBus | None = None

    # Middleware-specific state (namespaced by middleware name)
    state: dict[str, Any] = field(default_factory=dict)

    # Timing
    turn_start_time: float = field(default_factory=time.time)

    async def emit(self, event_type: EventType, data: dict[str, Any] | None = None) -> None:
        """Convenience: emit an event if event_bus is available."""
        if self.event_bus:
            await self.event_bus.emit(Event(type=event_type, data=data or {}))


class Middleware:
    """Base class for agent middlewares.

    Subclass and override before_model() and/or after_model().
    """

    name: str = "base"
    order: int = 100  # Lower runs first in before_model, last in after_model

    async def before_model(self, ctx: MiddlewareContext) -> None:
        """Called before the LLM call. Modify ctx.messages or set flags."""

    async def after_model(self, ctx: MiddlewareContext) -> None:
        """Called after the LLM call. Inspect/modify ctx.llm_response."""

    async def on_turn_end(self, ctx: MiddlewareContext) -> None:
        """Called at the end of each turn after tools execute."""

    async def on_session_start(self, ctx: MiddlewareContext) -> None:
        """Called once when a session begins."""

    async def on_session_end(self, ctx: MiddlewareContext) -> None:
        """Called once when a session ends."""


class MiddlewareChain:
    """Ordered chain of middlewares executed around each LLM call.

    Middlewares are sorted by their ``order`` attribute.
    """

    def __init__(self, middlewares: list[Middleware] | None = None) -> None:
        self._middlewares: list[Middleware] = sorted(
            middlewares or [], key=lambda m: m.order
        )

    def add(self, middleware: Middleware) -> None:
        """Add a middleware and re-sort."""
        self._middlewares.append(middleware)
        self._middlewares.sort(key=lambda m: m.order)

    def remove(self, name: str) -> bool:
        """Remove a middleware by name. Returns True if found."""
        before = len(self._middlewares)
        self._middlewares = [m for m in self._middlewares if m.name != name]
        return len(self._middlewares) < before

    @property
    def middleware_names(self) -> list[str]:
        return [m.name for m in self._middlewares]

    async def run_before_model(self, ctx: MiddlewareContext) -> None:
        """Execute all before_model hooks in order."""
        for mw in self._middlewares:
            if ctx.halt:
                break
            try:
                await mw.before_model(ctx)
            except Exception as exc:
                logger.error("Middleware %s.before_model failed: %s", mw.name, exc)
                await ctx.emit(EventType.ERROR, {
                    "source": "middleware",
                    "middleware": mw.name,
                    "phase": "before_model",
                    "message": str(exc),
                })

    async def run_after_model(self, ctx: MiddlewareContext) -> None:
        """Execute all after_model hooks in reverse order."""
        for mw in reversed(self._middlewares):
            try:
                await mw.after_model(ctx)
            except Exception as exc:
                logger.error("Middleware %s.after_model failed: %s", mw.name, exc)
                await ctx.emit(EventType.ERROR, {
                    "source": "middleware",
                    "middleware": mw.name,
                    "phase": "after_model",
                    "message": str(exc),
                })

    async def run_on_turn_end(self, ctx: MiddlewareContext) -> None:
        """Execute all on_turn_end hooks in order."""
        for mw in self._middlewares:
            try:
                await mw.on_turn_end(ctx)
            except Exception as exc:
                logger.error("Middleware %s.on_turn_end failed: %s", mw.name, exc)

    async def run_on_session_start(self, ctx: MiddlewareContext) -> None:
        """Execute all on_session_start hooks in order."""
        for mw in self._middlewares:
            try:
                await mw.on_session_start(ctx)
            except Exception as exc:
                logger.error("Middleware %s.on_session_start failed: %s", mw.name, exc)

    async def run_on_session_end(self, ctx: MiddlewareContext) -> None:
        """Execute all on_session_end hooks in order."""
        for mw in self._middlewares:
            try:
                await mw.on_session_end(ctx)
            except Exception as exc:
                logger.error("Middleware %s.on_session_end failed: %s", mw.name, exc)

    def status(self) -> list[dict[str, Any]]:
        """Return status info for each middleware (for API/observability)."""
        result = []
        for mw in self._middlewares:
            info: dict[str, Any] = {
                "name": mw.name,
                "order": mw.order,
                "type": type(mw).__name__,
            }
            if hasattr(mw, "stats"):
                info["stats"] = mw.stats()
            result.append(info)
        return result
