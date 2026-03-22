"""Connector Hub — abstract interface to MCP connector providers.

Supports pluggable providers (Pipedream, Nango, etc.) with a unified API.
Each provider handles OAuth, credential lifecycle, and API normalization.
"""

from __future__ import annotations

import json
import logging
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

    async def call_tool(self, tool_name: str, arguments: dict[str, Any],
                        user_id: str = "") -> ConnectorResult:
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

    async def _get_token(self) -> str:
        """Get or refresh the Pipedream access token."""
        if self._access_token:
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
                self._access_token = resp.json().get("access_token", "")
            else:
                logger.warning("Pipedream token request failed: %s", resp.status_code)
        return self._access_token

    def _headers(self, user_id: str = "", app: str = "") -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {self._access_token}",
            "x-pd-project-id": self.project_id,
            "x-pd-environment": self.environment,
        }
        if user_id:
            h["x-pd-external-user-id"] = user_id
        if app:
            h["x-pd-app-slug"] = app
        return h

    async def list_tools(self, app: str = "") -> list[ConnectorTool]:
        """List available tools, optionally filtered by app."""
        import httpx

        token = await self._get_token()
        if not token:
            return []

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                # Use MCP JSON-RPC to list tools
                resp = await client.post(
                    self.MCP_URL,
                    headers={**self._headers(app=app), "Content-Type": "application/json"},
                    json={"jsonrpc": "2.0", "id": "1", "method": "tools/list"},
                )
                if resp.status_code != 200:
                    return []
                data = resp.json()
                tools_data = data.get("result", {}).get("tools", [])
                return [
                    ConnectorTool(
                        name=t.get("name", ""),
                        description=t.get("description", ""),
                        app=app,
                        input_schema=t.get("inputSchema", {}),
                        provider="pipedream",
                    )
                    for t in tools_data
                ]
        except Exception as exc:
            logger.warning("Pipedream list_tools failed: %s", exc)
            return []

    async def call_tool(self, tool_name: str, arguments: dict[str, Any],
                        user_id: str = "") -> ConnectorResult:
        """Call a tool via Pipedream MCP."""
        import httpx

        token = await self._get_token()
        if not token:
            return ConnectorResult(success=False, error="No Pipedream access token")

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    self.MCP_URL,
                    headers={**self._headers(user_id=user_id), "Content-Type": "application/json"},
                    json={
                        "jsonrpc": "2.0", "id": "1",
                        "method": "tools/call",
                        "params": {"name": tool_name, "arguments": arguments},
                    },
                )

                data = resp.json()

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
                content = result.get("content", [])
                text = "".join(c.get("text", "") for c in content if c.get("type") == "text")

                return ConnectorResult(success=True, data=text)

        except Exception as exc:
            return ConnectorResult(success=False, error=str(exc))

    async def get_auth_url(self, app: str, user_id: str) -> str:
        """Get the OAuth connection URL for a user + app."""
        return f"https://pipedream.com/_static/connect.html?app={app}&connectLink=true"


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

    async def call_tool(self, tool_name: str, arguments: dict[str, Any],
                        user_id: str = "") -> ConnectorResult:
        return await self._provider.call_tool(tool_name, arguments, user_id=user_id)

    async def get_auth_url(self, app: str, user_id: str) -> str:
        return await self._provider.get_auth_url(app, user_id)
