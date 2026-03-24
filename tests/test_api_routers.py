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

    # Create DB with v4 schema (all tables)
    from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4
    db = create_database(tmp_path / "data" / "agent.db")
    # Force v3+v4 tables
    for migration in [MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4]:
        for stmt in migration.split(";"):
            stmt = stmt.strip()
            if stmt and not stmt.startswith("--"):
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

    def test_auth_providers(self, api_client):
        resp = api_client.get("/api/v1/auth/providers")
        assert resp.status_code == 200
        data = resp.json()
        assert "active_provider" in data
        assert "password_enabled" in data

    def test_clerk_exchange_disabled(self, api_client):
        resp = api_client.post("/api/v1/auth/clerk/exchange", json={"clerk_token": "abc"})
        assert resp.status_code == 400

    def test_clerk_exchange_enabled(self, api_client, monkeypatch):
        monkeypatch.setenv("AGENTOS_AUTH_PROVIDER", "clerk")

        from agentos.auth.clerk import ClerkClaims
        import agentos.auth.clerk as clerk_mod

        monkeypatch.setattr(
            clerk_mod,
            "verify_clerk_token",
            lambda _token: ClerkClaims(
                sub="user_123",
                email="clerk@example.com",
                name="Clerk User",
                org_id="org_abc",
                org_name="Acme",
                org_role="org:admin",
                iss="https://clerk.example",
                exp=2_000_000_000,
                iat=1_900_000_000,
            ),
        )

        resp = api_client.post("/api/v1/auth/clerk/exchange", json={"clerk_token": "abc"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["provider"] == "clerk"
        assert data["email"] == "clerk@example.com"
        me = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {data['token']}"})
        assert me.status_code == 200
        assert me.json()["role"] == "admin"

    def test_password_auth_disabled(self, api_client, monkeypatch):
        monkeypatch.setenv("AGENTOS_AUTH_ALLOW_PASSWORD", "false")
        resp = api_client.post("/api/v1/auth/signup", json={"email": "blocked@example.com", "password": "p"})
        assert resp.status_code == 400


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

    def test_create_from_description_draft_only_gates_persistence(self, api_client):
        signup = api_client.post(
            "/api/v1/auth/signup",
            json={"email": "draft-agent@test.com", "password": "pass12345"},
        )
        token = signup.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        draft = api_client.post(
            "/api/v1/agents/create-from-description"
            "?description=Build%20a%20support%20assistant%20agent"
            "&name=canvas-draft-agent&draft_only=true",
            headers=headers,
        )
        assert draft.status_code == 200
        draft_data = draft.json()
        assert draft_data["created"] is False
        assert draft_data["name"] == "canvas-draft-agent"

        list_after_draft = api_client.get("/api/v1/agents")
        assert list_after_draft.status_code == 200
        assert all(a["name"] != "canvas-draft-agent" for a in list_after_draft.json())

        approved = api_client.post(
            "/api/v1/agents/create-from-description"
            "?description=Build%20a%20support%20assistant%20agent"
            "&name=canvas-draft-agent&draft_only=false",
            headers=headers,
        )
        assert approved.status_code == 200
        approved_data = approved.json()
        assert approved_data["created"] is True
        assert approved_data["name"] == "canvas-draft-agent"

        list_after_create = api_client.get("/api/v1/agents")
        assert list_after_create.status_code == 200
        assert any(a["name"] == "canvas-draft-agent" for a in list_after_create.json())


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
    def _auth_header(self, api_client):
        email = "obs@test.com"
        password = "pass12345"
        signup_resp = api_client.post("/api/v1/auth/signup", json={"email": email, "password": password})
        if signup_resp.status_code == 200:
            data = signup_resp.json()
            assert "token" in data, data
            return {"Authorization": f"Bearer {data['token']}"}
        assert signup_resp.status_code == 409, signup_resp.json()
        login_resp = api_client.post("/api/v1/auth/login", json={"email": email, "password": password})
        assert login_resp.status_code == 200, login_resp.json()
        token = login_resp.json().get("token")
        assert token
        return {"Authorization": f"Bearer {token}"}

    def test_stats(self, api_client):
        headers = self._auth_header(api_client)
        resp = api_client.get("/api/v1/observability/stats", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "tables" in data

    def test_cost_ledger(self, api_client):
        headers = self._auth_header(api_client)
        resp = api_client.get("/api/v1/observability/cost-ledger", headers=headers)
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


class TestCanvasOverlayApiContracts:
    """Regression coverage for canvas overlay CRUD wiring."""

    def _auth_header(self, api_client, email: str = "canvas@test.com"):
        password = "pass12345"
        signup_resp = api_client.post("/api/v1/auth/signup", json={"email": email, "password": password})
        signup = signup_resp.json()
        token = signup.get("token")
        if not token:
            login_resp = api_client.post("/api/v1/auth/login", json={"email": email, "password": password})
            login = login_resp.json()
            token = login.get("token")
        assert token, f"Unable to authenticate test user: signup={signup}"
        return {"Authorization": f"Bearer {token}"}

    def test_projects_create_list_and_env_update(self, api_client):
        headers = self._auth_header(api_client, "canvas-projects@test.com")

        create = api_client.post(
            "/api/v1/projects?name=canvas-proj&description=from-canvas&plan=standard",
            headers=headers,
        )
        assert create.status_code == 200
        create_data = create.json()
        project_id = create.json()["project_id"]
        assert "meta_agent" in create_data
        assert create_data["meta_agent"]["name"]

        listed = api_client.get("/api/v1/projects", headers=headers)
        assert listed.status_code == 200
        assert any(p["project_id"] == project_id for p in listed.json()["projects"])

        agents = api_client.get("/api/v1/agents")
        assert agents.status_code == 200
        assert any(a["name"] == create_data["meta_agent"]["name"] for a in agents.json())

        envs = api_client.get(f"/api/v1/projects/{project_id}/envs", headers=headers)
        assert envs.status_code == 200
        env_names = {env["name"] for env in envs.json()["environments"]}
        assert {"development", "staging", "production"}.issubset(env_names)

        update = api_client.put(f"/api/v1/projects/{project_id}/envs/development?plan=pro", headers=headers)
        assert update.status_code == 200
        assert update.json()["updated"] == "development"

    def test_projects_canvas_layout_roundtrip(self, api_client):
        headers = self._auth_header(api_client, "canvas-layout@test.com")
        created = api_client.post("/api/v1/projects?name=layout-proj", headers=headers)
        assert created.status_code == 200
        project_id = created.json()["project_id"]

        empty_layout = api_client.get(f"/api/v1/projects/{project_id}/canvas-layout", headers=headers)
        assert empty_layout.status_code == 200
        assert empty_layout.json()["nodes"] == []
        assert empty_layout.json()["edges"] == []

        payload = {
            "nodes": [{"id": "agent-1", "type": "agent", "position": {"x": 100, "y": 120}, "data": {"name": "Agent 1"}}],
            "edges": [{"id": "e-1", "source": "knowledge-1", "target": "agent-1"}],
        }
        saved = api_client.put(f"/api/v1/projects/{project_id}/canvas-layout", json=payload, headers=headers)
        assert saved.status_code == 200
        assert saved.json()["saved"] is True
        assert saved.json()["assignments"] == 1

        loaded = api_client.get(f"/api/v1/projects/{project_id}/canvas-layout", headers=headers)
        assert loaded.status_code == 200
        data = loaded.json()
        assert len(data["nodes"]) == 1
        assert len(data["edges"]) == 1
        assert len(data["assignments"]) == 1

    def test_releases_promote_and_canary_lifecycle(self, api_client):
        headers = self._auth_header(api_client, "canvas-releases@test.com")
        agent_name = "test-agent"

        promote = api_client.post(
            f"/api/v1/releases/{agent_name}/promote?from_channel=draft&to_channel=staging",
            headers=headers,
        )
        assert promote.status_code == 200
        promoted = promote.json()
        assert promoted["promoted"] == agent_name
        assert promoted["to"] == "staging"

        channels = api_client.get(f"/api/v1/releases/{agent_name}/channels")
        assert channels.status_code == 200
        assert isinstance(channels.json()["channels"], list)

        set_canary = api_client.post(
            f"/api/v1/releases/{agent_name}/canary?primary_version={promoted['version']}&canary_version=v-next&canary_weight=0.2",
            headers=headers,
        )
        assert set_canary.status_code == 200
        assert set_canary.json()["weight"] == 0.2

        canary = api_client.get(f"/api/v1/releases/{agent_name}/canary")
        assert canary.status_code == 200
        assert canary.json()["canary"] is not None

        remove = api_client.delete(f"/api/v1/releases/{agent_name}/canary", headers=headers)
        assert remove.status_code == 200
        assert remove.json()["removed"] is True

    def test_infrastructure_gpu_and_retention_crud(self, api_client, monkeypatch):
        headers = self._auth_header(api_client, "canvas-infra@test.com")

        listed = api_client.get("/api/v1/gpu/endpoints", headers=headers)
        assert listed.status_code == 200
        assert "endpoints" in listed.json()

        monkeypatch.setenv("GMI_INFRA_API_KEY", "test-key")
        provision = api_client.post(
            "/api/v1/gpu/endpoints?model_id=gpt-4.1-mini&gpu_type=h200&gpu_count=1",
            headers=headers,
        )
        assert provision.status_code == 200
        endpoint_id = provision.json()["endpoint_id"]

        terminate = api_client.delete(f"/api/v1/gpu/endpoints/{endpoint_id}", headers=headers)
        assert terminate.status_code == 200

        retention = api_client.get("/api/v1/retention", headers=headers)
        assert retention.status_code == 200
        assert "policies" in retention.json()

        create_policy = api_client.post(
            "/api/v1/retention?resource_type=sessions&retention_days=7",
            headers=headers,
        )
        assert create_policy.status_code == 200
        policy_id = create_policy.json()["policy_id"]

        apply_resp = api_client.post("/api/v1/retention/apply", headers=headers)
        assert apply_resp.status_code == 200
        assert "applied" in apply_resp.json()

        delete_policy = api_client.delete(f"/api/v1/retention/{policy_id}", headers=headers)
        assert delete_policy.status_code == 200

    def test_projects_requires_auth_for_mutation(self, api_client):
        resp = api_client.post("/api/v1/projects?name=no-auth")
        assert resp.status_code == 401

    def test_projects_rejects_invalid_plan(self, api_client):
        headers = self._auth_header(api_client, "canvas-invalid-plan@test.com")
        resp = api_client.post("/api/v1/projects?name=bad-plan&plan=invalid-tier", headers=headers)
        assert resp.status_code == 400

    def test_projects_cross_org_isolation(self, api_client):
        owner_headers = self._auth_header(api_client, "canvas-owner@test.com")
        other_headers = self._auth_header(api_client, "canvas-other@test.com")

        created = api_client.post("/api/v1/projects?name=isolated-proj", headers=owner_headers)
        assert created.status_code == 200
        project_id = created.json()["project_id"]

        # Other org should not be able to access envs for this project.
        envs = api_client.get(f"/api/v1/projects/{project_id}/envs", headers=other_headers)
        assert envs.status_code == 404

        update = api_client.put(
            f"/api/v1/projects/{project_id}/envs/development?plan=pro",
            headers=other_headers,
        )
        assert update.status_code == 404

        layout_get = api_client.get(f"/api/v1/projects/{project_id}/canvas-layout", headers=other_headers)
        assert layout_get.status_code == 404

    def test_project_scoped_agent_run_denied_for_other_org(self, api_client):
        owner_headers = self._auth_header(api_client, "canvas-scope-owner@test.com")
        other_headers = self._auth_header(api_client, "canvas-scope-other@test.com")

        created = api_client.post("/api/v1/projects?name=scope-proj", headers=owner_headers)
        assert created.status_code == 200
        project_id = created.json()["project_id"]

        scoped_agent = {
            "name": "project-scoped-agent",
            "description": "Scoped test agent",
            "version": "0.1.0",
            "system_prompt": "You are helpful.",
            "model": "stub-model",
            "tools": [],
            "governance": {"budget_limit_usd": 10.0, "require_confirmation_for_destructive": True, "blocked_tools": []},
            "memory": {
                "working": {"max_items": 50},
                "episodic": {"max_episodes": 100, "ttl_days": 30},
                "procedural": {"max_procedures": 50},
            },
            "max_turns": 3,
            "tags": [f"project:{project_id}"],
        }
        Path("agents/project-scoped-agent.json").write_text(json.dumps(scoped_agent, indent=2))

        denied = api_client.post(
            "/api/v1/agents/project-scoped-agent/run",
            json={"task": "test run"},
            headers=other_headers,
        )
        assert denied.status_code == 403
        assert "scoped" in denied.json()["detail"]

    def test_project_scoped_api_key_enforced_for_agent_run(self, api_client):
        owner_headers = self._auth_header(api_client, "canvas-scope-key@test.com")

        project_a = api_client.post("/api/v1/projects?name=scope-a", headers=owner_headers)
        project_b = api_client.post("/api/v1/projects?name=scope-b", headers=owner_headers)
        assert project_a.status_code == 200 and project_b.status_code == 200
        project_a_id = project_a.json()["project_id"]
        project_b_id = project_b.json()["project_id"]

        scoped_agent = {
            "name": "project-key-scoped-agent",
            "description": "Scoped key test agent",
            "version": "0.1.0",
            "system_prompt": "You are helpful.",
            "model": "stub-model",
            "tools": [],
            "governance": {"budget_limit_usd": 10.0, "require_confirmation_for_destructive": True, "blocked_tools": []},
            "memory": {
                "working": {"max_items": 50},
                "episodic": {"max_episodes": 100, "ttl_days": 30},
                "procedural": {"max_procedures": 50},
            },
            "max_turns": 3,
            "tags": [f"project:{project_a_id}"],
        }
        Path("agents/project-key-scoped-agent.json").write_text(json.dumps(scoped_agent, indent=2))

        key_resp = api_client.post(
            "/api/v1/api-keys",
            json={
                "name": "proj-b-only",
                "scopes": ["agents:run"],
                "project_id": project_b_id,
            },
            headers=owner_headers,
        )
        assert key_resp.status_code == 200
        api_key = key_resp.json()["key"]

        denied = api_client.post(
            "/api/v1/agents/project-key-scoped-agent/run",
            json={"task": "test run"},
            headers={"Authorization": f"Bearer {api_key}"},
        )
        assert denied.status_code == 403
        assert "different project" in denied.json()["detail"]


class TestEdgeIngestBridge:
    def _auth_header(self, api_client, email: str = "edge-ingest@test.com"):
        password = "pass12345"
        signup_resp = api_client.post("/api/v1/auth/signup", json={"email": email, "password": password})
        signup = signup_resp.json()
        token = signup.get("token")
        if not token:
            login_resp = api_client.post("/api/v1/auth/login", json={"email": email, "password": password})
            login = login_resp.json()
            token = login.get("token")
        assert token, f"Unable to authenticate test user: signup={signup}"
        return {"Authorization": f"Bearer {token}"}

    def test_ingest_events_issue_and_conversation_rows(self, api_client, monkeypatch):
        monkeypatch.setenv("EDGE_INGEST_TOKEN", "test-edge-token")
        headers = {"Authorization": "Bearer test-edge-token"}

        events = api_client.post(
            "/api/v1/edge-ingest/events",
            json={
                "events": [
                    {
                        "session_id": "edge-session-1",
                        "turn": 1,
                        "event_type": "llm.call",
                        "action": "inference",
                        "plan": "standard",
                        "tier": "moderate",
                        "provider": "gmi",
                        "model": "deepseek",
                        "status": "ok",
                        "latency_ms": 123,
                        "input_tokens": 12,
                        "output_tokens": 34,
                        "cost_usd": 0.001,
                        "details_json": "{\"httpStatus\":200}",
                    }
                ]
            },
            headers=headers,
        )
        assert events.status_code == 200
        assert events.json()["events"] == 1

        issue = api_client.post(
            "/api/v1/edge-ingest/issues",
            json={
                "issue_id": "edge-issue-1",
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "title": "Edge issue",
                "description": "desc",
                "category": "runtime",
                "severity": "medium",
                "status": "open",
            },
            headers=headers,
        )
        assert issue.status_code == 200

        score = api_client.post(
            "/api/v1/edge-ingest/conversation/score",
            json={
                "session_id": "edge-session-1",
                "turn_number": 1,
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "sentiment": "positive",
                "sentiment_score": 0.8,
                "quality_overall": 0.75,
            },
            headers=headers,
        )
        assert score.status_code == 200

        analytics = api_client.post(
            "/api/v1/edge-ingest/conversation/analytics",
            json={
                "session_id": "edge-session-1",
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "avg_sentiment_score": 0.8,
                "dominant_sentiment": "positive",
                "avg_quality": 0.75,
                "total_turns": 1,
            },
            headers=headers,
        )
        assert analytics.status_code == 200

        from agentos.core.db_config import initialize_db, get_db

        initialize_db()
        db = get_db()
        event_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM otel_events WHERE session_id = ?",
            ("edge-session-1",),
        ).fetchone()
        issue_row = db.conn.execute(
            "SELECT issue_id FROM issues WHERE issue_id = ?",
            ("edge-issue-1",),
        ).fetchone()
        conv_row = db.conn.execute(
            "SELECT session_id FROM conversation_analytics WHERE session_id = ?",
            ("edge-session-1",),
        ).fetchone()
        assert int(event_row["cnt"]) >= 1
        assert issue_row is not None
        assert conv_row is not None

    def test_ingest_events_requires_token(self, api_client, monkeypatch):
        monkeypatch.setenv("EDGE_INGEST_TOKEN", "test-edge-token")
        denied = api_client.post("/api/v1/edge-ingest/events", json={"events": []})
        assert denied.status_code == 401

    def test_ingest_security_and_compliance_domains(self, api_client, monkeypatch):
        monkeypatch.setenv("EDGE_INGEST_TOKEN", "test-edge-token")
        headers = {"Authorization": "Bearer test-edge-token"}
        scan_id = "edge-scan-1"
        image_id = "edge-image-1"

        scan = api_client.post(
            "/api/v1/edge-ingest/security/scan",
            json={
                "scan_id": scan_id,
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "scan_type": "runtime",
                "status": "completed",
                "total_probes": 1,
                "passed": 1,
                "failed": 0,
                "errors": 0,
                "risk_score": 0.1,
                "risk_level": "low",
            },
            headers=headers,
        )
        assert scan.status_code == 200

        finding = api_client.post(
            "/api/v1/edge-ingest/security/finding",
            json={
                "scan_id": scan_id,
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "probe_id": "probe-1",
                "probe_name": "prompt_injection",
                "category": "prompt",
                "layer": "runtime",
                "severity": "medium",
                "status": "open",
                "title": "Prompt injection risk",
                "description": "desc",
                "evidence": "evidence",
                "remediation": "remediate",
                "aivss_vector": "AV:N/AC:L",
                "aivss_score": 6.0,
            },
            headers=headers,
        )
        assert finding.status_code == 200

        risk = api_client.post(
            "/api/v1/edge-ingest/security/risk-profile",
            json={
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "risk_score": 0.4,
                "risk_level": "medium",
                "aivss_vector_json": "{\"prompt\":6.0}",
                "last_scan_id": scan_id,
                "findings_summary_json": "{\"open\":1}",
            },
            headers=headers,
        )
        assert risk.status_code == 200

        gold = api_client.post(
            "/api/v1/edge-ingest/gold-image",
            json={
                "image_id": image_id,
                "org_id": "org-test",
                "name": "Edge Gold",
                "description": "baseline",
                "config_json": "{\"plan\":\"standard\"}",
                "config_hash": "hash-1",
                "version": "1.0.0",
                "category": "general",
                "is_active": 1,
                "created_by": "edge",
            },
            headers=headers,
        )
        assert gold.status_code == 200

        comp = api_client.post(
            "/api/v1/edge-ingest/compliance-check",
            json={
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "image_id": image_id,
                "image_name": "Edge Gold",
                "status": "pass",
                "drift_count": 0,
                "drift_fields": "[]",
                "drift_details_json": "{}",
                "checked_by": "edge",
            },
            headers=headers,
        )
        assert comp.status_code == 200

        from agentos.core.db_config import initialize_db, get_db

        initialize_db()
        db = get_db()
        finding_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM security_findings WHERE scan_id = ?",
            (scan_id,),
        ).fetchone()
        risk_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM agent_risk_profiles WHERE agent_name = ?",
            ("edge-agent",),
        ).fetchone()
        gold_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM gold_images WHERE image_id = ?",
            (image_id,),
        ).fetchone()
        comp_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM compliance_checks WHERE image_id = ?",
            (image_id,),
        ).fetchone()
        assert int(finding_row["cnt"]) >= 1
        assert int(risk_row["cnt"]) >= 1
        assert int(gold_row["cnt"]) >= 1
        assert int(comp_row["cnt"]) >= 1

    def test_ingest_episode_and_vapi_domains(self, api_client, monkeypatch):
        monkeypatch.setenv("EDGE_INGEST_TOKEN", "test-edge-token")
        headers = {"Authorization": "Bearer test-edge-token"}
        episode_id = "edge-episode-1"
        call_id = "edge-call-1"

        episode = api_client.post(
            "/api/v1/edge-ingest/episode",
            json={
                "id": episode_id,
                "input": "hello",
                "output": "world",
                "outcome": "completed",
                "metadata": {"source": "edge-smoke"},
            },
            headers=headers,
        )
        assert episode.status_code == 200

        call = api_client.post(
            "/api/v1/edge-ingest/vapi/call",
            json={
                "call_id": call_id,
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "phone_number": "+15551234567",
                "direction": "outbound",
                "status": "completed",
                "duration_seconds": 12,
                "transcript": "hello",
                "cost_usd": 0.02,
                "vapi_assistant_id": "assistant-1",
                "metadata": {"provider": "vapi"},
            },
            headers=headers,
        )
        assert call.status_code == 200

        event = api_client.post(
            "/api/v1/edge-ingest/vapi/event",
            json={
                "call_id": call_id,
                "org_id": "org-test",
                "event_type": "call.completed",
                "payload_json": "{\"ok\":true}",
            },
            headers=headers,
        )
        assert event.status_code == 200

        generic_call = api_client.post(
            "/api/v1/edge-ingest/voice/call",
            json={
                "call_id": "edge-voice-1",
                "platform": "retell",
                "org_id": "org-test",
                "agent_name": "edge-agent",
                "phone_number": "+15557654321",
                "direction": "outbound",
                "status": "completed",
                "duration_seconds": 9,
                "transcript": "generic voice",
                "cost_usd": 0.05,
                "platform_agent_id": "retell-1",
                "metadata": {"provider": "retell"},
            },
            headers=headers,
        )
        assert generic_call.status_code == 200

        generic_event = api_client.post(
            "/api/v1/edge-ingest/voice/event",
            json={
                "call_id": "edge-voice-1",
                "platform": "retell",
                "org_id": "org-test",
                "event_type": "call.completed",
                "payload_json": "{\"ok\":true}",
            },
            headers=headers,
        )
        assert generic_event.status_code == 200

        from agentos.core.db_config import initialize_db, get_db

        initialize_db()
        db = get_db()
        ep_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM episodes WHERE id = ?",
            (episode_id,),
        ).fetchone()
        call_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM vapi_calls WHERE call_id = ?",
            (call_id,),
        ).fetchone()
        evt_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM vapi_events WHERE call_id = ?",
            (call_id,),
        ).fetchone()
        g_call_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM voice_calls WHERE call_id = ?",
            ("edge-voice-1",),
        ).fetchone()
        g_evt_row = db.conn.execute(
            "SELECT COUNT(*) AS cnt FROM voice_events WHERE call_id = ?",
            ("edge-voice-1",),
        ).fetchone()
        assert int(ep_row["cnt"]) >= 1
        assert int(call_row["cnt"]) >= 1
        assert int(evt_row["cnt"]) >= 1
        assert int(g_call_row["cnt"]) >= 1
        assert int(g_evt_row["cnt"]) >= 1

    def test_releases_rejects_invalid_canary_weight(self, api_client):
        headers = self._auth_header(api_client, "canvas-releases-invalid@test.com")
        resp = api_client.post(
            "/api/v1/releases/test-agent/canary?primary_version=v1&canary_version=v2&canary_weight=2.0",
            headers=headers,
        )
        assert resp.status_code == 400

    def test_infrastructure_rejects_missing_gpu_key(self, api_client, monkeypatch):
        headers = self._auth_header(api_client, "canvas-gpu-missing-key@test.com")
        monkeypatch.delenv("GMI_INFRA_API_KEY", raising=False)
        resp = api_client.post("/api/v1/gpu/endpoints?model_id=test-model", headers=headers)
        assert resp.status_code == 503

    def test_retention_rejects_invalid_resource_type(self, api_client):
        headers = self._auth_header(api_client, "canvas-retention-invalid@test.com")
        resp = api_client.post("/api/v1/retention?resource_type=unknown_type&retention_days=10", headers=headers)
        assert resp.status_code == 400

    def test_workflows_create_run_list_and_delete(self, api_client):
        headers = self._auth_header(api_client, "canvas-workflows@test.com")

        create = api_client.post(
            "/api/v1/workflows",
            json={"name": "Canvas Flow", "description": "from canvas", "steps": []},
            headers=headers,
        )
        assert create.status_code == 200
        workflow_id = create.json()["workflow_id"]

        listed = api_client.get("/api/v1/workflows", headers=headers)
        assert listed.status_code == 200
        assert any(w["workflow_id"] == workflow_id for w in listed.json()["workflows"])

        run = api_client.post(
            f"/api/v1/workflows/{workflow_id}/run",
            json={"input_text": "hello from canvas"},
            headers=headers,
        )
        assert run.status_code == 200
        run_data = run.json()
        assert run_data["status"] in {"completed", "failed"}
        run_id = run_data["run_id"]

        runs = api_client.get(f"/api/v1/workflows/{workflow_id}/runs", headers=headers)
        assert runs.status_code == 200
        assert any(r["run_id"] == run_id for r in runs.json()["runs"])

        delete = api_client.delete(f"/api/v1/workflows/{workflow_id}", headers=headers)
        assert delete.status_code == 200
        assert delete.json()["deleted"] == workflow_id

    def test_workflow_validate_rejects_bad_dependency(self, api_client):
        headers = self._auth_header(api_client, "canvas-workflow-validate@test.com")
        resp = api_client.post(
            "/api/v1/workflows/validate",
            json={
                "name": "invalid-flow",
                "steps": [
                    {"id": "s1", "type": "llm", "agent": "test-agent", "task": "t", "depends_on": ["unknown"]},
                ],
            },
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is False
        assert any("depends on unknown step" in err for err in body["errors"])

    def test_schedules_create_toggle_update_and_delete(self, api_client):
        headers = self._auth_header(api_client, "canvas-schedules@test.com")
        create = api_client.post(
            "/api/v1/schedules",
            json={"agent_name": "test-agent", "cron": "* * * * *", "task": "check status"},
            headers=headers,
        )
        assert create.status_code == 200
        schedule_id = create.json()["schedule_id"]

        listed = api_client.get("/api/v1/schedules")
        assert listed.status_code == 200
        assert any(s["schedule_id"] == schedule_id for s in listed.json())

        disable = api_client.post(f"/api/v1/schedules/{schedule_id}/disable")
        assert disable.status_code == 200
        assert disable.json()["enabled"] is False

        enable = api_client.post(f"/api/v1/schedules/{schedule_id}/enable")
        assert enable.status_code == 200
        assert enable.json()["enabled"] is True

        update = api_client.put(f"/api/v1/schedules/{schedule_id}?task=updated-task", headers=headers)
        assert update.status_code == 200
        assert update.json()["task"] == "updated-task"

        history = api_client.get(f"/api/v1/schedules/{schedule_id}/history")
        assert history.status_code == 200
        assert history.json()["schedule_id"] == schedule_id

        delete = api_client.delete(f"/api/v1/schedules/{schedule_id}", headers=headers)
        assert delete.status_code == 200

    def test_schedules_reject_invalid_cron(self, api_client):
        headers = self._auth_header(api_client, "canvas-schedules-badcron@test.com")
        resp = api_client.post(
            "/api/v1/schedules",
            json={"agent_name": "test-agent", "cron": "not-a-cron", "task": "x"},
            headers=headers,
        )
        assert resp.status_code == 400

    def test_webhooks_update_and_auxiliary_actions(self, api_client):
        headers = self._auth_header(api_client, "canvas-webhooks@test.com")
        create = api_client.post("/api/v1/webhooks", json={"url": "https://example.com/hook"}, headers=headers)
        assert create.status_code == 200
        webhook_id = create.json()["webhook_id"]

        update = api_client.put(
            f"/api/v1/webhooks/{webhook_id}?is_active=false&events=agent.run.completed&events=agent.error",
            headers=headers,
        )
        assert update.status_code == 200
        assert update.json()["updated"] == webhook_id

        test_resp = api_client.post(f"/api/v1/webhooks/{webhook_id}/test", headers=headers)
        assert test_resp.status_code == 200
        assert "success" in test_resp.json()

        deliveries = api_client.get(f"/api/v1/webhooks/{webhook_id}/deliveries", headers=headers)
        assert deliveries.status_code == 200
        assert "deliveries" in deliveries.json()

        rotated = api_client.post(f"/api/v1/webhooks/{webhook_id}/rotate-secret", headers=headers)
        assert rotated.status_code == 200
        assert rotated.json()["rotated"] is True

    def test_webhooks_reject_unsafe_url(self, api_client):
        headers = self._auth_header(api_client, "canvas-webhooks-unsafe@test.com")
        resp = api_client.post("/api/v1/webhooks", json={"url": "http://localhost:9999/hook"}, headers=headers)
        assert resp.status_code == 400

    def test_governance_policy_secret_and_audit_flows(self, api_client):
        headers = self._auth_header(api_client, "canvas-governance@test.com")

        list_policies = api_client.get("/api/v1/policies", headers=headers)
        assert list_policies.status_code == 200
        assert "policies" in list_policies.json()

        created_policy = api_client.post(
            "/api/v1/policies?name=CanvasPolicy&budget_limit_usd=25&require_confirmation=true&max_turns=40",
            headers=headers,
        )
        assert created_policy.status_code == 200
        policy_id = created_policy.json()["policy_id"]

        got_policy = api_client.get(f"/api/v1/policies/{policy_id}")
        assert got_policy.status_code == 200
        assert got_policy.json()["policy_id"] == policy_id

        created_secret = api_client.post(
            "/api/v1/secrets?name=OPENAI_API_KEY&value=sk-test&project_id=&env=",
            headers=headers,
        )
        assert created_secret.status_code == 200

        list_secrets = api_client.get("/api/v1/secrets", headers=headers)
        assert list_secrets.status_code == 200
        assert any(s["name"] == "OPENAI_API_KEY" for s in list_secrets.json()["secrets"])

        rotate_secret = api_client.post("/api/v1/secrets/OPENAI_API_KEY/rotate?new_value=sk-rotated", headers=headers)
        assert rotate_secret.status_code == 200
        assert rotate_secret.json()["rotated"] == "OPENAI_API_KEY"

        audit = api_client.get("/api/v1/audit/log?limit=30&since_days=30", headers=headers)
        assert audit.status_code == 200
        assert "entries" in audit.json()

        deleted_secret = api_client.delete("/api/v1/secrets/OPENAI_API_KEY", headers=headers)
        assert deleted_secret.status_code == 200

        deleted_policy = api_client.delete(f"/api/v1/policies/{policy_id}", headers=headers)
        assert deleted_policy.status_code == 200
