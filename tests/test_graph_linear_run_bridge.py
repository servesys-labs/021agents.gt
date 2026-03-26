"""Control-plane ↔ edge bridge for linear declarative graph runs."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.auth.jwt import create_token, set_secret
from agentos.core.harness import AgentHarness


def _auth_header() -> dict[str, str]:
    set_secret("test-graph-linear-bridge")
    token = create_token(user_id="graph-bridge-user", email="graph-bridge@test.com")
    return {"Authorization": f"Bearer {token}"}


LINEAR_GRAPH: dict[str, Any] = {
    "id": "bridge-test",
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


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.chdir(tmp_path)
    return TestClient(create_app(AgentHarness()))


def test_linear_run_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/graphs/linear-run",
        json={
            "graph": LINEAR_GRAPH,
            "task": "hello",
            "agent_context": {"agent_name": "demo"},
        },
    )
    assert resp.status_code == 401


def test_linear_run_requires_task_or_input(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/graphs/linear-run",
        json={"graph": LINEAR_GRAPH, "agent_context": {"agent_name": "demo"}},
        headers=_auth_header(),
    )
    assert resp.status_code == 422


def test_linear_run_422_when_graph_not_linear(client: TestClient) -> None:
    branching = {
        "nodes": [{"id": "a", "kind": "x"}, {"id": "b", "kind": "y"}, {"id": "c", "kind": "z"}],
        "edges": [
            {"source": "a", "target": "b"},
            {"source": "a", "target": "c"},
        ],
    }
    resp = client.post(
        "/api/v1/graphs/linear-run",
        json={
            "graph": branching,
            "task": "t",
            "agent_context": {"agent_name": "demo"},
        },
        headers=_auth_header(),
    )
    assert resp.status_code == 422
    detail = resp.json().get("detail")
    assert isinstance(detail, dict)
    assert any(e.get("code") == "NOT_LINEAR_PATH" for e in detail.get("errors", []))


def test_linear_run_503_when_edge_url_missing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDGE_RUNTIME_URL", raising=False)
    monkeypatch.delenv("EDGE_RUNTIME_TOKEN", raising=False)
    resp = client.post(
        "/api/v1/graphs/linear-run",
        json={
            "graph": LINEAR_GRAPH,
            "task": "hello",
            "agent_context": {"agent_name": "demo"},
        },
        headers=_auth_header(),
    )
    assert resp.status_code == 503
    assert "EDGE_RUNTIME_URL" in resp.json().get("detail", "")


def test_linear_run_503_when_edge_token_missing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example.test")
    monkeypatch.delenv("EDGE_RUNTIME_TOKEN", raising=False)
    resp = client.post(
        "/api/v1/graphs/linear-run",
        json={
            "graph": LINEAR_GRAPH,
            "task": "hello",
            "agent_context": {"agent_name": "demo"},
        },
        headers=_auth_header(),
    )
    assert resp.status_code == 503
    assert "EDGE_RUNTIME_TOKEN" in resp.json().get("detail", "")


def test_linear_run_proxies_to_edge_with_validation_payload(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example.test")
    monkeypatch.setenv("EDGE_RUNTIME_TOKEN", "edge-secret-token")

    captured: dict[str, Any] = {}

    class _Resp:
        def __init__(self, status_code: int, payload: dict[str, Any] | None = None) -> None:
            self.status_code = status_code
            self._payload = payload or {}
            self.text = json.dumps(self._payload)

        def json(self) -> dict[str, Any]:
            return self._payload

    class _AsyncClient:
        def __init__(self, timeout: float = 10) -> None:
            self.timeout = timeout

        async def __aenter__(self) -> _AsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, json: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> _Resp:
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return _Resp(
                200,
                {
                    "edge_ok": True,
                    "forwarded_linear_path": json.get("validation", {}).get("linear_path"),
                    "trace_digest_sha256": "lin123",
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", _AsyncClient)

    resp = client.post(
        "/api/v1/graphs/linear-run",
        json={
            "graph": LINEAR_GRAPH,
            "input": "from input alias",
            "agent_context": {"agent_name": "my-agent", "org_id": "o1"},
            "initial_state": {"seed": 1},
        },
        headers=_auth_header(),
    )
    assert resp.status_code == 200
    assert resp.json().get("edge_ok") is True
    assert resp.json().get("forwarded_linear_path") == ["n1", "n2", "n3"]
    assert resp.json().get("trace_digest_sha256") == "lin123"

    assert captured["url"] == "https://edge.example.test/api/v1/graphs/linear-run"
    assert captured["headers"].get("Authorization") == "Bearer edge-secret-token"
    fwd = captured["json"]
    assert fwd["task"] == "from input alias"
    assert fwd["agent_context"] == {"agent_name": "my-agent", "org_id": "o1"}
    assert fwd["initial_state"] == {"seed": 1}
    assert fwd["validation"]["linear_path"] == ["n1", "n2", "n3"]
    assert fwd["validation"].get("graph_id") == "bridge-test"


def test_linear_run_forwards_edge_error_status(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example.test")
    monkeypatch.setenv("EDGE_RUNTIME_TOKEN", "tok")

    class _Resp:
        def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
            self.status_code = status_code
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self) -> dict[str, Any]:
            return self._payload

    class _AsyncClient:
        def __init__(self, timeout: float = 10) -> None:
            self.timeout = timeout

        async def __aenter__(self) -> _AsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, json: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> _Resp:
            return _Resp(401, {"error": "unauthorized"})

    monkeypatch.setattr(httpx, "AsyncClient", _AsyncClient)

    resp = client.post(
        "/api/v1/graphs/linear-run",
        json={"graph": LINEAR_GRAPH, "task": "x", "agent_context": {"agent_name": "a"}},
        headers=_auth_header(),
    )
    assert resp.status_code == 401
    assert resp.json().get("detail") == {"error": "unauthorized"}


def test_edge_worker_exposes_linear_graph_route() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    index_ts = (root / "deploy" / "src" / "index.ts").read_text(encoding="utf-8")
    assert '/api/v1/graphs/linear-run' in index_ts
    assert "executeLinearDeclarativeRun" in index_ts


def test_edge_linear_declarative_exports_kind_map() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    text = (root / "deploy" / "src" / "runtime" / "linear_declarative.ts").read_text(encoding="utf-8")
    assert "export const EDGE_FRESH_GRAPH_KIND_MAP" in text
    assert "export function executeLinearDeclarativeRun" in text
    assert "export function executeBoundedDagDeclarativeRun" in text
    assert "fresh_bootstrap" in text


def test_edge_linear_route_emits_trace_digest_contract() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    text = (root / "deploy" / "src" / "index.ts").read_text(encoding="utf-8")
    assert "trace_digest_sha256: traceDigestSha256" in text
    assert "sha256Hex(JSON.stringify(result.linear_trace))" in text
