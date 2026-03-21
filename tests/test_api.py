"""Tests for the API layer."""

import pytest
from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.core.harness import AgentHarness


class TestAPI:
    def setup_method(self):
        harness = AgentHarness()
        self.app = create_app(harness)
        self.client = TestClient(self.app)

    def test_health(self):
        resp = self.client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "version" in data

    def test_list_tools(self):
        resp = self.client.get("/tools")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_memory_snapshot(self):
        resp = self.client.get("/memory/snapshot")
        assert resp.status_code == 200

    def test_list_agents(self):
        resp = self.client.get("/agents")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_run_named_agent(self):
        # This tests the /agents/{name}/run endpoint
        # It should return 404 for a nonexistent agent
        resp = self.client.post(
            "/agents/nonexistent-xyz/run",
            json={"input": "hello"},
        )
        assert resp.status_code == 404

    def test_get_agent_not_found(self):
        resp = self.client.get("/agents/nonexistent-xyz")
        assert resp.status_code == 404
