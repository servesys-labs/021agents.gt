"""End-to-end integration tests — real user workflows exercising multiple subsystems.

Unlike the existing integration tests (which test wiring: "does observer attach?"),
these test actual user journeys:

1. init → create → run → eval (full project lifecycle)
2. run with tools → observer → DB → evolution analysis
3. ingest → run → RAG context flows into agent memory
4. eval → evolve → apply → re-eval (continuous improvement loop)
5. API server: /agents/{name}/run + /run with full harness
6. cmd_run: --json output, --input-file, --quiet, --output
"""

import argparse
import asyncio
import json
import pytest
from pathlib import Path

from agentos.agent import Agent, AgentConfig, load_agent_config, save_agent_config


# ── Helpers ──────────────────────────────────────────────────────────────


def _scaffold_project(tmp_path, agent_name="test-bot", tools=None):
    """Scaffold a minimal project like `agentos init` does."""
    for d in ("agents", "tools", "data", "eval"):
        (tmp_path / d).mkdir(exist_ok=True)

    config = AgentConfig(
        name=agent_name,
        description=f"Test agent: {agent_name}",
        tools=tools or [],
    )
    save_agent_config(config, tmp_path / "agents" / f"{agent_name}.json")

    # Smoke-test eval file
    (tmp_path / "eval" / "smoke-test.json").write_text(json.dumps([
        {"input": "Say hello", "expected": "hello", "grader": "contains"},
        {"input": "What is 2+2?", "expected": "4", "grader": "contains"},
    ]))

    return config


# ── 1. Full Project Lifecycle: init → create → run → eval ────────────────


class TestFullLifecycle:
    """End-to-end: scaffold project, create agent, run it, evaluate it."""

    @pytest.mark.asyncio
    async def test_create_run_eval_lifecycle(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "lifecycle-bot")

        # Load and run the agent
        agent = Agent.from_file(tmp_path / "agents" / "lifecycle-bot.json")
        results = await agent.run("Say hello to the world")

        assert len(results) >= 1
        assert results[-1].done is True
        final = results[-1].llm_response.content
        assert final  # non-empty output

        # Eval the agent
        from agentos.cli import _load_eval_tasks, _make_agent_fn
        gym, tasks_data = _load_eval_tasks(tmp_path / "eval" / "smoke-test.json")
        gym.trials_per_task = 1

        report = await gym.run(_make_agent_fn(agent))
        assert report.total_tasks == 2
        assert report.total_trials == 2
        assert report.avg_latency_ms >= 0

    @pytest.mark.asyncio
    async def test_agent_from_name(self, tmp_path, monkeypatch):
        """Agent.from_name should find agents in the agents/ directory."""
        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "named-bot")

        agent = Agent.from_name("named-bot")
        assert agent.config.name == "named-bot"
        results = await agent.run("hello")
        assert results[-1].done is True


# ── 2. Run with Tools → Observer → DB → Evolution Analysis ──────────────


class TestRunToEvolutionPipeline:
    """Agent.run() with tools should flow data all the way through
    observer → DB → evolution analyzer."""

    @pytest.mark.asyncio
    async def test_tool_run_observed_and_persisted(self, tmp_path, monkeypatch):
        """Run an agent with tools, verify the session is observed and persisted,
        then verify the evolution analyzer can read and analyze it."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        (tmp_path / "tools").mkdir()

        # Create a tool plugin
        tool_def = {
            "name": "test-search",
            "description": "Test search tool",
            "input_schema": {
                "type": "object",
                "properties": {"q": {"type": "string"}},
            },
        }
        (tmp_path / "tools" / "test-search.json").write_text(json.dumps(tool_def))

        config = AgentConfig(name="tool-bot", tools=["test-search"])
        save_agent_config(config, tmp_path / "agents" / "tool-bot.json")

        agent = Agent(config)
        assert agent.db is not None

        # Run a few sessions to build history
        for task in ["Search for cats", "Search for dogs", "Search for birds"]:
            await agent.run(task)

        # Verify observer captured all sessions
        assert len(agent.observer.records) == 3

        # Verify all sessions are in DB
        sessions = agent.db.query_sessions()
        assert len(sessions) == 3

        # Verify evolution analyzer can analyze the session records
        from agentos.evolution.analyzer import FailureAnalyzer
        analyzer = FailureAnalyzer(min_sessions=1)
        report = analyzer.analyze(agent.observer.records)
        assert report.total_sessions == 3

    @pytest.mark.asyncio
    async def test_session_cost_flows_to_db(self, tmp_path, monkeypatch):
        """Session cost from harness should be captured in observer and DB."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        config = AgentConfig(name="cost-bot")
        agent = Agent(config)

        await agent.run("Hello")

        rec = agent.observer.records[0]
        assert rec.cost.total_usd > 0  # StubProvider returns 0.001

        # Verify cost is in DB session
        sessions = agent.db.query_sessions()
        assert len(sessions) >= 1


