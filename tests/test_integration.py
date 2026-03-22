"""Integration tests — verify all systems are wired together, not isolated.

These tests check that:
1. Agent auto-attaches observer + DB on construction
2. cmd_run sessions get persisted to SQLite
3. cmd_eval persists eval_runs to SQLite
4. Evolution loop reads feedback from DB
5. Every code path leaves a trace in the database
"""

import json
import pytest
from pathlib import Path
from unittest.mock import patch

from agentos.agent import Agent, AgentConfig, save_agent_config


def _init_project(tmp_path):
    """Set up a minimal project structure (like agentos init)."""
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    config = AgentConfig(name="test-bot", description="integration test")
    save_agent_config(config, agents_dir / "test-bot.json")
    return agents_dir / "test-bot.json"


class TestAgentAutoObservability:
    """Agent should auto-attach observer and DB when data/ exists."""

    def test_agent_gets_observer(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        config = AgentConfig(name="bot")
        agent = Agent(config)
        assert agent.observer is not None
        assert agent.tracer is not None

    def test_agent_gets_db_when_data_dir_exists(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        config = AgentConfig(name="bot")
        agent = Agent(config)
        assert agent.db is not None
        assert agent.db.table_exists("sessions")
        assert agent.db.table_exists("spans")
        assert agent.db.table_exists("feedback")

    def test_agent_no_db_without_data_dir(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        # No data/ dir
        config = AgentConfig(name="bot")
        agent = Agent(config)
        assert agent.db is None
        # Observer still works (just no persistence)
        assert agent.observer is not None

    @pytest.mark.asyncio
    async def test_run_creates_session_record(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        config = AgentConfig(name="bot")
        agent = Agent(config)

        await agent.run("hello")

        # Observer should have captured a session
        assert len(agent.observer.records) == 1
        rec = agent.observer.records[0]
        assert rec.status in ("success", "error")
        assert rec.is_finished

    @pytest.mark.asyncio
    async def test_run_persists_to_db(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        config = AgentConfig(name="bot")
        agent = Agent(config)

        await agent.run("hello")

        # Session should be in DB
        sessions = agent.db.query_sessions()
        assert len(sessions) >= 1
        assert sessions[0]["agent_name"] == "bot"

    @pytest.mark.asyncio
    async def test_run_persists_turns_to_db(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        config = AgentConfig(name="bot")
        agent = Agent(config)

        await agent.run("hello")

        # Turns should be populated (not empty like before)
        sessions = agent.db.query_sessions()
        if sessions:
            rows = agent.db.conn.execute(
                "SELECT * FROM turns WHERE session_id = ?",
                (sessions[0]["session_id"],)
            ).fetchall()
            assert len(rows) >= 1


class TestEvalPersistence:
    """cmd_eval should persist eval runs to the database."""

    @pytest.mark.asyncio
    async def test_eval_persists_eval_run(self, tmp_path, monkeypatch):
        from agentos.cli import cmd_eval, _load_eval_tasks

        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        save_agent_config(
            AgentConfig(name="eval-bot"),
            agents_dir / "eval-bot.json",
        )

        tasks_file = tmp_path / "tasks.json"
        tasks_file.write_text(json.dumps([
            {"input": "hi", "expected": "hello", "grader": "contains"},
        ]))

        args = type("Args", (), {
            "name": str(agents_dir / "eval-bot.json"),
            "tasks_file": str(tasks_file),
            "trials": 1,
        })()

        await cmd_eval(args)

        # Check eval_runs table
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        rows = db.conn.execute("SELECT * FROM eval_runs").fetchall()
        assert len(rows) >= 1
        row = dict(rows[0])
        assert row["agent_name"] == "eval-bot"
        assert row["total_tasks"] == 1
        db.close()


class TestFeedbackIntegration:
    """Feedback should flow into the evolution analyzer."""

    def test_analyzer_reads_feedback(self, tmp_path, monkeypatch):
        from agentos.core.database import create_database
        from agentos.evolution.analyzer import AnalysisReport, FailureAnalyzer

        db = create_database(tmp_path / "test.db")

        # Insert session + feedback
        db.insert_session({
            "session_id": "sess-fb1",
            "composition": {"agent_name": "bot"},
            "cost": {}, "benchmark_cost": {},
        })
        db.insert_feedback(session_id="sess-fb1", rating=-1, comment="Wrong answer")
        db.insert_feedback(session_id="sess-fb1", rating=-1, comment="Still wrong")
        db.insert_feedback(session_id="sess-fb1", rating=1, comment="Good")

        # Analyzer should incorporate feedback
        analyzer = FailureAnalyzer()
        report = AnalysisReport(total_sessions=3, success_rate=0.33)
        feedback = db.feedback_summary()
        analyzer.incorporate_feedback(report, feedback)

        # Should have a feedback recommendation
        assert any("feedback" in r.lower() for r in report.recommendations)
        db.close()


class TestApplyOverridesReattaches:
    """apply_overrides should re-attach observability."""

    def test_observer_reattached_after_override(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        config = AgentConfig(name="bot")
        agent = Agent(config)

        old_observer = agent.observer
        agent.apply_overrides(turns=10)

        # Observer should be re-attached (new instance on new harness)
        assert agent.observer is not None
        assert agent.observer is not old_observer
