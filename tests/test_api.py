"""Tests for the API layer."""

import pytest
from fastapi.testclient import TestClient

from agentos.api.app import create_app
from agentos.core.harness import AgentHarness, HarnessConfig
from agentos.llm.provider import LLMResponse
from agentos.llm.router import Complexity, LLMRouter
from agentos.tools.executor import ToolExecutor
from agentos.tools.mcp import MCPClient, MCPServer, MCPTool


class TestAPI:
    def setup_method(self):
        harness = AgentHarness()
        self.app = create_app(harness)
        self.client = TestClient(self.app)

    def test_health(self):
        resp = self.client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "version" in data

    def test_list_tools(self):
        resp = self.client.get("/tools")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_memory_snapshot(self):
        resp = self.client.get("/memory/snapshot")
        assert resp.status_code == 200

    def test_list_agents(self):
        resp = self.client.get("/agents")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_run_named_agent(self):
        # This tests the /agents/{name}/run endpoint
        # It should return 404 for a nonexistent agent
        resp = self.client.post(
            "/agents/nonexistent-xyz/run",
            json={"input": "hello"},
        )
        assert resp.status_code == 404

    def test_get_agent_not_found(self):
        resp = self.client.get("/agents/nonexistent-xyz")
        assert resp.status_code == 404

    def test_run_config_overrides_max_turns(self):
        class AlwaysToolProvider:
            @property
            def model_id(self):
                return "test-model"

            async def complete(self, messages, **kwargs):
                return LLMResponse(
                    content="Working...",
                    model="test-model",
                    tool_calls=[{"id": "tc_1", "name": "search", "arguments": {"q": "x"}}],
                    usage={"input_tokens": 5, "output_tokens": 5},
                    cost_usd=0.001,
                )

        router = LLMRouter()
        provider = AlwaysToolProvider()
        for tier in Complexity:
            router.register(tier, provider)

        mcp = MCPClient()
        mcp.register_server(MCPServer(name="search", tools=[
            MCPTool(name="search", description="Search", input_schema={
                "type": "object",
                "properties": {"q": {"type": "string"}},
            }),
        ]))

        async def search_handler(q=""):
            return f"Results for {q}"

        mcp.register_handler("search", search_handler)

        harness = AgentHarness(
            config=HarnessConfig(max_turns=3),
            llm_router=router,
            tool_executor=ToolExecutor(mcp_client=mcp),
        )
        app = create_app(harness)
        client = TestClient(app)

        # Baseline uses configured max_turns=3 (provider never completes).
        baseline = client.post("/run", json={"input": "keep going"})
        assert baseline.status_code == 200
        assert len(baseline.json()["turns"]) == 3

        # Request-scoped override limits this call to 1 turn.
        overridden = client.post(
            "/run",
            json={"input": "keep going", "config": {"max_turns": 1}},
        )
        assert overridden.status_code == 200
        assert len(overridden.json()["turns"]) == 1