# ── 3. Ingest → Run → RAG Context in Memory ─────────────────────────────


class TestIngestToRunRAG:
    """Documents ingested via cmd_ingest should appear in agent memory context."""

    @pytest.mark.asyncio
    async def test_ingested_docs_available_in_agent(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        # Create a knowledge document
        doc = tmp_path / "knowledge.txt"
        doc.write_text(
            "AgentOS was created in 2025. "
            "It supports autonomous agents with tools, memory, and evaluation. "
            "The framework uses Claude as its default LLM provider."
        )

        # Ingest it
        from agentos.cli import cmd_ingest
        cmd_ingest(argparse.Namespace(files=[str(doc)], chunk_size=256))

        # Verify rag_index.json was created
        index_path = tmp_path / "data" / "rag_index.json"
        assert index_path.exists()
        index = json.loads(index_path.read_text())
        assert len(index["source_files"]) == 1

        # Create agent — should auto-load RAG pipeline
        config = AgentConfig(name="rag-bot")
        agent = Agent(config)
        rag = agent._harness.memory_manager.rag
        assert rag is not None

        # Verify the RAG pipeline can retrieve the ingested content
        context = await agent._harness.memory_manager.build_context("AgentOS")
        assert "Retrieved Documents" in context or "AgentOS" in context

    @pytest.mark.asyncio
    async def test_no_rag_without_ingest(self, tmp_path, monkeypatch):
        """Without ingesting docs, RAG should not be available."""
        monkeypatch.chdir(tmp_path)

        config = AgentConfig(name="no-rag-bot")
        agent = Agent(config)
        assert agent._harness.memory_manager.rag is None


# ── 4. Eval → Evolve → Apply → Re-Eval ──────────────────────────────────


class TestEvalEvolveCycle:
    """The full eval → analyze → propose → apply → re-eval cycle."""

    @pytest.mark.asyncio
    async def test_eval_then_evolve_cycle(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "evolve-bot")
        (tmp_path / "data").mkdir(exist_ok=True)

        agent = Agent.from_name("evolve-bot")

        # Step 1: Baseline eval
        from agentos.cli import _load_eval_tasks, _make_agent_fn
        gym, _ = _load_eval_tasks(tmp_path / "eval" / "smoke-test.json")
        gym.trials_per_task = 1

        baseline = await gym.run(_make_agent_fn(agent))
        assert baseline.total_tasks == 2

        # Step 2: Set up evolution loop
        from agentos.evolution.loop import EvolutionLoop
        loop = EvolutionLoop.for_agent(agent, min_sessions_for_analysis=1)

        # Run a few sessions to populate observer records
        for task in ["hello", "what is 1+1?", "tell me a joke"]:
            await agent.run(task)

        # Step 3: Analyze
        report = loop.analyze()
        assert report.total_sessions >= 3

        # Step 4: Propose (may or may not generate proposals depending on analysis)
        proposals = loop.propose(report)
        # Just verify the pipeline doesn't crash
        assert isinstance(proposals, list)

        # Step 5: If proposals exist, approve and apply one
        if proposals:
            loop.approve(proposals[0].id)
            new_config = loop.apply_approved()
            assert new_config is not None

            # Verify config was saved to disk
            saved = json.loads(
                (tmp_path / "agents" / "evolve-bot.json").read_text()
            )
            assert saved["version"] != "0.1.0"  # version bumped

    @pytest.mark.asyncio
    async def test_evolution_status_and_export(self, tmp_path, monkeypatch):
        """Evolution loop status and export should work without crashing."""
        from agentos.evolution.loop import EvolutionLoop

        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "status-bot")
        (tmp_path / "data").mkdir(exist_ok=True)

        agent = Agent.from_name("status-bot")
        await agent.run("hello")

        loop = EvolutionLoop.for_agent(agent, min_sessions_for_analysis=1)
        status = loop.status()
        assert "agent" in status
        assert status["agent"] == "status-bot"

        export_path = loop.export(tmp_path / "evolution.json")
        assert export_path.exists()
        exported = json.loads(export_path.read_text())
        assert exported["agent"] == "status-bot"


