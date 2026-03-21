"""Tests for the CLI commands."""

import asyncio
import json
import subprocess
import sys
import pytest
from pathlib import Path
from unittest.mock import patch

from agentos.cli import cmd_init, cmd_list, cmd_tools


def _make_args(**overrides):
    """Build a mock Args namespace from keyword arguments."""
    class Args:
        pass
    for k, v in overrides.items():
        setattr(Args, k, v)
    return Args()


def _make_init_args(directory, **overrides):
    """Build a complete Args namespace for cmd_init with sane defaults."""
    defaults = dict(
        directory=str(directory),
        name=None,
        remote=None,
        no_git=True,        # skip git in tests to avoid side-effects
        no_signing=True,     # skip signing to avoid filesystem permissions issues
        template=None,
        dry_run=False,
        force=False,
    )
    defaults.update(overrides)
    return _make_args(**defaults)


class TestCmdInit:
    def test_init_creates_structure(self, tmp_path):
        args = _make_init_args(tmp_path)
        cmd_init(args)

        # Core directories
        assert (tmp_path / "agents").is_dir()
        assert (tmp_path / "tools").is_dir()
        assert (tmp_path / "data").is_dir()
        assert (tmp_path / "eval").is_dir()
        assert (tmp_path / "sessions").is_dir()
        # Starter files
        assert (tmp_path / "tools" / "example-search.json").exists()
        assert (tmp_path / "eval" / "smoke-test.json").exists()
        assert (tmp_path / "agentos.yaml").exists()
        assert (tmp_path / ".env.example").exists()
        assert (tmp_path / ".gitignore").exists()
        assert (tmp_path / ".github" / "workflows" / "eval.yml").exists()

    def test_init_default_creates_orchestrator(self, tmp_path):
        """Default init should create an orchestrator agent."""
        args = _make_init_args(tmp_path, name="my-project")
        cmd_init(args)

        agent_path = tmp_path / "agents" / "my-project.json"
        assert agent_path.exists()
        data = json.loads(agent_path.read_text())
        assert "orchestrator" in data["tags"]
        assert "create-agent" in data["tools"]
        assert "eval-agent" in data["tools"]
        assert "evolve-agent" in data["tools"]
        assert "meta-agent" in data["description"].lower() or "orchestrator" in data["description"].lower()

    def test_init_does_not_overwrite(self, tmp_path):
        agent_name = tmp_path.name.replace(" ", "-").lower()
        # Normalise to what _slugify would produce
        import re
        agent_name = re.sub(r"[^a-zA-Z0-9]+", "-", agent_name).strip("-") or "my-agent"

        agent_path = tmp_path / "agents" / f"{agent_name}.json"
        agent_path.parent.mkdir(parents=True)
        agent_path.write_text('{"name": "custom"}')

        args = _make_init_args(tmp_path)
        cmd_init(args)

        # Should not overwrite existing file
        data = json.loads(agent_path.read_text())
        assert data["name"] == "custom"

    def test_init_force_overwrites(self, tmp_path):
        """--force should regenerate files that already exist."""
        args = _make_init_args(tmp_path)
        cmd_init(args)

        # Tamper with the .env.example
        env_path = tmp_path / ".env.example"
        env_path.write_text("CUSTOM=1")

        args = _make_init_args(tmp_path, force=True)
        cmd_init(args)

        # Should be overwritten back to the standard template
        content = env_path.read_text()
        assert "ANTHROPIC_API_KEY" in content
        assert "CUSTOM=1" not in content

    def test_init_dry_run_writes_nothing(self, tmp_path):
        target = tmp_path / "fresh"
        target.mkdir()

        args = _make_init_args(target, dry_run=True)
        cmd_init(args)

        # Directories should NOT be created in dry-run
        assert not (target / "agents").exists()
        assert not (target / "tools").exists()

    def test_init_template_research(self, tmp_path):
        args = _make_init_args(tmp_path, template="research", name="my-researcher")
        cmd_init(args)

        agent_path = tmp_path / "agents" / "my-researcher.json"
        assert agent_path.exists()
        data = json.loads(agent_path.read_text())
        assert data["name"] == "my-researcher"
        assert "web-search" in data["tools"]
        assert "research" in data["tags"]

    def test_init_template_code_review(self, tmp_path):
        args = _make_init_args(tmp_path, template="code-review", name="reviewer")
        cmd_init(args)

        data = json.loads((tmp_path / "agents" / "reviewer.json").read_text())
        assert "code-review" in data["tags"]
        assert data["max_turns"] == 10

    def test_init_rejects_file_as_directory(self, tmp_path):
        target = tmp_path / "somefile.txt"
        target.write_text("hello")

        args = _make_init_args(target)
        with pytest.raises(SystemExit):
            cmd_init(args)

    def test_init_agent_is_valid(self, tmp_path):
        args = _make_init_args(tmp_path, name="my-agent")
        cmd_init(args)

        from agentos.agent import load_agent_config
        config = load_agent_config(tmp_path / "agents" / "my-agent.json")
        assert config.name == "my-agent"

    def test_init_env_example_includes_e2b(self, tmp_path):
        args = _make_init_args(tmp_path)
        cmd_init(args)

        content = (tmp_path / ".env.example").read_text()
        assert "E2B_API_KEY" in content

    def test_init_uses_default_model_constant(self, tmp_path):
        from agentos.defaults import DEFAULT_MODEL
        args = _make_init_args(tmp_path, name="my-agent")
        cmd_init(args)

        data = json.loads((tmp_path / "agents" / "my-agent.json").read_text())
        assert data["model"] == DEFAULT_MODEL

        yaml_content = (tmp_path / "agentos.yaml").read_text()
        assert DEFAULT_MODEL in yaml_content

    def test_init_next_steps_mention_orchestrator_chat(self, tmp_path, capsys):
        """Default orchestrator template should suggest chatting with it."""
        args = _make_init_args(tmp_path, name="my-agent")
        cmd_init(args)

        captured = capsys.readouterr()
        assert "agentos chat" in captured.out
        assert "orchestrator" in captured.out.lower()

    def test_init_blank_next_steps_mention_create(self, tmp_path, capsys):
        """Blank template should suggest agentos create."""
        args = _make_init_args(tmp_path, name="my-agent", template="blank")
        cmd_init(args)

        captured = capsys.readouterr()
        assert "agentos create" in captured.out


