"""Shared execution context for graph runtime nodes."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class GraphContext:
    """Mutable state flowing through graph node execution."""

    messages: list[dict[str, Any]] = field(default_factory=list)
    tools: list[dict[str, Any]] = field(default_factory=list)
    routing_decision: dict[str, Any] = field(default_factory=dict)
    session_state: dict[str, Any] = field(default_factory=dict)
    checkpoints: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    cancelled: bool = False

    def checkpoint(self, node_id: str, status: str, details: dict[str, Any] | None = None) -> None:
        """Record a lightweight checkpoint entry for node lifecycle tracking."""
        self.checkpoints.append({
            "node_id": node_id,
            "status": status,
            "details": details or {},
        })

    def with_message(self, role: str, content: str, **extra: Any) -> None:
        """Append a message while preserving role/content shape."""
        item: dict[str, Any] = {"role": role, "content": content}
        item.update(extra)
        self.messages.append(item)
