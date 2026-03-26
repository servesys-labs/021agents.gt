"""Shared execution context for graph runtime nodes."""

from __future__ import annotations

from dataclasses import dataclass, field
from copy import deepcopy
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
    state_reducers: dict[str, str] = field(default_factory=dict)
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

    def apply_state_update(self, updates: dict[str, Any]) -> None:
        """Apply reducer-aware updates to session_state deterministically."""
        for key in sorted(updates.keys()):
            incoming = updates[key]
            if key not in self.session_state:
                self.session_state[key] = deepcopy(incoming)
                continue
            strategy = str(self.state_reducers.get(key, "replace"))
            current = self.session_state[key]
            if strategy == "sum_numeric":
                self.session_state[key] = float(current or 0.0) + float(incoming or 0.0)
            elif strategy == "max_numeric":
                self.session_state[key] = max(float(current or 0.0), float(incoming or 0.0))
            elif strategy == "append_list":
                left = list(current) if isinstance(current, list) else []
                right = list(incoming) if isinstance(incoming, list) else [incoming]
                self.session_state[key] = left + right
            elif strategy == "merge_dict":
                left = dict(current) if isinstance(current, dict) else {}
                right = dict(incoming) if isinstance(incoming, dict) else {}
                merged = {**left, **right}
                self.session_state[key] = {k: merged[k] for k in sorted(merged.keys())}
            elif strategy == "extend_unique":
                left = list(current) if isinstance(current, list) else []
                right = list(incoming) if isinstance(incoming, list) else [incoming]
                dedup: dict[str, Any] = {}
                for item in left + right:
                    dedup[str(item)] = item
                self.session_state[key] = [dedup[k] for k in sorted(dedup.keys())]
            else:
                self.session_state[key] = deepcopy(incoming)
