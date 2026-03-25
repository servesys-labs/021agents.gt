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


def _is_simple_chat(user_input: str, harness: AgentHarness) -> bool:
    """Detect simple single-turn chat that can skip heavy setup.

    Returns True when:
    - Short message (< 200 chars)
    - No tool-like keywords that would trigger tool execution
    - Agent has no required governance (checkpoints, approval)
    - No active middleware (middleware expects full lifecycle events)
    """
    if len(user_input) > 200:
        return False
    if getattr(harness.config, "enable_checkpoints", False):
        return False
    if getattr(harness.config, "require_human_approval", False):
        return False
    # Default middleware (loop detection, summarization) is safe to skip
    # for single-turn chat. Only block if custom middleware is present.
    _DEFAULT_MW = {"loop_detection", "summarization"}
    if hasattr(harness, "middleware_chain"):
        mw_names = set(harness.middleware_chain.middleware_names)
        if mw_names - _DEFAULT_MW:
            return False
    # Keywords that suggest tool use is needed
    import re
    tool_signals = r"\b(search|find|look up|browse|run|execute|bash|python|code|file|image|generate|create|deploy|build|analyze|crawl)\b"
    if re.search(tool_signals, user_input.lower()):
        return False
    return True


async def _run_fast_chat(harness: AgentHarness, user_input: str) -> list[TurnResult]:
    """Ultra-fast path for simple chat — skip setup/governance/record overhead.

    Only runs: system prompt → LLM call → return result.
    Billing and events fire in the background.
    """
    harness.trace_id = uuid.uuid4().hex[:16]
    harness._current_session_id = uuid.uuid4().hex[:16]
    harness._turn = 1

    # Minimal system prompt (skip memory, skills, procedures)
    messages: list[dict[str, Any]] = []
    if harness.system_prompt:
        messages.append({"role": "system", "content": harness.system_prompt})
    messages.append({"role": "user", "content": user_input})

    # Ensure router has tools set (needed for routing decision)
    available_tools = harness.tool_executor.available_tools()
    harness.llm_router.set_tools(available_tools)

    # Direct LLM call — no governance check, no middleware chain
    try:
        llm_response = await harness.llm_router.route(messages)
    except Exception:
        return [TurnResult(
            turn_number=1,
            error="LLM call failed",
            done=True,
            stop_reason="llm_error",
        )]

    if llm_response is None:
        return [TurnResult(
            turn_number=1,
            error="LLM returned no response",
            done=True,
            stop_reason="llm_error",
        )]

    # If the LLM wants to call tools, fall back to full runtime
    if llm_response.tool_calls:
        return None  # sentinel: caller should retry with full runtime

    result = TurnResult(
        turn_number=1,
        llm_response=llm_response,
        done=True,
        stop_reason="completed",
        cost_usd=llm_response.cost_usd,
        cumulative_cost_usd=llm_response.cost_usd,
        model_used=llm_response.model,
        execution_mode="fast_chat",
    )

    # Fire-and-forget: emit events + record cost in background
    async def _bg_record() -> None:
        try:
            harness.governance.record_cost(llm_response.cost_usd)
            await harness.event_bus.emit(Event(type=EventType.SESSION_START, data={
                "input": user_input,
                "session_id": harness._current_session_id,
                "trace_id": harness.trace_id,
                "fast_chat": True,
            }))
            await harness.event_bus.emit(Event(type=EventType.LLM_RESPONSE, data={
                "model": llm_response.model,
                "content": llm_response.content[:200] if llm_response.content else "",
                "cost_usd": llm_response.cost_usd,
                "input_tokens": llm_response.usage.get("input_tokens", 0),
                "output_tokens": llm_response.usage.get("output_tokens", 0),
            }))
            await harness.event_bus.emit(Event(type=EventType.SESSION_END))
            harness._notify_turn(result)
        except Exception:
            pass

    asyncio.create_task(_bg_record())
    return [result]


async def run_with_graph_runtime(harness: AgentHarness, user_input: str) -> list[TurnResult]:
    """Execute one request using graph nodes wrapped around current harness primitives.

    This is an incremental migration adapter: graph orchestration, harness internals.
    Simple chat messages use a fast path that skips heavy setup/governance/record nodes.
    """
    # Fast-chat path: skip the full graph for simple messages.
    # Only enabled when calling from runtime_proxy (production path).
    # Tests and direct callers use the full graph for lifecycle parity.
    if getattr(harness, "_enable_fast_chat", False) and _is_simple_chat(user_input, harness):
        fast_result = await _run_fast_chat(harness, user_input)
        if fast_result is not None:  # None means LLM requested tools, fall through
            return fast_result

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
