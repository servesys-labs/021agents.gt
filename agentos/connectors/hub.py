"""Connector Hub — abstract interface to MCP connector providers.

Supports pluggable providers (Pipedream, Nango, etc.) with a unified API.
Each provider handles OAuth, credential lifecycle, and API normalization.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class ConnectorTool:
    """A tool exposed by a connector provider."""
    name: str
    description: str
    app: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)
    provider: str = ""


@dataclass
class ConnectorResult:
    """Result from calling a connector tool."""
    success: bool
    data: Any = None
    error: str = ""
    auth_required: bool = False
    auth_url: str = ""


class ConnectorProvider:
    """Base class for connector providers."""

    name: str = "base"

    async def list_apps(self) -> list[dict[str, str]]:
        raise NotImplementedError

    async def list_tools(self, app: str = "") -> list[ConnectorTool]:
        raise NotImplementedError

    async def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        app: str = "",
        user_id: str = "",
    ) -> ConnectorResult:
        raise NotImplementedError

    async def get_auth_url(self, app: str, user_id: str) -> str:
        raise NotImplementedError


class PipedreamProvider(ConnectorProvider):
    """Pipedream MCP connector — 3,000+ apps with managed OAuth.

    Uses Pipedream's remote MCP server at https://remote.mcp.pipedream.net
    """

    name = "pipedream"
    MCP_URL = "https://remote.mcp.pipedream.net"

    def __init__(
        self,
        project_id: str = "",
        client_id: str = "",
        client_secret: str = "",
        environment: str = "production",
    ) -> None:
        self.project_id = project_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.environment = environment
        self._access_token: str = ""
        self._access_token_expires_at: float = 0.0

    async def _get_token(self) -> str:
        """Get or refresh the Pipedream access token."""
        if self._access_token and time.time() < self._access_token_expires_at:
            return self._access_token

        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://api.pipedream.com/v1/oauth/token",
                json={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
            )
            if resp.status_code == 200:
                payload = resp.json()
                self._access_token = payload.get("access_token", "")
                expires_in = int(payload.get("expires_in", 3600))
                # Refresh slightly early to avoid edge expiry race.
                self._access_token_expires_at = time.time() + max(expires_in - 30, 30)
            else:
                logger.warning("Pipedream token request failed: %s", resp.status_code)
        return self._access_token

    def _headers(self, user_id: str = "", app: str = "") -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "x-pd-project-id": self.project_id,
            "x-pd-environment": self.environment,
            "x-pd-external-user-id": user_id or "default-user",
        }
        if app:
            h["x-pd-app-slug"] = app
        return h

    @staticmethod
    def _parse_sse_or_json(text: str) -> dict:
        """Parse response that may be JSON or SSE (text/event-stream)."""
        text = text.strip()
        if text.startswith("event:") or text.startswith("data:"):
            # SSE may contain multi-line "data:" chunks terminated by blank lines.
            chunks: list[str] = []
            current: list[str] = []
            for raw_line in text.splitlines():
                line = raw_line.strip("\r")
                if line == "":
                    if current:
                        chunks.append("\n".join(current))
                        current = []
                    continue
                if line.startswith("data:"):
                    current.append(line[5:].lstrip())
            if current:
                chunks.append("\n".join(current))

            for chunk in chunks:
                try:
                    return json.loads(chunk)
                except json.JSONDecodeError:
                    continue
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {}

    async def list_tools(self, app: str = "") -> list[ConnectorTool]:
        """List available tools, optionally filtered by app."""
        import httpx

        token = await self._get_token()
        if not token:
            return []

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    self.MCP_URL,
                    headers=self._headers(app=app),
                    json={"jsonrpc": "2.0", "id": "1", "method": "tools/list"},
                )
                if resp.status_code != 200:
                    logger.warning("Pipedream list_tools HTTP %s: %s", resp.status_code, resp.text[:200])
                    return []
                data = self._parse_sse_or_json(resp.text)
                tools_data = data.get("result", {}).get("tools", [])
                return [
                    ConnectorTool(
                        name=t.get("name", ""),
                        description=t.get("description", t.get("title", "")),
                        app=app,
                        input_schema=t.get("inputSchema", {}),
                        provider="pipedream",
                    )
                    for t in tools_data
                ]
        except Exception as exc:
            logger.warning("Pipedream list_tools failed: %s", exc)
            return []

    async def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        app: str = "",
        user_id: str = "",
    ) -> ConnectorResult:
        """Call a tool via Pipedream MCP."""
        import httpx

        async def _post_call() -> ConnectorResult:
            token = await self._get_token()
            if not token:
                return ConnectorResult(success=False, error="No Pipedream access token")

            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    resp = await client.post(
                        self.MCP_URL,
                        headers={**self._headers(user_id=user_id, app=app), "Content-Type": "application/json"},
                        json={
                            "jsonrpc": "2.0", "id": "1",
                            "method": "tools/call",
                            "params": {"name": tool_name, "arguments": arguments},
                        },
                    )
                    if resp.status_code == 401:
                        return ConnectorResult(success=False, error="__AUTH_EXPIRED__")
                    if resp.status_code != 200:
                        return ConnectorResult(
                            success=False,
                            error=f"Pipedream HTTP {resp.status_code}: {resp.text[:300]}",
                        )

                    data = self._parse_sse_or_json(resp.text)

                    # Check for auth required response
                    if "error" in data:
                        error_msg = data["error"].get("message", "")
                        if "connect" in error_msg.lower() or "auth" in error_msg.lower():
                            return ConnectorResult(
                                success=False,
                                auth_required=True,
                                auth_url=error_msg,
                                error="User authentication required for this app",
                            )
                        return ConnectorResult(success=False, error=error_msg)

                    result = data.get("result", {})
                    if result.get("isError"):
                        return ConnectorResult(
                            success=False,
                            error="".join(
                                c.get("text", "")
                                for c in result.get("content", [])
                                if isinstance(c, dict) and c.get("type") == "text"
                            ) or "Connector tool returned error",
                        )
                    content = result.get("content", [])
                    text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
                    return ConnectorResult(success=True, data=text)

            except Exception as exc:
                return ConnectorResult(success=False, error=str(exc))

        first = await _post_call()
        if first.error == "__AUTH_EXPIRED__":
            # Force token refresh and retry once.
            self._access_token = ""
            self._access_token_expires_at = 0.0
            second = await _post_call()
            if second.error == "__AUTH_EXPIRED__":
                return ConnectorResult(success=False, error="Pipedream authorization failed after token refresh")
            return second
        return first

    async def get_auth_url(self, app: str, user_id: str) -> str:
        """Get the OAuth connection URL for a user + app."""
        from urllib.parse import urlencode

        # Keep user/app/project context in the URL so the caller can complete
        # auth for the intended tenant and app selection.
        params = {
            "app": app,
            "connectLink": "true",
            "external_user_id": user_id or "default-user",
            "project_id": self.project_id,
            "environment": self.environment,
        }
        return f"https://pipedream.com/_static/connect.html?{urlencode(params)}"


class ConnectorHub:
    """Unified hub for managing connector providers.

    Usage:
        hub = ConnectorHub(provider="pipedream", ...)
        tools = await hub.list_tools(app="slack")
        result = await hub.call_tool("slack_send_message", {...}, user_id="user-123")
    """

    PROVIDERS = {
        "pipedream": PipedreamProvider,
    }

    def __init__(self, provider: str = "pipedream", **kwargs) -> None:
        provider_cls = self.PROVIDERS.get(provider)
        if not provider_cls:
            raise ValueError(f"Unknown connector provider: {provider}. Available: {list(self.PROVIDERS.keys())}")
        self._provider = provider_cls(**kwargs)

    async def list_tools(self, app: str = "") -> list[ConnectorTool]:
        return await self._provider.list_tools(app=app)

    async def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        app: str = "",
        user_id: str = "",
        org_id: str = "",
    ) -> ConnectorResult:
        import time as _time
        start = _time.time()

        result = await self._provider.call_tool(
            tool_name,
            arguments,
            app=app,
            user_id=user_id,
        )

        duration_ms = (_time.time() - start) * 1000

        # Track billing at the hub level — ensures ALL connector calls are billed
        # regardless of whether they come from API, CLI, or agent tool
        try:
            from agentos.core.db_config import get_db, initialize_db
            initialize_db()
            db = get_db()
            if db:
                db.record_billing(
                    cost_type="connector",
                    total_cost_usd=0.001,
                    org_id=org_id,
                    customer_id=user_id,
                    description=f"Connector: {tool_name}",
                    model=tool_name,
                    provider=self._provider.name,
                )
        except Exception:
            pass  # Don't block tool call on billing failure

        return result

    async def get_auth_url(self, app: str, user_id: str) -> str:
        return await self._provider.get_auth_url(app, user_id)