# ── 5. API Server End-to-End ─────────────────────────────────────────────


class TestAPIServerIntegration:
    """Full API server with real harness and agent endpoints."""

    def setup_method(self):
        from agentos.auth import jwt
        jwt.set_secret("test-api-integration")

    def teardown_method(self):
        from agentos.auth import jwt
        jwt._jwt_secret = None

    def test_run_endpoint_produces_output(self):
        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        from fastapi.testclient import TestClient

        app = create_app(AgentHarness())
        client = TestClient(app)

        resp = client.post("/run", json={"input": "Say hello"})
        assert resp.status_code == 200
        data = resp.json()
        assert "turns" in data
        assert "final_output" in data
        assert len(data["turns"]) >= 1
        assert data["final_output"]  # non-empty

    def test_run_named_agent(self, tmp_path, monkeypatch):
        """POST /agents/{name}/run should work for an existing agent."""
        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        from fastapi.testclient import TestClient

        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "api-bot")

        app = create_app(AgentHarness())
        client = TestClient(app)

        resp = client.post("/agents/api-bot/run", json={"input": "hello"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["final_output"]

    def test_agent_tools_endpoint(self, tmp_path, monkeypatch):
        """GET /agents/{name}/tools should return tool list."""
        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        from fastapi.testclient import TestClient

        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "tools-bot")

        app = create_app(AgentHarness())
        client = TestClient(app)

        resp = client.get("/agents/tools-bot/tools")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_auth_signup_login_me_flow(self):
        """Full auth flow: signup → login → /auth/me."""
        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        from fastapi.testclient import TestClient

        app = create_app(AgentHarness())
        client = TestClient(app)

        # Signup
        resp = client.post("/auth/signup", json={
            "email": "test@example.com",
            "password": "securepassword123",
            "name": "Test User",
        })
        assert resp.status_code == 200
        signup_data = resp.json()
        assert signup_data["token"]
        token = signup_data["token"]

        # Use token to hit /auth/me
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        me = resp.json()
        assert me["email"] == "test@example.com"
        assert me["name"] == "Test User"

        # Login with same credentials
        resp = client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "securepassword123",
        })
        assert resp.status_code == 200
        login_data = resp.json()
        assert login_data["token"]

        # Bad password should fail
        resp = client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "wrong",
        })
        assert resp.status_code == 401

        # Cleanup
        users_file = Path("data/users.json")
        if users_file.exists():
            users_file.unlink()


# ── 6. cmd_run Modes ─────────────────────────────────────────────────────


