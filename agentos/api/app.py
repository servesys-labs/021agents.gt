"""FastAPI application for AgentOS API-first access."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from agentos.core.harness import AgentHarness

logger = logging.getLogger(__name__)


class RunRequest(BaseModel):
    input: str = Field(..., description="User input to the agent")
    config: dict[str, Any] = Field(default_factory=dict, description="Optional config overrides")


class AgentRunRequest(BaseModel):
    input: str = Field(..., description="User input to the agent")


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


class AgentInfo(BaseModel):
    name: str
    description: str
    model: str
    tools: list[str | dict[str, Any]]
    tags: list[str]


def _build_run_response(results: list) -> RunResponse:
    """Convert harness results to API response."""
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


def create_app(harness: AgentHarness | None = None) -> FastAPI:
    """Create the AgentOS FastAPI application."""
    from fastapi.staticfiles import StaticFiles

    app = FastAPI(title="AgentOS", version="0.1.0", description="Composable Autonomous Agent Framework")
    _harness = harness or AgentHarness.from_config_file()

    # Mount auth routes (signup, login, /auth/me, token verify)
    from agentos.auth.middleware import mount_auth_routes
    mount_auth_routes(app)

    # Serve local dashboard (same SPA as CF deploy)
    import importlib.resources
    dashboard_dir = Path(__file__).parent.parent / "dashboard"
    if dashboard_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(dashboard_dir)), name="static")

    # Cache of loaded Agent instances
    _agent_cache: dict[str, Any] = {}

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        from agentos import __version__
        return HealthResponse(status="ok", version=__version__)

    @app.post("/run", response_model=RunResponse)
    async def run(request: RunRequest) -> RunResponse:
        results = await _harness.run(request.input)
        return _build_run_response(results)

    @app.get("/tools")
    async def list_tools() -> list[dict[str, Any]]:
        return _harness.tool_executor.available_tools()

    @app.get("/memory/snapshot")
    async def memory_snapshot() -> dict[str, Any]:
        return _harness.memory_manager.working.snapshot()

    # ── Agent-specific endpoints ──────────────────────────────────────────

    @app.get("/agents", response_model=list[AgentInfo])
    async def list_agents_api() -> list[AgentInfo]:
        """List all available agents."""
        from agentos.agent import list_agents
        agents = list_agents()
        return [
            AgentInfo(
                name=a.name,
                description=a.description,
                model=a.model,
                tools=a.tools,
                tags=a.tags,
            )
            for a in agents
        ]

    @app.get("/agents/{agent_name}", response_model=AgentInfo)
    async def get_agent_info(agent_name: str) -> AgentInfo:
        """Get info about a specific agent."""
        from agentos.agent import Agent
        try:
            agent = Agent.from_name(agent_name)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
        return AgentInfo(
            name=agent.config.name,
            description=agent.config.description,
            model=agent.config.model,
            tools=agent.config.tools,
            tags=agent.config.tags,
        )

    @app.post("/agents/{agent_name}/run", response_model=RunResponse)
    async def run_agent(agent_name: str, request: AgentRunRequest) -> RunResponse:
        """Run a named agent on a task."""
        from agentos.agent import Agent
        # Cache agent instances for reuse (preserves memory across calls)
        if agent_name not in _agent_cache:
            try:
                _agent_cache[agent_name] = Agent.from_name(agent_name)
            except FileNotFoundError:
                raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")

        agent = _agent_cache[agent_name]
        results = await agent.run(request.input)
        return _build_run_response(results)

    @app.get("/agents/{agent_name}/tools")
    async def get_agent_tools(agent_name: str) -> list[dict[str, Any]]:
        """List tools available to a specific agent."""
        from agentos.agent import Agent
        if agent_name not in _agent_cache:
            try:
                _agent_cache[agent_name] = Agent.from_name(agent_name)
            except FileNotFoundError:
                raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
        return _agent_cache[agent_name]._harness.tool_executor.available_tools()

    # ── Dashboard ─────────────────────────────────────────────────────────

    @app.get("/dashboard")
    async def dashboard():
        """Serve the local dashboard SPA."""
        from fastapi.responses import FileResponse
        index = dashboard_dir / "index.html" if dashboard_dir.is_dir() else None
        if index and index.exists():
            return FileResponse(str(index))
        return {"error": "Dashboard not found. Run 'agentos init' first."}

    return app
