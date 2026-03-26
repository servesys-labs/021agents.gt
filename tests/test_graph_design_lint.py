from __future__ import annotations

from fastapi.testclient import TestClient

from agentos.api.deps import _get_db
from agentos.api.app import create_app
from agentos.auth.jwt import create_token, set_secret
from agentos.core.harness import AgentHarness
from agentos.graph.design_lint import lint_graph_design


def _auth_header() -> dict[str, str]:
    set_secret("test-graph-design-lint")
    token = create_token(user_id="graph-lint-user", email="graph-lint@test.com")
    return {"Authorization": f"Bearer {token}"}


def test_lint_flags_background_node_on_critical_path() -> None:
    spec = {
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "telemetry_emit"},
            {"id": "n3", "kind": "final"},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
        ],
    }
    r = lint_graph_design(spec)
    assert not r.valid
    assert any(e.code == "BACKGROUND_ON_CRITICAL_PATH" for e in r.errors)


def test_lint_flags_async_side_effect_without_idempotency() -> None:
    spec = {
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "telemetry_emit", "async": True},
            {"id": "n3", "kind": "final"},
        ],
        "edges": [
            {"source": "n1", "target": "n3"},
            {"source": "n1", "target": "n2"},
        ],
    }
    r = lint_graph_design(spec)
    assert not r.valid
    assert any(e.code == "ASYNC_SIDE_EFFECT_MISSING_IDEMPOTENCY" for e in r.errors)


def test_lint_warns_on_fanin_from_async_branch() -> None:
    spec = {
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "route_llm"},
            {"id": "n3", "kind": "summarize", "async": True},
            {"id": "n4", "kind": "tools"},
            {"id": "n5", "kind": "final"},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n1", "target": "n3"},
            {"source": "n2", "target": "n4"},
            {"source": "n3", "target": "n4"},
            {"source": "n4", "target": "n5"},
        ],
    }
    r = lint_graph_design(spec, strict=False)
    assert r.valid
    assert any(w.code == "FANIN_FROM_ASYNC_BRANCH" for w in r.warnings)

    strict_r = lint_graph_design(spec, strict=True)
    assert not strict_r.valid
    assert any(e.code == "FANIN_FROM_ASYNC_BRANCH" for e in strict_r.errors)


def test_graph_lint_api_returns_lint_summary(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    client = TestClient(create_app(AgentHarness()))
    spec = {
        "id": "no-code-agent",
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "route_llm"},
            {"id": "n3", "kind": "final"},
            {"id": "n4", "kind": "telemetry_emit", "async": True, "idempotency_key": "sess:turn:n4"},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
            {"source": "n1", "target": "n4"},
        ],
    }
    resp = client.post(
        "/api/v1/graphs/lint",
        json={"graph": spec, "strict": False},
        headers=_auth_header(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    assert body["summary"]["graph_id"] == "no-code-agent"
    assert body["summary"]["lint"]["strict"] is False
    assert body["summary"]["lint"]["background_node_count"] == 1


def test_graph_autofix_api_fixes_common_lint_failures(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    client = TestClient(create_app(AgentHarness()))
    spec = {
        "id": "auto-fix-graph",
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "route_llm"},
            {"id": "n3", "kind": "final"},
            {"id": "n4", "kind": "telemetry_emit", "async": True},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
            {"source": "n2", "target": "n4"},
            {"source": "n4", "target": "n3"},
        ],
    }
    resp = client.post(
        "/api/v1/graphs/autofix",
        json={"graph": spec, "strict": True, "apply": True},
        headers=_auth_header(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["autofix_applied"] is True
    assert body["lint_before"]["valid"] is False
    assert body["lint_after"]["valid"] is True
    fixed = body["graph"]
    n4 = next(n for n in fixed["nodes"] if n["id"] == "n4")
    assert isinstance(n4.get("idempotency_key"), str) and n4["idempotency_key"]
    assert not any(
        e.get("source", e.get("from")) == "n4" for e in fixed.get("edges", [])
    )


def test_graph_gate_pack_promote_candidate_when_lint_and_eval_pass(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    client = TestClient(create_app(AgentHarness()))
    (tmp_path / "data").mkdir(parents=True, exist_ok=True)
    (tmp_path / "data" / "agent.db").touch()
    db = _get_db()
    db.insert_eval_run(
        {
            "agent_name": "gate-pass-agent",
            "benchmark_name": "smoke",
            "total_tasks": 3,
            "total_trials": 9,
            "pass_count": 8,
            "fail_count": 1,
            "error_count": 0,
            "pass_rate": 0.89,
            "avg_score": 0.9,
        },
    )
    graph = {
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "route_llm"},
            {"id": "n3", "kind": "final"},
            {"id": "n4", "kind": "telemetry_emit", "async": True, "idempotency_key": "sess:turn:n4"},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
            {"source": "n1", "target": "n4"},
        ],
    }
    resp = client.post(
        "/api/v1/graphs/gate-pack",
        json={
            "agent_name": "gate-pass-agent",
            "graph": graph,
            "strict_graph_lint": True,
            "min_eval_pass_rate": 0.85,
            "min_eval_trials": 3,
            "target_channel": "staging",
        },
        headers=_auth_header(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["graph_lint"]["valid"] is True
    assert body["eval_gate"]["passed"] is True
    assert body["rollout"]["decision"] == "promote_candidate"


def test_lint_flags_async_state_write_without_idempotency() -> None:
    spec = {
        "state_contract": {"reducers": {"memory.facts": "append"}},
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "tools", "async": True, "state_writes": ["memory.facts"]},
            {"id": "n3", "kind": "final"},
        ],
        "edges": [
            {"source": "n1", "target": "n3"},
            {"source": "n1", "target": "n2"},
        ],
    }
    r = lint_graph_design(spec, strict=True)
    assert not r.valid
    assert any(e.code == "ASYNC_STATE_WRITE_MISSING_IDEMPOTENCY" for e in r.errors)


def test_lint_warns_for_state_write_without_reducer() -> None:
    spec = {
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "tools", "state_writes": ["plan.summary"]},
            {"id": "n3", "kind": "final"},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
        ],
    }
    r = lint_graph_design(spec, strict=False)
    assert r.valid
    assert any(w.code == "STATE_WRITE_WITHOUT_REDUCER" for w in r.warnings)


def test_lint_flags_invalid_skill_manifest_shape() -> None:
    spec = {
        "nodes": [
            {"id": "n1", "kind": "bootstrap"},
            {"id": "n2", "kind": "tools", "skills": [{"description": "missing id"}]},
            {"id": "n3", "kind": "final"},
        ],
        "edges": [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
        ],
    }
    r = lint_graph_design(spec, strict=True)
    assert not r.valid
    assert any(e.code == "MISSING_SKILL_ID" for e in r.errors)
