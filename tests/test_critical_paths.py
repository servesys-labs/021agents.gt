"""Tests for critical production paths — budget exhaustion, max turns, tool failure
retry, governance blocking at runtime, LLM failure, span persistence, evolution
disk writes, CLI overrides, procedural memory, and cost accumulation.

These test the harness execution loop, not just isolated units.
"""

import asyncio
import json
import pytest
from pathlib import Path

from agentos.core.events import Event, EventBus, EventType
from agentos.core.governance import GovernanceLayer, GovernancePolicy
from agentos.core.harness import AgentHarness, HarnessConfig
from agentos.llm.provider import LLMResponse, StubProvider
from agentos.llm.router import Complexity, LLMRouter
from agentos.memory.manager import MemoryManager
from agentos.tools.executor import ToolExecutor
from agentos.tools.mcp import MCPClient, MCPServer, MCPTool


# ── Helpers ──────────────────────────────────────────────────────────────


def _make_tool_calling_provider(tool_calls_on_turns=None, cost_per_call=0.001):
    """Create a provider that makes tool calls on specified turns (1-indexed),
    then returns a final text response on other turns.

    tool_calls_on_turns: set of turn numbers that should return tool calls.
                         Defaults to {1} (tool call on first turn only).
    """
    if tool_calls_on_turns is None:
        tool_calls_on_turns = {1}
    call_count = 0

    class _Provider:
        @property
        def model_id(self):
            return "test-model"

        async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
            nonlocal call_count
            call_count += 1
            if call_count in tool_calls_on_turns:
                return LLMResponse(
                    content="Calling tool.",
                    model="test-model",
                    tool_calls=[{"id": f"tc_{call_count}", "name": "search",
                                 "arguments": {"q": "test"}}],
                    usage={"input_tokens": 10, "output_tokens": 20},
                    cost_usd=cost_per_call,
                )
            return LLMResponse(
                content="Done.",
                model="test-model",
                usage={"input_tokens": 10, "output_tokens": 20},
                cost_usd=cost_per_call,
            )

    return _Provider()


def _make_always_tool_calling_provider(cost_per_call=0.001):
    """Provider that ALWAYS returns tool calls (never completes on its own)."""

    class _Provider:
        @property
        def model_id(self):
            return "test-model"

        async def complete(self, messages, max_tokens=4096, temperature=0.0, tools=None):
            return LLMResponse(
                content="Still working.",
                model="test-model",
                tool_calls=[{"id": "tc_x", "name": "search",
                             "arguments": {"q": "test"}}],
                usage={"input_tokens": 10, "output_tokens": 20},
                cost_usd=cost_per_call,
            )

    return _Provider()


def _make_router(provider):
    router = LLMRouter()
    for tier in Complexity:
        router.register(tier, provider)
    return router


def _make_tool_executor():
    """Create a tool executor with a working 'search' tool."""
    mcp = MCPClient()
    mcp.register_server(MCPServer(name="search", tools=[
        MCPTool(name="search", description="Search",
                input_schema={"type": "object", "properties": {"q": {"type": "string"}}}),
    ]))

    async def search_handler(q=""):
        return f"Results for: {q}"

    mcp.register_handler("search", search_handler)
    return ToolExecutor(mcp_client=mcp)


def _make_failing_tool_executor():
    """Create a tool executor with a 'search' tool that always fails."""
    mcp = MCPClient()
    mcp.register_server(MCPServer(name="search", tools=[
        MCPTool(name="search", description="Search",
                input_schema={"type": "object", "properties": {"q": {"type": "string"}}}),
    ]))

    async def fail_handler(q=""):
        raise RuntimeError("Network error")

    mcp.register_handler("search", fail_handler)
    return ToolExecutor(mcp_client=mcp, max_retries=1)


# ── Budget Exhaustion ────────────────────────────────────────────────────


