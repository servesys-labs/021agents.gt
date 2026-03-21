"""Tests for the SQLite database schema, migrations, and CRUD operations."""

import json
import time
import pytest
from pathlib import Path

from agentos.core.database import AgentDB, SCHEMA_VERSION, create_database


class TestSchemaInit:
    """Tests for fresh database initialization."""

    def test_creates_all_tables(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        expected = [
            "sessions", "turns", "errors",
            "evolution_entries", "proposals",
            "episodes", "facts", "procedures",
            "cost_ledger", "eval_runs", "_meta",
        ]
        for table in expected:
            assert db.table_exists(table), f"Table '{table}' not created"
        db.close()

    def test_schema_version(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        assert db.schema_version() == SCHEMA_VERSION
        db.close()

    def test_sessions_has_new_columns(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        cols = {row[1] for row in db.conn.execute("PRAGMA table_info(sessions)").fetchall()}
        assert "finish_accepted" in cols
        assert "stop_initiated_by" in cols
        assert "benchmark_cost_total_usd" in cols
        assert "benchmark_cost_llm_input_usd" in cols
        assert "eval_conditions_json" in cols
        db.close()

    def test_eval_runs_table_exists(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        cols = {row[1] for row in db.conn.execute("PRAGMA table_info(eval_runs)").fetchall()}
        assert "benchmark_name" in cols
        assert "grader_type" in cols
        assert "protocol" in cols
        assert "benchmark_cost_usd" in cols
        assert "pass_at_1" in cols
        assert "eval_conditions_json" in cols
        db.close()


class TestMigration:
    """Tests for v1 → v2 migration."""

    def _create_v1_db(self, path):
        """Create a v1 database (without the new columns)."""
        import sqlite3
        conn = sqlite3.connect(str(path))
        conn.execute("PRAGMA journal_mode=WAL")
        # Minimal v1 schema — sessions without new columns
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL DEFAULT '',
                agent_name TEXT NOT NULL DEFAULT '',
                agent_version TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'unknown',
                stop_reason TEXT NOT NULL DEFAULT 'completed',
                is_finished INTEGER NOT NULL DEFAULT 0,
                error_attribution TEXT,
                step_count INTEGER NOT NULL DEFAULT 0,
                action_count INTEGER NOT NULL DEFAULT 0,
                time_to_first_action_ms REAL NOT NULL DEFAULT 0.0,
                wall_clock_seconds REAL NOT NULL DEFAULT 0.0,
                input_text TEXT NOT NULL DEFAULT '',
                output_text TEXT NOT NULL DEFAULT '',
                cost_llm_input_usd REAL NOT NULL DEFAULT 0.0,
                cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
                cost_tool_usd REAL NOT NULL DEFAULT 0.0,
                cost_total_usd REAL NOT NULL DEFAULT 0.0,
                composition_json TEXT NOT NULL DEFAULT '{}',
                eval_score REAL,
                eval_passed INTEGER,
                eval_task_name TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                turn_number INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS errors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                tool_name TEXT,
                turn INTEGER NOT NULL DEFAULT 0,
                recoverable INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL DEFAULT 0
            );
            INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '1');
        """)
        conn.commit()
        # Insert a test session
        conn.execute(
            "INSERT INTO sessions (session_id, agent_name, status) VALUES (?, ?, ?)",
            ("test-session-1", "my-agent", "success"),
        )
        conn.commit()
        conn.close()

    def test_migration_adds_columns(self, tmp_path):
        path = tmp_path / "v1.db"
        self._create_v1_db(path)

        db = AgentDB(path)
        assert db.schema_version() == 1

        db.initialize()  # Should trigger migration
        assert db.schema_version() == SCHEMA_VERSION

        cols = {row[1] for row in db.conn.execute("PRAGMA table_info(sessions)").fetchall()}
        assert "finish_accepted" in cols
        assert "stop_initiated_by" in cols
        assert "benchmark_cost_total_usd" in cols
        assert "eval_conditions_json" in cols

        # eval_runs table should be created
        assert db.table_exists("eval_runs")
        db.close()

    def test_migration_preserves_data(self, tmp_path):
        path = tmp_path / "v1.db"
        self._create_v1_db(path)

        db = AgentDB(path)
        db.initialize()

        sessions = db.query_sessions()
        assert len(sessions) == 1
        assert sessions[0]["session_id"] == "test-session-1"
        assert sessions[0]["agent_name"] == "my-agent"
        db.close()

    def test_migration_idempotent(self, tmp_path):
        path = tmp_path / "v1.db"
        self._create_v1_db(path)

        db = AgentDB(path)
        db.initialize()
        db.initialize()  # Should not fail
        assert db.schema_version() == SCHEMA_VERSION
        db.close()


class TestSessionPersistence:
    """Tests for session insert with new fields."""

    def test_insert_session_with_new_fields(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        record = {
            "session_id": "sess-001",
            "agent_name": "test-agent",
            "timestamp": time.time(),
            "composition": {"agent_id": "a1", "agent_name": "test-agent", "model": "claude"},
            "status": "success",
            "stop_reason": "completed",
            "stop_initiated_by": "agent",
            "is_finished": True,
            "finish_accepted": True,
            "error_attribution": None,
            "step_count": 3,
            "action_count": 5,
            "time_to_first_action_ms": 120.0,
            "wall_clock_seconds": 2.5,
            "input_text": "hello",
            "output_text": "world",
            "cost": {"llm_input_cost_usd": 0.01, "llm_output_cost_usd": 0.02, "tool_cost_usd": 0.0, "total_usd": 0.03},
            "benchmark_cost": {"llm_input_cost_usd": 0.001, "llm_output_cost_usd": 0.002, "tool_cost_usd": 0.0, "total_usd": 0.003},
            "eval_score": 0.95,
            "eval_passed": True,
            "eval_task_name": "greeting",
            "eval_conditions": {"seed": 42, "perturbation": True},
        }
        db.insert_session(record)

        rows = db.query_sessions()
        assert len(rows) == 1
        row = rows[0]
        assert row["session_id"] == "sess-001"
        assert row["finish_accepted"] == 1
        assert row["stop_initiated_by"] == "agent"
        assert row["benchmark_cost_total_usd"] == pytest.approx(0.003)
        assert row["benchmark_cost_llm_input_usd"] == pytest.approx(0.001)
        assert json.loads(row["eval_conditions_json"]) == {"seed": 42, "perturbation": True}
        db.close()

    def test_insert_session_finish_accepted_none(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        record = {
            "session_id": "sess-002",
            "composition": {},
            "cost": {},
            "benchmark_cost": {},
        }
        db.insert_session(record)
        rows = db.query_sessions()
        assert rows[0]["finish_accepted"] is None
        db.close()


class TestTurnsPersistence:
    """Tests for turn-level data persistence."""

    def test_insert_turns(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        db.insert_session({
            "session_id": "sess-t1",
            "composition": {},
            "cost": {},
            "benchmark_cost": {},
        })

        turns = [
            {
                "turn_number": 1,
                "model_used": "claude-sonnet",
                "input_tokens": 100,
                "output_tokens": 50,
                "latency_ms": 250.0,
                "llm_content": "Hello!",
                "cost": {"llm_input_cost_usd": 0.001, "llm_output_cost_usd": 0.002, "tool_cost_usd": 0.0, "total_usd": 0.003},
                "tool_calls": [{"name": "search", "arguments": {"q": "test"}}],
                "tool_results": [{"tool": "search", "result": "found"}],
                "errors": [],
            },
            {
                "turn_number": 2,
                "model_used": "claude-sonnet",
                "input_tokens": 200,
                "output_tokens": 100,
                "latency_ms": 300.0,
                "llm_content": "Done.",
                "cost": {"llm_input_cost_usd": 0.002, "llm_output_cost_usd": 0.003, "tool_cost_usd": 0.0, "total_usd": 0.005},
                "tool_calls": [],
                "tool_results": [],
                "errors": [],
            },
        ]
        db.insert_turns("sess-t1", turns)

        rows = db.conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number", ("sess-t1",)
        ).fetchall()
        assert len(rows) == 2
        assert rows[0]["turn_number"] == 1
        assert rows[0]["model_used"] == "claude-sonnet"
        assert rows[0]["input_tokens"] == 100
        assert rows[0]["cost_total_usd"] == pytest.approx(0.003)
        assert json.loads(rows[0]["tool_calls_json"])[0]["name"] == "search"
        assert rows[1]["turn_number"] == 2
        assert rows[1]["llm_content"] == "Done."
        db.close()


class TestEvalRunPersistence:
    """Tests for eval_runs table."""

    def test_insert_eval_run(self, tmp_path):
        db = create_database(tmp_path / "test.db")
        report = {
            "agent_name": "my-agent",
            "agent_version": "0.2.0",
            "model": "claude-sonnet",
            "benchmark_name": "smoke-test",
            "benchmark_version": "1.0",
            "grader_type": "contains",
            "protocol": "agentos",
            "total_tasks": 3,
            "total_trials": 9,
            "pass_count": 7,
            "fail_count": 2,
            "error_count": 0,
            "pass_rate": 0.778,
            "avg_score": 0.85,
            "avg_latency_ms": 150.0,
            "total_cost_usd": 0.05,
            "benchmark_cost_usd": 0.002,
            "avg_tool_calls": 2.0,
            "tool_efficiency": 0.35,
            "pass_at_1": 0.67,
            "pass_at_3": 0.95,
            "eval_conditions": {"seed": 42, "perturbation": False},
        }
        row_id = db.insert_eval_run(report)
        assert row_id > 0

        rows = db.conn.execute("SELECT * FROM eval_runs WHERE id = ?", (row_id,)).fetchall()
        assert len(rows) == 1
        row = dict(rows[0])
        assert row["agent_name"] == "my-agent"
        assert row["benchmark_name"] == "smoke-test"
        assert row["pass_rate"] == pytest.approx(0.778)
        assert row["benchmark_cost_usd"] == pytest.approx(0.002)
        assert row["pass_at_1"] == pytest.approx(0.67)
        assert json.loads(row["eval_conditions_json"]) == {"seed": 42, "perturbation": False}
        db.close()


class TestObserverTurnPersistence:
    """Tests that the Observer actually writes turns to the DB."""

    @pytest.mark.asyncio
    async def test_observer_persists_turns(self, tmp_path):
        from agentos.core.events import Event, EventBus, EventType
        from agentos.evolution.observer import Observer

        db = create_database(tmp_path / "test.db")
        bus = EventBus()
        observer = Observer(event_bus=bus, db=db)
        observer.attach(agent_name="test-agent", agent_config={"model": "test"})

        # Simulate a session
        await bus.emit(Event(type=EventType.SESSION_START, data={"input": "hello"}))
        await bus.emit(Event(type=EventType.TURN_START, data={"turn": 1}))
        await bus.emit(Event(type=EventType.LLM_REQUEST, data={}))
        await bus.emit(Event(type=EventType.LLM_RESPONSE, data={
            "model": "claude", "content": "Hi!", "cost_usd": 0.01,
            "input_tokens": 10, "output_tokens": 5,
        }))
        await bus.emit(Event(type=EventType.TURN_END, data={"turn": 1}))
        await bus.emit(Event(type=EventType.SESSION_END, data={}))

        # Check sessions table
        sessions = db.query_sessions()
        assert len(sessions) == 1

        # Check turns table is populated
        rows = db.conn.execute("SELECT * FROM turns").fetchall()
        assert len(rows) == 1
        assert rows[0]["turn_number"] == 1
        assert rows[0]["model_used"] == "claude"
        db.close()
