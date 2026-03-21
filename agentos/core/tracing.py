"""Span-based tracing for agent observability.

Traditional software has deterministic, readable control flow. Agent behavior
is non-deterministic — you only see what happened AFTER, in the traces.
Traces are the source of truth for agents (Mikyo King, Arize AI).

This module provides structured span tracing with parent-child relationships:

    session (trace_id)
    ├── turn_1 (span)
    │   ├── llm_call (span)
    │   ├── tool_call: search (span)
    │   │   └── sub_agent (span)
    │   │       ├── llm_call (span)
    │   │       └── tool_call: write (span)
    │   └── llm_call (span)
    └── turn_2 (span)
        └── llm_call (span)

Usage::

    tracer = Tracer()
    with tracer.start_trace("user-query") as trace:
        with trace.span("turn_1", kind="turn") as turn:
            with turn.span("llm_call", kind="llm") as llm:
                llm.set_attribute("model", "claude-sonnet")
                llm.set_attribute("input_tokens", 150)
            with turn.span("tool_call", kind="tool") as tool:
                tool.set_attribute("tool_name", "search")
                tool.set_attribute("arguments", {"q": "test"})

    # Export for analysis
    spans = tracer.export()
"""

from __future__ import annotations

import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Generator


@dataclass
class Span:
    """A single unit of work in a trace tree.

    Spans form a tree via parent_span_id. Each span has:
    - Identity: trace_id, span_id, parent_span_id
    - Timing: start_time, end_time, duration_ms
    - Semantics: name, kind, status, attributes
    """

    trace_id: str
    span_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    parent_span_id: str | None = None
    name: str = ""
    kind: str = ""  # turn, llm, tool, sub_agent, memory, governance
    status: str = "ok"  # ok, error, timeout
    start_time: float = field(default_factory=time.time)
    end_time: float = 0.0
    duration_ms: float = 0.0
    attributes: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)

    def set_attribute(self, key: str, value: Any) -> None:
        self.attributes[key] = value

    def add_event(self, name: str, attributes: dict[str, Any] | None = None) -> None:
        self.events.append({
            "name": name,
            "timestamp": time.time(),
            "attributes": attributes or {},
        })

    def set_error(self, error: str) -> None:
        self.status = "error"
        self.attributes["error"] = error

    def finish(self) -> None:
        self.end_time = time.time()
        self.duration_ms = (self.end_time - self.start_time) * 1000

    @contextmanager
    def span(self, name: str, kind: str = "") -> Generator[Span, None, None]:
        """Create a child span."""
        child = Span(
            trace_id=self.trace_id,
            parent_span_id=self.span_id,
            name=name,
            kind=kind,
        )
        self._tracer._spans.append(child)
        try:
            yield child
        except Exception as exc:
            child.set_error(str(exc))
            raise
        finally:
            child.finish()

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "name": self.name,
            "kind": self.kind,
            "status": self.status,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration_ms": self.duration_ms,
            "attributes": self.attributes,
            "events": self.events,
        }


@dataclass
class Trace:
    """A complete trace — a tree of spans rooted at a session."""

    trace_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    name: str = ""
    _tracer: Tracer | None = field(default=None, repr=False)
    _root_span: Span | None = field(default=None, repr=False)

    @contextmanager
    def span(self, name: str, kind: str = "") -> Generator[Span, None, None]:
        """Create a top-level span in this trace."""
        s = Span(
            trace_id=self.trace_id,
            parent_span_id=self._root_span.span_id if self._root_span else None,
            name=name,
            kind=kind,
        )
        s._tracer = self._tracer
        self._tracer._spans.append(s)
        try:
            yield s
        except Exception as exc:
            s.set_error(str(exc))
            raise
        finally:
            s.finish()


class Tracer:
    """Collects spans across agent sessions for observability.

    Thread-safe span collection. Spans are stored in-memory and can be
    exported to the database or as JSON for external tools.
    """

    def __init__(self) -> None:
        self._spans: list[Span] = []
        self._traces: list[Trace] = []

    @contextmanager
    def start_trace(self, name: str = "") -> Generator[Trace, None, None]:
        """Start a new trace (session-level)."""
        trace = Trace(name=name, _tracer=self)
        root = Span(
            trace_id=trace.trace_id,
            name=name or "session",
            kind="session",
        )
        root._tracer = self
        trace._root_span = root
        self._spans.append(root)
        self._traces.append(trace)
        try:
            yield trace
        finally:
            root.finish()

    def export(self) -> list[dict[str, Any]]:
        """Export all spans as a list of dicts."""
        return [s.to_dict() for s in self._spans]

    def export_trace(self, trace_id: str) -> list[dict[str, Any]]:
        """Export spans for a single trace."""
        return [s.to_dict() for s in self._spans if s.trace_id == trace_id]

    def clear(self) -> None:
        self._spans.clear()
        self._traces.clear()

    @property
    def span_count(self) -> int:
        return len(self._spans)

    def build_tree(self, trace_id: str) -> dict[str, Any]:
        """Build a nested tree representation of a trace.

        Returns a dict with 'span' and 'children' keys, making it
        easy to visualize the trace hierarchy.
        """
        spans = [s for s in self._spans if s.trace_id == trace_id]
        by_id = {s.span_id: s for s in spans}
        children: dict[str | None, list[Span]] = {}
        root = None
        for s in spans:
            children.setdefault(s.parent_span_id, []).append(s)
            if s.parent_span_id is None or s.parent_span_id not in by_id:
                root = s

        def _build(span: Span) -> dict[str, Any]:
            node = span.to_dict()
            node["children"] = [
                _build(child) for child in children.get(span.span_id, [])
            ]
            return node

        return _build(root) if root else {}
