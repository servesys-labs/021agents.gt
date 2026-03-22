from __future__ import annotations

import pytest

from agentos.api.deps import CurrentUser
from agentos.api.routers import connectors as connectors_router
from agentos.api.routers.connectors import ConnectorToolCallRequest, _redact_arguments
from agentos.connectors.hub import ConnectorHub, ConnectorResult, ConnectorTool, PipedreamProvider


class _DummyProvider:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.last_call: dict = {}

    async def list_tools(self, app: str = "") -> list[ConnectorTool]:
        return [ConnectorTool(name="dummy", description="d", app=app, provider="dummy")]

    async def call_tool(
        self,
        tool_name: str,
        arguments: dict,
        *,
        app: str = "",
        user_id: str = "",
    ) -> ConnectorResult:
        self.last_call = {
            "tool_name": tool_name,
            "arguments": arguments,
            "app": app,
            "user_id": user_id,
        }
        return ConnectorResult(success=True, data={"ok": True})

    async def get_auth_url(self, app: str, user_id: str) -> str:
        return f"https://example.test/auth?app={app}&user={user_id}"


def test_parse_sse_multiline_data_payload():
    payload = (
        "event: message\n"
        "data: {\"result\":\n"
        "data: {\"tools\": [{\"name\": \"slack-send-message\"}]}}\n\n"
    )
    parsed = PipedreamProvider._parse_sse_or_json(payload)
    assert parsed["result"]["tools"][0]["name"] == "slack-send-message"


@pytest.mark.asyncio
async def test_connector_hub_forwards_app_and_user():
    original = ConnectorHub.PROVIDERS.copy()
    try:
        ConnectorHub.PROVIDERS["dummy"] = _DummyProvider
        hub = ConnectorHub(provider="dummy")
        result = await hub.call_tool("t", {"x": 1}, app="slack", user_id="u1")
        assert result.success is True
        provider = hub._provider  # intentional white-box check
        assert provider.last_call["app"] == "slack"
        assert provider.last_call["user_id"] == "u1"
    finally:
        ConnectorHub.PROVIDERS = original


@pytest.mark.asyncio
async def test_connector_router_redacts_sensitive_audit_fields(monkeypatch):
    class _DummyDB:
        def __init__(self):
            self.audit_changes = None

        def record_billing(self, **kwargs):
            return None

        def audit(self, action, user_id="", org_id="", project_id="", resource_type="", resource_id="", changes=None):
            self.audit_changes = changes

    provider = _DummyProvider()
    db = _DummyDB()

    def _hub_factory():
        class _Hub:
            async def call_tool(self, tool_name, arguments, *, app="", user_id="", org_id=""):
                return await provider.call_tool(tool_name, arguments, app=app, user_id=user_id)

        return _Hub()

    monkeypatch.setattr(connectors_router, "_get_hub", _hub_factory)
    monkeypatch.setattr(connectors_router, "_get_db", lambda: db)

    req = ConnectorToolCallRequest(
        tool_name="slack-send-message",
        app="slack",
        arguments={
            "channel": "#alerts",
            "token": "super-secret",
            "nested": {"password": "dont-log-me"},
        },
    )
    user = CurrentUser(user_id="u1", email="u1@example.com", org_id="o1")

    resp = await connectors_router.call_connector_tool(req, user)
    assert resp["success"] is True
    assert provider.last_call["app"] == "slack"
    assert db.audit_changes["arguments"]["token"] == "***REDACTED***"
    assert db.audit_changes["arguments"]["nested"]["password"] == "***REDACTED***"


def test_redact_arguments_handles_nested_structures():
    raw = {
        "api_key": "abc",
        "nested": {"refresh_token": "def", "safe": 1},
        "items": [{"secret": "x"}, {"ok": True}],
    }
    redacted = _redact_arguments(raw)
    assert redacted["api_key"] == "***REDACTED***"
    assert redacted["nested"]["refresh_token"] == "***REDACTED***"
    assert redacted["nested"]["safe"] == 1
    assert redacted["items"][0]["secret"] == "***REDACTED***"
