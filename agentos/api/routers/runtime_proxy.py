"""Legacy runtime-proxy compatibility shim.

Edge runtime is the only execution path. This module is intentionally minimal:
- Keep small helper functions used by adapter tests.
- Keep `/runtime-proxy/tool/call` for backward-compatible tool-call payloads.
- Reject agent/graph runtime execution on backend.
"""

from __future__ import annotations

import inspect
import os
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from agentos.integrations.lc_adapters import (
    coerce_tool_call_request,
    format_runnable_prompt,
    normalize_tool_schemas,
)

router = APIRouter(prefix="/runtime-proxy", tags=["runtime-proxy"])


def _require_edge_token(authorization: str | None = None, x_edge_token: str | None = None) -> None:
    expected = (os.environ.get("EDGE_INGEST_TOKEN", "") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="EDGE_INGEST_TOKEN not configured")

    presented = (x_edge_token or "").strip()
    if not presented and authorization and authorization.lower().startswith("bearer "):
        presented = authorization.split(" ", 1)[1].strip()
    if presented != expected:
        raise HTTPException(status_code=401, detail="invalid edge token")


def _resolve_runnable_task(input_value: Any, prompt_template: dict[str, Any] | None) -> str:
    """Resolve runnable task text from raw input + optional prompt template."""
    if isinstance(prompt_template, dict):
        rendered = format_runnable_prompt(prompt_template, input_value)
        if rendered:
            return rendered
    if isinstance(input_value, str):
        return input_value
    if isinstance(input_value, dict):
        if isinstance(input_value.get("input"), str):
            return str(input_value.get("input"))
        if isinstance(input_value.get("task"), str):
            return str(input_value.get("task"))
        return str(input_value)
    if input_value is None:
        return ""
    return str(input_value)


def _merge_tool_schemas_metadata(
    metadata: dict[str, Any],
    tool_schemas: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Attach normalized tool schema metadata for adapter interoperability."""
    if not tool_schemas:
        return metadata
    merged = dict(metadata)
    merged["tool_schemas"] = normalize_tool_schemas(tool_schemas)
    return merged


class ToolCallProxyRequest(BaseModel):
    tool: str | None = None
    name: str | None = None
    args: dict[str, Any] = Field(default_factory=dict)
    tool_input: dict[str, Any] | str | None = None
    input: dict[str, Any] | str | None = None


def _resolve_tool_callable(tool_name: str) -> Any:
    import agentos.tools.builtins as builtins_mod

    fn = getattr(builtins_mod, tool_name, None)
    if fn is None:
        raise HTTPException(status_code=404, detail=f"Unknown tool '{tool_name}'")
    return fn


@router.post("/tool/call")
async def tool_call_proxy(
    request: ToolCallProxyRequest,
    authorization: str | None = Header(default=None, alias="Authorization"),
    x_edge_token: str | None = Header(default=None, alias="X-Edge-Token"),
):
    """Compatibility endpoint for tool-call payloads."""
    _require_edge_token(authorization, x_edge_token)

    try:
        tool_name, args = coerce_tool_call_request(request.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not tool_name:
        raise HTTPException(status_code=400, detail="tool (or name) is required")

    fn = _resolve_tool_callable(tool_name)
    try:
        if inspect.iscoroutinefunction(fn):
            output = await fn(**args)
        else:
            output = fn(**args)
    except HTTPException:
        raise
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid args for tool '{tool_name}': {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Tool '{tool_name}' failed: {exc}")

    return {"tool": tool_name, "output": output}


@router.post("/agent/run")
async def runtime_proxy_agent_run_blocked():
    """Backend runtime execution is removed in edge-first architecture."""
    raise HTTPException(
        status_code=410,
        detail=(
            "Backend runtime execution is removed. "
            "Use worker `/api/v1/runtime-proxy/agent/run`."
        ),
    )