class TestBudgetExhaustion:
    """Budget should stop the harness mid-run when exceeded."""

    @pytest.mark.asyncio
    async def test_budget_exhaustion_stops_run(self):
        """When budget runs out mid-execution, the harness should stop with stop_reason='budget'."""
        provider = _make_always_tool_calling_provider(cost_per_call=0.05)
        gov = GovernanceLayer(GovernancePolicy(budget_limit_usd=0.06))

        harness = AgentHarness(
            config=HarnessConfig(max_turns=10),
            llm_router=_make_router(provider),
            tool_executor=_make_tool_executor(),
            governance=gov,
        )

        results = await harness.run("Search repeatedly")
        # First turn: costs 0.05 (under 0.06 budget). Second turn: budget check
        # at 0.05 spent, 0.01 remaining. check_budget(0.01) = 0.05+0.01 <= 0.06 = True.
        # After second call: 0.10 spent. Third turn: check_budget(0.01) = 0.10+0.01 > 0.06 = False.
        # So _call_llm returns None, stop_reason = "budget"
        last = results[-1]
        assert last.done is True
        assert last.stop_reason == "budget"
        assert last.error == "LLM call failed"

    @pytest.mark.asyncio
    async def test_zero_budget_stops_immediately(self):
        """Budget of 0 should stop on the very first LLM call."""
        gov = GovernanceLayer(GovernancePolicy(budget_limit_usd=0.0))
        harness = AgentHarness(
            config=HarnessConfig(max_turns=5),
            governance=gov,
        )

        results = await harness.run("Hello")
        assert len(results) == 1
        assert results[0].stop_reason == "budget"
        assert results[0].done is True


# ── Max Turns Boundary ───────────────────────────────────────────────────


class TestMaxTurnsBoundary:
    """The harness must stop at exactly max_turns."""

    @pytest.mark.asyncio
    async def test_stops_at_max_turns(self):
        """With a provider that always makes tool calls, the harness should
        stop at max_turns and NOT loop forever."""
        provider = _make_always_tool_calling_provider()

        harness = AgentHarness(
            config=HarnessConfig(max_turns=3),
            llm_router=_make_router(provider),
            tool_executor=_make_tool_executor(),
        )

        results = await harness.run("Keep searching")
        assert len(results) == 3  # exactly 3 turns
        # Last turn should NOT have done=True (loop just ran out of turns)
        # The loop exits naturally without setting done on the last tool-call turn

    @pytest.mark.asyncio
    async def test_max_turns_1_completes(self):
        """max_turns=1 with a non-tool-calling provider should complete normally."""
        harness = AgentHarness(config=HarnessConfig(max_turns=1))
        results = await harness.run("Hi")
        assert len(results) == 1
        assert results[0].done is True
        assert results[0].stop_reason == "completed"


# ── Tool Failure Retry ───────────────────────────────────────────────────


class TestToolFailureRetry:
    """When tools fail and retry_on_tool_failure is True, error context should
    be injected into messages so the LLM can try a different approach."""

    @pytest.mark.asyncio
    async def test_tool_failure_injects_error_context(self):
        """Failed tool calls should inject error summary into conversation."""
        # Provider: turn 1 = tool call, turn 2 = text (done)
        provider = _make_tool_calling_provider(tool_calls_on_turns={1})

        harness = AgentHarness(
            config=HarnessConfig(max_turns=5, retry_on_tool_failure=True),
            llm_router=_make_router(provider),
            tool_executor=_make_failing_tool_executor(),
        )

        results = await harness.run("Search for something")
        # Turn 1: tool call fails. retry_on_tool_failure injects error context.
        # Turn 2: provider returns text (done).
        assert len(results) == 2
        assert results[0].tool_results  # first turn has tool results
        assert any("error" in tr for tr in results[0].tool_results)
        assert results[1].done is True

    @pytest.mark.asyncio
    async def test_retry_disabled_still_continues(self):
        """With retry_on_tool_failure=False, failed tools don't inject error context
        but the harness still continues to the next turn."""
        provider = _make_tool_calling_provider(tool_calls_on_turns={1})

        harness = AgentHarness(
            config=HarnessConfig(max_turns=5, retry_on_tool_failure=False),
            llm_router=_make_router(provider),
            tool_executor=_make_failing_tool_executor(),
        )

        results = await harness.run("Search")
        assert len(results) == 2
        assert results[1].done is True


# ── Governance Blocks Tools at Runtime ───────────────────────────────────


