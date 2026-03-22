"""FastAPI application for AgentOS API-first access."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from agentos.core.events import EventBus
from agentos.core.governance import GovernanceLayer, GovernancePolicy
from agentos.core.harness import AgentHarness
from agentos.env import load_dotenv_if_present
from agentos.api.deps import CurrentUser, get_current_user, _get_db_safe

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


def _build_harness_with_overrides(
    base: AgentHarness,
    overrides: dict[str, Any],
) -> AgentHarness:
    """Build a request-scoped harness with safe config overrides."""
    base_cfg = base.config
    cfg = {
        "max_turns": base_cfg.max_turns,
        "timeout_seconds": base_cfg.timeout_seconds,
        "retry_on_tool_failure": base_cfg.retry_on_tool_failure,
        "max_retries": base_cfg.max_retries,
    }
    gov_base = base.governance.policy
    gov = {
        "require_confirmation_for_destructive": gov_base.require_confirmation_for_destructive,
        "budget_limit_usd": gov_base.budget_limit_usd,
        "allowed_domains": list(gov_base.allowed_domains),
        "blocked_tools": list(gov_base.blocked_tools),
        "max_tokens_per_turn": gov_base.max_tokens_per_turn,
    }

    for key in ("max_turns", "timeout_seconds", "retry_on_tool_failure", "max_retries"):
        if key in overrides:
            cfg[key] = overrides[key]
    for key in (
        "budget_limit_usd",
        "blocked_tools",
        "require_confirmation_for_destructive",
        "allowed_domains",
        "max_tokens_per_turn",
    ):
        if key in overrides:
            gov[key] = overrides[key]

    # Guardrails against malformed request values.
    cfg["max_turns"] = max(1, int(cfg["max_turns"]))
    cfg["timeout_seconds"] = max(0.01, float(cfg["timeout_seconds"]))
    cfg["max_retries"] = max(0, int(cfg["max_retries"]))
    cfg["retry_on_tool_failure"] = bool(cfg["retry_on_tool_failure"])
    gov["budget_limit_usd"] = max(0.0, float(gov["budget_limit_usd"]))
    gov["blocked_tools"] = [str(t) for t in gov["blocked_tools"]]
    gov["allowed_domains"] = [str(d) for d in gov["allowed_domains"]]
    gov["require_confirmation_for_destructive"] = bool(
        gov["require_confirmation_for_destructive"]
    )
    gov["max_tokens_per_turn"] = max(1, int(gov["max_tokens_per_turn"]))

    request_harness = AgentHarness(
        config=type(base_cfg)(**cfg),
        llm_router=base.llm_router,
        tool_executor=base.tool_executor,
        memory_manager=base.memory_manager,
        governance=GovernanceLayer(GovernancePolicy(**gov)),
        event_bus=EventBus(),
    )
    request_harness.system_prompt = base.system_prompt
    return request_harness


def create_app(harness: AgentHarness | None = None) -> FastAPI:
    """Create the AgentOS FastAPI application."""
    from fastapi.staticfiles import StaticFiles

    load_dotenv_if_present()

    app = FastAPI(
        title="AgentOS",
        version="0.2.0",
        description="Agent Control Plane — build, test, govern, deploy, and observe AI agents. "
        "165+ API endpoints, 21 builtin tools, 3,000+ app integrations via Pipedream, "
        "A2A + MCP protocol support, multi-provider LLM routing (GMI, Anthropic, OpenAI, Cloudflare).",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )

    # Build a real harness from the first available agent so /run uses a real LLM.
    if harness is None:
        try:
            from agentos.agent import Agent, list_agents
            agents = list_agents()
            if agents:
                default_agent = Agent.from_name(agents[0].name)
                harness = default_agent._harness
                logger.info("Default harness loaded from agent '%s'", agents[0].name)
        except Exception as exc:
            logger.warning("Could not load default agent for harness: %s", exc)
    _harness = harness or AgentHarness.from_config_file()

    # Rate limiting
    from agentos.api.ratelimit import RateLimitMiddleware
    app.add_middleware(RateLimitMiddleware)

    # Mount legacy auth routes
    from agentos.auth.middleware import mount_auth_routes
    mount_auth_routes(app)

    # Mount A2A protocol routes (agent discovery + JSON-RPC)
    from agentos.a2a.server import mount_a2a_routes
    mount_a2a_routes(app)

    # Mount v1 API routers (portal backend)
    from agentos.api.routers import (
        auth, agents as agents_router, sessions, eval, evolve,
        billing, plans, schedules, api_keys, webhooks, orgs,
        tools as tools_router, sandbox as sandbox_router,
        rag, compare, observability, memory, deploy, gpu, config,
        projects, audit, policies, slos, releases, jobs, workflows, retention,
        secrets, mcp_control, connectors, stripe_billing,
        skills as skills_router, middleware as middleware_router,
    )
    for r in [
        auth.router, agents_router.router, sessions.router,
        eval.router, evolve.router, billing.router, plans.router,
        schedules.router, api_keys.router, webhooks.router, orgs.router,
        tools_router.router, sandbox_router.router, rag.router,
        compare.router, observability.router, memory.router,
        deploy.router, gpu.router, config.router,
        projects.router, audit.router, policies.router, slos.router,
        releases.router, jobs.router, workflows.router, retention.router,
        secrets.router, mcp_control.router, connectors.router,
        stripe_billing.router,
        skills_router.router, middleware_router.router,
    ]:
        app.include_router(r, prefix="/api/v1")

    # Auto-start scheduler and job worker as background tasks
    @app.on_event("startup")
    async def _start_background_services() -> None:
        import asyncio

        # Background scheduler — checks for due schedules every 60s
        try:
            from agentos.scheduler import scheduler_loop

            async def _run_scheduler() -> None:
                while True:
                    try:
                        scheduler_loop()
                    except Exception as exc:
                        logger.warning("Scheduler tick error: %s", exc)
                    await asyncio.sleep(60)

            asyncio.create_task(_run_scheduler())
            logger.info("Background scheduler started")
        except Exception as exc:
            logger.warning("Could not start background scheduler: %s", exc)

        # Background job worker — dequeues and processes async jobs
        async def _run_job_worker() -> None:
            while True:
                try:
                    db = _get_db_safe()
                    if db is None:
                        await asyncio.sleep(10)
                        continue
                    job = db.dequeue_job()
                    if job is None:
                        await asyncio.sleep(5)
                        continue
                    # Process the job by running the agent
                    job_id = job["job_id"]
                    agent_name = job.get("agent_name", "")
                    task = job.get("task", "")
                    logger.info("Job worker: processing job %s (agent=%s)", job_id, agent_name)
                    try:
                        from agentos.agent import Agent
                        agent = Agent.from_name(agent_name)
                        results = await agent.run(task)
                        output = results[-1].llm_response.text if results and results[-1].llm_response else ""
                        session_id = getattr(agent._harness, "_current_session_id", "")
                        db.complete_job(job_id, result={"output": output[:500]}, session_id=session_id)
                        logger.info("Job %s completed", job_id)
                    except Exception as exc:
                        db.fail_job(job_id, error=str(exc)[:500])
                        logger.error("Job %s failed: %s", job_id, exc)
                except Exception as exc:
                    logger.warning("Job worker error: %s", exc)
                    await asyncio.sleep(10)

        asyncio.create_task(_run_job_worker())
        logger.info("Background job worker started")

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
    async def run(request: RunRequest, user: CurrentUser = Depends(get_current_user)) -> RunResponse:
        runner = (
            _build_harness_with_overrides(_harness, request.config)
            if request.config
            else _harness
        )
        results = await runner.run(request.input)
        return _build_run_response(results)

    @app.post("/run/stream")
    async def run_stream(request: RunRequest, user: CurrentUser = Depends(get_current_user)):
        """Stream agent run results as Server-Sent Events."""
        import asyncio
        from starlette.responses import StreamingResponse

        turn_queue: asyncio.Queue = asyncio.Queue()

        runner = (
            _build_harness_with_overrides(_harness, request.config)
            if request.config
            else _harness
        )

        def on_turn(result):
            content = result.llm_response.content if result.llm_response else ""
            turn_queue.put_nowait({
                "turn": result.turn_number,
                "content": content,
                "tool_results": result.tool_results,
                "done": result.done,
                "error": result.error,
                "cost_usd": result.cost_usd,
            })

        runner.on_turn_complete = on_turn

        async def event_stream():
            import json as _json
            task = asyncio.create_task(runner.run(request.input))
            while not task.done():
                try:
                    data = await asyncio.wait_for(turn_queue.get(), timeout=0.5)
                    yield f"data: {_json.dumps(data)}\n\n"
                    if data.get("done"):
                        break
                except asyncio.TimeoutError:
                    continue
            # Drain remaining
            while not turn_queue.empty():
                data = turn_queue.get_nowait()
                yield f"data: {_json.dumps(data)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    @app.get("/tools")
    async def list_tools(user: CurrentUser = Depends(get_current_user)) -> list[dict[str, Any]]:
        return _harness.tool_executor.available_tools()

    @app.get("/memory/snapshot")
    async def memory_snapshot(user: CurrentUser = Depends(get_current_user)) -> dict[str, Any]:
        return _harness.memory_manager.working.snapshot()

    # ── Agent-specific endpoints ──────────────────────────────────────────

    @app.get("/agents", response_model=list[AgentInfo])
    async def list_agents_api(user: CurrentUser = Depends(get_current_user)) -> list[AgentInfo]:
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
    async def get_agent_info(agent_name: str, user: CurrentUser = Depends(get_current_user)) -> AgentInfo:
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
    async def run_agent(
        agent_name: str,
        request: AgentRunRequest,
        user: CurrentUser = Depends(get_current_user),
    ) -> RunResponse:
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
    async def get_agent_tools(
        agent_name: str,
        user: CurrentUser = Depends(get_current_user),
    ) -> list[dict[str, Any]]:
        """List tools available to a specific agent."""
        from agentos.agent import Agent
        if agent_name not in _agent_cache:
            try:
                _agent_cache[agent_name] = Agent.from_name(agent_name)
            except FileNotFoundError:
                raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found")
        return _agent_cache[agent_name]._harness.tool_executor.available_tools()

    # ── Sandbox endpoints ────────────────────────────────────────────────
    # Always require auth — these endpoints can execute arbitrary commands.

    from agentos.auth.middleware import require_auth as _require_sandbox_auth

    _sandbox_mgr_instance: list = []  # lazy singleton

    def _sandbox_mgr():
        if not _sandbox_mgr_instance:
            from agentos.sandbox import SandboxManager
            mgr = SandboxManager()
            # Block local fallback in API mode — it's host RCE without sandboxing
            if not mgr.has_api_key:
                logger.warning(
                    "E2B_API_KEY not set — sandbox endpoints will reject requests "
                    "to prevent unauthenticated host command execution"
                )
            _sandbox_mgr_instance.append(mgr)
        return _sandbox_mgr_instance[0]

    def _check_sandbox_available():
        """Raise 503 if sandbox is in local-fallback mode (unsafe for API)."""
        mgr = _sandbox_mgr()
        if not mgr.has_api_key:
            raise HTTPException(
                status_code=503,
                detail="Sandbox unavailable: E2B_API_KEY not configured. "
                "Local fallback is disabled in API mode for security.",
            )

    @app.post("/sandbox/create")
    async def sandbox_create(
        request: dict[str, Any] | None = None,
        _user=Depends(_require_sandbox_auth),
    ) -> dict[str, Any]:
        """Create a new E2B sandbox."""
        _check_sandbox_available()
        template = (request or {}).get("template", "base")
        timeout_sec = (request or {}).get("timeout_sec", 300)
        session = await _sandbox_mgr().create(template=template, timeout_sec=timeout_sec)
        return {"sandbox_id": session.sandbox_id, "template": session.template, "status": session.status}

    @app.post("/sandbox/exec")
    async def sandbox_exec(
        request: dict[str, Any],
        _user=Depends(_require_sandbox_auth),
    ) -> dict[str, Any]:
        """Execute a command in a sandbox."""
        _check_sandbox_available()
        command = request.get("command", "")
        if not command:
            raise HTTPException(status_code=400, detail="command required")
        result = await _sandbox_mgr().exec(
            command=command,
            sandbox_id=request.get("sandbox_id"),
            timeout_ms=int(request.get("timeout_ms", 30000)),
        )
        return {
            "sandbox_id": result.sandbox_id,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.exit_code,
            "duration_ms": result.duration_ms,
        }

    @app.post("/sandbox/file/write")
    async def sandbox_file_write(
        request: dict[str, Any],
        _user=Depends(_require_sandbox_auth),
    ) -> dict[str, Any]:
        """Write a file in a sandbox."""
        _check_sandbox_available()
        path = request.get("path", "")
        content = request.get("content")
        if not path or content is None:
            raise HTTPException(status_code=400, detail="path and content required")
        result = await _sandbox_mgr().file_write(path=path, content=content, sandbox_id=request.get("sandbox_id"))
        return {"sandbox_id": result.sandbox_id, "path": result.path, "success": result.success, "error": result.error}

    @app.post("/sandbox/file/read")
    async def sandbox_file_read(
        request: dict[str, Any],
        _user=Depends(_require_sandbox_auth),
    ) -> dict[str, Any]:
        """Read a file from a sandbox."""
        _check_sandbox_available()
        path = request.get("path", "")
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        result = await _sandbox_mgr().file_read(path=path, sandbox_id=request.get("sandbox_id"))
        return {"sandbox_id": result.sandbox_id, "path": result.path, "content": result.content, "success": result.success, "error": result.error}

    @app.get("/sandbox/list")
    async def sandbox_list(_user=Depends(_require_sandbox_auth)) -> dict[str, Any]:
        """List all active sandboxes."""
        sandboxes = await _sandbox_mgr().list_sandboxes()
        return {"sandboxes": sandboxes}

    @app.post("/sandbox/kill")
    async def sandbox_kill_endpoint(
        request: dict[str, Any],
        _user=Depends(_require_sandbox_auth),
    ) -> dict[str, Any]:
        """Kill a sandbox."""
        _check_sandbox_available()
        sandbox_id = request.get("sandbox_id", "")
        if not sandbox_id:
            raise HTTPException(status_code=400, detail="sandbox_id required")
        killed = await _sandbox_mgr().kill(sandbox_id=sandbox_id)
        return {"killed": killed, "sandbox_id": sandbox_id}

    @app.post("/sandbox/keepalive")
    async def sandbox_keepalive(
        request: dict[str, Any],
        _user=Depends(_require_sandbox_auth),
    ) -> dict[str, Any]:
        """Extend sandbox timeout."""
        sandbox_id = request.get("sandbox_id", "")
        if not sandbox_id:
            raise HTTPException(status_code=400, detail="sandbox_id required")
        ok = await _sandbox_mgr().keepalive(sandbox_id=sandbox_id, timeout_sec=int(request.get("timeout_sec", 300)))
        return {"kept_alive": ok, "sandbox_id": sandbox_id}

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
