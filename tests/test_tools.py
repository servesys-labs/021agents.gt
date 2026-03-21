"""Tests for tool execution and MCP integration."""

import pytest

from agentos.tools.executor import ToolExecutor
from agentos.tools.mcp import MCPClient, MCPServer, MCPTool


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
