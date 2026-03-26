"""Design-time lint rules for no-code declarative agent graphs.

These checks are intentionally opinionated for "works out of the box" graph authoring:
- Keep telemetry/eval/indexing off the critical user-response path.
- Require idempotency keys for async side-effect nodes.
- Warn when async branches fan-in to blocking joins.
"""

from __future__ import annotations

from typing import Any

from agentos.graph.contracts import lint_graph_contracts
from agentos.graph.validate import GraphValidationIssue, GraphValidationResult, validate_graph_definition

_BACKGROUND_KINDS = frozenset(
    {
        "telemetry",
        "telemetry_emit",
        "eval_enqueue",
        "experiment_enqueue",
        "autoresearch_enqueue",
        "index",
        "index_write",
        "analytics",
    },
)

_SIDE_EFFECT_KINDS = frozenset(
    {
        "telemetry",
        "telemetry_emit",
        "eval_enqueue",
        "experiment_enqueue",
        "autoresearch_enqueue",
        "index",
        "index_write",
        "db_write",
        "memory_write",
    },
)

_FINAL_KINDS = frozenset({"final", "final_answer", "respond"})


def _node_kind(node: dict[str, Any]) -> str:
    kind = node.get("kind")
    if isinstance(kind, str) and kind.strip():
        return kind.strip()
    typ = node.get("type")
    if isinstance(typ, str) and typ.strip():
        return typ.strip()
    return ""


def _node_async(node: dict[str, Any]) -> bool:
    raw_async = node.get("async")
    if isinstance(raw_async, bool):
        return raw_async
    execution = node.get("execution")
    if isinstance(execution, dict):
        ex_async = execution.get("async")
        if isinstance(ex_async, bool):
            return ex_async
        ex_blocking = execution.get("blocking")
        if isinstance(ex_blocking, bool):
            return not ex_blocking
    blocking = node.get("blocking")
    if isinstance(blocking, bool):
        return not blocking
    return False


def _idempotency_key(node: dict[str, Any]) -> str | None:
    raw = node.get("idempotency_key")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    config = node.get("config")
    if isinstance(config, dict):
        c = config.get("idempotency_key")
        if isinstance(c, str) and c.strip():
            return c.strip()
    execution = node.get("execution")
    if isinstance(execution, dict):
        e = execution.get("idempotency_key")
        if isinstance(e, str) and e.strip():
            return e.strip()
    return None


def lint_graph_design(raw: Any, *, strict: bool = False) -> GraphValidationResult:
    """Run design lint checks over a validated DAG graph.

    When ``strict=True``, warnings are promoted to errors for no-code publish gates.
    """
    base = validate_graph_definition(raw)
    if not base.valid or base.summary is None:
        return base
    if not isinstance(raw, dict):
        return base
    nodes_raw = raw.get("nodes")
    if not isinstance(nodes_raw, list):
        return base
    node_map: dict[str, dict[str, Any]] = {}
    for n in nodes_raw:
        if isinstance(n, dict) and isinstance(n.get("id"), str) and n["id"].strip():
            node_map[n["id"].strip()] = n

    node_ids = set(base.summary.get("node_ids") or [])
    adj: dict[str, list[str]] = {nid: [] for nid in node_ids}
    rev: dict[str, list[str]] = {nid: [] for nid in node_ids}
    incoming_count: dict[str, int] = {nid: 0 for nid in node_ids}
    for e in raw.get("edges", []) or []:
        if not isinstance(e, dict):
            continue
        s = e.get("source", e.get("from"))
        t = e.get("target", e.get("to"))
        if isinstance(s, str) and isinstance(t, str):
            s = s.strip()
            t = t.strip()
            if s in node_ids and t in node_ids:
                adj[s].append(t)
                rev[t].append(s)
                incoming_count[t] += 1
    for nid in node_ids:
        adj[nid] = sorted(set(adj[nid]))
        rev[nid] = sorted(set(rev[nid]))

    final_nodes = [
        nid
        for nid in node_ids
        if _node_kind(node_map.get(nid, {})) in _FINAL_KINDS
    ]
    if not final_nodes:
        final_nodes = list(base.summary.get("exit_nodes") or [])

    critical_ancestors: set[str] = set()
    stack: list[str] = list(final_nodes)
    while stack:
        cur = stack.pop()
        if cur in critical_ancestors:
            continue
        critical_ancestors.add(cur)
        stack.extend(rev.get(cur, []))

    errors = list(base.errors)
    warnings = list(base.warnings)

    for nid in sorted(node_ids):
        node = node_map.get(nid, {})
        kind = _node_kind(node)
        is_async = _node_async(node)
        is_background = kind in _BACKGROUND_KINDS
        is_side_effect = kind in _SIDE_EFFECT_KINDS

        if is_background and nid in critical_ancestors:
            errors.append(
                GraphValidationIssue(
                    code="BACKGROUND_ON_CRITICAL_PATH",
                    message=(
                        f"Background node '{nid}' ({kind}) is on the path to final response. "
                        "Move it to a non-blocking branch."
                    ),
                    path=f"nodes[{nid}]",
                    details={"node_id": nid, "kind": kind},
                ),
            )

        if is_async and is_side_effect and _idempotency_key(node) is None:
            errors.append(
                GraphValidationIssue(
                    code="ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY",
                    message=(
                        f"Async side-effect node '{nid}' ({kind}) requires idempotency_key "
                        "to support retries/replays safely."
                    ),
                    path=f"nodes[{nid}]",
                    details={"node_id": nid, "kind": kind},
                ),
            )

    async_node_ids = {nid for nid in node_ids if _node_async(node_map.get(nid, {}))}
    c_errors, c_warnings = lint_graph_contracts(
        raw,
        node_ids=node_ids,
        node_map=node_map,
        async_node_ids=async_node_ids,
    )
    errors.extend(c_errors)
    warnings.extend(c_warnings)

    for nid in sorted(node_ids):
        if incoming_count.get(nid, 0) <= 1:
            continue
        preds = rev.get(nid, [])
        async_preds = [p for p in preds if _node_async(node_map.get(p, {}))]
        if async_preds:
            warnings.append(
                GraphValidationIssue(
                    code="FANIN_FROM_ASYNC_BRANCH",
                    message=(
                        f"Node '{nid}' has fan-in from async predecessor(s): {', '.join(sorted(async_preds))}. "
                        "Avoid joining async branches into blocking response path."
                    ),
                    path=f"nodes[{nid}]",
                    details={"node_id": nid, "async_predecessors": sorted(async_preds)},
                ),
            )

    if strict and warnings:
        errors.extend(warnings)
        warnings = []

    summary = dict(base.summary or {})
    summary["lint"] = {
        "strict": strict,
        "final_nodes": sorted(final_nodes),
        "critical_path_node_count": len(critical_ancestors),
        "background_node_count": sum(
            1
            for nid in node_ids
            if _node_kind(node_map.get(nid, {})) in _BACKGROUND_KINDS
        ),
        "async_node_count": len(async_node_ids),
    }

    return GraphValidationResult(errors=errors, warnings=warnings, summary=summary)
