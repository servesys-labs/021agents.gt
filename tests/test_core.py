"""Tests for the core event bus and governance layer."""

import asyncio

import pytest

from agentos.core.events import Event, EventBus, EventType
from agentos.core.governance import GovernanceLayer, GovernancePolicy


class TestEventBus:
    @pytest.mark.asyncio
    async def test_emit_and_listen(self):
        bus = EventBus()
        received: list[Event] = []

        async def listener(event: Event):
            received.append(event)

        bus.on(EventType.TASK_RECEIVED, listener)
        await bus.emit(Event(type=EventType.TASK_RECEIVED, data={"msg": "hello"}))

        assert len(received) == 1
        assert received[0].data["msg"] == "hello"

    @pytest.mark.asyncio
    async def test_global_listener(self):
        bus = EventBus()
        received: list[Event] = []

        async def listener(event: Event):
            received.append(event)

        bus.on_all(listener)
        await bus.emit(Event(type=EventType.TURN_START))
        await bus.emit(Event(type=EventType.TURN_END))

        assert len(received) == 2


class TestGovernance:
    def test_budget_tracking(self):
        gov = GovernanceLayer(GovernancePolicy(budget_limit_usd=1.0))
        assert gov.check_budget(0.5) is True
        gov.record_cost(0.8)
        assert gov.check_budget(0.5) is False
        assert gov.remaining_budget == pytest.approx(0.2)

    def test_tool_blocking(self):
        gov = GovernanceLayer(GovernancePolicy(blocked_tools=["rm_rf"]))
        assert gov.is_tool_allowed("search") is True
        assert gov.is_tool_allowed("rm_rf") is False

    def test_destructive_action_confirmation(self):
        gov = GovernanceLayer(GovernancePolicy(require_confirmation_for_destructive=True))
        assert gov.requires_confirmation({"action": "delete file"}) is True
        assert gov.requires_confirmation({"action": "read file"}) is False
