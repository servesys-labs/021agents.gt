"""Minimal graph runtime executor and node protocol."""

from __future__ import annotations

import time
import uuid
from typing import Protocol

from agentos.core.events import Event, EventType
from agentos.graph.context import GraphContext


class GraphNode(Protocol):
    """Node interface for graph-first orchestration."""

    node_id: str

    async def execute(self, ctx: GraphContext) -> GraphContext:
        """Execute node logic and return the updated graph context."""
        ...

    def should_skip(self, ctx: GraphContext) -> bool:
        """Return True if this node should be skipped for current context."""
        ...


class GraphRuntime:
    """Sequential graph executor with per-node retry and checkpoints.

    Phase 1 intentionally keeps execution deterministic and simple; DAG fan-out
    and advanced policies layer on top in later phases.
    """

    def __init__(self, nodes: list[GraphNode]) -> None:
        self.nodes = nodes

    async def run(self, ctx: GraphContext) -> GraphContext:
        for node in self.nodes:
            node_id = getattr(node, "node_id", "?")
            turn = int(ctx.session_state.get("current_turn", 0))
            if ctx.cancelled:
                ctx.checkpoint(node_id, "cancelled")
                await self._emit_node_end(ctx, node_id=node_id, turn=turn, status="cancelled", attempt=0, latency_ms=0.0)
                break

            if self._should_skip(node, ctx):
                ctx.checkpoint(node_id, "skipped")
                await self._emit_node_end(ctx, node_id=node_id, turn=turn, status="skipped", attempt=0, latency_ms=0.0)
                continue

            max_attempts = max(1, self._max_retries(node) + 1)
            last_error: Exception | None = None
            for attempt in range(1, max_attempts + 1):
                ctx.checkpoint(node_id, "running", {"attempt": attempt})
                await self._emit_node_start(ctx, node_id=node_id, turn=turn, attempt=attempt)
                started = time.time()
                try:
                    ctx = await node.execute(ctx)
                    ended = time.time()
                    latency_ms = (ended - started) * 1000.0
                    self._append_node_span(
                        ctx,
                        node_id=node_id,
                        turn=turn,
                        attempt=attempt,
                        started=started,
                        ended=ended,
                        status="ok",
                        error="",
                    )
                    ctx.checkpoint(node_id, "completed", {"attempt": attempt})
                    await self._emit_node_end(
                        ctx,
                        node_id=node_id,
                        turn=turn,
                        status="completed",
                        attempt=attempt,
                        latency_ms=latency_ms,
                    )
                    break
                except Exception as exc:
                    last_error = exc
                    ended = time.time()
                    latency_ms = (ended - started) * 1000.0
                    self._append_node_span(
                        ctx,
                        node_id=node_id,
                        turn=turn,
                        attempt=attempt,
                        started=started,
                        ended=ended,
                        status="error",
                        error=str(exc),
                    )
                    ctx.checkpoint(
                        node_id,
                        "failed_attempt",
                        {"attempt": attempt, "error": str(exc)},
                    )
                    await self._emit_node_error(
                        ctx,
                        node_id=node_id,
                        turn=turn,
                        attempt=attempt,
                        latency_ms=latency_ms,
                        error=str(exc),
                    )
                    if attempt >= max_attempts:
                        raise
            if last_error is not None and max_attempts == 0:
                raise last_error

        return ctx

    @staticmethod
    def _should_skip(node: GraphNode, ctx: GraphContext) -> bool:
        checker = getattr(node, "should_skip", None)
        if checker is None:
            return False
        return bool(checker(ctx))

    @staticmethod
    def _max_retries(node: GraphNode) -> int:
        raw = getattr(node, "max_retries", 0)
        try:
            return max(0, int(raw))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _append_node_span(
        ctx: GraphContext,
        *,
        node_id: str,
        turn: int,
        attempt: int,
        started: float,
        ended: float,
        status: str,
        error: str,
    ) -> None:
        spans = ctx.session_state.setdefault("node_spans", [])
        span = {
            "span_id": uuid.uuid4().hex[:16],
            "trace_id": str(ctx.session_state.get("trace_id", "")),
            "parent_span_id": "",
            "session_id": str(ctx.session_state.get("session_id", "")),
            "name": node_id,
            "kind": "graph_node",
            "status": status,
            "start_time": started,
            "end_time": ended,
            "duration_ms": (ended - started) * 1000.0,
            "attributes": {
                "node_id": node_id,
                "turn": turn,
                "attempt": attempt,
                "error": error,
            },
            "events": [],
        }
        if isinstance(spans, list):
            spans.append(span)

    @staticmethod
    def _event_bus(ctx: GraphContext):
        return ctx.session_state.get("event_bus")

    async def _emit_node_start(self, ctx: GraphContext, *, node_id: str, turn: int, attempt: int) -> None:
        event_bus = self._event_bus(ctx)
        if event_bus is None:
            return
        await event_bus.emit(Event(type=EventType.NODE_START, data={
            "node_id": node_id,
            "turn": turn,
            "attempt": attempt,
        }))

    async def _emit_node_end(
        self,
        ctx: GraphContext,
        *,
        node_id: str,
        turn: int,
        status: str,
        attempt: int,
        latency_ms: float,
    ) -> None:
        event_bus = self._event_bus(ctx)
        if event_bus is None:
            return
        await event_bus.emit(Event(type=EventType.NODE_END, data={
            "node_id": node_id,
            "turn": turn,
            "status": status,
            "attempt": attempt,
            "latency_ms": latency_ms,
        }))

    async def _emit_node_error(
        self,
        ctx: GraphContext,
        *,
        node_id: str,
        turn: int,
        attempt: int,
        latency_ms: float,
        error: str,
    ) -> None:
        event_bus = self._event_bus(ctx)
        if event_bus is None:
            return
        await event_bus.emit(Event(type=EventType.NODE_ERROR, data={
            "node_id": node_id,
            "turn": turn,
            "attempt": attempt,
            "latency_ms": latency_ms,
            "error": error,
        }))
