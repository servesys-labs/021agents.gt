"""Control-plane boundary tests for edge-first runtime ownership."""

from __future__ import annotations

from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.auth.jwt import create_token, set_secret
from agentos.core.harness import AgentHarness


def _auth_header() -> dict[str, str]:
    set_secret("test-control-plane-boundary")
    token = create_token(user_id="boundary-user", email="boundary@test.com")
    return {"Authorization": f"Bearer {token}"}


def test_top_level_run_endpoint_is_gone() -> None:
    client = TestClient(create_app(AgentHarness()))
    resp = client.post("/run", json={"input": "hello"}, headers=_auth_header())
    assert resp.status_code == 410
    assert "edge-first architecture" in resp.json().get("detail", "")


def test_top_level_run_stream_endpoint_is_gone() -> None:
    client = TestClient(create_app(AgentHarness()))
    resp = client.post("/run/stream", json={"input": "hello"}, headers=_auth_header())
    assert resp.status_code == 410
    assert "runtime-proxy/agent/run" in resp.json().get("detail", "")


def test_named_agent_run_endpoint_is_gone() -> None:
    client = TestClient(create_app(AgentHarness()))
    resp = client.post("/agents/test-agent/run", json={"input": "hello"}, headers=_auth_header())
    assert resp.status_code == 410
    assert "edge-first architecture" in resp.json().get("detail", "")
