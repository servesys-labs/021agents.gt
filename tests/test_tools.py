"""Tests for tool execution and MCP integration."""

import pytest

from agentos.tools.executor import ToolExecutor
from agentos.tools.mcp import MCPClient, MCPPrompt, MCPServer, MCPTool


class TestMCPClient:
    def test_register_and_list_tools(self):
        client = MCPClient()
        server = MCPServer(
            name="test-server",
            tools=[MCPTool(name="search", description="Search the web")],
        )
        client.register_server(server)
        tools = client.list_tools()
        assert len(tools) == 1
        assert tools[0].name == "search"

    def test_find_tool(self):
        client = MCPClient()
        tool = MCPTool(name="calc", description="Calculator")
        server = MCPServer(name="math", tools=[tool])
        client.register_server(server)
        result = client.find_tool("calc")
        assert result is not None
        assert result[1].name == "calc"
        assert client.find_tool("nonexistent") is None

    @pytest.mark.asyncio
    async def test_invoke_with_handler(self):
        client = MCPClient()

        async def add(a: int, b: int):
            return a + b

        client.register_handler("add", add)
        result = await client.invoke("add", {"a": 2, "b": 3})
        assert result["result"] == 5

    @pytest.mark.asyncio
    async def test_invoke_missing_handler(self):
        client = MCPClient()
        result = await client.invoke("missing", {})
        assert "error" in result

    def test_prompts(self):
        client = MCPClient()
        prompt = MCPPrompt(
            name="summarize",
            description="Summarize a document",
            template="Summarize the following: {{text}}",
            arguments=[{"name": "text", "type": "string"}],
        )
        server = MCPServer(name="prompt-server", prompts=[prompt])
        client.register_server(server)
        prompts = client.list_prompts()
        assert len(prompts) == 1
        assert prompts[0].name == "summarize"

        found = client.find_prompt("summarize")
        assert found is not None
        rendered = found.render(text="Hello world")
        assert rendered == "Summarize the following: Hello world"
        assert client.find_prompt("nonexistent") is None

    def test_schema_validation_passes(self):
        client = MCPClient()
        tool = MCPTool(
            name="add",
            description="Add numbers",
            input_schema={
                "type": "object",
                "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                "required": ["a", "b"],
            },
        )
        server = MCPServer(name="math", tools=[tool])
        client.register_server(server)
        errors = client.validate_arguments("add", {"a": 1, "b": 2})
        assert errors == []

    def test_schema_validation_missing_required(self):
        client = MCPClient()
        tool = MCPTool(
            name="add",
            description="Add numbers",
            input_schema={
                "type": "object",
                "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                "required": ["a", "b"],
            },
        )
        server = MCPServer(name="math", tools=[tool])
        client.register_server(server)
        errors = client.validate_arguments("add", {"a": 1})
        assert any("Missing required" in e for e in errors)

    def test_schema_validation_wrong_type(self):
        client = MCPClient()
        tool = MCPTool(
            name="greet",
            description="Greet",
            input_schema={
                "type": "object",
                "properties": {"name": {"type": "string"}},
            },
        )
        server = MCPServer(name="test", tools=[tool])
        client.register_server(server)
        errors = client.validate_arguments("greet", {"name": 123})
        assert any("expected type" in e for e in errors)

    @pytest.mark.asyncio
    async def test_invoke_rejects_invalid_schema(self):
        client = MCPClient()
        tool = MCPTool(
            name="typed",
            description="Typed tool",
            input_schema={
                "type": "object",
                "properties": {"x": {"type": "integer"}},
                "required": ["x"],
            },
        )
        server = MCPServer(name="s", tools=[tool])
        client.register_server(server)

        async def handler(x: int):
            return x * 2

        client.register_handler("typed", handler)
        # Missing required arg
        result = await client.invoke("typed", {})
        assert "error" in result
        assert "Schema validation" in result["error"]


class TestToolExecutor:
    @pytest.mark.asyncio
    async def test_execute_with_retries(self):
        client = MCPClient()

        async def fail_tool():
            raise ValueError("boom")

        client.register_handler("fail", fail_tool)
        executor = ToolExecutor(mcp_client=client, max_retries=2)
        result = await executor.execute("fail", {})
        assert "error" in result
        assert result["attempts"] == 2
