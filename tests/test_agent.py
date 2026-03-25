"""Tests for the Agent definition, loading, and execution."""

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from agentos.agent import Agent, AgentConfig, load_agent_config, save_agent_config, list_agents
from agentos.core.harness import TurnResult


class TestAgentConfig:
    def test_defaults(self):
        config = AgentConfig(name="test")
        assert config.name == "test"
        assert config.model == "claude-sonnet-4-6-20250627"
        assert config.max_turns == 50
        assert config.governance["budget_limit_usd"] == 10.0

    def test_to_dict_roundtrip(self):
        config = AgentConfig(
            name="my-bot",
            description="A test agent",
            tools=["web-search"],
            tags=["test"],
        )
        data = config.to_dict()
        restored = AgentConfig.from_dict(data)
        assert restored.name == "my-bot"
        assert restored.tools == ["web-search"]
        assert restored.tags == ["test"]

    def test_from_dict_ignores_unknown_keys(self):
        data = {"name": "test", "unknown_key": "value", "foo": 123}
        config = AgentConfig.from_dict(data)
        assert config.name == "test"
        assert not hasattr(config, "unknown_key")


class TestAgentFileIO:
    def test_save_and_load_json(self, tmp_path):
        config = AgentConfig(
            name="file-test",
            description="Saved agent",
            tools=["web-search"],
        )
        path = save_agent_config(config, tmp_path / "file-test.json")
        assert path.exists()

        loaded = load_agent_config(path)
        assert loaded.name == "file-test"
        assert loaded.description == "Saved agent"
        assert loaded.tools == ["web-search"]

    def test_list_agents(self, tmp_path):
        # Create two agent files
        for name in ["agent-a", "agent-b"]:
            config = AgentConfig(name=name, description=f"Agent {name}")
            save_agent_config(config, tmp_path / f"{name}.json")

        agents = list_agents(tmp_path)
        assert len(agents) == 2
        names = [a.name for a in agents]
        assert "agent-a" in names
        assert "agent-b" in names

    def test_list_agents_empty(self, tmp_path):
        agents = list_agents(tmp_path)
        assert agents == []

    def test_list_agents_nonexistent_dir(self, tmp_path):
        agents = list_agents(tmp_path / "nonexistent")
        assert agents == []