def _make_create_args(**overrides):
    """Build a complete Args namespace for cmd_create with sane defaults."""
    defaults = dict(
        one_shot=None,
        name=None,
        output=None,
        model=None,
        provider="stub",
        tools_dir=None,
        force=False,
        max_turns=20,
    )
    defaults.update(overrides)
    return _make_args(**defaults)


class TestCmdCreate:
    @pytest.mark.asyncio
    async def test_one_shot_creates_agent_file(self, tmp_path):
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        args = _make_create_args(
            one_shot="a research assistant that finds papers",
            output=str(agents_dir / "researcher.json"),
        )

        with patch("agentos.cli.Path") as mock_path_cls:
            # Let Path.cwd() return tmp_path so the project check passes
            mock_path_cls.cwd.return_value = tmp_path
            # But let Path(x) still work normally for everything else
            mock_path_cls.side_effect = Path
            mock_path_cls.cwd = lambda: tmp_path

            # Simpler: just call cmd_create and let it use stub provider
            # We need to patch the project detection check
            await cmd_create(args)

        assert (agents_dir / "researcher.json").exists()
        data = json.loads((agents_dir / "researcher.json").read_text())
        assert data["name"] is not None
        assert "research" in data["description"].lower()

    @pytest.mark.asyncio
    async def test_one_shot_with_name_override(self, tmp_path):
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        args = _make_create_args(
            one_shot="a customer support bot",
            name="my-bot",
            output=str(agents_dir / "my-bot.json"),
        )

        await cmd_create(args)

        data = json.loads((agents_dir / "my-bot.json").read_text())
        assert data["name"] == "my-bot"

    @pytest.mark.asyncio
    async def test_create_collision_without_force_exits(self, tmp_path):
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        # Create an existing file
        existing = agents_dir / "existing.json"
        existing.write_text('{"name": "existing"}')

        args = _make_create_args(
            one_shot="some agent",
            name="existing",
            output=str(existing),
        )

        with pytest.raises(SystemExit):
            await cmd_create(args)

    @pytest.mark.asyncio
    async def test_create_collision_with_force_overwrites(self, tmp_path):
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        existing = agents_dir / "overwrite-me.json"
        existing.write_text('{"name": "old"}')

        args = _make_create_args(
            one_shot="a new agent",
            name="overwrite-me",
            output=str(existing),
            force=True,
        )

        await cmd_create(args)

        data = json.loads(existing.read_text())
        assert data["name"] == "overwrite-me"

    @pytest.mark.asyncio
    async def test_create_warns_without_project(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_create

        # Use a directory with no agents/ or agentos.yaml
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        monkeypatch.chdir(empty_dir)

        out_path = empty_dir / "my-agent.json"
        args = _make_create_args(
            one_shot="a test bot",
            output=str(out_path),
        )

        await cmd_create(args)

        captured = capsys.readouterr()
        assert "No AgentOS project detected" in captured.out

    @pytest.mark.asyncio
    async def test_create_custom_tools_dir(self, tmp_path):
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        tools_dir = tmp_path / "my-tools"
        tools_dir.mkdir()

        # Create a custom tool in the custom tools dir
        tool = {"name": "custom-tool", "description": "My custom tool", "input_schema": {"type": "object", "properties": {}}}
        (tools_dir / "custom-tool.json").write_text(json.dumps(tool))

        args = _make_create_args(
            one_shot="an agent using custom tools",
            output=str(agents_dir / "custom.json"),
            tools_dir=str(tools_dir),
        )

        await cmd_create(args)
        assert (agents_dir / "custom.json").exists()

    @pytest.mark.asyncio
    async def test_create_stamps_agent_id_from_identity(self, tmp_path, monkeypatch):
        """create should read agents/.identity.json and stamp agent_id."""
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        # Write a project identity
        identity = {"agent_id": "agent-test123", "fingerprint": "abc"}
        (agents_dir / ".identity.json").write_text(json.dumps(identity))
        # agentos.yaml so no "project not detected" warning
        (tmp_path / "agentos.yaml").write_text("project: test\n")
        monkeypatch.chdir(tmp_path)

        args = _make_create_args(
            one_shot="a test bot",
            name="stamped",
            output=str(agents_dir / "stamped.json"),
        )
        await cmd_create(args)

        data = json.loads((agents_dir / "stamped.json").read_text())
        assert data["agent_id"] == "agent-test123"

    @pytest.mark.asyncio
    async def test_create_next_steps_mention_eval(self, tmp_path, capsys):
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()

        args = _make_create_args(
            one_shot="a simple bot",
            output=str(agents_dir / "simple.json"),
        )
        await cmd_create(args)

        captured = capsys.readouterr()
        assert "agentos eval" in captured.out


def _make_run_args(name, **overrides):
    """Build a complete Args namespace for cmd_run with sane defaults."""
    defaults = dict(
        name=name,
        task=None,
        turns=None,
        timeout=None,
        budget=None,
        model=None,
        input_file=None,
        output=None,
        json_output=False,
        quiet=False,
        verbose=False,
    )
    defaults.update(overrides)
    return _make_args(**defaults)


def _write_stub_agent(agents_dir, name="test-agent"):
    """Create a minimal agent JSON file and return its path."""
    from agentos.agent import AgentConfig, save_agent_config
    config = AgentConfig(name=name, description="A test agent")
    path = agents_dir / f"{name}.json"
    save_agent_config(config, path)
    return path


class TestCmdRun:
    @pytest.mark.asyncio
    async def test_run_with_task_arg(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(str(agents_dir / "test-agent.json"), task="hello world")
        await cmd_run(args)

        captured = capsys.readouterr()
        assert "Running agent" in captured.out
        assert "test-agent" in captured.out

    @pytest.mark.asyncio
    async def test_run_reads_input_file(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        # Write task to a file
        task_file = tmp_path / "task.txt"
        task_file.write_text("Summarize this document")

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            input_file=str(task_file),
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        assert "Summarize this document" in captured.out

    @pytest.mark.asyncio
    async def test_run_input_file_not_found(self, tmp_path, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            input_file="/nonexistent/file.txt",
        )
        with pytest.raises(SystemExit) as exc_info:
            await cmd_run(args)
        assert exc_info.value.code == 1

    @pytest.mark.asyncio
    async def test_run_no_task_exits(self, tmp_path, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        # Simulate non-interactive stdin with no data
        import io
        monkeypatch.setattr("sys.stdin", io.StringIO(""))

        args = _make_run_args(str(agents_dir / "test-agent.json"))
        with pytest.raises(SystemExit) as exc_info:
            await cmd_run(args)
        assert exc_info.value.code == 1

    @pytest.mark.asyncio
    async def test_run_quiet_mode(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            quiet=True,
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        # Quiet mode should NOT show "Running agent" or summary
        assert "Running agent" not in captured.out
        assert "turn" not in captured.out.lower().split("stub")[0]  # allow "stub" mentions

    @pytest.mark.asyncio
    async def test_run_json_output(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            json_output=True,
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["agent"] == "test-agent"
        assert data["task"] == "hello"
        assert "success" in data
        assert "turns" in data
        assert "cost_usd" in data
        assert "latency_ms" in data

    @pytest.mark.asyncio
    async def test_run_json_verbose_includes_results(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            json_output=True,
            verbose=True,
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "results" in data
        assert isinstance(data["results"], list)

    @pytest.mark.asyncio
    async def test_run_output_to_file(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        out_file = tmp_path / "output.txt"
        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            output=str(out_file),
        )
        await cmd_run(args)

        assert out_file.exists()

    @pytest.mark.asyncio
    async def test_run_shows_cost_summary(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        # Should show summary with turns, tool calls, latency, cost
        assert "turn" in captured.out.lower()
        assert "tool call" in captured.out.lower()
        assert "ms" in captured.out
        assert "$" in captured.out

    @pytest.mark.asyncio
    async def test_run_turns_override(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            turns=3,
        )
        await cmd_run(args)

        # Just verify it doesn't crash — the agent uses stub so it runs fine
        captured = capsys.readouterr()
        assert "test-agent" in captured.out

    @pytest.mark.asyncio
    async def test_run_stub_provider_warning(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)
        # Ensure no API keys so stub provider is used
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        assert "stub provider" in captured.out.lower()

    @pytest.mark.asyncio
    async def test_run_json_no_duplicate_output(self, tmp_path, capsys, monkeypatch):
        """JSON mode should not print any non-JSON text."""
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            json_output=True,
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        # The entire stdout should be valid JSON
        data = json.loads(captured.out)
        assert isinstance(data, dict)


    @pytest.mark.asyncio
    async def test_run_model_override(self, tmp_path, capsys, monkeypatch):
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            model="gpt-4o",
            json_output=True,
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["success"]

    @pytest.mark.asyncio
    async def test_run_reads_project_defaults(self, tmp_path, capsys, monkeypatch):
        """run should pick up budget from agentos.yaml."""
        from agentos.cli import cmd_run

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir)
        monkeypatch.chdir(tmp_path)

        # Write agentos.yaml with a custom budget
        (tmp_path / "agentos.yaml").write_text(
            "defaults:\n  budget_limit_usd: 5.0\n"
        )

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
            quiet=True,
        )
        await cmd_run(args)
        # Doesn't crash — that's the test
        captured = capsys.readouterr()
        assert captured.out  # got some output

    @pytest.mark.asyncio
    async def test_run_warns_mismatched_agent_id(self, tmp_path, capsys, monkeypatch):
        """run should warn if agent_id doesn't match project identity."""
        from agentos.cli import cmd_run
        from agentos.agent import AgentConfig, save_agent_config

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        monkeypatch.chdir(tmp_path)

        # Create agent with one ID
        config = AgentConfig(name="test-agent", agent_id="agent-AAA")
        save_agent_config(config, agents_dir / "test-agent.json")

        # Create project identity with different ID
        identity = {"agent_id": "agent-BBB", "fingerprint": "xyz"}
        (agents_dir / ".identity.json").write_text(json.dumps(identity))

        args = _make_run_args(
            str(agents_dir / "test-agent.json"),
            task="hello",
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        assert "Warning" in captured.err
        assert "agent-AAA" in captured.err
        assert "agent-BBB" in captured.err

    @pytest.mark.asyncio
    async def test_run_stub_built_agent_warning(self, tmp_path, capsys, monkeypatch):
        """run should warn that a stub-built agent should be re-created."""
        from agentos.cli import cmd_run
        from agentos.agent import AgentConfig, save_agent_config

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        # Create agent marked as stub-built
        config = AgentConfig(name="stub-agent", built_with="stub")
        save_agent_config(config, agents_dir / "stub-agent.json")

        args = _make_run_args(
            str(agents_dir / "stub-agent.json"),
            task="hello",
        )
        await cmd_run(args)

        captured = capsys.readouterr()
        assert "re-create" in captured.out.lower()


class TestCrossCutting:
    """Tests that verify consistency across init, create, and run."""

    def test_no_short_flag_collision(self):
        """Ensure -o doesn't collide between create and run."""
        import argparse
        parser = argparse.ArgumentParser()
        sub = parser.add_subparsers(dest="command")

        # Simulate create parser
        create_p = sub.add_parser("create")
        create_p.add_argument("--one-shot", "-1", type=str)
        create_p.add_argument("--output", "-O", type=str)

        # Simulate run parser
        run_p = sub.add_parser("run")
        run_p.add_argument("--output", "-o", type=str)

        # These should parse without conflict
        args = parser.parse_args(["create", "-1", "test desc"])
        assert args.one_shot == "test desc"
        args = parser.parse_args(["run", "-o", "out.txt"])
        assert args.output == "out.txt"

    @pytest.mark.asyncio
    async def test_create_stamps_built_with(self, tmp_path, monkeypatch):
        """create should stamp built_with into the agent config."""
        from agentos.cli import cmd_create

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        monkeypatch.chdir(tmp_path)

        args = _make_create_args(
            one_shot="a test bot",
            name="stamped",
            output=str(agents_dir / "stamped.json"),
        )
        await cmd_create(args)

        data = json.loads((agents_dir / "stamped.json").read_text())
        assert "built_with" in data
        assert data["built_with"] == "stub"

    def test_init_next_steps_mention_run(self, tmp_path, capsys):
        """Orchestrator next steps should mention 'agentos run'."""
        args = _make_init_args(tmp_path, name="my-project")
        cmd_init(args)

        captured = capsys.readouterr()
        assert "agentos run" in captured.out
        assert "agentos chat" in captured.out


class TestCmdList:
    def test_list_with_agents(self, tmp_path, capsys):
        from agentos.agent import AgentConfig, save_agent_config
        save_agent_config(
            AgentConfig(name="test-agent", description="A test", model="claude-sonnet-4-20250514"),
            tmp_path / "test-agent.json",
        )

        with patch("agentos.agent._resolve_agents_dir", return_value=tmp_path):

            class Args:
                pass

            cmd_list(Args())

        captured = capsys.readouterr()
        assert "test-agent" in captured.out

    def test_list_empty(self, tmp_path, capsys):
        empty = tmp_path / "empty_agents"
        empty.mkdir()

        with patch("agentos.agent._resolve_agents_dir", return_value=empty):

            class Args:
                pass

            cmd_list(Args())

        captured = capsys.readouterr()
        assert "No agents found" in captured.out


class TestCLIEntrypoint:
    def test_version_flag(self):
        result = subprocess.run(
            [sys.executable, "-m", "agentos.cli", "--version"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "agentos" in result.stdout

    def test_missing_agent_error(self):
        result = subprocess.run(
            [sys.executable, "-m", "agentos.cli", "run", "nonexistent-agent-xyz", "hello"],
            capture_output=True, text=True,
        )
        assert result.returncode == 1
        assert "Error" in result.stdout or "Error" in result.stderr or "not found" in result.stdout.lower()

    def test_help(self):
        result = subprocess.run(
            [sys.executable, "-m", "agentos.cli", "--help"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "init" in result.stdout
        assert "create" in result.stdout
        assert "run" in result.stdout
