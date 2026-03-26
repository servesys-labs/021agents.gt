"""Deterministic graph lint auto-fix helpers for no-code workflows."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from agentos.graph.design_lint import lint_graph_design


def lint_payload_from_result(result: Any) -> dict[str, Any]:
    """Serialize lint result into API-safe payload."""
    return {
        "valid": bool(getattr(result, "valid", False)),
        "errors": [e.to_dict() for e in getattr(result, "errors", [])],
        "warnings": [w.to_dict() for w in getattr(result, "warnings", [])],
        "summary": getattr(result, "summary", None),
    }


def _node_id_from_issue(issue: dict[str, Any]) -> str:
    details = issue.get("details")
    if isinstance(details, dict):
        nid = details.get("node_id")
        if isinstance(nid, str) and nid.strip():
            return nid.strip()
    path = issue.get("path")
    if isinstance(path, str) and path.startswith("nodes[") and path.endswith("]"):
        return path[len("nodes[") : -1]
    return ""


def autofix_graph_common_issues(
    graph: dict[str, Any],
    issues: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Apply deterministic fixes for known lint issue codes."""
    fixed = deepcopy(graph)
    nodes_raw = fixed.get("nodes")
    edges_raw = fixed.get("edges")
    if not isinstance(nodes_raw, list) or not isinstance(edges_raw, list):
        return fixed, []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    for node in nodes_raw:
        if isinstance(node, dict) and isinstance(node.get("id"), str):
            nid = node["id"].strip()
            if nid:
                nodes_by_id[nid] = node
    applied: list[dict[str, Any]] = []
    for issue in issues:
        code = str(issue.get("code", "")).strip()
        if code == "ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY":
            nid = _node_id_from_issue(issue)
            node = nodes_by_id.get(nid)
            if isinstance(node, dict):
                node["idempotency_key"] = (
                    node.get("idempotency_key")
                    or f"session:${{session_id}}:turn:${{turn}}:{nid or 'side_effect'}"
                )
                applied.append({"code": code, "node_id": nid, "action": "set_idempotency_key"})
        elif code == "BACKGROUND_ON_CRITICAL_PATH":
            nid = _node_id_from_issue(issue)
            before = len(edges_raw)
            edges_raw[:] = [
                e
                for e in edges_raw
                if not (
                    isinstance(e, dict)
                    and isinstance(e.get("source", e.get("from")), str)
                    and e.get("source", e.get("from")).strip() == nid
                )
            ]
            if len(edges_raw) != before:
                applied.append({"code": code, "node_id": nid, "action": "remove_outgoing_edges"})
        elif code == "FANIN_FROM_ASYNC_BRANCH":
            details = issue.get("details")
            async_preds = []
            if isinstance(details, dict):
                raw_preds = details.get("async_predecessors")
                if isinstance(raw_preds, list):
                    async_preds = [str(p).strip() for p in raw_preds if isinstance(p, str) and p.strip()]
            changed = []
            for pred in async_preds:
                node = nodes_by_id.get(pred)
                if isinstance(node, dict):
                    node["async"] = False
                    changed.append(pred)
            if changed:
                applied.append({"code": code, "node_ids": changed, "action": "set_async_false"})
    return fixed, applied


def lint_and_autofix_graph(
    graph: dict[str, Any],
    *,
    strict: bool,
    apply: bool = True,
) -> dict[str, Any]:
    """Run lint and return optional post-fix candidate with before/after status."""
    before = lint_graph_design(graph, strict=strict)
    before_payload = lint_payload_from_result(before)
    if not apply or before_payload["valid"]:
        return {
            "autofix_applied": False,
            "applied_fixes": [],
            "graph": graph,
            "lint_before": before_payload,
            "lint_after": before_payload,
        }
    fixed_graph, applied = autofix_graph_common_issues(graph, before_payload["errors"])
    after = lint_graph_design(fixed_graph, strict=strict)
    return {
        "autofix_applied": len(applied) > 0,
        "applied_fixes": applied,
        "graph": fixed_graph,
        "lint_before": before_payload,
        "lint_after": lint_payload_from_result(after),
    }
