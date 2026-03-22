"""Agents router — CRUD, run, stream, versions."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from starlette.responses import StreamingResponse

from agentos.api.deps import CurrentUser, get_current_user, get_optional_user
from agentos.api.schemas import (
    AgentCreateRequest, AgentResponse, AgentRunRequest, RunResponse,
)

router = APIRouter(prefix="/agents", tags=["agents"])


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
async def create_agent(request: AgentCreateRequest, user: CurrentUser = Depends(get_current_user)):
    """Create a new agent."""
    from agentos.agent import AgentConfig, save_agent_config

    config = AgentConfig(
        name=request.name,
        description=request.description,
        system_prompt=request.system_prompt,
        model=request.model or "claude-sonnet-4-20250514",
        tools=request.tools,
        max_turns=request.max_turns,
        tags=request.tags,
    )
    config.governance["budget_limit_usd"] = request.budget_limit_usd
    save_agent_config(config)

    return AgentResponse(
        name=config.name, description=config.description, model=config.model,
        tools=config.tools, tags=config.tags, version=config.version,
    )


@router.put("/{name}", response_model=AgentResponse)
async def update_agent(name: str, request: AgentCreateRequest, user: CurrentUser = Depends(get_current_user)):
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
    save_agent_config(config)

    return AgentResponse(
        name=config.name, description=config.description, model=config.model,
        tools=config.tools, tags=config.tags, version=config.version,
    )


@router.delete("/{name}")
async def delete_agent(name: str, user: CurrentUser = Depends(get_current_user)):
    """Delete an agent."""
    from pathlib import Path
    from agentos.agent import _resolve_agents_dir

    agents_dir = _resolve_agents_dir()
    for ext in (".json", ".yaml", ".yml"):
        p = agents_dir / f"{name}{ext}"
        if p.exists():
            p.unlink()
            return {"deleted": name}
    raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")


@router.post("/{name}/run", response_model=RunResponse)
async def run_agent(name: str, request: AgentRunRequest):
    """Run an agent on a task."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    start = time.monotonic()
    results = await agent.run(request.task)
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
async def run_agent_stream(name: str, request: AgentRunRequest):
    """Run an agent with SSE streaming."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    turn_queue: asyncio.Queue = asyncio.Queue()

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

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/{name}/versions")
async def list_versions(name: str):
    """List all versions of an agent from the evolution ledger."""
    from pathlib import Path

    ledger_path = Path.cwd() / "data" / "evolution" / name / "ledger.json"
    if not ledger_path.exists():
        return {"versions": [], "current": "0.1.0"}

    try:
        ledger = json.loads(ledger_path.read_text())
        return {
            "versions": ledger.get("entries", []),
            "current": ledger.get("current_version", "0.1.0"),
        }
    except Exception:
        return {"versions": [], "current": "0.1.0"}


@router.post("/create-from-description")
async def create_from_description(
    description: str,
    name: str = "",
    tools: str = "auto",
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

    path = save_agent_config(config)

    return AgentResponse(
        name=config.name, description=config.description, model=config.model,
        tools=config.tools, tags=config.tags, version=config.version,
    )


@router.post("/{name}/chat")
async def chat_turn(name: str, message: str, session_id: str = ""):
    """Send a single turn in a multi-turn conversation."""
    from agentos.agent import Agent

    try:
        agent = Agent.from_name(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")

    results = await agent.run(message)
    output = ""
    for r in results:
        if r.llm_response and r.llm_response.content:
            output = r.llm_response.content

    return {
        "response": output,
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
