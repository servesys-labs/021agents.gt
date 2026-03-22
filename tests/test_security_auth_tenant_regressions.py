from __future__ import annotations

from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.auth.jwt import create_token, verify_token
from agentos.core.harness import AgentHarness


def test_jwt_org_id_round_trip():
    token = create_token(user_id="u1", email="u1@example.com", extra={"org_id": "org-123"})
    claims = verify_token(token)
    assert claims is not None
    assert claims.org_id == "org-123"


def test_top_level_run_requires_auth():
    client = TestClient(create_app(AgentHarness()))
    resp = client.post("/run", json={"input": "hello"})
    assert resp.status_code == 401


def test_jobs_list_requires_auth():
    client = TestClient(create_app(AgentHarness()))
    resp = client.get("/api/v1/jobs")
    assert resp.status_code == 401
