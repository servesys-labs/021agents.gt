"""Tests for API v1 routers — auth, agents, sessions, billing, etc."""

import json
import pytest
from pathlib import Path
from fastapi.testclient import TestClient


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    """Create a test API client with initialized project."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "agents").mkdir()
    (tmp_path / "eval").mkdir()

    # Create DB with v3 schema (portal tables)
    from agentos.core.database import create_database, MIGRATION_V2_TO_V3
    db = create_database(tmp_path / "data" / "agent.db")
    # Force v3 tables
    for stmt in MIGRATION_V2_TO_V3.split(";"):
        stmt = stmt.strip()
        if stmt:
            try:
                db.conn.execute(stmt)
            except Exception:
                pass
    db.conn.commit()
    db.close()

    # Create test agent
    agent_config = {
        "name": "test-agent", "description": "A test agent", "version": "0.1.0",
        "system_prompt": "You are helpful.", "model": "stub-model",
        "tools": [], "governance": {"budget_limit_usd": 10.0, "require_confirmation_for_destructive": True, "blocked_tools": [], "allowed_domains": []},
        "memory": {"working": {"max_items": 50}, "episodic": {"max_episodes": 100, "ttl_days": 30}, "procedural": {"max_procedures": 50}},
        "max_turns": 5, "tags": ["test"],
    }
    (tmp_path / "agents" / "test-agent.json").write_text(json.dumps(agent_config, indent=2))

    # Create eval tasks
    (tmp_path / "eval" / "smoke-test.json").write_text(json.dumps([
        {"name": "greeting", "input": "Say hello", "expected": "hello", "grader": "contains"},
    ]))

    from agentos.api.app import create_app
    from agentos.core.harness import AgentHarness
    app = create_app(AgentHarness())
    return TestClient(app)


class TestHealthEndpoint:
    def test_health(self, api_client):
        resp = api_client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "version" in data
        assert "uptime_seconds" in data


class TestAuthRouter:
    def test_signup(self, api_client):
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": "test@example.com", "password": "pass123", "name": "Test",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert data["email"] == "test@example.com"
        assert data["org_id"]  # Personal org created

    def test_signup_duplicate(self, api_client):
        api_client.post("/api/v1/auth/signup", json={"email": "dup@test.com", "password": "p"})
        resp = api_client.post("/api/v1/auth/signup", json={"email": "dup@test.com", "password": "p"})
        assert resp.status_code == 409

    def test_login(self, api_client):
        api_client.post("/api/v1/auth/signup", json={"email": "login@test.com", "password": "secret"})
        resp = api_client.post("/api/v1/auth/login", json={"email": "login@test.com", "password": "secret"})
        assert resp.status_code == 200
        assert "token" in resp.json()

    def test_login_wrong_password(self, api_client):
        api_client.post("/api/v1/auth/signup", json={"email": "wp@test.com", "password": "right"})
        resp = api_client.post("/api/v1/auth/login", json={"email": "wp@test.com", "password": "wrong"})
        assert resp.status_code == 401

    def test_me(self, api_client):
        signup = api_client.post("/api/v1/auth/signup", json={"email": "me@test.com", "password": "p"}).json()
        resp = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {signup['token']}"})
        assert resp.status_code == 200
        assert resp.json()["email"] == "me@test.com"

    def test_me_no_auth(self, api_client):
        resp = api_client.get("/api/v1/auth/me")
        assert resp.status_code == 401

    def test_logout(self, api_client):
        signup = api_client.post("/api/v1/auth/signup", json={"email": "out@test.com", "password": "p"}).json()
        resp = api_client.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {signup['token']}"})
        assert resp.status_code == 200


class TestAgentsRouter:
    def test_list_agents(self, api_client):
        resp = api_client.get("/api/v1/agents")
        assert resp.status_code == 200
        agents = resp.json()
        assert len(agents) >= 1
        assert agents[0]["name"] == "test-agent"

    def test_get_agent(self, api_client):
        resp = api_client.get("/api/v1/agents/test-agent")
        assert resp.status_code == 200
        assert resp.json()["name"] == "test-agent"

    def test_get_agent_not_found(self, api_client):
        resp = api_client.get("/api/v1/agents/nonexistent")
        assert resp.status_code == 404

    def test_get_agent_config(self, api_client):
        resp = api_client.get("/api/v1/agents/test-agent/config")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "test-agent"
        assert "system_prompt" in data

    def test_export_import(self, api_client):
        # Export
        resp = api_client.get("/api/v1/agents/test-agent/export")
        assert resp.status_code == 200
        config = resp.json()["agent"]
        assert config["name"] == "test-agent"


class TestSessionsRouter:
    def test_list_empty(self, api_client):
        resp = api_client.get("/api/v1/sessions")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_stats(self, api_client):
        resp = api_client.get("/api/v1/sessions/stats/summary")
        assert resp.status_code == 200
        data = resp.json()
        assert "total_sessions" in data


class TestApiKeysRouter:
    def _auth_header(self, api_client):
        signup = api_client.post("/api/v1/auth/signup", json={"email": "key@test.com", "password": "p"}).json()
        return {"Authorization": f"Bearer {signup['token']}"}

    def test_create_and_list(self, api_client):
        headers = self._auth_header(api_client)
        resp = api_client.post("/api/v1/api-keys", json={"name": "test-key"}, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["key"].startswith("ak_")
        assert data["name"] == "test-key"

        resp = api_client.get("/api/v1/api-keys", headers=headers)
        assert len(resp.json()) == 1

    def test_revoke(self, api_client):
        headers = self._auth_header(api_client)
        key = api_client.post("/api/v1/api-keys", json={"name": "revoke-me"}, headers=headers).json()
        resp = api_client.delete(f"/api/v1/api-keys/{key['key_id']}", headers=headers)
        assert resp.status_code == 200

    def test_rotate(self, api_client):
        headers = self._auth_header(api_client)
        key = api_client.post("/api/v1/api-keys", json={"name": "rotate-me"}, headers=headers).json()
        resp = api_client.post(f"/api/v1/api-keys/{key['key_id']}/rotate", headers=headers)
        assert resp.status_code == 200
        new_key = resp.json()
        assert new_key["key"] != key["key"]


class TestPlansRouter:
    def test_list_plans(self, api_client):
        resp = api_client.get("/api/v1/plans")
        assert resp.status_code == 200


class TestToolsRouter:
    def test_list_tools(self, api_client):
        resp = api_client.get("/api/v1/tools")
        assert resp.status_code == 200
        data = resp.json()
        assert "tools" in data
        assert len(data["tools"]) > 0


class TestObservabilityRouter:
    def test_stats(self, api_client):
        resp = api_client.get("/api/v1/observability/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert "tables" in data

    def test_cost_ledger(self, api_client):
        resp = api_client.get("/api/v1/observability/cost-ledger")
        assert resp.status_code == 200
        assert "entries" in resp.json()


class TestOrgsRouter:
    def _auth_header(self, api_client):
        signup = api_client.post("/api/v1/auth/signup", json={"email": "org@test.com", "password": "p"}).json()
        return {"Authorization": f"Bearer {signup['token']}"}

    def test_list_orgs(self, api_client):
        headers = self._auth_header(api_client)
        resp = api_client.get("/api/v1/orgs", headers=headers)
        assert resp.status_code == 200
        orgs = resp.json()
        assert len(orgs) == 1  # Personal org

    def test_create_org(self, api_client):
        headers = self._auth_header(api_client)
        resp = api_client.post("/api/v1/orgs", json={"name": "New Org"}, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["name"] == "New Org"


class TestWebhooksRouter:
    def _auth_header(self, api_client):
        signup = api_client.post("/api/v1/auth/signup", json={"email": "wh@test.com", "password": "p"}).json()
        return {"Authorization": f"Bearer {signup['token']}"}

    def test_create_and_list(self, api_client):
        headers = self._auth_header(api_client)
        resp = api_client.post("/api/v1/webhooks", json={"url": "https://example.com/hook"}, headers=headers)
        assert resp.status_code == 200
        wh = resp.json()
        assert wh["url"] == "https://example.com/hook"

        resp = api_client.get("/api/v1/webhooks", headers=headers)
        assert len(resp.json()) == 1

    def test_delete(self, api_client):
        headers = self._auth_header(api_client)
        wh = api_client.post("/api/v1/webhooks", json={"url": "https://del.com"}, headers=headers).json()
        resp = api_client.delete(f"/api/v1/webhooks/{wh['webhook_id']}", headers=headers)
        assert resp.status_code == 200


class TestSchedulesRouter:
    def _auth_header(self, api_client):
        signup = api_client.post("/api/v1/auth/signup", json={"email": "sched@test.com", "password": "p"}).json()
        return {"Authorization": f"Bearer {signup['token']}"}

    def test_create_and_list(self, api_client):
        headers = self._auth_header(api_client)
        resp = api_client.post("/api/v1/schedules", json={
            "agent_name": "test-agent", "cron": "@daily", "task": "check health",
        }, headers=headers)
        assert resp.status_code == 200

        resp = api_client.get("/api/v1/schedules")
        assert len(resp.json()) >= 1


class TestMemoryRouter:
    def test_list_episodes_empty(self, api_client):
        resp = api_client.get("/api/v1/memory/test-agent/episodes")
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    def test_list_facts_empty(self, api_client):
        resp = api_client.get("/api/v1/memory/test-agent/facts")
        assert resp.status_code == 200

    def test_list_procedures_empty(self, api_client):
        resp = api_client.get("/api/v1/memory/test-agent/procedures")
        assert resp.status_code == 200
