"""Tests for the middleware chain, loop detection, and summarization."""

from __future__ import annotations

import asyncio
import pytest
from unittest.mock import AsyncMock

from agentos.core.events import EventBus
from agentos.llm.provider import LLMResponse
from agentos.middleware.base import Middleware, MiddlewareChain, MiddlewareContext
from agentos.middleware.loop_detection import LoopDetectionMiddleware
from agentos.middleware.summarization import SummarizationMiddleware


# ── MiddlewareContext ──────────────────────────────────────────────────


def test_middleware_context_defaults():
    ctx = MiddlewareContext()
    assert ctx.turn_number == 0
    assert ctx.halt is False
    assert ctx.skip_llm_call is False
    assert ctx.force_text_response is False
    assert ctx.injected_messages == []


@pytest.mark.asyncio
async def test_middleware_context_emit_with_bus():
    from agentos.core.events import EventType
    bus = EventBus()
    received = []
    async def listener(event):
        received.append(event)
    bus.on(EventType.ERROR, listener)
    ctx = MiddlewareContext(event_bus=bus)
    await ctx.emit(EventType.ERROR, {"test": True})
    assert len(received) == 1
    assert received[0].data["test"] is True


@pytest.mark.asyncio
async def test_middleware_context_emit_without_bus():
    ctx = MiddlewareContext()
    await ctx.emit(None)  # Should not raise


# ── MiddlewareChain ────────────────────────────────────────────────────


class TrackingMiddleware(Middleware):
    name = "tracking"
    order = 50

    def __init__(self):
        self.before_calls = 0
        self.after_calls = 0
        self.session_start_calls = 0
        self.session_end_calls = 0
        self.turn_end_calls = 0

    async def before_model(self, ctx):
        self.before_calls += 1

    async def after_model(self, ctx):
        self.after_calls += 1

    async def on_session_start(self, ctx):
        self.session_start_calls += 1

    async def on_session_end(self, ctx):
        self.session_end_calls += 1

    async def on_turn_end(self, ctx):
        self.turn_end_calls += 1


class HaltingMiddleware(Middleware):
    name = "halter"
    order = 10

    async def before_model(self, ctx):
        ctx.halt = True
        ctx.halt_reason = "test halt"


@pytest.mark.asyncio
async def test_middleware_chain_order():
    mw1 = TrackingMiddleware()
    mw1.name = "first"
    mw1.order = 10

    mw2 = TrackingMiddleware()
    mw2.name = "second"
    mw2.order = 20

    chain = MiddlewareChain([mw2, mw1])
    assert chain.middleware_names == ["first", "second"]


@pytest.mark.asyncio
async def test_middleware_chain_before_after():
    mw = TrackingMiddleware()
    chain = MiddlewareChain([mw])
    ctx = MiddlewareContext()

    await chain.run_before_model(ctx)
    assert mw.before_calls == 1
    assert mw.after_calls == 0

    await chain.run_after_model(ctx)
    assert mw.after_calls == 1


@pytest.mark.asyncio
async def test_middleware_chain_halt_stops_processing():
    halter = HaltingMiddleware()
    tracker = TrackingMiddleware()
    tracker.order = 20
    chain = MiddlewareChain([halter, tracker])
    ctx = MiddlewareContext()

    await chain.run_before_model(ctx)
    assert ctx.halt is True
    assert ctx.halt_reason == "test halt"
    assert tracker.before_calls == 0  # Never reached


@pytest.mark.asyncio
async def test_middleware_chain_add_remove():
    chain = MiddlewareChain()
    mw = TrackingMiddleware()
    chain.add(mw)
    assert "tracking" in chain.middleware_names

    removed = chain.remove("tracking")
    assert removed is True
    assert "tracking" not in chain.middleware_names

    removed = chain.remove("nonexistent")
    assert removed is False


@pytest.mark.asyncio
async def test_middleware_chain_session_lifecycle():
    mw = TrackingMiddleware()
    chain = MiddlewareChain([mw])
    ctx = MiddlewareContext()

    await chain.run_on_session_start(ctx)
    assert mw.session_start_calls == 1

    await chain.run_on_turn_end(ctx)
    assert mw.turn_end_calls == 1

    await chain.run_on_session_end(ctx)
    assert mw.session_end_calls == 1


def test_middleware_chain_status():
    mw = LoopDetectionMiddleware()
    chain = MiddlewareChain([mw])
    status = chain.status()
    assert len(status) == 1
    assert status[0]["name"] == "loop_detection"
    assert "stats" in status[0]
    assert "total_warnings" in status[0]["stats"]


@pytest.mark.asyncio
async def test_middleware_chain_error_resilience():
    """Middleware errors should be caught, not crash the chain."""
    class BrokenMiddleware(Middleware):
        name = "broken"
        order = 10
        async def before_model(self, ctx):
            raise RuntimeError("boom")

    tracker = TrackingMiddleware()
    tracker.order = 20
    chain = MiddlewareChain([BrokenMiddleware(), tracker])
    ctx = MiddlewareContext()

    # Should not raise
    await chain.run_before_model(ctx)
    # Tracker should still be called (broken middleware's error is caught)
    assert tracker.before_calls == 1


# ── LoopDetectionMiddleware ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_loop_detection_no_tool_calls():
    mw = LoopDetectionMiddleware()
    ctx = MiddlewareContext(session_id="test-1")
    ctx.llm_response = LLMResponse(content="hello", model="test", tool_calls=[])
    await mw.after_model(ctx)
    assert ctx.force_text_response is False
    assert len(ctx.injected_messages) == 0


