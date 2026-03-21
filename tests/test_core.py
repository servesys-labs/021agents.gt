"""Tests for the core harness, governance, and event bus."""

import asyncio

import pytest

from agentos.core.events import Event, EventBus, EventType
from agentos.core.governance import GovernanceLayer, GovernancePolicy
from agentos.core.harness import AgentHarness, HarnessConfig


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


class TestAgentHarness:
    @pytest.mark.asyncio
    async def test_simple_run(self):
        harness = AgentHarness(config=HarnessConfig(max_turns=3))
        results = await harness.run("Hello, what is 2+2?")
        assert len(results) >= 1
        assert results[-1].done is True

    @pytest.mark.asyncio
    async def test_from_config_file(self):
        harness = AgentHarness.from_config_file()
        assert harness.config.max_turns == 50

    @pytest.mark.asyncio
    async def test_init_sequence_emits_task_received(self):
        """Verify the initialization sequence emits TASK_RECEIVED with complexity."""
        bus = EventBus()
        received: list[Event] = []

        async def listener(event: Event):
            received.append(event)

        bus.on(EventType.TASK_RECEIVED, listener)
        harness = AgentHarness(config=HarnessConfig(max_turns=1), event_bus=bus)
        await harness.run("Implement a new feature")
        assert len(received) == 1
        assert "complexity" in received[0].data

    @pytest.mark.asyncio
    async def test_stores_episodic_memory(self):
        harness = AgentHarness(config=HarnessConfig(max_turns=1))
        await harness.run("Hello there")
        assert harness.memory_manager.episodic.count() == 1
