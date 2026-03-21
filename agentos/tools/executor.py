"""Tool execution engine with retry and sandboxing."""

from __future__ import annotations

import logging
from typing import Any

from agentos.tools.mcp import MCPClient

logger = logging.getLogger(__name__)


class ToolExecutor:
    """Executes tools via MCP with retry logic and error handling."""

    def __init__(self, mcp_client: MCPClient | None = None, max_retries: int = 3) -> None:
        self.mcp_client = mcp_client or MCPClient()
        self.max_retries = max_retries

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Execute a tool with retries on failure."""
        last_error = ""
        for attempt in range(1, self.max_retries + 1):
            result = await self.mcp_client.invoke(tool_name, arguments)
            if "error" not in result:
                return result
            last_error = result["error"]
            logger.warning(
                "Tool %s attempt %d/%d failed: %s",
                tool_name, attempt, self.max_retries, last_error,
            )
        return {"tool": tool_name, "error": last_error, "attempts": self.max_retries}

    def available_tools(self) -> list[dict[str, Any]]:
        """Return tool schemas for LLM function-calling."""
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }
            for tool in self.mcp_client.list_tools()
        ]
