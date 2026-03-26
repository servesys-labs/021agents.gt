"""Control-plane ↔ edge bridge for bounded DAG declarative graph runs."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.auth.jwt import create_token, set_secret
from agentos.core.harness import AgentHarness


def _auth_header() -> dict[str, str]:
    set_secret("test-graph-dag-bridge")
    token = create_token(user_id="graph-dag-user", email="graph-dag@test.com")
    return {"Authorization": f"Bearer {token}"}


DAG_GRAPH: dict[str, Any] = {
    "id": "dag-bridge-test",
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


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.chdir(tmp_path)
    return TestClient(create_app(AgentHarness()))


def test_dag_run_422_when_branching_bound_exceeded(client: TestClient) -> None:
    too_many = {
        "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
        "edges": [
            {"source": "a", "target": "b"},
            {"source": "a", "target": "c"},
            {"source": "a", "target": "d"},
        ],
    }
    resp = client.post(
        "/api/v1/graphs/dag-run",
        json={"graph": too_many, "task": "t", "max_branching": 2, "agent_context": {"agent_name": "demo"}},
        headers=_auth_header(),
    )
    assert resp.status_code == 422
    detail = resp.json().get("detail")
    assert isinstance(detail, dict)
    assert any(e.get("code") == "TOO_MANY_BRANCHES" for e in detail.get("errors", []))


def test_dag_run_proxies_execution_order_validation(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
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
                    "trace_digest_sha256": "abc123",
                    "execution_order": ["a", "b", "c", "d"],
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", _AsyncClient)

    resp = client.post(
        "/api/v1/graphs/dag-run",
        json={
            "graph": DAG_GRAPH,
            "task": "hello",
            "max_branching": 2,
            "max_fanin": 2,
            "agent_context": {"agent_name": "my-agent", "org_id": "o1"},
            "initial_state": {"seed": 1},
        },
        headers=_auth_header(),
    )
    assert resp.status_code == 200
    assert resp.json().get("edge_ok") is True
    assert resp.json().get("trace_digest_sha256") == "abc123"
    assert captured["url"] == "https://edge.example.test/api/v1/graphs/dag-run"
    fwd = captured["json"]
    assert fwd["max_branching"] == 2
    assert fwd["max_fanin"] == 2
    assert fwd["validation"]["execution_order"] == ["a", "b", "c", "d"]


def test_edge_worker_exposes_dag_graph_route() -> None:
    root = Path(__file__).resolve().parent.parent
    index_ts = (root / "deploy" / "src" / "index.ts").read_text(encoding="utf-8")
    assert "/api/v1/graphs/dag-run" in index_ts
    assert "executeBoundedDagDeclarativeRun" in index_ts


def test_dag_run_forwards_edge_validation_mismatch_status(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example.test")
    monkeypatch.setenv("EDGE_RUNTIME_TOKEN", "edge-secret-token")

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

        async def post(
            self,
            url: str,
            json: dict[str, Any] | None = None,
            headers: dict[str, str] | None = None,
        ) -> _Resp:
            return _Resp(
                409,
                {
                    "success": False,
                    "error_code": "VALIDATION_MISMATCH",
                    "error": "validation.execution_order does not match graph structure",
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", _AsyncClient)

    resp = client.post(
        "/api/v1/graphs/dag-run",
        json={
            "graph": DAG_GRAPH,
            "task": "hello",
            "max_branching": 2,
            "max_fanin": 2,
            "agent_context": {"agent_name": "my-agent"},
        },
        headers=_auth_header(),
    )
    assert resp.status_code == 409
    detail = resp.json().get("detail")
    assert isinstance(detail, dict)
    assert detail.get("error_code") == "VALIDATION_MISMATCH"


def test_dag_run_forwarded_validation_payload_is_replay_stable(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDGE_RUNTIME_URL", "https://edge.example.test")
    monkeypatch.setenv("EDGE_RUNTIME_TOKEN", "edge-secret-token")
    captures: list[dict[str, Any]] = []

    class _Resp:
        def __init__(self) -> None:
            self.status_code = 200
            self._payload = {"edge_ok": True}
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

        async def post(
            self,
            url: str,
            json: dict[str, Any] | None = None,
            headers: dict[str, str] | None = None,
        ) -> _Resp:
            captures.append(dict(json or {}))
            return _Resp()

    monkeypatch.setattr(httpx, "AsyncClient", _AsyncClient)

    payload = {
        "graph": DAG_GRAPH,
        "task": "same input",
        "max_branching": 2,
        "max_fanin": 2,
        "agent_context": {"agent_name": "my-agent"},
    }
    r1 = client.post("/api/v1/graphs/dag-run", json=payload, headers=_auth_header())
    r2 = client.post("/api/v1/graphs/dag-run", json=payload, headers=_auth_header())
    assert r1.status_code == 200 and r2.status_code == 200

    assert len(captures) == 2
    v1 = captures[0]["validation"]["execution_order"]
    v2 = captures[1]["validation"]["execution_order"]
    assert v1 == v2 == ["a", "b", "c", "d"]
    h1 = hashlib.sha256("\0".join(v1).encode("utf-8")).hexdigest()
    h2 = hashlib.sha256("\0".join(v2).encode("utf-8")).hexdigest()
    assert h1 == h2
