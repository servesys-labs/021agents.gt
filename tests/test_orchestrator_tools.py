"""Tests for orchestrator tool handlers (create-agent, eval-agent, etc.)."""

import json
import os
import pytest

from agentos.tools.builtins import (
    create_agent,
    eval_agent,
    evolve_agent,
    list_agents_handler,
    list_tools_handler,
    BUILTIN_HANDLERS,
)


class TestBuiltinRegistry:
    """Verify all orchestrator tools are registered."""

    def test_orchestrator_tools_registered(self):
        expected = [
            "create-agent", "eval-agent", "evolve-agent",
            "list-agents", "list-tools",
        ]
        for name in expected:
            assert name in BUILTIN_HANDLERS, f"{name} not in BUILTIN_HANDLERS"

    def test_handlers_are_coroutines(self):
        import asyncio
        for name in ["create-agent", "eval-agent", "evolve-agent",
                      "list-agents", "list-tools"]:
            handler = BUILTIN_HANDLERS[name]
            assert asyncio.iscoroutinefunction(handler), f"{name} is not async"


class TestCreateAgent:
    @pytest.mark.asyncio
    async def test_creates_agent_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()
        (tmp_path / "tools").mkdir()

        result = await create_agent(
            description="A test agent that answers trivia questions",
            name="trivia-bot",
        )

        assert "trivia-bot" in result
        assert "Agent created" in result
        agent_path = tmp_path / "agents" / "trivia-bot.json"
        assert agent_path.exists()

        data = json.loads(agent_path.read_text())
        assert data["name"] == "trivia-bot"

    @pytest.mark.asyncio
    async def test_auto_generates_name(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()
        (tmp_path / "tools").mkdir()

        result = await create_agent(description="An agent for code review")
        assert "Agent created" in result
        # Should have created some agent file
        agents = list((tmp_path / "agents").glob("*.json"))
        assert len(agents) == 1

    @pytest.mark.asyncio
    async def test_suggests_next_steps(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()
        (tmp_path / "tools").mkdir()

        result = await create_agent(description="test agent", name="test")
        assert "eval-agent" in result
        assert "evolve-agent" in result


class TestEvalAgent:
    @pytest.mark.asyncio
    async def test_missing_agent(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()

        result = await eval_agent(agent_name="nonexistent")
        assert "not found" in result

    @pytest.mark.asyncio
    async def test_missing_eval_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        # Create a minimal agent
        from agentos.agent import AgentConfig, save_agent_config
        config = AgentConfig(name="test-agent", description="Test")
        save_agent_config(config, agents_dir / "test-agent.json")

        result = await eval_agent(agent_name="test-agent")
        assert "not found" in result

    @pytest.mark.asyncio
    async def test_runs_eval_with_tasks(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        eval_dir = tmp_path / "eval"
        eval_dir.mkdir()

        # Create agent
        from agentos.agent import AgentConfig, save_agent_config
        config = AgentConfig(name="test-agent", description="Test")
        save_agent_config(config, agents_dir / "test-agent.json")

        # Create eval tasks
        tasks = [
            {"name": "greet", "input": "Say hello", "expected": "hello", "grader": "contains"},
        ]
        (eval_dir / "smoke-test.json").write_text(json.dumps(tasks))

        result = await eval_agent(agent_name="test-agent")
        assert "Eval Report" in result
        assert "Pass rate" in result
        assert "greet" in result


class TestEvolveAgent:
    @pytest.mark.asyncio
    async def test_missing_agent(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()

        result = await evolve_agent(agent_name="nonexistent")
        assert "not found" in result

    @pytest.mark.asyncio
    async def test_analyze_empty(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        from agentos.agent import AgentConfig, save_agent_config
        config = AgentConfig(name="test-agent", description="Test")
        save_agent_config(config, agents_dir / "test-agent.json")

        result = await evolve_agent(agent_name="test-agent", action="analyze")
        assert "Analysis Report" in result

    @pytest.mark.asyncio
    async def test_status(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        from agentos.agent import AgentConfig, save_agent_config
        config = AgentConfig(name="test-agent", description="Test")
        save_agent_config(config, agents_dir / "test-agent.json")

        result = await evolve_agent(agent_name="test-agent", action="status")
        assert "Evolution Status" in result
        assert "test-agent" in result

    @pytest.mark.asyncio
    async def test_propose(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        from agentos.agent import AgentConfig, save_agent_config
        config = AgentConfig(name="test-agent", description="Test")
        save_agent_config(config, agents_dir / "test-agent.json")

        result = await evolve_agent(agent_name="test-agent", action="propose")
        # Either generates proposals or reports none — both valid
        assert "proposals" in result.lower() or "No proposals" in result


class TestListAgents:
    @pytest.mark.asyncio
    async def test_empty(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()

        result = await list_agents_handler()
        assert "No agents" in result

    @pytest.mark.asyncio
    async def test_with_agents(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        from agentos.agent import AgentConfig, save_agent_config
        save_agent_config(
            AgentConfig(name="alpha", description="First agent", tags=["test"]),
            agents_dir / "alpha.json",
        )
        save_agent_config(
            AgentConfig(name="beta", description="Second agent", tools=["web-search"]),
            agents_dir / "beta.json",
        )

        result = await list_agents_handler()
        assert "Agents (2)" in result
        assert "alpha" in result
        assert "beta" in result
        assert "First agent" in result
        assert "1 tools" in result


class TestListTools:
    @pytest.mark.asyncio
    async def test_empty(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        empty_tools = tmp_path / "tools"
        empty_tools.mkdir()

        result = await list_tools_handler()
        assert "No tools" in result

    @pytest.mark.asyncio
    async def test_with_tools(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        tools_dir = tmp_path / "tools"
        tools_dir.mkdir()

        # Create a tool definition
        tool_def = {
            "name": "my-tool",
            "description": "A custom tool for testing",
            "input_schema": {"type": "object", "properties": {}},
        }
        (tools_dir / "my-tool.json").write_text(json.dumps(tool_def))

        result = await list_tools_handler()
        assert "my-tool" in result
        assert "A custom tool" in result


class TestToolSchemaIntegration:
    """Verify tool JSON schemas match handler signatures."""

    def test_create_agent_schema_matches(self):
        schema = json.loads(
            (os.path.dirname(__file__) + "/../tools/create-agent.json")
            and open("tools/create-agent.json").read()
        )
        props = schema["input_schema"]["properties"]
        assert "description" in props
        assert "name" in props

    def test_eval_agent_schema_matches(self):
        schema = json.loads(open("tools/eval-agent.json").read())
        props = schema["input_schema"]["properties"]
        assert "agent_name" in props
        assert "eval_file" in props
        assert "trials" in props

    def test_evolve_agent_schema_matches(self):
        schema = json.loads(open("tools/evolve-agent.json").read())
        props = schema["input_schema"]["properties"]
        assert "agent_name" in props
        assert "action" in props
