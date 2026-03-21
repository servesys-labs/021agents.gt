"""Tests for the Agent definition, loading, and execution."""

import json
import pytest
from pathlib import Path

from agentos.agent import Agent, AgentConfig, load_agent_config, save_agent_config, list_agents


class TestAgentConfig:
    def test_defaults(self):
        config = AgentConfig(name="test")
        assert config.name == "test"
        assert config.model == "claude-sonnet-4-20250514"
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
        wm = agent._harness.memory_manager.working
        assert wm.get("system_prompt") == "You are a pirate."
        assert wm.get("personality") == "Gruff and salty"

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
