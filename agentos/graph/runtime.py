"""Minimal graph runtime executor and node protocol."""

from __future__ import annotations

from typing import Protocol

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
            if ctx.cancelled:
                ctx.checkpoint(getattr(node, "node_id", "?"), "cancelled")
                break

            if self._should_skip(node, ctx):
                ctx.checkpoint(getattr(node, "node_id", "?"), "skipped")
                continue

            max_attempts = max(1, self._max_retries(node) + 1)
            last_error: Exception | None = None
            for attempt in range(1, max_attempts + 1):
                ctx.checkpoint(getattr(node, "node_id", "?"), "running", {"attempt": attempt})
                try:
                    ctx = await node.execute(ctx)
                    ctx.checkpoint(getattr(node, "node_id", "?"), "completed", {"attempt": attempt})
                    break
                except Exception as exc:
                    last_error = exc
                    ctx.checkpoint(
                        getattr(node, "node_id", "?"),
                        "failed_attempt",
                        {"attempt": attempt, "error": str(exc)},
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
