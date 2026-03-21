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
