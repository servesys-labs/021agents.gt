"""A2A Server — JSON-RPC endpoints for the Agent-to-Agent protocol.

Mounts onto the existing FastAPI app to expose agents as A2A-compatible
servers that can be discovered and invoked by any A2A client.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger(__name__)

# Task storage (in-memory — for production, use the SQLite DB)
_tasks: dict[str, dict[str, Any]] = {}


def _jsonrpc_response(id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id, "result": result}


def _jsonrpc_error(id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}


def _make_task(task_id: str, status: str = "WORKING", messages: list | None = None,
               artifacts: list | None = None) -> dict[str, Any]:
    return {
        "id": task_id,
        "status": {"state": status, "timestamp": _iso_now()},
        "messages": messages or [],
        "artifacts": artifacts or [],
        "createdAt": _iso_now(),
    }


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def mount_a2a_routes(app: FastAPI, agent_loader: Any = None) -> None:
    """Mount A2A protocol endpoints onto a FastAPI app.

    Args:
        app: The FastAPI application
        agent_loader: Callable that returns (agent_name, Agent) for a given request.
                      If None, uses the default agent.
    """

    @app.get("/.well-known/agent.json")
    async def agent_card(request: Request):
        """Serve the A2A Agent Card for discovery."""
        from agentos.agent import list_agents
        from agentos.a2a.card import build_agent_card

        base_url = str(request.base_url).rstrip("/")
        agents = list_agents()

        if not agents:
            return JSONResponse({"error": "No agents available"}, status_code=404)

        # Return the first agent's card (or a combined card)
        card = build_agent_card(agents[0], base_url=base_url)
        return JSONResponse(card.to_dict())

    @app.get("/.well-known/agents.json")
    async def all_agent_cards(request: Request):
        """List all available agent cards."""
        from agentos.agent import list_agents
        from agentos.a2a.card import build_agent_card

        base_url = str(request.base_url).rstrip("/")
        agents = list_agents()
        cards = [build_agent_card(a, base_url=base_url).to_dict() for a in agents]
        return JSONResponse(cards)

    @app.post("/a2a")
    async def a2a_jsonrpc(request: Request):
        """Handle A2A JSON-RPC requests."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(_jsonrpc_error(None, -32700, "Parse error"), status_code=400)

        method = body.get("method", "")
        params = body.get("params", {})
        req_id = body.get("id")

        if method == "SendMessage":
            return await _handle_send_message(req_id, params, request)
        elif method == "GetTask":
            return _handle_get_task(req_id, params)
        elif method == "CancelTask":
            return _handle_cancel_task(req_id, params)
        elif method == "ListTasks":
            return _handle_list_tasks(req_id, params)
        elif method == "SendStreamingMessage":
            return await _handle_send_streaming(req_id, params, request)
        else:
            return JSONResponse(_jsonrpc_error(req_id, -32601, f"Method not found: {method}"))

    async def _handle_send_message(req_id: Any, params: dict, request: Request) -> JSONResponse:
        """Handle SendMessage — run an agent on the message content."""
        from agentos.agent import Agent

        message = params.get("message", {})
        parts = message.get("parts", [])
        text = ""
        for part in parts:
            if "text" in part:
                text += part["text"]

        if not text:
            return JSONResponse(_jsonrpc_error(req_id, -32602, "No text content in message"))

        # Determine which agent to use
        agent_name = params.get("agentName", "")
        task_id = params.get("taskId") or uuid.uuid4().hex[:16]

        # Create task record
        task = _make_task(task_id, "WORKING", messages=[message])
        _tasks[task_id] = task

        try:
            if agent_name:
                agent = Agent.from_name(agent_name)
            else:
                from agentos.agent import list_agents
                agents = list_agents()
                if not agents:
                    return JSONResponse(_jsonrpc_error(req_id, -32000, "No agents available"))
                agent = Agent.from_name(agents[0].name)

            results = await agent.run(text)

            # Extract output
            output = ""
            for r in results:
                if r.llm_response and r.llm_response.content:
                    output = r.llm_response.content

            # Build response message
            response_message = {
                "id": uuid.uuid4().hex[:16],
                "role": "agent",
                "parts": [{"text": output}],
                "timestamp": _iso_now(),
            }

            # Update task
            task["status"] = {"state": "COMPLETED", "timestamp": _iso_now()}
            task["messages"].append(response_message)
            task["artifacts"] = [{
                "id": uuid.uuid4().hex[:16],
                "name": "response",
                "parts": [{"text": output}],
            }]

            return JSONResponse(_jsonrpc_response(req_id, {"task": task}))

        except FileNotFoundError:
            task["status"] = {"state": "FAILED", "timestamp": _iso_now()}
            return JSONResponse(_jsonrpc_error(req_id, -32000, f"Agent '{agent_name}' not found"))
        except Exception as exc:
            task["status"] = {"state": "FAILED", "timestamp": _iso_now()}
            return JSONResponse(_jsonrpc_error(req_id, -32000, str(exc)))

    async def _handle_send_streaming(req_id: Any, params: dict, request: Request):
        """Handle SendStreamingMessage — stream turn results via SSE."""
        from agentos.agent import Agent

        message = params.get("message", {})
        parts = message.get("parts", [])
        text = "".join(p.get("text", "") for p in parts)

        if not text:
            return JSONResponse(_jsonrpc_error(req_id, -32602, "No text content"))

        agent_name = params.get("agentName", "")
        task_id = params.get("taskId") or uuid.uuid4().hex[:16]

        task = _make_task(task_id, "WORKING", messages=[message])
        _tasks[task_id] = task

        try:
            if agent_name:
                agent = Agent.from_name(agent_name)
            else:
                from agentos.agent import list_agents
                agents = list_agents()
                if not agents:
                    return JSONResponse(_jsonrpc_error(req_id, -32602, "No agents"))
                agent = Agent.from_name(agents[0].name)
        except FileNotFoundError:
            return JSONResponse(_jsonrpc_error(req_id, -32000, f"Agent not found"))

        turn_queue: asyncio.Queue = asyncio.Queue()

        def on_turn(result):
            content = result.llm_response.content if result.llm_response else ""
            turn_queue.put_nowait({
                "message": {
                    "id": uuid.uuid4().hex[:16],
                    "role": "agent",
                    "parts": [{"text": content}],
                    "timestamp": _iso_now(),
                }
            })

        agent._harness.on_turn_complete = on_turn

        async def event_stream():
            run_task = asyncio.create_task(agent.run(text))
            while not run_task.done():
                try:
                    data = await asyncio.wait_for(turn_queue.get(), timeout=0.5)
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    continue
            while not turn_queue.empty():
                data = turn_queue.get_nowait()
                yield f"data: {json.dumps(data)}\n\n"
            # Final status update
            task["status"]["state"] = "COMPLETED"
            yield f"data: {json.dumps({'statusUpdate': {'taskId': task_id, 'status': task['status']}})}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    def _handle_get_task(req_id: Any, params: dict) -> JSONResponse:
        task_id = params.get("id", "")
        task = _tasks.get(task_id)
        if not task:
            return JSONResponse(_jsonrpc_error(req_id, -32000, f"Task '{task_id}' not found"))
        return JSONResponse(_jsonrpc_response(req_id, {"task": task}))

    def _handle_cancel_task(req_id: Any, params: dict) -> JSONResponse:
        task_id = params.get("id", "")
        task = _tasks.get(task_id)
        if not task:
            return JSONResponse(_jsonrpc_error(req_id, -32000, f"Task '{task_id}' not found"))
        task["status"] = {"state": "CANCELED", "timestamp": _iso_now()}
        return JSONResponse(_jsonrpc_response(req_id, {"task": task}))

    def _handle_list_tasks(req_id: Any, params: dict) -> JSONResponse:
        tasks = list(_tasks.values())
        return JSONResponse(_jsonrpc_response(req_id, {"tasks": tasks}))