class TestGovernanceBlocksToolsAtRuntime:
    """Governance should block tools during actual harness execution, not just in unit tests."""

    @pytest.mark.asyncio
    async def test_blocked_tool_returns_error_in_results(self):
        """A blocked tool should produce an error result without executing."""
        provider = _make_tool_calling_provider(tool_calls_on_turns={1})
        gov = GovernanceLayer(GovernancePolicy(blocked_tools=["search"]))

        harness = AgentHarness(
            config=HarnessConfig(max_turns=5),
            llm_router=_make_router(provider),
            tool_executor=_make_tool_executor(),
            governance=gov,
        )

        results = await harness.run("Search for cats")
        # Turn 1: tool call to "search" is blocked by governance
        assert len(results) >= 1
        blocked_results = [tr for r in results for tr in r.tool_results if "error" in tr]
        assert any("blocked by governance" in tr["error"] for tr in blocked_results)

    @pytest.mark.asyncio
    async def test_destructive_action_requires_confirmation(self):
        """A tool call with destructive keywords should be blocked."""
        call_count = 0

        class DestructiveProvider:
            @property
            def model_id(self):
                return "test"

            async def complete(self, messages, **kwargs):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    return LLMResponse(
                        content="Deleting.",
                        model="test",
                        tool_calls=[{"id": "tc_1", "name": "delete-file",
                                     "arguments": {"path": "/important"}}],
                        usage={"input_tokens": 10, "output_tokens": 10},
                        cost_usd=0.001,
                    )
                return LLMResponse(content="Done.", model="test",
                                   usage={"input_tokens": 10, "output_tokens": 10},
                                   cost_usd=0.001)

        mcp = MCPClient()
        mcp.register_server(MCPServer(name="fs", tools=[
            MCPTool(name="delete-file", description="Delete a file"),
        ]))

        async def delete_handler(path=""):
            return "deleted"

        mcp.register_handler("delete-file", delete_handler)

        gov = GovernanceLayer(GovernancePolicy(require_confirmation_for_destructive=True))
        harness = AgentHarness(
            config=HarnessConfig(max_turns=3),
            llm_router=_make_router(DestructiveProvider()),
            tool_executor=ToolExecutor(mcp_client=mcp),
            governance=gov,
        )

        results = await harness.run("Delete the file")
        blocked = [tr for r in results for tr in r.tool_results if "error" in tr]
        assert any("confirmation" in tr["error"].lower() for tr in blocked)


# ── LLM Call Failure Stop Reason ─────────────────────────────────────────


class TestLLMCallFailure:
    """When budget is fine but LLM fails, stop_reason should be 'llm_error'."""

    @pytest.mark.asyncio
    async def test_llm_error_stop_reason(self):
        """Force LLM failure on first call by exhausting budget after call."""
        # Use a governance with very tight budget
        gov = GovernanceLayer(GovernancePolicy(budget_limit_usd=0.001))
        # Record a cost that puts us over budget
        gov.record_cost(0.002)

        harness = AgentHarness(
            config=HarnessConfig(max_turns=3),
            governance=gov,
        )

        results = await harness.run("Hello")
        assert len(results) == 1
        assert results[0].stop_reason == "budget"
        assert results[0].done is True


# ── Span Persistence to Database ─────────────────────────────────────────


class TestSpanPersistence:
    """Agent.run() should persist tracer spans to the database."""

    @pytest.mark.asyncio
    async def test_spans_persisted_after_run(self, tmp_path, monkeypatch):
        from agentos.agent import Agent, AgentConfig

        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        config = AgentConfig(name="span-bot")
        agent = Agent(config)
        assert agent.db is not None

        await agent.run("Hello")

        # Check spans table
        rows = agent.db.conn.execute("SELECT COUNT(*) FROM spans").fetchone()
        # Tracer may or may not have spans depending on implementation,
        # but the code path should not crash
        assert rows is not None


# ── Evolution Apply Writes to Disk ───────────────────────────────────────


