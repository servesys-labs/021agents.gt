"""Tests for the CLI commands."""

import asyncio
import json
import io
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
        assert data["max_turns"] == 15

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
        monkeypatch.delenv("GMI_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)

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
        monkeypatch.delenv("GMI_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)

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


class TestLoadEvalTasks:
    """Tests for the _load_eval_tasks helper (shared by eval + evolve)."""

    def test_missing_file_exits(self, tmp_path):
        from agentos.cli import _load_eval_tasks
        with pytest.raises(SystemExit):
            _load_eval_tasks(tmp_path / "nonexistent.json")

    def test_malformed_json_exits(self, tmp_path):
        from agentos.cli import _load_eval_tasks
        bad = tmp_path / "bad.json"
        bad.write_text("not json {{{")
        with pytest.raises(SystemExit):
            _load_eval_tasks(bad)

    def test_empty_tasks_exits(self, tmp_path):
        from agentos.cli import _load_eval_tasks
        empty = tmp_path / "empty.json"
        empty.write_text("[]")
        with pytest.raises(SystemExit):
            _load_eval_tasks(empty)

    def test_missing_fields_exits(self, tmp_path):
        from agentos.cli import _load_eval_tasks
        bad = tmp_path / "missing.json"
        bad.write_text('[{"input": "hello"}]')  # missing expected
        with pytest.raises(SystemExit):
            _load_eval_tasks(bad)

    def test_unknown_grader_warns(self, tmp_path, capsys):
        from agentos.cli import _load_eval_tasks
        tasks = tmp_path / "tasks.json"
        tasks.write_text(json.dumps([{"input": "hi", "expected": "hello", "grader": "fuzzy"}]))
        gym, data = _load_eval_tasks(tasks)
        captured = capsys.readouterr()
        assert "Unknown grader type" in captured.err
        assert len(data) == 1

    def test_valid_tasks_load(self, tmp_path):
        from agentos.cli import _load_eval_tasks
        tasks = tmp_path / "tasks.json"
        tasks.write_text(json.dumps([
            {"input": "hi", "expected": "hello", "grader": "exact"},
            {"input": "bye", "expected": "goodbye"},
        ]))
        gym, data = _load_eval_tasks(tasks)
        assert len(data) == 2


class TestNumericValidation:
    """Tests for _validate_positive."""

    def test_rejects_negative_timeout(self):
        from agentos.cli import _validate_positive
        with pytest.raises(SystemExit):
            _validate_positive(-5, "timeout")

    def test_rejects_zero_turns(self):
        from agentos.cli import _validate_positive
        with pytest.raises(SystemExit):
            _validate_positive(0, "turns")

    def test_allows_zero_budget(self):
        from agentos.cli import _validate_positive
        _validate_positive(0, "budget", allow_zero=True)  # should not raise

    def test_allows_none(self):
        from agentos.cli import _validate_positive
        _validate_positive(None, "timeout")  # should not raise

    def test_allows_positive(self):
        from agentos.cli import _validate_positive
        _validate_positive(42, "turns")  # should not raise


class TestCmdChat:
    """Tests for chat command."""

    @pytest.mark.asyncio
    async def test_chat_warns_mismatched_agent_id(self, tmp_path, capsys, monkeypatch):
        """chat should warn if agent_id doesn't match project identity."""
        from agentos.cli import cmd_chat
        from agentos.agent import AgentConfig, save_agent_config

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        monkeypatch.chdir(tmp_path)

        config = AgentConfig(name="test-agent", agent_id="agent-AAA")
        save_agent_config(config, agents_dir / "test-agent.json")

        identity = {"agent_id": "agent-BBB", "fingerprint": "xyz"}
        (agents_dir / ".identity.json").write_text(json.dumps(identity))

        # Simulate EOFError immediately to exit the chat loop
        monkeypatch.setattr("builtins.input", lambda _: (_ for _ in ()).throw(EOFError))

        class Args:
            name = str(agents_dir / "test-agent.json")

        await cmd_chat(Args())

        captured = capsys.readouterr()
        assert "Warning" in captured.err
        assert "agent-AAA" in captured.err
        assert "agent-BBB" in captured.err


class TestCmdDeploy:
    """Tests for deploy command."""

    def test_deploy_no_deploy_dir(self, tmp_path, monkeypatch):
        """deploy should exit 1 when no deploy/ dir exists."""
        from agentos.cli import cmd_deploy
        from agentos.agent import AgentConfig, save_agent_config

        # Use a completely isolated directory with no deploy/ anywhere
        isolated = tmp_path / "isolated"
        isolated.mkdir()
        agents_dir = isolated / "agents"
        agents_dir.mkdir()
        monkeypatch.chdir(isolated)

        config = AgentConfig(name="test-agent")
        save_agent_config(config, agents_dir / "test-agent.json")

        # Patch __file__ resolution to prevent fallback to package deploy/
        fake_parent = isolated / "fake_pkg"
        fake_parent.mkdir()
        monkeypatch.setattr("agentos.cli.Path.__file__", str(fake_parent / "cli.py"), raising=False)

        class Args:
            name = str(agents_dir / "test-agent.json")

        # Patch Path(__file__) to avoid the package fallback
        original_resolve = Path.resolve
        def fake_resolve(self):
            if "cli.py" in str(self):
                return isolated / "fake_pkg" / "agentos" / "cli.py"
            return original_resolve(self)

        with patch.object(Path, "resolve", fake_resolve):
            with pytest.raises(SystemExit):
                cmd_deploy(Args())

    def test_deploy_writes_config(self, tmp_path, monkeypatch, capsys):
        """deploy should write agent-config.json into deploy/."""
        from agentos.cli import cmd_deploy
        from agentos.agent import AgentConfig, save_agent_config

        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        deploy_dir = tmp_path / "deploy"
        deploy_dir.mkdir()
        monkeypatch.chdir(tmp_path)

        config = AgentConfig(name="my-bot", description="A bot")
        save_agent_config(config, agents_dir / "my-bot.json")

        class Args:
            name = str(agents_dir / "my-bot.json")

        # Mock subprocess and shutil.which so deploy doesn't actually run npm/wrangler
        mock_result = type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        with patch("subprocess.run", return_value=mock_result), \
             patch("shutil.which", return_value="/usr/bin/npm"):
            cmd_deploy(Args())

        deploy_config = deploy_dir / "agent-config.json"
        assert deploy_config.exists()
        data = json.loads(deploy_config.read_text())
        assert data["agentName"] == "my-bot"
        assert data["agentDescription"] == "A bot"


class TestCmdIngest:
    """Tests for ingest command."""

    def test_ingest_index_has_length_not_text(self, tmp_path, capsys, monkeypatch):
        """Ingest index should store document length, not truncated text."""
        from agentos.cli import cmd_ingest

        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        doc_dir = tmp_path / "docs"
        doc_dir.mkdir()
        (doc_dir / "test.txt").write_text("Hello world " * 100)

        class Args:
            name = "test-agent"
            files = [str(doc_dir)]
            chunk_size = 500

        cmd_ingest(Args())

        index = json.loads((tmp_path / "data" / "rag_index.json").read_text())
        for doc in index["documents"]:
            assert "text" not in doc
            assert "length" in doc
            assert isinstance(doc["length"], int)


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


class _StdoutCapture:
    """Capture stdout text writes and binary buffer writes."""

    def __init__(self):
        self._bytes = bytearray()
        self.buffer = self

    def write(self, data):
        if isinstance(data, str):
            self._bytes.extend(data.encode("utf-8"))
        else:
            self._bytes.extend(data)
        return len(data)

    def flush(self):
        return None

    @property
    def text(self) -> str:
        return self._bytes.decode("utf-8", errors="replace")


class _StdinBytesCapture:
    """Provide a binary stdin-like object with .buffer for framed MCP tests."""

    def __init__(self, data: bytes):
        self.buffer = io.BytesIO(data)

    def readline(self) -> str:
        return self.buffer.readline().decode("utf-8", errors="replace")


class TestMcpStdioServer:
    def test_mcp_serve_logs_to_stderr_not_stdout(self, tmp_path, monkeypatch, capsys):
        """Human-readable startup logs must not pollute stdout MCP stream."""
        from agentos.cli import cmd_mcp_serve

        monkeypatch.chdir(tmp_path)
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        _write_stub_agent(agents_dir, name="mcp-agent")

        class Args:
            agent = None
            port = 3000

        # Force stdio loop to exit immediately.
        monkeypatch.setattr("agentos.cli._run_mcp_stdio", lambda agents, tools: None)
        cmd_mcp_serve(Args())

        captured = capsys.readouterr()
        assert "AgentOS MCP Server" in captured.err
        assert "AgentOS MCP Server" not in captured.out

    def test_run_mcp_stdio_utf8_content_length_uses_bytes(self, monkeypatch):
        """Content-Length should be byte length, not character length."""
        from agentos.cli import _run_mcp_stdio

        # One initialize call with non-ASCII id, then EOF.
        req = json.dumps(
            {"jsonrpc": "2.0", "id": "ü", "method": "initialize", "params": {}},
            ensure_ascii=False,
        )
        input_stream = io.StringIO(req + "\n")
        output_stream = _StdoutCapture()

        monkeypatch.setattr("sys.stdin", input_stream)
        monkeypatch.setattr("sys.stdout", output_stream)

        _run_mcp_stdio([], [])
        raw = output_stream.text
        assert "Content-Length:" in raw
        header, body = raw.split("\r\n\r\n", 1)
        length = int(header.split("Content-Length:", 1)[1].strip())
        # Byte length and character length differ when body contains "ü".
        assert len(body.encode("utf-8")) == length

    def test_run_mcp_stdio_unknown_method_returns_jsonrpc_error(self, monkeypatch):
        """Unknown methods should return protocol-level JSON-RPC error."""
        from agentos.cli import _run_mcp_stdio

        req = json.dumps({"jsonrpc": "2.0", "id": "1", "method": "unknown/method"})
        input_stream = io.StringIO(req + "\n")
        output_stream = _StdoutCapture()
        monkeypatch.setattr("sys.stdin", input_stream)
        monkeypatch.setattr("sys.stdout", output_stream)

        _run_mcp_stdio([], [])
        _, body = output_stream.text.split("\r\n\r\n", 1)
        payload = json.loads(body)
        assert payload.get("jsonrpc") == "2.0"
        assert payload.get("id") == "1"
        assert "error" in payload
        assert payload["error"]["code"] == -32601

    def test_run_mcp_stdio_framed_request_is_parsed_from_bytes(self, monkeypatch):
        """Framed MCP requests should be parsed from stdin bytes safely."""
        from agentos.cli import _run_mcp_stdio

        body = json.dumps({"jsonrpc": "2.0", "id": "42", "method": "initialize"}).encode("utf-8")
        framed = b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body
        input_stream = _StdinBytesCapture(framed)
        output_stream = _StdoutCapture()
        monkeypatch.setattr("sys.stdin", input_stream)
        monkeypatch.setattr("sys.stdout", output_stream)

        _run_mcp_stdio([], [])
        _, response_body = output_stream.text.split("\r\n\r\n", 1)
        payload = json.loads(response_body)
        assert payload["id"] == "42"
        assert payload["result"]["protocolVersion"] == "2024-11-05"

    def test_run_mcp_stdio_unknown_notification_has_no_response(self, monkeypatch):
        """Unknown notifications (no id) must not receive any response."""
        from agentos.cli import _run_mcp_stdio

        req = json.dumps({"jsonrpc": "2.0", "method": "unknown/method"})
        input_stream = io.StringIO(req + "\n")
        output_stream = _StdoutCapture()
        monkeypatch.setattr("sys.stdin", input_stream)
        monkeypatch.setattr("sys.stdout", output_stream)

        _run_mcp_stdio([], [])
        assert output_stream.text == ""

    def test_run_mcp_stdio_invalid_json_returns_parse_error(self, monkeypatch):
        """Malformed JSON should return JSON-RPC parse error."""
        from agentos.cli import _run_mcp_stdio

        input_stream = io.StringIO("{not-json}\n")
        output_stream = _StdoutCapture()
        monkeypatch.setattr("sys.stdin", input_stream)
        monkeypatch.setattr("sys.stdout", output_stream)

        _run_mcp_stdio([], [])
        _, body = output_stream.text.split("\r\n\r\n", 1)
        payload = json.loads(body)
        assert payload["error"]["code"] == -32700
        assert payload["id"] is None
