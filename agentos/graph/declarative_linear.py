"""Linear declarative graph bridge: validate JSON specs, then run in topological path order.

Maps each node's ``kind`` (or ``type``) to caller-supplied handlers. Provides a stable
mapping from declarative kinds to edge worker graph node ids for LangGraph / edge parity
documentation — handlers remain pluggable (e.g. wrap :class:`GraphRuntime` nodes later).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from agentos.graph.validate import GraphValidationIssue, GraphValidationResult, validate_graph_definition

# Declarative kind → edge_graph.ts fresh-run node id (parity anchor; handlers are not auto-wired).
EDGE_FRESH_GRAPH_KIND_MAP: dict[str, str] = {
    "bootstrap": "fresh_bootstrap",
    "turn_budget": "fresh_turn_budget",
    "summarize": "fresh_summarize",
    "route_llm": "fresh_route_llm",
    "post_llm": "fresh_post_llm",
    "approval": "fresh_approval",
    "final": "fresh_final_answer",
    "tools": "fresh_tools",
    "loop_detect": "fresh_loop_detect",
    "after_tools": "fresh_after_tools",
}

# Declarative kind → edge_graph.ts resume-turn subgraph node id.
EDGE_RESUME_GRAPH_KIND_MAP: dict[str, str] = {
    "resume_turn_gate": "resume_turn_gate",
    "resume_llm": "resume_llm",
    "resume_post_llm": "resume_post_llm",
    "resume_final": "resume_final",
    "resume_tools": "resume_tools",
    "resume_bump_turn": "resume_bump_turn",
}

LinearStateHandler = Callable[[dict[str, Any]], dict[str, Any]]


def resolve_declarative_node_kind(node: dict[str, Any]) -> str:
    """Return normalized executor kind for a node dict (``kind`` wins over ``type``)."""
    k = node.get("kind")
    if isinstance(k, str) and k.strip():
        return k.strip()
    t = node.get("type")
    if isinstance(t, str) and t.strip():
        return t.strip()
    return ""


def edge_executor_id_for_kind(
    kind: str,
    *,
    subgraph: str = "fresh",
) -> str | None:
    """Map a declarative kind to the corresponding ``edge_graph.ts`` node constant, if known."""
    if subgraph == "fresh":
        return EDGE_FRESH_GRAPH_KIND_MAP.get(kind)
    if subgraph == "resume":
        return EDGE_RESUME_GRAPH_KIND_MAP.get(kind)
    return None


def _normalized_edges(raw: dict[str, Any]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for e in raw.get("edges", []) or []:
        if not isinstance(e, dict):
            continue
        s = e.get("source", e.get("from"))
        t = e.get("target", e.get("to"))
        if isinstance(s, str) and isinstance(t, str) and s.strip() and t.strip():
            out.append((s.strip(), t.strip()))
    return out


def _topological_order(raw: dict[str, Any], summary: dict[str, Any]) -> list[str] | None:
    node_ids: set[str] = set(summary.get("node_ids") or [])
    if not node_ids:
        return None
    incoming: dict[str, int] = {nid: 0 for nid in node_ids}
    outgoing: dict[str, set[str]] = {nid: set() for nid in node_ids}
    for s, t in _normalized_edges(raw):
        if s not in node_ids or t not in node_ids:
            return None
        if t not in outgoing[s]:
            outgoing[s].add(t)
            incoming[t] += 1
    ready = sorted([nid for nid, deg in incoming.items() if deg == 0])
    order: list[str] = []
    while ready:
        nid = ready.pop(0)
        order.append(nid)
        for nxt in sorted(outgoing[nid]):
            incoming[nxt] -= 1
            if incoming[nxt] == 0:
                ready.append(nxt)
        ready.sort()
    if len(order) != len(node_ids):
        return None
    return order


def linear_entry_exit_path(raw: dict[str, Any], summary: dict[str, Any]) -> list[str] | None:
    """If the graph is a single simple path from the unique entry to the unique exit, return it."""
    node_ids: set[str] = set(summary.get("node_ids") or [])
    entry = list(summary.get("entry_nodes") or [])
    exit_nodes = list(summary.get("exit_nodes") or [])
    if len(entry) != 1 or len(exit_nodes) != 1:
        return None
    adj: dict[str, list[str]] = {n: [] for n in node_ids}
    for s, t in _normalized_edges(raw):
        if s in adj and t in node_ids:
            adj[s].append(t)
    for k in adj:
        adj[k] = sorted(set(adj[k]))
    start, end = entry[0], exit_nodes[0]
    path: list[str] = [start]
    seen: set[str] = {start}
    while True:
        outs = adj.get(path[-1], [])
        if len(outs) == 0:
            break
        if len(outs) != 1:
            return None
        nxt = outs[0]
        if nxt in seen:
            return None
        seen.add(nxt)
        path.append(nxt)
    if path[-1] != end or len(seen) != len(node_ids):
        return None
    return path


def validate_linear_declarative_graph(raw: Any) -> GraphValidationResult:
    """Like :func:`validate_graph_definition` but requires a single directed path covering all nodes."""
    base = validate_graph_definition(raw)
    if not base.valid or base.summary is None:
        return base
    if not isinstance(raw, dict):
        return base
    path = linear_entry_exit_path(raw, base.summary)
    if path is None:
        return GraphValidationResult(
            errors=[
                GraphValidationIssue(
                    code="NOT_LINEAR_PATH",
                    message="Graph must be a single simple path (one entry, one exit, unique outgoing per step)",
                    path="edges",
                ),
            ],
            warnings=base.warnings,
            summary=base.summary,
        )
    summary = {**base.summary, "linear_path": path}
    return GraphValidationResult(errors=[], warnings=base.warnings, summary=summary)


def validate_bounded_dag_declarative_graph(
    raw: Any,
    *,
    max_branching: int = 4,
    max_fanin: int = 4,
) -> GraphValidationResult:
    """Validate a declarative DAG and enforce bounded branching/fan-in with deterministic topo order."""
    base = validate_graph_definition(raw)
    if not base.valid or base.summary is None:
        return base
    if not isinstance(raw, dict):
        return base
    node_ids: set[str] = set(base.summary.get("node_ids") or [])
    outgoing_count: dict[str, int] = {nid: 0 for nid in node_ids}
    incoming_count: dict[str, int] = {nid: 0 for nid in node_ids}
    for s, t in _normalized_edges(raw):
        if s in node_ids and t in node_ids:
            outgoing_count[s] += 1
            incoming_count[t] += 1
    for nid, deg in outgoing_count.items():
        if deg > max_branching:
            return GraphValidationResult(
                errors=[
                    GraphValidationIssue(
                        code="TOO_MANY_BRANCHES",
                        message=f"Node '{nid}' exceeds max branching ({deg} > {max_branching})",
                        path=f"nodes[{nid}]",
                    ),
                ],
                warnings=base.warnings,
                summary=base.summary,
            )
    for nid, deg in incoming_count.items():
        if deg > max_fanin:
            return GraphValidationResult(
                errors=[
                    GraphValidationIssue(
                        code="TOO_MANY_FANIN",
                        message=f"Node '{nid}' exceeds max fan-in ({deg} > {max_fanin})",
                        path=f"nodes[{nid}]",
                    ),
                ],
                warnings=base.warnings,
                summary=base.summary,
            )
    order = _topological_order(raw, base.summary)
    if order is None:
        return GraphValidationResult(
            errors=[
                GraphValidationIssue(
                    code="INVALID_TOPOLOGY",
                    message="Could not derive deterministic topological order",
                    path="edges",
                ),
            ],
            warnings=base.warnings,
            summary=base.summary,
        )
    summary = {
        **base.summary,
        "execution_order": order,
        "max_branching": max_branching,
        "max_fanin": max_fanin,
    }
    return GraphValidationResult(errors=[], warnings=base.warnings, summary=summary)


def run_linear_declarative_graph(
    raw: dict[str, Any],
    handlers: Mapping[str, LinearStateHandler],
    *,
    initial_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute a validated linear graph: each handler receives and returns a state dict."""
    vr = validate_linear_declarative_graph(raw)
    if not vr.valid or vr.summary is None:
        first = vr.errors[0] if vr.errors else None
        msg = first.message if first else "invalid graph"
        raise ValueError(msg)
    path = vr.summary.get("linear_path")
    if not isinstance(path, list) or not path:
        raise ValueError("missing linear_path in validation summary")
    nodes_raw = raw.get("nodes")
    if not isinstance(nodes_raw, list):
        raise ValueError("'nodes' must be a list")
    by_id: dict[str, dict[str, Any]] = {}
    for n in nodes_raw:
        if isinstance(n, dict) and isinstance(n.get("id"), str) and n["id"].strip():
            by_id[n["id"].strip()] = n
    state: dict[str, Any] = dict(initial_state or {})
    trace: list[dict[str, str]] = []
    for nid in path:
        node = by_id.get(nid)
        if node is None:
            raise ValueError(f"unknown node id {nid!r}")
        kind = resolve_declarative_node_kind(node)
        if not kind:
            raise ValueError(f"node {nid!r} has no non-empty kind or type")
        fn = handlers.get(kind)
        if fn is None:
            raise ValueError(f"no handler registered for kind {kind!r}")
        edge_id = edge_executor_id_for_kind(kind)
        trace.append({"node_id": nid, "kind": kind, "edge_executor_id": edge_id or ""})
        state = dict(fn(state))
    state["__linear_trace__"] = trace
    return state


