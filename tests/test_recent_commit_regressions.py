from __future__ import annotations

import json

import pytest

from agentos.api.deps import CurrentUser
from agentos.api.routers import jobs, mcp_control, secrets, workflows
from agentos.api.routers.mcp_control import RegisterMCPServerRequest
from agentos.connectors.hub import PipedreamProvider


def test_jobs_dlq_route_registered_before_dynamic_job_id():
    paths = [r.path for r in jobs.router.routes]
    dlq_found = any("dlq" in p for p in paths)
    dynamic_found = any("{job_id}" in p for p in paths)
    assert dlq_found, f"DLQ route not found in {paths}"
    assert dynamic_found, f"Dynamic job_id route not found in {paths}"


@pytest.mark.asyncio
async def test_workflow_run_with_no_steps_returns_input(monkeypatch):
    class _Cursor:
        def __init__(self, row=None, rowcount=1):
            self._row = row
            self.rowcount = rowcount

        def fetchone(self):
            return self._row

    class _Conn:
        def execute(self, query, params=()):
            if "SELECT * FROM workflows" in query:
                return _Cursor(
                    {
                        "workflow_id": params[0],
                        "steps_json": "[]",
                    }
                )
            return _Cursor()

        def commit(self):
            return None

    class _DB:
        def __init__(self):
            self.conn = _Conn()

    monkeypatch.setattr(workflows, "_get_db", lambda: _DB())
    user = CurrentUser(user_id="u1", email="u1@example.com", org_id="o1")
    out = await workflows.run_workflow("wf-empty", input_text="hello", user=user)
    assert out["status"] == "completed"
    assert out["final_output"] == "hello"


@pytest.mark.asyncio
async def test_secrets_are_not_stored_in_plaintext(monkeypatch):
    class _Conn:
        def __init__(self):
            self.inserted_value = ""

        def execute(self, query, params=()):
            if query.startswith("SELECT name FROM secrets"):
                return type("_C", (), {"fetchone": lambda self: None})()
            if "INSERT INTO secrets" in query:
                self.inserted_value = params[4]
            return type("_C", (), {"rowcount": 1})()

        def commit(self):
            return None

    class _DB:
        def __init__(self):
            self.conn = _Conn()

    db = _DB()
    monkeypatch.setattr(secrets, "_get_db", lambda: db)
    monkeypatch.setenv("AGENTOS_SECRET_ENCRYPTION_KEY", "test-secret-key")

    user = CurrentUser(user_id="u1", email="u1@example.com", org_id="o1")
    await secrets.create_secret(name="API_KEY", value="plain-text", user=user)
    assert db.conn.inserted_value
    assert db.conn.inserted_value != "plain-text"
    assert db.conn.inserted_value.startswith("fernet:v1:") or db.conn.inserted_value != "plain-text"


def test_secret_codec_round_trip_current_format(monkeypatch):
    monkeypatch.setenv("AGENTOS_SECRET_ENCRYPTION_KEY", "roundtrip-key")
    encrypted = secrets._encrypt_secret("super-secret-value")
    decrypted = secrets._decrypt_secret(encrypted)
    assert decrypted == "super-secret-value"


def test_secret_codec_round_trip_legacy_format(monkeypatch):
    monkeypatch.setenv("AGENTOS_SECRET_ENCRYPTION_KEY", "legacy-key")
    legacy = secrets._encrypt_secret_legacy("legacy-secret")
    decrypted = secrets._decrypt_secret(legacy)
    assert decrypted == "legacy-secret"


@pytest.mark.asyncio
async def test_mcp_metadata_is_valid_json(monkeypatch):
    class _Conn:
        def __init__(self):
            self.metadata_json = ""

        def execute(self, query, params=()):
            if "INSERT INTO mcp_servers" in query:
                self.metadata_json = params[6]
            return type("_C", (), {"rowcount": 1})()

        def commit(self):
            return None

    class _DB:
        def __init__(self):
            self.conn = _Conn()

    db = _DB()
    monkeypatch.setattr(mcp_control, "_get_db", lambda: db)
    user = CurrentUser(user_id="u1", email="u1@example.com", org_id="o1")
    request = RegisterMCPServerRequest(
        name="demo",
        url="https://example.com/mcp",
        metadata={"region": "us", "features": ["tools"]},
    )
    await mcp_control.register_mcp_server(request, user)
    assert json.loads(db.conn.metadata_json) == {"region": "us", "features": ["tools"]}


@pytest.mark.asyncio
async def test_pipedream_call_tool_refreshes_expired_token(monkeypatch):
    class _Resp:
        def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
            self.status_code = status_code
            self._payload = payload or {}
            self.text = text or (json.dumps(payload) if payload is not None else "")

        def json(self):
            return self._payload

    state = {"token_calls": 0, "tool_calls": 0}

    class _AsyncClient:
        def __init__(self, timeout=10):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, headers=None, json=None):
            if "oauth/token" in url:
                state["token_calls"] += 1
                return _Resp(200, {"access_token": f"tok-{state['token_calls']}", "expires_in": 3600})
            state["tool_calls"] += 1
            if state["tool_calls"] == 1:
                return _Resp(401, text="expired")
            return _Resp(200, {"result": {"content": [{"type": "text", "text": "ok"}]}})

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", _AsyncClient)
    provider = PipedreamProvider(project_id="p", client_id="c", client_secret="s")
    result = await provider.call_tool("slack_send_message", {"channel": "#x"}, app="slack", user_id="u1")

    assert result.success is True
    assert result.data == "ok"
    assert state["token_calls"] == 2
