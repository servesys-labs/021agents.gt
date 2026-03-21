"""Tests for the CLI commands."""

import asyncio
import json
import subprocess
import sys
import pytest
from pathlib import Path
from unittest.mock import patch

from agentos.cli import cmd_init, cmd_list, cmd_tools


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

    class Args:
        pass

    for k, v in defaults.items():
        setattr(Args, k, v)
    return Args()


class TestCmdInit:
    def test_init_creates_structure(self, tmp_path):
        args = _make_init_args(tmp_path)
        cmd_init(args)

        slug = tmp_path.name.replace(" ", "-").lower()
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
        from agentos.cli import DEFAULT_MODEL
        args = _make_init_args(tmp_path, name="my-agent")
        cmd_init(args)

        data = json.loads((tmp_path / "agents" / "my-agent.json").read_text())
        assert data["model"] == DEFAULT_MODEL

        yaml_content = (tmp_path / "agentos.yaml").read_text()
        assert DEFAULT_MODEL in yaml_content


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

    class Args:
        pass

    for k, v in defaults.items():
        setattr(Args, k, v)
    return Args()


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


class TestCmdList:
    def test_list_with_agents(self, tmp_path, capsys):
        from agentos.agent import AgentConfig, save_agent_config
        save_agent_config(
            AgentConfig(name="test-agent", description="A test", model="claude-sonnet-4-20250514"),
            tmp_path / "test-agent.json",
        )

        with patch("agentos.agent.AGENTS_DIR", tmp_path):

            class Args:
                pass

            cmd_list(Args())

        captured = capsys.readouterr()
        assert "test-agent" in captured.out

    def test_list_empty(self, tmp_path, capsys):
        with patch("agentos.agent.AGENTS_DIR", tmp_path):

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
