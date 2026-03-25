"""Adapter to run existing harness behavior through graph runtime nodes."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from agentos.core.events import Event, EventType
from agentos.core.harness import AgentHarness, TurnResult
from agentos.graph.context import GraphContext
from agentos.graph.nodes import (
    ApprovalNode,
    CheckpointNode,
    GovernanceNode,
    GraphTurnState,
    HarnessSetupNode,
    LLMNode,
    RecordNode,
    ToolExecNode,
    TurnResultNode,
)
from agentos.graph.runtime import GraphRuntime
from agentos.llm.provider import LLMResponse
from agentos.middleware.base import MiddlewareContext


def _serialize_llm_response(resp: LLMResponse | None) -> dict[str, Any]:
    if resp is None:
        return {}
    return {
        "content": resp.content,
        "model": resp.model,
        "tool_calls": list(resp.tool_calls),
        "usage": dict(resp.usage),
        "cost_usd": float(resp.cost_usd),
        "latency_ms": float(resp.latency_ms),
    }


def _deserialize_llm_response(data: dict[str, Any]) -> LLMResponse | None:
    if not isinstance(data, dict) or not data:
        return None
    return LLMResponse(
        content=str(data.get("content", "")),
        model=str(data.get("model", "")),
        tool_calls=list(data.get("tool_calls", [])),
        usage=dict(data.get("usage", {})),
        cost_usd=float(data.get("cost_usd", 0.0) or 0.0),
        latency_ms=float(data.get("latency_ms", 0.0) or 0.0),
    )


async def run_with_graph_runtime(harness: AgentHarness, user_input: str) -> list[TurnResult]:
    """Execute one request using graph nodes wrapped around current harness primitives.

    This is an incremental migration adapter: graph orchestration, harness internals.
    """
    async def _run_inner() -> list[TurnResult]:
        state = GraphTurnState(user_input=user_input)
        # Mirror harness trace/session context for tool propagation and observability.
        harness.trace_id = uuid.uuid4().hex[:16]
        harness._current_session_id = uuid.uuid4().hex[:16]
        mw_ctx = MiddlewareContext(
            session_id=harness._current_session_id,
            trace_id=harness.trace_id,
            event_bus=harness.event_bus,
        )
        ctx = GraphContext(
            messages=[{"role": "user", "content": user_input}],
            session_state={
                "results": [],
                "middleware_ctx": mw_ctx,
                "event_bus": harness.event_bus,
                "trace_id": harness.trace_id,
                "session_id": harness._current_session_id,
                "node_spans": [],
                "checkpoint_snapshots": [],
            },
        )
        setattr(harness, "_graph_node_spans", [])
        setattr(harness, "_pending_graph_resume_payload", None)
        runtime_nodes = [
            HarnessSetupNode(harness, state),
            GovernanceNode(harness),
        ]
        if getattr(harness.config, "enable_checkpoints", False):
            runtime_nodes.append(CheckpointNode("checkpoint_pre_llm"))
        runtime_nodes.append(LLMNode(harness))
        runtime_nodes.append(ApprovalNode(harness, state))
        runtime_nodes.append(ToolExecNode(harness))
        if getattr(harness.config, "enable_checkpoints", False):
            runtime_nodes.append(CheckpointNode("checkpoint_post_tools"))
        runtime_nodes.extend([
            TurnResultNode(harness, state),
            RecordNode(harness),
        ])
        runtime = GraphRuntime(nodes=runtime_nodes)
        if harness._async_memory_updater and not harness._async_memory_started:
            harness._async_memory_updater.start()
            harness._async_memory_started = True
        await harness.middleware_chain.run_on_session_start(mw_ctx)
        await harness.event_bus.emit(Event(type=EventType.SESSION_START, data={
            "input": user_input,
            "session_id": harness._current_session_id,
            "trace_id": harness.trace_id,
            "parent_session_id": harness.parent_session_id,
            "depth": harness.depth,
            "middleware_chain": harness.middleware_chain.middleware_names,
        }))
        complexity = harness.llm_router.classify([{"role": "user", "content": user_input}])
        await harness.event_bus.emit(Event(
            type=EventType.TASK_RECEIVED,
            data={"input": user_input, "complexity": complexity.value},
        ))
        try:
            for turn in range(1, harness.config.max_turns + 1):
                harness._turn = turn
                mw_ctx.turn_number = turn
                mw_ctx.messages = ctx.messages
                mw_ctx.injected_messages = []
                await harness.event_bus.emit(Event(type=EventType.TURN_START, data={"turn": turn}))
                ctx.session_state["current_turn"] = turn
                ctx.session_state["previous_results_count"] = len(ctx.session_state["results"])
                ctx = await runtime.run(ctx)
                turn_spans = [
                    s
                    for s in ctx.session_state.get("node_spans", [])
                    if isinstance(s, dict)
                    and isinstance(s.get("attributes"), dict)
                    and int(s["attributes"].get("turn", 0)) == turn
                ]
                if turn_spans:
                    harness._graph_node_spans.extend(turn_spans)
                if bool(ctx.session_state.get("approval_pending")) and not bool(ctx.session_state.get("approval_granted")):
                    harness._pending_graph_resume_payload = {
                        "checkpoint_id": uuid.uuid4().hex[:16],
                        "messages": list(ctx.messages),
                        "llm_response": _serialize_llm_response(ctx.session_state.get("llm_response")),
                        "current_turn": turn,
                        "cumulative_cost_usd": float(state.cumulative_cost),
                        "trace_id": str(ctx.session_state.get("trace_id", "")),
                        "session_id": str(ctx.session_state.get("session_id", "")),
                    }
                if state.done:
                    break
            return ctx.session_state["results"]
        finally:
            await harness.middleware_chain.run_on_session_end(mw_ctx)
            await harness.event_bus.emit(Event(type=EventType.SESSION_END))

    try:
        return await asyncio.wait_for(_run_inner(), timeout=harness.config.timeout_seconds)
    except asyncio.TimeoutError:
        # Keep timeout semantics aligned with harness API.
        return [TurnResult(
            turn_number=harness._turn or 1,
            error=f"Timed out after {harness.config.timeout_seconds:.0f}s",
            done=True,
            stop_reason="timeout",
        )]


async def resume_with_graph_runtime(harness: AgentHarness, checkpoint_payload: dict[str, Any]) -> list[TurnResult]:
    """Resume an approval-gated graph run from a persisted checkpoint payload."""

    async def _run_inner() -> list[TurnResult]:
        messages = checkpoint_payload.get("messages", [])
        if not isinstance(messages, list):
            messages = []
        llm_response = _deserialize_llm_response(
            checkpoint_payload.get("llm_response", {}),
        )
        if llm_response is None:
            return [TurnResult(
                turn_number=1,
                error="Invalid checkpoint payload: missing llm_response",
                done=True,
                stop_reason="resume_error",
            )]

        state = GraphTurnState(
            user_input=str(messages[0].get("content", "")) if messages else "",
            cumulative_cost=float(checkpoint_payload.get("cumulative_cost_usd", 0.0) or 0.0),
        )
        harness.trace_id = str(checkpoint_payload.get("trace_id", "")) or uuid.uuid4().hex[:16]
        harness._current_session_id = (
            str(checkpoint_payload.get("session_id", "")) or uuid.uuid4().hex[:16]
        )
        mw_ctx = MiddlewareContext(
            session_id=harness._current_session_id,
            trace_id=harness.trace_id,
            event_bus=harness.event_bus,
        )
        turn = int(checkpoint_payload.get("current_turn", 1) or 1)
        ctx = GraphContext(
            messages=messages,
            session_state={
                "results": [],
                "middleware_ctx": mw_ctx,
                "event_bus": harness.event_bus,
                "trace_id": harness.trace_id,
                "session_id": harness._current_session_id,
                "node_spans": [],
                "checkpoint_snapshots": [],
                "current_turn": turn,
                "llm_response": llm_response,
                "approval_granted": True,
            },
        )
        setattr(harness, "_graph_node_spans", [])
        resume_turn_nodes = [ToolExecNode(harness)]
        if getattr(harness.config, "enable_checkpoints", False):
            resume_turn_nodes.append(CheckpointNode("checkpoint_post_tools"))
        resume_turn_nodes.extend([
            TurnResultNode(harness, state),
            RecordNode(harness),
        ])
        resume_runtime = GraphRuntime(nodes=resume_turn_nodes)
        followup_nodes = [GovernanceNode(harness)]
        if getattr(harness.config, "enable_checkpoints", False):
            followup_nodes.append(CheckpointNode("checkpoint_pre_llm"))
        followup_nodes.extend([
            LLMNode(harness),
            ApprovalNode(harness, state),
            ToolExecNode(harness),
        ])
        if getattr(harness.config, "enable_checkpoints", False):
            followup_nodes.append(CheckpointNode("checkpoint_post_tools"))
        followup_nodes.extend([
            TurnResultNode(harness, state),
            RecordNode(harness),
        ])
        followup_runtime = GraphRuntime(nodes=followup_nodes)
        await harness.middleware_chain.run_on_session_start(mw_ctx)
        await harness.event_bus.emit(Event(type=EventType.SESSION_START, data={
            "input": state.user_input,
            "session_id": harness._current_session_id,
            "trace_id": harness.trace_id,
            "resume_from_checkpoint": str(checkpoint_payload.get("checkpoint_id", "")),
        }))
        await harness.event_bus.emit(Event(type=EventType.TURN_START, data={"turn": turn}))
        try:
            ctx = await resume_runtime.run(ctx)
            turn_spans = [
                s
                for s in ctx.session_state.get("node_spans", [])
                if isinstance(s, dict)
                and isinstance(s.get("attributes"), dict)
                and int(s["attributes"].get("turn", 0)) == turn
            ]
            if turn_spans:
                harness._graph_node_spans.extend(turn_spans)
            while not state.done and turn < harness.config.max_turns:
                turn += 1
                harness._turn = turn
                mw_ctx.turn_number = turn
                mw_ctx.messages = ctx.messages
                mw_ctx.injected_messages = []
                ctx.session_state["current_turn"] = turn
                ctx.session_state["previous_results_count"] = len(ctx.session_state["results"])
                await harness.event_bus.emit(Event(type=EventType.TURN_START, data={"turn": turn}))
                ctx = await followup_runtime.run(ctx)
                turn_spans = [
                    s
                    for s in ctx.session_state.get("node_spans", [])
                    if isinstance(s, dict)
                    and isinstance(s.get("attributes"), dict)
                    and int(s["attributes"].get("turn", 0)) == turn
                ]
                if turn_spans:
                    harness._graph_node_spans.extend(turn_spans)
            return ctx.session_state.get("results", [])
        finally:
            await harness.middleware_chain.run_on_session_end(mw_ctx)
            await harness.event_bus.emit(Event(type=EventType.SESSION_END))

    try:
        return await asyncio.wait_for(_run_inner(), timeout=harness.config.timeout_seconds)
    except asyncio.TimeoutError:
        return [TurnResult(
            turn_number=int(checkpoint_payload.get("current_turn", 1) or 1),
            error=f"Timed out after {harness.config.timeout_seconds:.0f}s",
            done=True,
            stop_reason="timeout",
        )]
