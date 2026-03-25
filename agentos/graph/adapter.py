"""Adapter to run existing harness behavior through graph runtime nodes."""

from __future__ import annotations

import asyncio
import uuid

from agentos.core.events import Event, EventType
from agentos.core.harness import AgentHarness, TurnResult
from agentos.graph.context import GraphContext
from agentos.graph.nodes import (
    GovernanceNode,
    GraphTurnState,
    HarnessSetupNode,
    LLMNode,
    RecordNode,
    ToolExecNode,
    TurnResultNode,
)
from agentos.graph.runtime import GraphRuntime
from agentos.middleware.base import MiddlewareContext


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
            session_state={"results": [], "middleware_ctx": mw_ctx},
        )
        runtime = GraphRuntime(nodes=[
            HarnessSetupNode(harness, state),
            GovernanceNode(harness),
            LLMNode(harness),
            ToolExecNode(harness),
            TurnResultNode(harness, state),
            RecordNode(harness),
        ])
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
