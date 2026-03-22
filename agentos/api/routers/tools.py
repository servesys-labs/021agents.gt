"""Tools router — list available tools, database stats, cost ledger."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter

from agentos.api.deps import _get_db

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("")
async def list_tools():
    """List all available builtin and plugin tools."""
    from agentos.tools.registry import ToolRegistry
    registry = ToolRegistry()
    tools = registry.list_all()
    return {
        "tools": [
            {
                "name": t.name,
                "description": t.description,
                "has_handler": t.handler is not None,
                "source": str(t.source_path) if t.source_path else "builtin",
            }
            for t in tools
        ]
    }
