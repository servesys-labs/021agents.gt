"""Tests for the tool plugin registry."""

import json
import pytest

from agentos.tools.registry import ToolPlugin, ToolRegistry


class TestToolPlugin:
    def test_to_mcp_tool(self):
        plugin = ToolPlugin(
            name="search",
            description="Search the web",
            input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
        )
        tool = plugin.to_mcp_tool()
        assert tool.name == "search"
        assert tool.description == "Search the web"

    def test_to_mcp_server(self):
        plugin = ToolPlugin(name="calc", description="Calculator")
        server = plugin.to_mcp_server()
        assert server.name == "calc"
        assert len(server.tools) == 1


class TestToolRegistry:
    def test_programmatic_register(self):
        registry = ToolRegistry(plugins_dir="/nonexistent")
        plugin = ToolPlugin(name="my-tool", description="A tool")
        registry.register(plugin)
        assert registry.get("my-tool") is not None
        assert "my-tool" in registry.names()

    def test_discover_json_tools(self, tmp_path):
        # Create a JSON tool definition
        tool_def = {
            "name": "json-tool",
            "description": "Loaded from JSON",
            "input_schema": {"type": "object"},
        }
        (tmp_path / "json-tool.json").write_text(json.dumps(tool_def))

        registry = ToolRegistry(plugins_dir=tmp_path)
        tools = registry.list_all()
        assert len(tools) == 1
        assert tools[0].name == "json-tool"
        assert tools[0].description == "Loaded from JSON"

    def test_discover_json_array(self, tmp_path):
        """A JSON file can contain an array of tool definitions."""
        tools_def = [
            {"name": "tool-a", "description": "Tool A"},
            {"name": "tool-b", "description": "Tool B"},
        ]
        (tmp_path / "multi.json").write_text(json.dumps(tools_def))

        registry = ToolRegistry(plugins_dir=tmp_path)
        tools = registry.list_all()
        assert len(tools) == 2
        names = [t.name for t in tools]
        assert "tool-a" in names
        assert "tool-b" in names

    def test_discover_python_module(self, tmp_path):
        """A Python file with a TOOLS list is discovered."""
        module_code = '''
TOOLS = [
    {
        "name": "py-tool",
        "description": "From Python module",
        "input_schema": {"type": "object"},
    }
]
'''
        (tmp_path / "my_tool.py").write_text(module_code)

        registry = ToolRegistry(plugins_dir=tmp_path)
        tools = registry.list_all()
        assert len(tools) == 1
        assert tools[0].name == "py-tool"

    def test_empty_directory(self, tmp_path):
        registry = ToolRegistry(plugins_dir=tmp_path)
        assert registry.list_all() == []

    def test_nonexistent_directory(self):
        registry = ToolRegistry(plugins_dir="/does/not/exist")
        assert registry.list_all() == []

    def test_get_returns_none_for_missing(self, tmp_path):
        registry = ToolRegistry(plugins_dir=tmp_path)
        assert registry.get("nonexistent") is None

    def test_to_mcp_client(self, tmp_path):
        tool_def = {"name": "mcp-tool", "description": "For MCP client"}
        (tmp_path / "mcp-tool.json").write_text(json.dumps(tool_def))

        registry = ToolRegistry(plugins_dir=tmp_path)
        client = registry.to_mcp_client()
        tools = client.list_tools()
        assert len(tools) == 1
        assert tools[0].name == "mcp-tool"

    def test_skips_invalid_json(self, tmp_path):
        (tmp_path / "bad.json").write_text("not valid json{{{")
        registry = ToolRegistry(plugins_dir=tmp_path)
        assert registry.list_all() == []

    def test_skips_underscore_python(self, tmp_path):
        """Python files starting with _ are skipped."""
        (tmp_path / "_internal.py").write_text("TOOLS = [{'name': 'hidden'}]")
        registry = ToolRegistry(plugins_dir=tmp_path)
        assert registry.list_all() == []
