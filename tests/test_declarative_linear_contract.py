"""Contract tests for linear declarative graph bridge (`agentos/graph/declarative_linear.py`)."""

from __future__ import annotations

import pytest

from agentos.graph.declarative_linear import (
    EDGE_FRESH_GRAPH_KIND_MAP,
    run_bounded_dag_declarative_graph,
    run_linear_declarative_graph,
    validate_bounded_dag_declarative_graph,
    validate_linear_declarative_graph,
)


def test_validate_linear_rejects_branching() -> None:
    spec = {
        "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
        "edges": [
            {"source": "a", "target": "b"},
            {"source": "a", "target": "c"},
        ],
    }
    r = validate_linear_declarative_graph(spec)
    assert not r.valid
    assert any(e.code == "NOT_LINEAR_PATH" for e in r.errors)


def test_validate_linear_accepts_simple_chain() -> None:
    spec = {
        "nodes": [{"id": "x", "kind": "bootstrap"}, {"id": "y", "type": "llm"}],
        "edges": [{"source": "x", "target": "y"}],
    }
    r = validate_linear_declarative_graph(spec)
    assert r.valid
    assert r.summary is not None
    assert r.summary["linear_path"] == ["x", "y"]


def test_run_linear_maps_kinds_to_handlers_and_edge_ids() -> None:
    spec = {
        "id": "chain",
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "route_llm"},
            {"id": "n3", "kind": "final"},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
        ],
    }

    def bump(key: str):
        def _fn(state: dict) -> dict:
            out = dict(state)
            out[key] = int(out.get(key, 0)) + 1
            return out

        return _fn

    handlers = {
        "bootstrap": bump("boot"),
        "route_llm": bump("llm"),
        "final": bump("fin"),
    }
    s1 = run_linear_declarative_graph(spec, handlers, initial_state={})
    s2 = run_linear_declarative_graph(spec, handlers, initial_state={})
    assert s1 == s2
    assert s1["boot"] == 1 and s1["llm"] == 1 and s1["fin"] == 1
    trace = s1["__linear_trace__"]
    assert [t["node_id"] for t in trace] == ["n1", "n2", "n3"]
    assert trace[0]["edge_executor_id"] == EDGE_FRESH_GRAPH_KIND_MAP["bootstrap"]
    assert trace[1]["edge_executor_id"] == EDGE_FRESH_GRAPH_KIND_MAP["route_llm"]
    assert trace[2]["edge_executor_id"] == EDGE_FRESH_GRAPH_KIND_MAP["final"]


def test_run_linear_prefers_kind_over_type() -> None:
    spec = {
        "nodes": [
            {"id": "a", "kind": "real", "type": "ignored"},
            {"id": "b", "kind": "final"},
        ],
        "edges": [{"source": "a", "target": "b"}],
    }
    handlers = {
        "real": lambda s: {**s, "which": "real"},
        "final": lambda s: {**s, "done": True},
    }
    out = run_linear_declarative_graph(spec, handlers)
    assert out["which"] == "real" and out["done"] is True


def test_run_linear_raises_on_missing_handler() -> None:
    spec = {
        "nodes": [{"id": "a", "kind": "unknown"}],
        "edges": [],
    }
    with pytest.raises(ValueError, match="no handler"):
        run_linear_declarative_graph(spec, {})


def test_validate_bounded_dag_accepts_branch_and_fanin_with_deterministic_order() -> None:
    spec = {
        "nodes": [
            {"id": "a", "kind": "bootstrap"},
            {"id": "b", "kind": "tools"},
            {"id": "c", "kind": "summarize"},
            {"id": "d", "kind": "final"},
        ],
        "edges": [
            {"source": "a", "target": "b"},
            {"source": "a", "target": "c"},
            {"source": "b", "target": "d"},
            {"source": "c", "target": "d"},
        ],
    }
    r = validate_bounded_dag_declarative_graph(spec, max_branching=2, max_fanin=2)
    assert r.valid
    assert r.summary is not None
    assert r.summary["execution_order"] == ["a", "b", "c", "d"]


def test_validate_bounded_dag_rejects_branching_bound_violation() -> None:
    spec = {
        "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
        "edges": [
            {"source": "a", "target": "b"},
            {"source": "a", "target": "c"},
            {"source": "a", "target": "d"},
        ],
    }
    r = validate_bounded_dag_declarative_graph(spec, max_branching=2, max_fanin=3)
    assert not r.valid
    assert any(e.code == "TOO_MANY_BRANCHES" for e in r.errors)


def test_run_bounded_dag_is_replay_deterministic() -> None:
    spec = {
        "nodes": [
            {"id": "a", "kind": "bootstrap"},
            {"id": "b", "kind": "tools"},
            {"id": "c", "kind": "summarize"},
            {"id": "d", "kind": "final"},
        ],
        "edges": [
            {"source": "a", "target": "b"},
            {"source": "a", "target": "c"},
            {"source": "b", "target": "d"},
            {"source": "c", "target": "d"},
        ],
    }
    handlers = {
        "bootstrap": lambda s: {**s, "boot": int(s.get("boot", 0)) + 1},
        "tools": lambda s: {**s, "tools": int(s.get("tools", 0)) + 1},
        "summarize": lambda s: {**s, "sum": int(s.get("sum", 0)) + 1},
        "final": lambda s: {**s, "fin": int(s.get("fin", 0)) + 1},
    }
    s1 = run_bounded_dag_declarative_graph(spec, handlers, initial_state={"seed": 1})
    s2 = run_bounded_dag_declarative_graph(spec, handlers, initial_state={"seed": 1})
    assert s1 == s2
    assert s1["__execution_order__"] == ["a", "b", "c", "d"]
    assert [t["node_id"] for t in s1["__dag_trace__"]] == ["a", "b", "c", "d"]
