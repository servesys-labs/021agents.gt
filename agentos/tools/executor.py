"""Tool execution engine with retry, sandboxing, and remote worker dispatch.

When TOOL_EXEC_VIA_WORKER=true, tools in WORKER_TOOLS are executed on the
Cloudflare worker via /cf/tool/exec instead of locally on the backend.
This keeps the control plane (Railway) free of user code execution.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from agentos.tools.mcp import MCPClient

logger = logging.getLogger(__name__)

# Tools that execute on the Cloudflare worker (not on the backend).
# These need CF bindings: Sandbox containers, LOADER, Browser Rendering,
# Vectorize, R2, or Worker fetch().
WORKER_TOOLS = {
    # Sandbox-based (bash, Python, filesystem)
    "bash", "python-exec", "read-file", "write-file", "edit-file",
    "grep", "glob", "sandbox_exec", "sandbox_file_write",
    "sandbox_file_read", "sandbox_kill",
    # Worker fetch (web, HTTP, connectors)
    "web-search", "http-request", "browse", "a2a-send", "connector",
    # Already on CF (RAG, browse, sandbox)
    "dynamic-exec", "web-crawl", "browser-render",
    "store-knowledge", "knowledge-search",
    # GMI API (image, audio)
    "image-generate", "text-to-speech", "speech-to-text",
    # Stateful
    "todo",
    # Project persistence (Sandbox ↔ R2)
    "save-project", "load-project", "list-project-versions",
}


def _use_worker_tools() -> bool:
    """Check if tool execution should be routed to the CF worker."""
    raw = os.environ.get("TOOL_EXEC_VIA_WORKER", "false").strip().lower()
    return raw in ("true", "1", "on", "yes")


class ToolExecutor:
    """Executes tools via MCP (local) or CF worker (remote) with retry logic."""

    def __init__(self, mcp_client: MCPClient | None = None, max_retries: int = 3) -> None:
        self.mcp_client = mcp_client or MCPClient()
        self.max_retries = max_retries
        # Session context — set by the harness before each run
        self.session_id: str = ""
        self.turn: int = 0

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Execute a tool with retries on failure.

        Routes to CF worker for tools in WORKER_TOOLS when the flag is on.
        Falls back to local execution otherwise.
        """
        if _use_worker_tools() and tool_name in WORKER_TOOLS:
            return await self._execute_remote(tool_name, arguments)

        # Local execution (MCP handlers)
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

    async def _execute_remote(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Execute a tool on the Cloudflare worker via /cf/tool/exec."""
        from agentos.infra.cloudflare_client import get_cf_client

        cf = get_cf_client()
        if cf is None:
            logger.warning("CloudflareClient not configured, falling back to local for %s", tool_name)
            return await self.mcp_client.invoke(tool_name, arguments)

        try:
            result = await cf.tool_exec(
                tool_name=tool_name,
                args=arguments,
                session_id=self.session_id,
                turn=self.turn,
            )
            # Normalize response: worker returns {tool, result} or {tool, error}
            if "error" in result:
                return {"tool": tool_name, "error": result["error"]}
            return {"tool": tool_name, "result": result.get("result", "")}
        except Exception as exc:
            logger.error("Remote tool execution failed for %s: %s", tool_name, exc)
            # Fall back to local execution on remote failure
            logger.info("Falling back to local execution for %s", tool_name)
            return await self.mcp_client.invoke(tool_name, arguments)

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