@pytest.mark.asyncio
async def test_loop_detection_no_repeat():
    mw = LoopDetectionMiddleware()
    ctx = MiddlewareContext(session_id="test-1")

    for i in range(3):
        ctx.llm_response = LLMResponse(
            content="", model="test",
            tool_calls=[{"name": f"tool_{i}", "arguments": {"x": i}}]
        )
        await mw.after_model(ctx)

    assert ctx.force_text_response is False
    assert len(ctx.injected_messages) == 0


@pytest.mark.asyncio
async def test_loop_detection_warning():
    mw = LoopDetectionMiddleware(warn_threshold=3, hard_limit=5)
    ctx = MiddlewareContext(session_id="test-warn")

    same_call = [{"name": "search", "arguments": {"q": "test"}}]

    for i in range(3):
        ctx.injected_messages = []
        ctx.llm_response = LLMResponse(content="", model="test", tool_calls=same_call)
        await mw.after_model(ctx)

    # Third call should trigger warning
    assert len(ctx.injected_messages) == 1
    assert "WARNING" in ctx.injected_messages[0]["content"]
    assert ctx.force_text_response is False
    assert mw.stats()["total_warnings"] == 1


@pytest.mark.asyncio
async def test_loop_detection_hard_stop():
    mw = LoopDetectionMiddleware(warn_threshold=2, hard_limit=4)
    ctx = MiddlewareContext(session_id="test-stop")

    same_call = [{"name": "search", "arguments": {"q": "test"}}]

    for i in range(4):
        ctx.injected_messages = []
        ctx.force_text_response = False
        ctx.llm_response = LLMResponse(content="", model="test", tool_calls=list(same_call))
        await mw.after_model(ctx)

    # Fourth call should trigger hard stop
    assert ctx.force_text_response is True
    assert ctx.llm_response.tool_calls == []
    assert "LOOP DETECTED" in ctx.injected_messages[0]["content"]
    assert mw.stats()["total_hard_stops"] == 1


@pytest.mark.asyncio
async def test_loop_detection_session_isolation():
    mw = LoopDetectionMiddleware(warn_threshold=3, hard_limit=5)
    same_call = [{"name": "search", "arguments": {"q": "test"}}]

    # Session A: 2 repeats
    ctx_a = MiddlewareContext(session_id="session-a")
    for i in range(2):
        ctx_a.llm_response = LLMResponse(content="", model="test", tool_calls=same_call)
        await mw.after_model(ctx_a)

    # Session B: 2 repeats — should not trigger (isolated from A)
    ctx_b = MiddlewareContext(session_id="session-b")
    for i in range(2):
        ctx_b.injected_messages = []
        ctx_b.llm_response = LLMResponse(content="", model="test", tool_calls=same_call)
        await mw.after_model(ctx_b)

    assert len(ctx_b.injected_messages) == 0


@pytest.mark.asyncio
async def test_loop_detection_session_reset():
    mw = LoopDetectionMiddleware(warn_threshold=3, hard_limit=5)
    ctx = MiddlewareContext(session_id="test-reset")

    same_call = [{"name": "search", "arguments": {"q": "test"}}]
    for i in range(2):
        ctx.llm_response = LLMResponse(content="", model="test", tool_calls=same_call)
        await mw.after_model(ctx)

    # Reset session
    await mw.on_session_start(ctx)

    # After reset, counter should be back to 0
    ctx.injected_messages = []
    ctx.llm_response = LLMResponse(content="", model="test", tool_calls=same_call)
    await mw.after_model(ctx)
    assert len(ctx.injected_messages) == 0


# ── SummarizationMiddleware ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_summarization_below_threshold():
    mw = SummarizationMiddleware(max_context_tokens=100_000)
    ctx = MiddlewareContext()
    ctx.messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
        {"role": "assistant", "content": "Hi there!"},
    ]
    original_count = len(ctx.messages)
    await mw.before_model(ctx)
    assert len(ctx.messages) == original_count


@pytest.mark.asyncio
async def test_summarization_above_threshold():
    mw = SummarizationMiddleware(
        max_context_tokens=100,
        summarize_threshold_ratio=0.5,
        keep_recent_turns=2,
    )
    ctx = MiddlewareContext()

    # Build a long conversation
    ctx.messages = [{"role": "system", "content": "System prompt."}]
    for i in range(20):
        ctx.messages.append({"role": "user", "content": f"User message {i} " * 50})
        ctx.messages.append({"role": "assistant", "content": f"Assistant response {i} " * 50})

    original_count = len(ctx.messages)
    await mw.before_model(ctx)

    # Messages should be reduced
    assert len(ctx.messages) < original_count

    # System prompt should be preserved
    assert ctx.messages[0]["role"] == "system"
    assert "System prompt" in ctx.messages[0]["content"]

    # There should be a summary message
    summary_msgs = [m for m in ctx.messages if "Context Summary" in m.get("content", "")]
    assert len(summary_msgs) == 1

    # Stats should be updated
    stats = mw.stats()
    assert stats["total_summarizations"] == 1
    assert stats["total_tokens_saved"] > 0


@pytest.mark.asyncio
async def test_summarization_preserves_recent():
    mw = SummarizationMiddleware(
        max_context_tokens=100,
        summarize_threshold_ratio=0.5,
        keep_recent_turns=2,
    )
    ctx = MiddlewareContext()

    ctx.messages = [{"role": "system", "content": "System prompt."}]
    for i in range(10):
        ctx.messages.append({"role": "user", "content": f"User msg {i} " * 50})
        ctx.messages.append({"role": "assistant", "content": f"Reply {i} " * 50})

    await mw.before_model(ctx)

    # Most recent messages should still be there
    non_system_msgs = [m for m in ctx.messages if m.get("role") != "system"]
    # Should have the last keep_recent_turns * 2 messages
    assert len(non_system_msgs) == 4  # 2 turns * 2 (user + assistant)