class TestAgent:
    @pytest.mark.asyncio
    async def test_agent_runs(self):
        config = AgentConfig(
            name="test-runner",
            description="Test agent",
            system_prompt="You are a test assistant.",
            max_turns=2,
        )
        agent = Agent(config)
        results = await agent.run("Hello, what is 2+2?")
        assert len(results) >= 1
        assert results[-1].done is True

    @pytest.mark.asyncio
    async def test_agent_from_file(self, tmp_path):
        config = AgentConfig(name="from-file", description="File-loaded agent")
        path = save_agent_config(config, tmp_path / "from-file.json")

        agent = Agent.from_file(path)
        assert agent.config.name == "from-file"
        results = await agent.run("test")
        assert len(results) >= 1

    @pytest.mark.asyncio
    async def test_agent_from_name(self, tmp_path):
        config = AgentConfig(name="named", description="Named agent")
        save_agent_config(config, tmp_path / "named.json")

        agent = Agent.from_name("named", directory=tmp_path)
        assert agent.config.name == "named"

    def test_agent_from_name_not_found(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            Agent.from_name("nonexistent", directory=tmp_path)

    @pytest.mark.asyncio
    async def test_agent_injects_system_prompt(self):
        config = AgentConfig(
            name="prompted",
            system_prompt="You are a pirate.",
            personality="Gruff and salty",
            max_turns=1,
        )
        agent = Agent(config)
        assert "You are a pirate." in agent._harness.system_prompt
        assert "Gruff and salty" in agent._harness.system_prompt

    @pytest.mark.asyncio
    async def test_agent_with_inline_tool(self):
        config = AgentConfig(
            name="tooled",
            tools=[{
                "name": "calc",
                "description": "Calculator",
                "input_schema": {
                    "type": "object",
                    "properties": {"expr": {"type": "string"}},
                },
            }],
            max_turns=2,
        )
        agent = Agent(config)
        tools = agent._harness.tool_executor.available_tools()
        assert len(tools) == 1
        assert tools[0]["name"] == "calc"

    @pytest.mark.asyncio
    async def test_agent_wires_tool_handler(self, tmp_path):
        """Verify that Python tool handlers are wired through to the MCPClient."""
        # Create a Python tool with a handler in a temp tools dir
        tool_code = '''
async def greet(name: str) -> str:
    return f"Hello, {name}!"

TOOLS = [{
    "name": "greeter",
    "description": "Greet someone",
    "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    "handler": greet,
}]
'''
        (tmp_path / "greeter.py").write_text(tool_code)

        from unittest.mock import patch
        from agentos.tools import registry as registry_mod

        with patch.object(registry_mod, "PLUGINS_DIR", tmp_path):
            config = AgentConfig(name="handler-test", tools=["greeter"], max_turns=1)
            agent = Agent(config)

            # Verify handler is registered
            handler = agent._harness.tool_executor.mcp_client._handlers.get("greeter")
            assert handler is not None

            # Verify it actually works
            result = await agent._harness.tool_executor.mcp_client.invoke("greeter", {"name": "World"})
            assert result["result"] == "Hello, World!"

    @pytest.mark.asyncio
    async def test_agent_governance_from_config(self):
        config = AgentConfig(
            name="governed",
            governance={
                "budget_limit_usd": 1.5,
                "blocked_tools": ["dangerous-tool"],
                "require_confirmation_for_destructive": False,
            },
        )
        agent = Agent(config)
        gov = agent._harness.governance
        assert gov.policy.budget_limit_usd == 1.5
        assert "dangerous-tool" in gov.policy.blocked_tools
        assert gov.policy.require_confirmation_for_destructive is False

    @pytest.mark.asyncio
    async def test_agent_run_uses_graph_runtime_by_default(self):
        config = AgentConfig(name="default-runtime", max_turns=1)
        agent = Agent(config)
        expected = [TurnResult(turn_number=1, done=True, stop_reason="completed")]

        with patch.object(agent._harness, "run", new=AsyncMock(return_value=[])) as harness_run:
            with patch("agentos.graph.adapter.run_with_graph_runtime", new=AsyncMock(return_value=expected)) as graph_run:
                results = await agent.run("hello")
                assert results == expected
                graph_run.assert_awaited_once()
                harness_run.assert_not_called()

    @pytest.mark.asyncio
    async def test_agent_run_uses_graph_runtime_when_enabled_in_config(self):
        config = AgentConfig(name="graph-runtime", max_turns=1)
        config.harness["runtime_mode"] = "graph"
        agent = Agent(config)
        expected = [TurnResult(turn_number=1, done=True, stop_reason="completed")]

        with patch.object(agent._harness, "run", new=AsyncMock(return_value=[])) as harness_run:
            with patch(
                "agentos.graph.adapter.run_with_graph_runtime",
                new=AsyncMock(return_value=expected),
            ) as graph_run:
                results = await agent.run("hello")
                assert results == expected
                graph_run.assert_awaited_once()
                harness_run.assert_not_called()

    @pytest.mark.asyncio
    async def test_agent_run_ignores_legacy_harness_runtime_mode(self):
        config = AgentConfig(name="legacy-harness-mode", max_turns=1)
        config.harness["runtime_mode"] = "harness"
        agent = Agent(config)
        expected = [TurnResult(turn_number=1, done=True, stop_reason="completed")]

        with patch.object(agent._harness, "run", new=AsyncMock(return_value=[])) as harness_run:
            with patch(
                "agentos.graph.adapter.run_with_graph_runtime",
                new=AsyncMock(return_value=expected),
            ) as graph_run:
                results = await agent.run("hello")
                assert results == expected
                graph_run.assert_awaited_once()
                harness_run.assert_not_called()
