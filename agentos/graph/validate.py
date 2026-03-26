"""Pure validation and normalization for declarative graph definitions.

Expected shape (JSON-serializable dict):

    {
        "id": "<optional graph id>",
        "nodes": [{"id": "a", ...}, ...],
        "edges": [{"source": "a", "target": "b"}, ...],
    }

Edges may use ``from`` / ``to`` instead of ``source`` / ``target``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class GraphValidationIssue:
    """Single validation finding with stable machine-readable ``code``."""

    code: str
    message: str
    path: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "path": self.path,
            "details": dict(self.details),
        }


@dataclass
class GraphValidationResult:
    errors: list[GraphValidationIssue]
    warnings: list[GraphValidationIssue]
    summary: dict[str, Any] | None = None

    @property
    def valid(self) -> bool:
        return len(self.errors) == 0


def _edge_endpoints(
    edge: Any,
    index: int,
    errors: list[GraphValidationIssue],
) -> tuple[str, str] | None:
    path = f"edges[{index}]"
    if not isinstance(edge, dict):
        errors.append(
            GraphValidationIssue(
                code="INVALID_EDGE",
                message=f"Edge at index {index} must be an object",
                path=path,
            ),
        )
        return None
    src = edge.get("source", edge.get("from"))
    tgt = edge.get("target", edge.get("to"))
    if src is None or tgt is None:
        errors.append(
            GraphValidationIssue(
                code="INVALID_EDGE",
                message="Each edge requires 'source' and 'target' (or 'from' and 'to')",
                path=path,
            ),
        )
        return None
    if not isinstance(src, str) or not isinstance(tgt, str):
        errors.append(
            GraphValidationIssue(
                code="INVALID_EDGE",
                message="Edge endpoints must be non-empty strings",
                path=path,
            ),
        )
        return None
    if not src.strip() or not tgt.strip():
        errors.append(
            GraphValidationIssue(
                code="INVALID_EDGE",
                message="Edge endpoints must be non-empty strings",
                path=path,
            ),
        )
        return None
    return src.strip(), tgt.strip()


def _detect_cycle(
    node_ids: set[str],
    adj: dict[str, list[str]],
) -> list[str] | None:
    """Return a closed walk of node ids along a directed cycle, or None if acyclic."""
    color: dict[str, Literal["white", "gray", "black"]] = {n: "white" for n in node_ids}
    parent: dict[str, str | None] = {n: None for n in node_ids}
    cycle_nodes: list[str] | None = None

    def visit(u: str) -> None:
        nonlocal cycle_nodes
        if cycle_nodes is not None:
            return
        color[u] = "gray"
        for v in adj.get(u, []):
            if v not in color:
                continue
            if color[v] == "gray":
                rev: list[str] = [u]
                w: str | None = parent.get(u)
                while w is not None and w != v:
                    rev.append(w)
                    w = parent.get(w)
                if w == v:
                    cycle_nodes = [v] + list(reversed(rev)) + [v]
                return
            if color[v] == "white":
                parent[v] = u
                visit(v)
                if cycle_nodes is not None:
                    return
        color[u] = "black"

    for n in sorted(node_ids):
        if color[n] == "white":
            visit(n)
        if cycle_nodes is not None:
            break
    return cycle_nodes


def _topological_order(node_ids: set[str], adj: dict[str, list[str]]) -> list[str]:
    in_deg: dict[str, int] = {n: 0 for n in node_ids}
    for u in node_ids:
        for v in adj.get(u, []):
            if v in in_deg:
                in_deg[v] += 1
    ready = sorted(n for n in node_ids if in_deg[n] == 0)
    out: list[str] = []
    while ready:
        u = ready.pop(0)
        out.append(u)
        for v in sorted(adj.get(u, [])):
            if v not in in_deg:
                continue
            in_deg[v] -= 1
            if in_deg[v] == 0:
                ready.append(v)
                ready.sort()
    return out


def validate_graph_definition(raw: Any) -> GraphValidationResult:
    """Validate a graph definition dict; pure and deterministic."""
    errors: list[GraphValidationIssue] = []
    warnings: list[GraphValidationIssue] = []

    if not isinstance(raw, dict):
        return GraphValidationResult(
            errors=[
                GraphValidationIssue(
                    code="GRAPH_NOT_OBJECT",
                    message="Graph definition must be a JSON object",
                    path="",
                ),
            ],
            warnings=[],
            summary=None,
        )

    graph_id: str | None = None
    if "id" in raw:
        gid = raw.get("id")
        if gid is not None and (not isinstance(gid, str) or not gid.strip()):
            errors.append(
                GraphValidationIssue(
                    code="INVALID_GRAPH_ID",
                    message="Optional 'id' must be a non-empty string",
                    path="id",
                ),
            )
        elif isinstance(gid, str) and gid.strip():
            graph_id = gid.strip()

    nodes_raw = raw.get("nodes", [])
    edges_raw = raw.get("edges", [])

    if not isinstance(nodes_raw, list):
        errors.append(
            GraphValidationIssue(
                code="INVALID_NODES",
                message="'nodes' must be a list",
                path="nodes",
            ),
        )
        return GraphValidationResult(errors=errors, warnings=warnings, summary=None)

    if not isinstance(edges_raw, list):
        errors.append(
            GraphValidationIssue(
                code="INVALID_EDGES",
                message="'edges' must be a list",
                path="edges",
            ),
        )
        return GraphValidationResult(errors=errors, warnings=warnings, summary=None)

    if len(nodes_raw) == 0:
        warnings.append(
            GraphValidationIssue(
                code="EMPTY_GRAPH",
                message="Graph has no nodes",
                path="nodes",
            ),
        )

    node_ids: set[str] = set()
    seen_ids: dict[str, int] = {}

    for i, node in enumerate(nodes_raw):
        path = f"nodes[{i}]"
        if not isinstance(node, dict):
            errors.append(
                GraphValidationIssue(
                    code="INVALID_NODE",
                    message=f"Node at index {i} must be an object",
                    path=path,
                ),
            )
            continue
        nid = node.get("id")
        if nid is None or (isinstance(nid, str) and not nid.strip()):
            errors.append(
                GraphValidationIssue(
                    code="MISSING_NODE_ID",
                    message="Each node must have a non-empty string 'id'",
                    path=path,
                ),
            )
            continue
        if not isinstance(nid, str):
            errors.append(
                GraphValidationIssue(
                    code="INVALID_NODE_ID",
                    message="Node 'id' must be a string",
                    path=f"{path}.id",
                ),
            )
            continue
        nid = nid.strip()
        if nid in seen_ids:
            errors.append(
                GraphValidationIssue(
                    code="DUPLICATE_NODE_ID",
                    message=f"Duplicate node id '{nid}'",
                    path=path,
                    details={"id": nid, "first_index": seen_ids[nid]},
                ),
            )
        else:
            seen_ids[nid] = i
            node_ids.add(nid)

    normalized_edges: list[tuple[str, str, int]] = []
    edge_pairs_seen: set[tuple[str, str]] = set()

    for i, edge in enumerate(edges_raw):
        ends = _edge_endpoints(edge, i, errors)
        if ends is None:
            continue
        s, t = ends
        if s not in node_ids:
            errors.append(
                GraphValidationIssue(
                    code="MISSING_NODE_REF",
                    message=f"Edge references unknown source node '{s}'",
                    path=f"edges[{i}]",
                    details={"source": s, "target": t},
                ),
            )
        if t not in node_ids:
            errors.append(
                GraphValidationIssue(
                    code="MISSING_NODE_REF",
                    message=f"Edge references unknown target node '{t}'",
                    path=f"edges[{i}]",
                    details={"source": s, "target": t},
                ),
            )
        if s == t:
            errors.append(
                GraphValidationIssue(
                    code="SELF_LOOP",
                    message=f"Self-loop on node '{s}' is not allowed",
                    path=f"edges[{i}]",
                    details={"node_id": s},
                ),
            )
        pair = (s, t)
        if pair in edge_pairs_seen:
            warnings.append(
                GraphValidationIssue(
                    code="DUPLICATE_EDGE",
                    message=f"Duplicate edge from '{s}' to '{t}'",
                    path=f"edges[{i}]",
                    details={"source": s, "target": t},
                ),
            )
        edge_pairs_seen.add(pair)
        normalized_edges.append((s, t, i))

    if errors:
        return GraphValidationResult(errors=errors, warnings=warnings, summary=None)

    adj: dict[str, list[str]] = {n: [] for n in node_ids}
    for s, t, _ in normalized_edges:
        adj[s].append(t)
    for k in adj:
        adj[k] = sorted(set(adj[k]))

    cycle = _detect_cycle(node_ids, adj)
    if cycle:
        errors.append(
            GraphValidationIssue(
                code="CYCLE",
                message="Directed cycle detected",
                path="edges",
                details={"cycle": cycle},
            ),
        )
        return GraphValidationResult(errors=errors, warnings=warnings, summary=None)

    # Entry = no incoming edges; exit = no outgoing edges.
    entry_nodes = set(node_ids)
    exit_nodes = set(node_ids)
    for s, t, _ in normalized_edges:
        entry_nodes.discard(t)
        exit_nodes.discard(s)

    isolated = sorted(n for n in node_ids if n not in {x for e in normalized_edges for x in (e[0], e[1])})
    for n in isolated:
        warnings.append(
            GraphValidationIssue(
                code="ISOLATED_NODE",
                message=f"Node '{n}' has no incident edges",
                path=f"nodes[{seen_ids[n]}]",
                details={"node_id": n},
            ),
        )

    topo = _topological_order(node_ids, adj)
    summary: dict[str, Any] = {
        "node_count": len(node_ids),
        "edge_count": len(normalized_edges),
        "node_ids": sorted(node_ids),
        "entry_nodes": sorted(entry_nodes),
        "exit_nodes": sorted(exit_nodes),
        "topological_order": topo,
    }
    if graph_id is not None:
        summary["graph_id"] = graph_id

    return GraphValidationResult(errors=[], warnings=warnings, summary=summary)
