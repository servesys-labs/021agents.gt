"""Tests for the CLI commands."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch

from agentos.cli import cmd_init, cmd_list, cmd_tools


class TestCmdInit:
    def test_init_creates_structure(self, tmp_path):
        class Args:
            directory = str(tmp_path)

        cmd_init(Args())
        assert (tmp_path / "agents").is_dir()
        assert (tmp_path / "tools").is_dir()
        assert (tmp_path / "data").is_dir()
        assert (tmp_path / "agents" / "my-agent.json").exists()
        assert (tmp_path / "tools" / "example-search.json").exists()

    def test_init_does_not_overwrite(self, tmp_path):
        agent_path = tmp_path / "agents" / "my-agent.json"
        agent_path.parent.mkdir(parents=True)
        agent_path.write_text('{"name": "custom"}')

        class Args:
            directory = str(tmp_path)

        cmd_init(Args())

        # Should not overwrite existing file
        data = json.loads(agent_path.read_text())
        assert data["name"] == "custom"

    def test_init_agent_is_valid(self, tmp_path):
        class Args:
            directory = str(tmp_path)

        cmd_init(Args())
        from agentos.agent import load_agent_config
        config = load_agent_config(tmp_path / "agents" / "my-agent.json")
        assert config.name == "my-agent"


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
