"""FastAPI application for AgentOS API-first access."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from agentos.core.harness import AgentHarness


class RunRequest(BaseModel):
    input: str = Field(..., description="User input to the agent")
    config: dict[str, Any] = Field(default_factory=dict, description="Optional config overrides")


class TurnOutput(BaseModel):
    turn: int
    content: str
    tool_results: list[dict[str, Any]] = []
    done: bool = False
    error: str | None = None


class RunResponse(BaseModel):
    turns: list[TurnOutput]
    final_output: str


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str


def create_app(harness: AgentHarness | None = None) -> FastAPI:
    """Create the AgentOS FastAPI application."""
    app = FastAPI(title="AgentOS", version="0.1.0", description="Composable Autonomous Agent Framework")
    _harness = harness or AgentHarness.from_config_file()

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        from agentos import __version__
        return HealthResponse(status="ok", version=__version__)

    @app.post("/run", response_model=RunResponse)
    async def run(request: RunRequest) -> RunResponse:
        results = await _harness.run(request.input)
        turns: list[TurnOutput] = []
        final_output = ""
        for r in results:
            content = r.llm_response.content if r.llm_response else ""
            turns.append(TurnOutput(
                turn=r.turn_number,
                content=content,
                tool_results=r.tool_results,
                done=r.done,
                error=r.error,
            ))
            if r.done and content:
                final_output = content
        return RunResponse(turns=turns, final_output=final_output)

    @app.get("/tools")
    async def list_tools() -> list[dict[str, Any]]:
        return _harness.tool_executor.available_tools()

    @app.get("/memory/snapshot")
    async def memory_snapshot() -> dict[str, Any]:
        return _harness.memory_manager.working.snapshot()

    return app
