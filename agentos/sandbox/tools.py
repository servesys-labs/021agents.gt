"""Sandbox tools for the AgentOS tool registry.

Registers sandbox_exec, sandbox_file_write, sandbox_file_read, sandbox_kill
as MCP-style tools available to agents.
"""

from __future__ import annotations

import logging
from typing import Any

from agentos.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)

# Module-level manager instance (lazy-initialized)
_manager: SandboxManager | None = None


def get_manager() -> SandboxManager:
    global _manager
    if _manager is None:
        _manager = SandboxManager()
    return _manager


def sandbox_tool_definitions() -> list[dict[str, Any]]:
    """Return MCP-style tool definitions for sandbox operations."""
    return [
        {
            "name": "sandbox_exec",
            "description": "Execute a shell command in a secure E2B sandbox. Returns stdout, stderr, and exit code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute"},
                    "sandbox_id": {"type": "string", "description": "Existing sandbox ID (optional)"},
                    "timeout_ms": {"type": "number", "description": "Timeout in ms (default: 30000)"},
                },
                "required": ["command"],
            },
        },
        {
            "name": "sandbox_file_write",
            "description": "Write a file inside the E2B sandbox filesystem",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path inside sandbox"},
                    "content": {"type": "string", "description": "File content"},
                    "sandbox_id": {"type": "string", "description": "Existing sandbox ID"},
                },
                "required": ["path", "content"],
            },
        },
        {
            "name": "sandbox_file_read",
            "description": "Read a file from the E2B sandbox filesystem",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path inside sandbox"},
                    "sandbox_id": {"type": "string", "description": "Existing sandbox ID"},
                },
                "required": ["path"],
            },
        },
        {
            "name": "sandbox_kill",
            "description": "Kill an E2B sandbox to free resources",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sandbox_id": {"type": "string", "description": "Sandbox ID to kill"},
                },
                "required": ["sandbox_id"],
            },
        },
    ]


async def handle_sandbox_tool(name: str, args: dict[str, Any]) -> Any:
    """Execute a sandbox tool call.

    Tries E2B sandbox first. If E2B is unavailable (no API key), falls
    back to Cloudflare container sandbox via CloudflareClient.
    """
    mgr = get_manager()

    if name == "sandbox_exec":
        try:
            result = await mgr.exec(
                command=args["command"],
                sandbox_id=args.get("sandbox_id"),
                timeout_ms=int(args.get("timeout_ms", 30000)),
            )
            return {
                "sandbox_id": result.sandbox_id,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exit_code": result.exit_code,
                "duration_ms": result.duration_ms,
            }
        except Exception as e2b_err:
            # Fall back to Cloudflare container sandbox
            logger.info("E2B sandbox unavailable (%s), trying CF sandbox", e2b_err)
            try:
                from agentos.infra.cloudflare_client import get_cf_client
                cf = get_cf_client()
                if cf:
                    cf_result = await cf.sandbox_exec(
                        code=args["command"],
                        language="bash",
                        timeout_ms=int(args.get("timeout_ms", 30000)),
                    )
                    return {
                        "sandbox_id": "cf-container",
                        "stdout": cf_result.get("stdout", ""),
                        "stderr": cf_result.get("stderr", ""),
                        "exit_code": cf_result.get("exit_code", 1),
                        "duration_ms": 0,
                    }
            except Exception as cf_err:
                logger.warning("CF sandbox also failed: %s", cf_err)
            raise  # Re-raise original E2B error if both fail

    if name == "sandbox_file_write":
        result = await mgr.file_write(
            path=args["path"],
            content=args["content"],
            sandbox_id=args.get("sandbox_id"),
        )
        return {
            "sandbox_id": result.sandbox_id,
            "path": result.path,
            "success": result.success,
            "error": result.error,
        }

    if name == "sandbox_file_read":
        result = await mgr.file_read(
            path=args["path"],
            sandbox_id=args.get("sandbox_id"),
        )
        return {
            "sandbox_id": result.sandbox_id,
            "path": result.path,
            "content": result.content,
            "success": result.success,
            "error": result.error,
        }

    if name == "sandbox_kill":
        killed = await mgr.kill(sandbox_id=args["sandbox_id"])
        return {"killed": killed, "sandbox_id": args["sandbox_id"]}

    raise ValueError(f"Unknown sandbox tool: {name}")