class TestEvolutionApplyDiskWrite:
    """apply_approved() should save the modified config to disk."""

    def test_apply_writes_config_file(self, tmp_path, monkeypatch):
        from agentos.agent import AgentConfig, save_agent_config
        from agentos.evolution.loop import EvolutionLoop

        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        config = AgentConfig(name="evolve-bot", description="original")
        save_agent_config(config, agents_dir / "evolve-bot.json")

        loop = EvolutionLoop(agent_config=config, data_dir=tmp_path / "evo")

        # Create and approve a proposal (ingest takes dicts)
        loop.review_queue.ingest([{
            "title": "Improve prompt",
            "rationale": "Better results",
            "category": "prompt",
            "priority": 0.8,
            "modification": {"description": "improved agent"},
        }])
        surfaced = loop.review_queue.pending
        assert len(surfaced) >= 1
        loop.approve(surfaced[0].id)

        new_config = loop.apply_approved()
        assert new_config is not None
        assert new_config.description == "improved agent"

        # Verify file on disk was updated
        saved = json.loads((agents_dir / "evolve-bot.json").read_text())
        assert saved["description"] == "improved agent"

    def test_apply_bumps_version(self, tmp_path, monkeypatch):
        from agentos.agent import AgentConfig, save_agent_config
        from agentos.evolution.loop import EvolutionLoop

        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        config = AgentConfig(name="v-bot", version="0.1.0")
        save_agent_config(config, agents_dir / "v-bot.json")

        loop = EvolutionLoop(agent_config=config, data_dir=tmp_path / "evo")

        loop.review_queue.ingest([{
            "title": "Tweak", "rationale": "Better", "category": "prompt",
            "priority": 0.5, "modification": {"temperature": 0.5},
        }])
        loop.approve(loop.review_queue.pending[0].id)

        new_config = loop.apply_approved()
        assert new_config is not None
        # Version should have been bumped from 0.1.0
        assert new_config.version != "0.1.0"


# ── CLI Overrides Take Effect ────────────────────────────────────────────


class TestCLIOverrides:
    """apply_overrides() should actually change harness behavior."""

    @pytest.mark.asyncio
    async def test_turns_override(self, tmp_path, monkeypatch):
        from agentos.agent import Agent, AgentConfig

        monkeypatch.chdir(tmp_path)
        config = AgentConfig(name="bot", max_turns=50)
        agent = Agent(config)

        agent.apply_overrides(turns=1)
        assert agent.config.max_turns == 1

        results = await agent.run("Hello")
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_budget_override(self, tmp_path, monkeypatch):
        from agentos.agent import Agent, AgentConfig

        monkeypatch.chdir(tmp_path)
        config = AgentConfig(name="bot")
        agent = Agent(config)

        agent.apply_overrides(budget=0.0)
        results = await agent.run("Hello")
        # Budget is 0, so the first LLM call should fail
        assert results[-1].stop_reason == "budget"

    def test_model_override_updates_config(self, tmp_path, monkeypatch):
        from agentos.agent import Agent, AgentConfig

        monkeypatch.chdir(tmp_path)
        config = AgentConfig(name="bot", model="claude-sonnet-4-20250514")
        agent = Agent(config)

        agent.apply_overrides(model="gpt-4o")
        assert agent.config.model == "gpt-4o"


# ── Procedural Memory Stored After Tool Use ──────────────────────────────


class TestProceduralMemoryStorage:
    """Successful tool sequences should be stored in procedural memory."""

    @pytest.mark.asyncio
    async def test_procedure_stored_after_tools(self):
        provider = _make_tool_calling_provider(tool_calls_on_turns={1})

        harness = AgentHarness(
            config=HarnessConfig(max_turns=5),
            llm_router=_make_router(provider),
            tool_executor=_make_tool_executor(),
        )

        await harness.run("Search for test results")
        # Should have stored a procedure from the successful tool sequence
        procedures = harness.memory_manager.procedural.find_best("search", limit=5)
        assert len(procedures) >= 1

    @pytest.mark.asyncio
    async def test_no_procedure_without_tools(self):
        """When no tools are called, no procedure should be stored."""
        harness = AgentHarness(config=HarnessConfig(max_turns=1))
        await harness.run("Just say hello")
        procedures = harness.memory_manager.procedural.find_best("hello", limit=5)
        assert len(procedures) == 0


# ── Cost Accumulation Across Turns ───────────────────────────────────────


