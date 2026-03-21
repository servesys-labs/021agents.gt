"""Tests for the CLI commands."""

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
