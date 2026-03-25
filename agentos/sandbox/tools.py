"""Sandbox tools for the AgentOS tool registry.

Execution priority:
  1. Cloudflare — Dynamic Workers (JS) + Containers SDK (bash/Python)
  2. E2B — legacy fallback if CF is not configured

Registers sandbox_exec, sandbox_file_write, sandbox_file_read, sandbox_kill
as MCP-style tools available to agents.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def sandbox_tool_definitions() -> list[dict[str, Any]]:
    """Return MCP-style tool definitions for sandbox operations."""
    return [
        {
            "name": "sandbox_exec",
            "description": "Execute a shell command in a secure sandbox. Returns stdout, stderr, and exit code.",
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
            "description": "Write a file inside the sandbox filesystem",
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
            "description": "Read a file from the sandbox filesystem",
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
            "description": "Kill a sandbox to free resources",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sandbox_id": {"type": "string", "description": "Sandbox ID to kill"},
                },
                "required": ["sandbox_id"],
            },
        },
    ]


async def _exec_via_cf(args: dict[str, Any]) -> dict[str, Any] | None:
    """Try executing via Cloudflare containers. Returns None if not configured."""
    try:
        from agentos.infra.cloudflare_client import get_cf_client
        cf = get_cf_client()
        if not cf:
            return None
        result = await cf.sandbox_exec(
            code=args["command"],
            language="bash",
            timeout_ms=int(args.get("timeout_ms", 30000)),
        )
        return {
            "sandbox_id": "cf-container",
            "stdout": result.get("stdout", ""),
            "stderr": result.get("stderr", ""),
            "exit_code": result.get("exit_code", 1),
            "duration_ms": result.get("duration_ms", 0),
        }
    except Exception as exc:
        logger.warning("CF sandbox exec failed: %s", exc)
        return None


async def _exec_via_e2b(args: dict[str, Any]) -> dict[str, Any] | None:
    """Try executing via E2B sandbox. Returns None if not configured."""
    try:
        from agentos.sandbox.manager import SandboxManager
        mgr = SandboxManager()
        if not mgr.has_api_key:
            return None
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
    except Exception as exc:
        logger.warning("E2B sandbox exec failed: %s", exc)
        return None


async def handle_sandbox_tool(name: str, args: dict[str, Any]) -> Any:
    """Execute a sandbox tool call.

    Priority: Cloudflare containers first, E2B fallback.
    """
    if name == "sandbox_exec":
        # 1. Try Cloudflare (Dynamic Workers + Containers SDK)
        result = await _exec_via_cf(args)
        if result is not None:
            return result

        # 2. Fallback to E2B
        result = await _exec_via_e2b(args)
        if result is not None:
            return result

        raise RuntimeError(
            "No sandbox available. Set AGENTOS_WORKER_URL for Cloudflare containers "
            "or E2B_API_KEY for E2B."
        )

    # File operations — E2B only (CF file ops go through /cf/storage/*)
    if name in ("sandbox_file_write", "sandbox_file_read", "sandbox_kill"):
        from agentos.sandbox.manager import SandboxManager
        mgr = SandboxManager()

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
