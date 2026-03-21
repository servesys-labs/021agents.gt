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
class MCPPrompt:
    """An MCP prompt template for specific tasks."""

    name: str
    description: str
    template: str
    arguments: list[dict[str, Any]] = field(default_factory=list)

    def render(self, **kwargs: Any) -> str:
        """Render the prompt template with the given arguments."""
        result = self.template
        for key, value in kwargs.items():
            result = result.replace(f"{{{{{key}}}}}", str(value))
        return result


@dataclass
class MCPServer:
    """Represents a connected MCP server exposing tools, resources, and prompts."""

    name: str
    tools: list[MCPTool] = field(default_factory=list)
    resources: list[MCPResource] = field(default_factory=list)
    prompts: list[MCPPrompt] = field(default_factory=list)

    def get_tool(self, tool_name: str) -> MCPTool | None:
        for t in self.tools:
            if t.name == tool_name:
                return t
        return None

    def get_prompt(self, prompt_name: str) -> MCPPrompt | None:
        for p in self.prompts:
            if p.name == prompt_name:
                return p
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

    def list_prompts(self) -> list[MCPPrompt]:
        prompts: list[MCPPrompt] = []
        for server in self._servers.values():
            prompts.extend(server.prompts)
        return prompts

    def find_prompt(self, prompt_name: str) -> MCPPrompt | None:
        for server in self._servers.values():
            prompt = server.get_prompt(prompt_name)
            if prompt:
                return prompt
        return None

    def find_tool(self, tool_name: str) -> tuple[MCPServer, MCPTool] | None:
        for server in self._servers.values():
            tool = server.get_tool(tool_name)
            if tool:
                return server, tool
        return None

    def validate_arguments(self, tool_name: str, arguments: dict[str, Any]) -> list[str]:
        """Validate tool arguments against the tool's input schema.

        Returns a list of validation errors (empty if valid).
        """
        found = self.find_tool(tool_name)
        if found is None:
            return []  # No schema to validate against
        _, tool = found
        schema = tool.input_schema
        if not schema:
            return []

        errors: list[str] = []
        required = schema.get("required", [])
        properties = schema.get("properties", {})

        for req in required:
            if req not in arguments:
                errors.append(f"Missing required argument: '{req}'")

        for key, value in arguments.items():
            if key in properties:
                prop = properties[key]
                expected_type = prop.get("type")
                if expected_type and not _type_matches(value, expected_type):
                    errors.append(
                        f"Argument '{key}' expected type '{expected_type}', got '{type(value).__name__}'"
                    )

        return errors

    async def invoke(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        # Validate inputs against schema before execution
        validation_errors = self.validate_arguments(tool_name, arguments)
        if validation_errors:
            return {"tool": tool_name, "error": f"Schema validation failed: {'; '.join(validation_errors)}"}

        handler = self._handlers.get(tool_name)
        if handler is None:
            return {"error": f"No handler registered for tool '{tool_name}'"}
        try:
            result = await handler(**arguments) if callable(handler) else handler
            return {"tool": tool_name, "result": result}
        except Exception as exc:
            return {"tool": tool_name, "error": str(exc)}


def _type_matches(value: Any, json_type: str) -> bool:
    """Check if a Python value matches a JSON Schema type."""
    type_map: dict[str, tuple[type, ...]] = {
        "string": (str,),
        "number": (int, float),
        "integer": (int,),
        "boolean": (bool,),
        "array": (list,),
        "object": (dict,),
    }
    expected = type_map.get(json_type)
    if expected is None:
        return True  # Unknown type, allow
    return isinstance(value, expected)