def run_bounded_dag_declarative_graph(
    raw: dict[str, Any],
    handlers: Mapping[str, LinearStateHandler],
    *,
    initial_state: dict[str, Any] | None = None,
    max_branching: int = 4,
    max_fanin: int = 4,
) -> dict[str, Any]:
    """Execute a validated bounded DAG in deterministic topological order."""
    vr = validate_bounded_dag_declarative_graph(
        raw,
        max_branching=max_branching,
        max_fanin=max_fanin,
    )
    if not vr.valid or vr.summary is None:
        first = vr.errors[0] if vr.errors else None
        msg = first.message if first else "invalid graph"
        raise ValueError(msg)
    order = vr.summary.get("execution_order")
    if not isinstance(order, list) or not order:
        raise ValueError("missing execution_order in validation summary")
    nodes_raw = raw.get("nodes")
    if not isinstance(nodes_raw, list):
        raise ValueError("'nodes' must be a list")
    by_id: dict[str, dict[str, Any]] = {}
    for n in nodes_raw:
        if isinstance(n, dict) and isinstance(n.get("id"), str) and n["id"].strip():
            by_id[n["id"].strip()] = n
    state: dict[str, Any] = dict(initial_state or {})
    trace: list[dict[str, str]] = []
    for nid in order:
        node = by_id.get(nid)
        if node is None:
            raise ValueError(f"unknown node id {nid!r}")
        kind = resolve_declarative_node_kind(node)
        if not kind:
            raise ValueError(f"node {nid!r} has no non-empty kind or type")
        fn = handlers.get(kind)
        if fn is None:
            raise ValueError(f"no handler registered for kind {kind!r}")
        edge_id = edge_executor_id_for_kind(kind)
        trace.append({"node_id": nid, "kind": kind, "edge_executor_id": edge_id or ""})
        state = dict(fn(state))
    state["__dag_trace__"] = trace
    state["__execution_order__"] = list(order)
    return state