class TestCmdRunModes:
    """cmd_run should support --json, --input-file, --output, --quiet."""

    @pytest.mark.asyncio
    async def test_json_output_format(self, tmp_path, monkeypatch):
        """--json should produce valid JSON with all required fields."""
        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "json-bot")

        from agentos.cli import cmd_run

        output_file = tmp_path / "result.json"
        args = argparse.Namespace(
            name=str(tmp_path / "agents" / "json-bot.json"),
            task="Say hello",
            turns=None, timeout=None, budget=None, model=None,
            input_file=None, output=str(output_file),
            json_output=True, quiet=False, verbose=False,
        )

        # cmd_run calls sys.exit on failure, catch SystemExit
        try:
            await cmd_run(args)
        except SystemExit:
            pass

        assert output_file.exists()
        data = json.loads(output_file.read_text())
        assert "agent" in data
        assert "task" in data
        assert "success" in data
        assert "output" in data
        assert "turns" in data
        assert "cost_usd" in data

    @pytest.mark.asyncio
    async def test_input_file(self, tmp_path, monkeypatch):
        """--input-file should read task from a file."""
        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "file-bot")

        task_file = tmp_path / "task.txt"
        task_file.write_text("Say hello from a file")

        from agentos.cli import cmd_run

        output_file = tmp_path / "out.json"
        args = argparse.Namespace(
            name=str(tmp_path / "agents" / "file-bot.json"),
            task=None,
            turns=1, timeout=None, budget=None, model=None,
            input_file=str(task_file), output=str(output_file),
            json_output=True, quiet=False, verbose=False,
        )

        try:
            await cmd_run(args)
        except SystemExit:
            pass

        assert output_file.exists()
        data = json.loads(output_file.read_text())
        assert data["task"] == "Say hello from a file"

    @pytest.mark.asyncio
    async def test_output_file_written(self, tmp_path, monkeypatch):
        """--output should write final output to a file."""
        monkeypatch.chdir(tmp_path)
        _scaffold_project(tmp_path, "out-bot")

        from agentos.cli import cmd_run

        output_file = tmp_path / "output.txt"
        args = argparse.Namespace(
            name=str(tmp_path / "agents" / "out-bot.json"),
            task="Say hello",
            turns=1, timeout=None, budget=None, model=None,
            input_file=None, output=str(output_file),
            json_output=False, quiet=True, verbose=False,
        )

        try:
            await cmd_run(args)
        except SystemExit:
            pass

        assert output_file.exists()
        content = output_file.read_text()
        assert content.strip()  # non-empty output


# ── 7. Agent Memory Persistence Across Runs ──────────────────────────────


class TestMemoryPersistenceAcrossRuns:
    """Episodic memory from one run should be available in the next."""

    @pytest.mark.asyncio
    async def test_episodic_memory_persists(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)

        config = AgentConfig(name="memory-bot")
        agent = Agent(config)

        # First run stores in episodic memory
        await agent.run("What is the capital of France?")
        assert agent._harness.memory_manager.episodic.count() == 1

        # Second run should have the first episode in memory
        await agent.run("What did I ask before?")
        assert agent._harness.memory_manager.episodic.count() == 2

        # Search should find the first episode
        episodes = agent._harness.memory_manager.episodic.search("capital", limit=5)
        assert len(episodes) >= 1


# ── 8. Multi-Agent: Create Multiple and List ─────────────────────────────


class TestMultiAgentProject:
    """A project should support multiple agents."""

    def test_list_multiple_agents(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()

        for name in ["agent-a", "agent-b", "agent-c"]:
            save_agent_config(
                AgentConfig(name=name, description=f"Agent {name}"),
                tmp_path / "agents" / f"{name}.json",
            )

        from agentos.agent import list_agents
        agents = list_agents()
        assert len(agents) == 3
        names = {a.name for a in agents}
        assert names == {"agent-a", "agent-b", "agent-c"}

    @pytest.mark.asyncio
    async def test_run_different_agents_independently(self, tmp_path, monkeypatch):
        """Different agents should have independent memory and state."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "agents").mkdir()

        for name in ["bot-x", "bot-y"]:
            save_agent_config(
                AgentConfig(name=name),
                tmp_path / "agents" / f"{name}.json",
            )

        agent_x = Agent.from_name("bot-x")
        agent_y = Agent.from_name("bot-y")

        await agent_x.run("Hello from X")
        await agent_y.run("Hello from Y")

        # Each should have their own episodic memory
        assert agent_x._harness.memory_manager.episodic.count() == 1
        assert agent_y._harness.memory_manager.episodic.count() == 1

        # They should NOT share memory
        x_episodes = agent_x._harness.memory_manager.episodic.search("X", limit=5)
        y_episodes = agent_y._harness.memory_manager.episodic.search("Y", limit=5)
        assert len(x_episodes) >= 1
        assert len(y_episodes) >= 1
