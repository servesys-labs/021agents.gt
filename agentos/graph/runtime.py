"""Minimal graph runtime executor and node protocol."""

from __future__ import annotations

import time
import uuid
import json
from copy import deepcopy
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


def _stable_repr(value: object) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    except Exception:
        return str(value)


def _reduce_value(current: object, incoming: object, strategy: str) -> object:
    if strategy == "sum_numeric":
        return float(current or 0.0) + float(incoming or 0.0)
    if strategy == "max_numeric":
        return max(float(current or 0.0), float(incoming or 0.0))
    if strategy == "append_list":
        left = list(current) if isinstance(current, list) else []
        right = list(incoming) if isinstance(incoming, list) else [incoming]
        return left + right
    if strategy == "extend_unique":
        left = list(current) if isinstance(current, list) else []
        right = list(incoming) if isinstance(incoming, list) else [incoming]
        dedup: dict[str, object] = {}
        for item in left + right:
            dedup[_stable_repr(item)] = item
        return [dedup[k] for k in sorted(dedup.keys())]
    if strategy == "merge_dict":
        left = dict(current) if isinstance(current, dict) else {}
        right = dict(incoming) if isinstance(incoming, dict) else {}
        merged = {**left, **right}
        return {k: merged[k] for k in sorted(merged.keys())}
    return deepcopy(incoming)


def merge_branch_states(
    branch_states: list[dict[str, object]],
    reducers: dict[str, str] | None = None,
) -> dict[str, object]:
    """Deterministically merge branch states using per-key reducers.

    Branches may include optional `__branch_id` for stable ordering.
    Supported reducers:
    - replace (default)
    - sum_numeric
    - max_numeric
    - append_list
    - extend_unique
    - merge_dict
    """
    reducer_map = reducers or {}
    ordered = sorted(
        branch_states,
        key=lambda s: (
            str(s.get("__branch_id", "")),
            _stable_repr({k: v for k, v in s.items() if k != "__branch_id"}),
        ),
    )
    merged: dict[str, object] = {}
    for state in ordered:
        for key in sorted(state.keys()):
            if key == "__branch_id":
                continue
            incoming = state[key]
            if key not in merged:
                merged[key] = deepcopy(incoming)
                continue
            strategy = str(reducer_map.get(key, "replace"))
            merged[key] = _reduce_value(merged[key], incoming, strategy)
    return {k: merged[k] for k in sorted(merged.keys())}


class GraphRuntime:
    """Sequential graph executor with per-node retry and checkpoints.

    Phase 1 intentionally keeps execution deterministic and simple; DAG fan-out
    and advanced policies layer on top in later phases.
    """

    def __init__(self, nodes: list[GraphNode]) -> None:
        self.nodes = nodes

    @staticmethod
    def merge_branch_states(
        branch_states: list[dict[str, object]],
        reducers: dict[str, str] | None = None,
    ) -> dict[str, object]:
        return merge_branch_states(branch_states, reducers)

    async def run(self, ctx: GraphContext) -> GraphContext:
        governance = ctx.session_state.get("governance")
        for node in self.nodes:
            node_id = getattr(node, "node_id", "?")
            turn = int(ctx.session_state.get("current_turn", 0))

            # Governance: budget gate — skip remaining nodes if budget exhausted
            if governance is not None and not governance.check_budget(0):
                ctx.checkpoint(node_id, "budget_exceeded")
                await self._emit_node_end(ctx, node_id=node_id, turn=turn, status="budget_exceeded", attempt=0, latency_ms=0.0)
                break

            # Governance: tool permission gate — if node declares tool_calls, verify each is allowed
            if governance is not None:
                pending_tools = getattr(node, "tool_calls", None) or ctx.session_state.get("pending_tool_calls") or []
                blocked = [t for t in pending_tools if not governance.is_tool_allowed(t if isinstance(t, str) else t.get("name", ""))]
                if blocked:
                    blocked_names = ", ".join(t if isinstance(t, str) else t.get("name", "") for t in blocked)
                    ctx.checkpoint(node_id, "tool_blocked", {"blocked_tools": blocked_names})
                    await self._emit_node_end(ctx, node_id=node_id, turn=turn, status="tool_blocked", attempt=0, latency_ms=0.0)
                    continue

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
                span_id = uuid.uuid4().hex[:16]
                parent_span_id = str(ctx.session_state.get("__span_parent_id", ""))
                ctx.session_state["__active_span_id"] = span_id
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
                        span_id=span_id,
                        parent_span_id=parent_span_id,
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
                        span_id=span_id,
                        parent_span_id=parent_span_id,
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
                finally:
                    ctx.session_state.pop("__active_span_id", None)
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
        span_id: str,
        parent_span_id: str,
        started: float,
        ended: float,
        status: str,
        error: str,
    ) -> None:
        spans = ctx.session_state.setdefault("node_spans", [])
        span = {
            "span_id": span_id,
            "trace_id": str(ctx.session_state.get("trace_id", "")),
            "parent_span_id": parent_span_id,
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
                "graph_id": str(ctx.session_state.get("__graph_id", "root")),
                "parent_graph_id": str(ctx.session_state.get("__parent_graph_id", "")),
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
            "graph_id": str(ctx.session_state.get("__graph_id", "root")),
            "parent_graph_id": str(ctx.session_state.get("__parent_graph_id", "")),
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
            "graph_id": str(ctx.session_state.get("__graph_id", "root")),
            "parent_graph_id": str(ctx.session_state.get("__parent_graph_id", "")),
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
            "graph_id": str(ctx.session_state.get("__graph_id", "root")),
            "parent_graph_id": str(ctx.session_state.get("__parent_graph_id", "")),
        }))
