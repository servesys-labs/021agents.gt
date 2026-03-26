"""Tests for the API layer."""

from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.core.harness import AgentHarness


class TestAPI:
    def setup_method(self):
        from agentos.auth.jwt import create_token, set_secret
        set_secret("test-api-secret")

        harness = AgentHarness()
        self.app = create_app(harness)
        self.client = TestClient(self.app)
        self.token = create_token(user_id="test-user", email="test@test.com")
        self.auth = {"Authorization": f"Bearer {self.token}"}

    def teardown_method(self):
        from agentos.auth import jwt
        jwt._jwt_secret = None

    def test_health(self):
        resp = self.client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "version" in data

    def test_list_tools(self):
        resp = self.client.get("/tools", headers=self.auth)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_memory_snapshot(self):
        resp = self.client.get("/memory/snapshot", headers=self.auth)
        assert resp.status_code == 200

    def test_list_agents(self):
        resp = self.client.get("/agents", headers=self.auth)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_run_named_agent(self):
        resp = self.client.post(
            "/agents/nonexistent-xyz/run",
            json={"input": "hello"},
            headers=self.auth,
        )
        assert resp.status_code == 410
        assert "edge-first architecture" in resp.json().get("detail", "")

    def test_get_agent_not_found(self):
        resp = self.client.get("/agents/nonexistent-xyz", headers=self.auth)
        assert resp.status_code == 404

    def test_run_is_edge_only(self):
        resp = self.client.post("/run", json={"input": "keep going"}, headers=self.auth)
        assert resp.status_code == 410
        assert "edge-first architecture" in resp.json().get("detail", "")
