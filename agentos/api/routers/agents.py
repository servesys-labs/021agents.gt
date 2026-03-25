"""Agents router — CRUD, run, stream, versions."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from starlette.responses import StreamingResponse

from agentos.api.deps import CurrentUser, get_current_user, get_optional_user, require_scope, _get_db
from agentos.api.schemas import (
    AgentCreateRequest, AgentResponse, AgentRunRequest, ChatRequest, RunResponse,
)

router = APIRouter(prefix="/agents", tags=["agents"])


def _set_runtime_mode_override(agent: Any, runtime_mode: str | None) -> str:
    """Set per-request runtime mode and return previous value."""
    harness_cfg = agent.config.harness if isinstance(agent.config.harness, dict) else {}
    prev = str(harness_cfg.get("runtime_mode", "graph")).strip().lower() or "graph"
    if runtime_mode == "graph":
        harness_cfg["runtime_mode"] = runtime_mode
    return prev


def _set_harness_bool_override(agent: Any, key: str, value: bool | None) -> bool:
    """Set per-request harness bool and return previous value."""
    harness_cfg = agent.config.harness if isinstance(agent.config.harness, dict) else {}
    prev = bool(harness_cfg.get(key, False))
    if isinstance(value, bool):
        harness_cfg[key] = value
    return prev


@router.get("", response_model=list[AgentResponse])
async def list_agents():
    """List all available agents."""
    from agentos.agent import list_agents as _list_agents
    agents = _list_agents()
    return [
        AgentResponse(
            name=a.name, description=a.description, model=a.model,
            tools=a.tools, tags=a.tags, version=a.version,
        )
        for a in agents
    ]


@router.get("/{name}", response_model=AgentResponse)
async def get_agent(name: str):
    """Get agent details."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        c = agent.config
        return AgentResponse(
            name=c.name, description=c.description, model=c.model,
            tools=c.tools, tags=c.tags, version=c.version,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.post("", response_model=AgentResponse)
async def create_agent(request: AgentCreateRequest, user: CurrentUser = Depends(require_scope("agents:write"))):
    """Create a new agent."""
    from agentos.agent import AgentConfig, save_agent_config

    config = AgentConfig(
        name=request.name,
        description=request.description,
        system_prompt=request.system_prompt,
        model=request.model or "anthropic/claude-sonnet-4.6",
        tools=request.tools,
        max_turns=request.max_turns,
        tags=request.tags,
    )
    config.governance["budget_limit_usd"] = request.budget_limit_usd
    save_agent_config(config, org_id=user.org_id, created_by=user.user_id)

    # Snapshot version in agent_versions table
    _snapshot_version(config, user.user_id)

    # Auto-deploy customer worker to dispatch namespace
    from agentos.infra.dispatch import auto_deploy_agent
    await auto_deploy_agent(config.name, user.org_id, user.project_id)

    return AgentResponse(
        name=config.name, description=config.description, model=config.model,
        tools=config.tools, tags=config.tags, version=config.version,
    )


def _snapshot_version(config: Any, created_by: str = "") -> None:
    """Store a version snapshot in agent_versions table."""
    try:
        db = _get_db()
        db.conn.execute(
            """INSERT OR REPLACE INTO agent_versions (agent_name, version, config_json, created_by)
            VALUES (?, ?, ?, ?)""",
            (config.name, config.version, json.dumps(config.to_dict()), created_by),
        )
        db.conn.commit()
    except Exception:
        pass  # Non-critical


def _extract_project_scope(agent: Any) -> str:
    """Read project scope from agent tags: project:<project_id>."""
    tags = getattr(getattr(agent, "config", None), "tags", []) or []
    for tag in tags:
        if isinstance(tag, str) and tag.startswith("project:"):
            return tag.split("project:", 1)[1].strip()
    return ""


def _enforce_compliance(agent: Any, user: CurrentUser) -> None:
    """Block execution if agent has critical drift from its gold image."""
    try:
        db = _get_db()
        from agentos.config.compliance import ComplianceChecker
        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name=agent.config.name,
            agent_config=agent.config.to_dict(),
            org_id=user.org_id,
            checked_by=user.user_id,
        )
        if report.status == "critical":
            drift_fields = ", ".join(d.field for d in report.drifted_fields[:5])
            raise HTTPException(
                status_code=403,
                detail=f"Agent '{agent.config.name}' has critical config drift from gold image "
                       f"'{report.image_name}': {drift_fields}. "
                       f"Fix the drift or update the gold image before running.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # Compliance check is best-effort — don't block on infra errors


def _enforce_project_scope_access(scoped_project_id: str, user: CurrentUser) -> None:
    """Ensure caller can execute a project-scoped agent."""
    if not scoped_project_id:
        return

    # API keys can be pinned to one project. Enforce exact project match.
    if user.project_id and user.project_id != scoped_project_id:
        raise HTTPException(status_code=403, detail="API key is scoped to a different project")

    # Org must still own the scoped project.
    db = _get_db()
    row = db.conn.execute(
        "SELECT 1 FROM projects WHERE project_id = ? AND org_id = ?",
        (scoped_project_id, user.org_id),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="Agent is scoped to another project/org")


@router.put("/{name}", response_model=AgentResponse)
async def update_agent(name: str, request: AgentCreateRequest, user: CurrentUser = Depends(require_scope("agents:write"))):
    """Update an existing agent."""
    from agentos.agent import Agent, AgentConfig, save_agent_config

    try:
        existing = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    config = existing.config
    if request.description:
        config.description = request.description
    if request.system_prompt:
        config.system_prompt = request.system_prompt
    if request.model:
        config.model = request.model
    if request.tools:
        config.tools = request.tools
    if request.tags:
        config.tags = request.tags
    config.max_turns = request.max_turns
    config.governance["budget_limit_usd"] = request.budget_limit_usd
    save_agent_config(config, org_id=user.org_id, created_by=user.user_id)

    # Snapshot updated version
    _snapshot_version(config, user.user_id)

    # Re-deploy customer worker with updated config
    from agentos.infra.dispatch import auto_deploy_agent
    await auto_deploy_agent(config.name, user.org_id, user.project_id)

    return AgentResponse(
        name=config.name, description=config.description, model=config.model,
        tools=config.tools, tags=config.tags, version=config.version,
    )


@router.delete("/{name}")
async def delete_agent(
    name: str,
    hard_delete: bool = False,
    user: CurrentUser = Depends(require_scope("agents:write")),
):
    """Delete an agent and cascade-clean all associated resources.

    Cleans up: DB records (sessions, turns, costs, evals, issues, compliance,
    schedules, webhooks, memory), Vectorize entries, R2 files, filesystem config.

    ?hard_delete=true  → permanently DELETE all rows (irreversible)
    ?hard_delete=false → soft-delete agent, count associated records (default)
    """
    from pathlib import Path
    from agentos.agent import _resolve_agents_dir

    # 1. Cascading DB cleanup
    db = _get_db()
    teardown_result = db.teardown_agent(name, org_id=user.org_id, hard_delete=hard_delete)

    if teardown_result.get("counts", {}).get("agent", 0) == 0:
        # Agent wasn't in DB — check filesystem
        agents_dir = _resolve_agents_dir()
        found_fs = any(
            (agents_dir / f"{name}{ext}").exists()
            for ext in (".json", ".yaml", ".yml")
        )
        if not found_fs:
            raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    # 2. Remove from filesystem
    agents_dir = _resolve_agents_dir()
    for ext in (".json", ".yaml", ".yml"):
        p = agents_dir / f"{name}{ext}"
        if p.exists():
            p.unlink()

    # 3. Clean up CF-side resources (Vectorize, R2) — best-effort
    cf_cleanup = {}
    try:
        from agentos.infra.cloudflare_client import get_cf_client
        cf = get_cf_client()
        if cf:
            cf_cleanup = await cf.teardown_agent(agent_name=name, org_id=user.org_id)
    except Exception as exc:
        cf_cleanup = {"error": str(exc)}

    # 4. Undeploy customer worker from dispatch namespace
    from agentos.infra.dispatch import auto_undeploy_agent
    undeploy_result = await auto_undeploy_agent(name, user.org_id)

    # 4. Audit log
    try:
        db.conn.execute(
            """INSERT INTO config_audit (agent_name, action, details_json, created_at)
            VALUES (?, ?, ?, ?)""",
            (name, "delete", json.dumps({
                "user": user.user_id, "org": user.org_id,
                "hard_delete": hard_delete, "cf_cleanup": cf_cleanup,
            }), time.time()),
        )
        db.conn.commit()
    except Exception:
        pass

    return {
        "deleted": name,
        "hard_delete": hard_delete,
        "db_cleanup": teardown_result.get("counts", {}),
        "cf_cleanup": cf_cleanup,
        "total_records_affected": teardown_result.get("total_records", 0),
    }


@router.post("/{name}/run", response_model=RunResponse)
async def run_agent(
    name: str,
    request: AgentRunRequest,
    user: CurrentUser = Depends(require_scope("agents:run")),
):
    """Run an agent on a task."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    scoped_project_id = _extract_project_scope(agent)
    _enforce_project_scope_access(scoped_project_id, user)
    _enforce_compliance(agent, user)
    if hasattr(agent, "set_runtime_context"):
        agent.set_runtime_context(
            org_id=user.org_id,
            project_id=scoped_project_id,
            user_id=user.user_id,
        )

    start = time.monotonic()
    prev_runtime_mode = _set_runtime_mode_override(agent, request.runtime_mode)
    prev_require_approval = _set_harness_bool_override(
        agent,
        "require_human_approval",
        request.require_human_approval,
    )
    prev_enable_checkpoints = _set_harness_bool_override(
        agent,
        "enable_checkpoints",
        request.enable_checkpoints,
    )
    try:
        results = await agent.run(request.task)
    finally:
        _set_runtime_mode_override(agent, prev_runtime_mode)
        _set_harness_bool_override(agent, "require_human_approval", prev_require_approval)
        _set_harness_bool_override(agent, "enable_checkpoints", prev_enable_checkpoints)
    elapsed = (time.monotonic() - start) * 1000

    output = ""
    total_cost = 0.0
    total_tools = 0
    session_id = ""
    trace_id = ""

    for r in results:
        if r.llm_response and r.llm_response.content:
            output = r.llm_response.content
        total_cost += r.cost_usd
        total_tools += len(r.tool_results)

    if hasattr(agent, "_observer") and agent._observer and agent._observer.records:
        last_rec = agent._observer.records[-1]
        session_id = last_rec.session_id
        trace_id = last_rec.trace_id

    return RunResponse(
        success=not any(r.error for r in results),
        output=output,
        turns=len(results),
        tool_calls=total_tools,
        cost_usd=round(total_cost, 6),
        latency_ms=round(elapsed, 1),
        session_id=session_id,
        trace_id=trace_id,
    )


@router.post("/{name}/run/stream")
async def run_agent_stream(
    name: str,
    request: AgentRunRequest,
    user: CurrentUser = Depends(require_scope("agents:run")),
):
    """Run an agent with SSE streaming."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    scoped_project_id = _extract_project_scope(agent)
    _enforce_project_scope_access(scoped_project_id, user)
    _enforce_compliance(agent, user)
    if hasattr(agent, "set_runtime_context"):
        agent.set_runtime_context(
            org_id=user.org_id,
            project_id=scoped_project_id,
            user_id=user.user_id,
        )

    turn_queue: asyncio.Queue = asyncio.Queue()
    prev_runtime_mode = _set_runtime_mode_override(agent, request.runtime_mode)
    prev_require_approval = _set_harness_bool_override(
        agent,
        "require_human_approval",
        request.require_human_approval,
    )
    prev_enable_checkpoints = _set_harness_bool_override(
        agent,
        "enable_checkpoints",
        request.enable_checkpoints,
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

    agent._harness.on_turn_complete = on_turn

    async def event_stream():
        try:
            task = asyncio.create_task(agent.run(request.task))
            while not task.done():
                try:
                    data = await asyncio.wait_for(turn_queue.get(), timeout=0.5)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get("done"):
                        break
                except asyncio.TimeoutError:
                    continue
            while not turn_queue.empty():
                data = turn_queue.get_nowait()
                yield f"data: {json.dumps(data)}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            _set_runtime_mode_override(agent, prev_runtime_mode)
            _set_harness_bool_override(agent, "require_human_approval", prev_require_approval)
            _set_harness_bool_override(agent, "enable_checkpoints", prev_enable_checkpoints)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/{name}/versions")
async def list_versions(name: str):
    """List all versions of an agent from DB + evolution ledger."""
    from pathlib import Path

    # Query agent_versions table
    db_versions: list[dict] = []
    try:
        db = _get_db()
        rows = db.conn.execute(
            "SELECT version, config_json, created_by, created_at FROM agent_versions WHERE agent_name = ? ORDER BY created_at DESC",
            (name,),
        ).fetchall()
        db_versions = [dict(r) for r in rows]
    except Exception:
        pass

    # Also check evolution ledger for backward compatibility
    ledger_path = Path.cwd() / "data" / "evolution" / name / "ledger.json"
    ledger_entries: list = []
    current = "0.1.0"
    if ledger_path.exists():
        try:
            ledger = json.loads(ledger_path.read_text())
            ledger_entries = ledger.get("entries", [])
            current = ledger.get("current_version", "0.1.0")
        except Exception:
            pass

    return {
        "versions": db_versions or ledger_entries,
        "current": current,
    }


@router.post("/create-from-description")
async def create_from_description(
    description: str,
    name: str = "",
    tools: str = "auto",
    draft_only: bool = False,
    user: CurrentUser = Depends(get_current_user),
):
    """Create an agent from a natural language description (LLM-powered).

    tools: 'auto' = auto-detect, 'none' = no tools, or comma-separated list
    """
    from agentos.builder import AgentBuilder, recommend_tools
    from agentos.agent import save_agent_config

    builder = AgentBuilder()
    config = await builder.build_from_description(description)

    if name:
        config.name = name

    if tools == "auto":
        config.tools = recommend_tools(description)
    elif tools == "none":
        config.tools = []
    elif tools:
        config.tools = [t.strip() for t in tools.split(",") if t.strip()]

    if draft_only:
        return {
            "created": False,
            "name": config.name,
            "description": config.description,
            "model": config.model,
            "tools": config.tools,
            "tags": config.tags,
            "version": config.version,
            "draft": config.to_dict(),
        }

    save_agent_config(config, org_id=user.org_id, created_by=user.user_id)
    _snapshot_version(config, user.user_id)

    return {
        "created": True,
        "name": config.name,
        "description": config.description,
        "model": config.model,
        "tools": config.tools,
        "tags": config.tags,
        "version": config.version,
    }


@router.post("/{name}/chat")
async def chat_turn(name: str, request: ChatRequest):
    """Send a single turn in a multi-turn conversation."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    session_id = request.session_id or str(uuid.uuid4())
    results = await agent.run(request.message)
    output = ""
    for r in results:
        if r.llm_response and r.llm_response.content:
            output = r.llm_response.content

    return {
        "response": output,
        "session_id": session_id,
        "turns": len(results),
        "cost_usd": sum(r.cost_usd for r in results),
    }


@router.get("/{name}/tools")
async def get_agent_tools(name: str):
    """List tools available to a specific agent."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        return {"tools": agent._harness.tool_executor.available_tools()}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.get("/{name}/config")
async def get_agent_config(name: str):
    """Get raw agent configuration JSON."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        return agent.config.to_dict()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.post("/{name}/clone")
async def clone_agent(name: str, new_name: str, user: CurrentUser = Depends(get_current_user)):
    """Clone an agent with a new name."""
    from agentos.agent import Agent, save_agent_config
    try:
        agent = Agent.from_name(name)
        config = agent.config
        config.name = new_name
        config.agent_id = ""  # Will get new ID
        save_agent_config(config, org_id=user.org_id, created_by=user.user_id)
        return AgentResponse(
            name=config.name, description=config.description, model=config.model,
            tools=config.tools, tags=config.tags, version=config.version,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.post("/import")
async def import_agent(config: dict[str, Any], user: CurrentUser = Depends(get_current_user)):
    """Import an agent from a JSON config."""
    from agentos.agent import AgentConfig, save_agent_config
    agent_config = AgentConfig.from_dict(config)
    save_agent_config(agent_config, org_id=user.org_id, created_by=user.user_id)
    return AgentResponse(
        name=agent_config.name, description=agent_config.description,
        model=agent_config.model, tools=agent_config.tools,
        tags=agent_config.tags, version=agent_config.version,
    )


@router.post("/{name}/run/{session_id}/cancel")
async def cancel_agent_run(
    name: str,
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Cancel an active agent run by session ID."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    # Attempt to cancel through the harness if it tracks active runs
    if hasattr(agent._harness, "cancel"):
        cancelled = agent._harness.cancel(session_id)
        if not cancelled:
            raise HTTPException(status_code=404, detail=f"No active run found for session '{session_id}'")
        return {"cancelled": session_id, "agent": name}

    # Fallback: mark the session as cancelled in the database
    from agentos.api.deps import _get_db
    db = _get_db()
    row = db.conn.execute(
        "SELECT session_id FROM sessions WHERE session_id = ? AND agent_name = ?",
        (session_id, name),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found for agent '{name}'")
    db.conn.execute(
        "UPDATE sessions SET status = 'cancelled' WHERE session_id = ?", (session_id,)
    )
    db.conn.commit()
    return {"cancelled": session_id, "agent": name}


@router.get("/{name}/export")
async def export_agent(name: str):
    """Export agent config as JSON for backup or sharing."""
    from agentos.agent import Agent
    try:
        agent = Agent.from_name(name)
        return {"agent": agent.config.to_dict()}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")