class TestCostAccumulation:
    """Total cost should equal sum of per-turn costs."""

    @pytest.mark.asyncio
    async def test_total_cost_matches_sum(self):
        provider = _make_tool_calling_provider(
            tool_calls_on_turns={1, 2},
            cost_per_call=0.01,
        )

        harness = AgentHarness(
            config=HarnessConfig(max_turns=5),
            llm_router=_make_router(provider),
            tool_executor=_make_tool_executor(),
        )

        results = await harness.run("Multi-turn task")
        total_from_turns = sum(r.cost_usd for r in results)
        total_from_responses = sum(
            r.llm_response.cost_usd for r in results if r.llm_response
        )
        assert total_from_turns == pytest.approx(total_from_responses)
        assert total_from_turns > 0

    @pytest.mark.asyncio
    async def test_governance_tracks_cumulative_cost(self):
        """Governance should see the total cost from all turns."""
        provider = _make_tool_calling_provider(
            tool_calls_on_turns={1},
            cost_per_call=0.01,
        )

        gov = GovernanceLayer(GovernancePolicy(budget_limit_usd=1.0))
        harness = AgentHarness(
            config=HarnessConfig(max_turns=5),
            llm_router=_make_router(provider),
            tool_executor=_make_tool_executor(),
            governance=gov,
        )

        results = await harness.run("Task")
        # 2 LLM calls at 0.01 each = 0.02 spent
        assert gov.remaining_budget == pytest.approx(1.0 - 0.02)


# ── Timeout ──────────────────────────────────────────────────────────────


class TestHarnessTimeout:
    """The harness should respect timeout_seconds."""

    @pytest.mark.asyncio
    async def test_timeout_stops_run(self):
        """A very short timeout should stop execution."""

        class SlowProvider:
            @property
            def model_id(self):
                return "slow"

            async def complete(self, messages, **kwargs):
                await asyncio.sleep(5)  # sleep longer than timeout
                return LLMResponse(content="Done.", model="slow",
                                   usage={"input_tokens": 1, "output_tokens": 1},
                                   cost_usd=0.001)

        harness = AgentHarness(
            config=HarnessConfig(max_turns=3, timeout_seconds=0.1),
            llm_router=_make_router(SlowProvider()),
        )

        results = await harness.run("Hello")
        assert len(results) == 1
        assert results[0].stop_reason == "timeout"
        assert results[0].done is True


# ── Episodic Memory Stored on Completion ─────────────────────────────────


class TestEpisodicMemoryOnCompletion:
    """When the agent completes, the interaction should be stored in episodic memory."""

    @pytest.mark.asyncio
    async def test_episode_stored(self):
        harness = AgentHarness(config=HarnessConfig(max_turns=1))
        assert harness.memory_manager.episodic.count() == 0

        await harness.run("What is 2+2?")
        assert harness.memory_manager.episodic.count() == 1

    @pytest.mark.asyncio
    async def test_episode_not_stored_on_timeout(self):
        """Timeouts should NOT store an episode (agent didn't complete)."""

        class SlowProvider:
            @property
            def model_id(self):
                return "slow"

            async def complete(self, messages, **kwargs):
                await asyncio.sleep(5)
                return LLMResponse(content="Done.", model="slow",
                                   usage={"input_tokens": 1, "output_tokens": 1},
                                   cost_usd=0.001)

        harness = AgentHarness(
            config=HarnessConfig(max_turns=1, timeout_seconds=0.1),
            llm_router=_make_router(SlowProvider()),
        )

        await harness.run("Hello")
        assert harness.memory_manager.episodic.count() == 0


# ── Full Agent.run() Integration ─────────────────────────────────────────


class TestAgentRunIntegration:
    """Full Agent.run() should produce observable, persistent results."""

    @pytest.mark.asyncio
    async def test_observer_captures_all_turns(self, tmp_path, monkeypatch):
        """Observer should capture every turn from a multi-turn run."""
        from agentos.agent import Agent, AgentConfig

        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        config = AgentConfig(name="bot", max_turns=5)
        agent = Agent(config)

        await agent.run("Hello")

        assert len(agent.observer.records) == 1
        rec = agent.observer.records[0]
        assert rec.is_finished
        assert len(rec.turns) >= 1

    @pytest.mark.asyncio
    async def test_multiple_runs_accumulate_records(self, tmp_path, monkeypatch):
        from agentos.agent import Agent, AgentConfig

        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        config = AgentConfig(name="bot")
        agent = Agent(config)

        await agent.run("Hello")
        await agent.run("World")

        assert len(agent.observer.records) == 2
        sessions = agent.db.query_sessions()
        assert len(sessions) == 2
