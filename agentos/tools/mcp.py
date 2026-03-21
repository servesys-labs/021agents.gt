"""Model Context Protocol (MCP) client-host-server integration."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MCPTool:
    """An MCP-exposed tool with name, description, and JSON Schema input."""

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)


@dataclass
class MCPResource:
    """An MCP resource (read-only data the agent can access)."""

    uri: str
    name: str
    mime_type: str = "application/json"


@dataclass
class MCPServer:
    """Represents a connected MCP server exposing tools and resources."""

    name: str
    tools: list[MCPTool] = field(default_factory=list)
    resources: list[MCPResource] = field(default_factory=list)

    def get_tool(self, tool_name: str) -> MCPTool | None:
        for t in self.tools:
            if t.name == tool_name:
                return t
        return None


class MCPClient:
    """Client that connects to MCP servers to discover and invoke tools.

    Follows the client-host-server architecture from the MCP specification.
    """

    def __init__(self) -> None:
        self._servers: dict[str, MCPServer] = {}
        self._handlers: dict[str, Any] = {}

    def register_server(self, server: MCPServer) -> None:
        self._servers[server.name] = server

    def register_handler(self, tool_name: str, handler: Any) -> None:
        """Register a callable handler for a tool name."""
        self._handlers[tool_name] = handler

    def list_tools(self) -> list[MCPTool]:
        tools: list[MCPTool] = []
        for server in self._servers.values():
            tools.extend(server.tools)
        return tools

    def list_resources(self) -> list[MCPResource]:
        resources: list[MCPResource] = []
        for server in self._servers.values():
            resources.extend(server.resources)
        return resources

    def find_tool(self, tool_name: str) -> tuple[MCPServer, MCPTool] | None:
        for server in self._servers.values():
            tool = server.get_tool(tool_name)
            if tool:
                return server, tool
        return None

    async def invoke(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        handler = self._handlers.get(tool_name)
        if handler is None:
            return {"error": f"No handler registered for tool '{tool_name}'"}
        try:
            result = await handler(**arguments) if callable(handler) else handler
            return {"tool": tool_name, "result": result}
        except Exception as exc:
            return {"tool": tool_name, "error": str(exc)}
