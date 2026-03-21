"""SQLite database — the agent's single-file persistent brain.

Why SQLite:
  - Zero dependencies (Python stdlib)
  - Single file (data/agent.db) — deploys with the agent
  - WAL mode — concurrent readers + single writer, no corruption
  - Indexes — query sessions by agent_id, timestamp, status
  - Atomic transactions — no half-written data on crash
  - Cloudflare D1 compatible — same schema works at the edge

Schema covers:
  - Sessions & turns (replaces sessions.jsonl)
  - Evolution ledger (replaces ledger.json)
  - Proposals / review queue (replaces proposals.json)
  - Memory tiers: episodes, facts, procedures (previously RAM-only)
  - Cost ledger (persistent cost tracking)
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

logger = logging.getLogger(__name__)

# Current schema version — bump when you add migrations
SCHEMA_VERSION = 2

# ── Schema DDL ───────────────────────────────────────────────────────────────

SCHEMA_SQL = """\
-- Schema version tracking
CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════
-- SESSIONS — replaces sessions.jsonl
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL DEFAULT '',
    agent_name          TEXT NOT NULL DEFAULT '',
    agent_version       TEXT NOT NULL DEFAULT '',
    model               TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'unknown',  -- success/error/timeout
    stop_reason         TEXT NOT NULL DEFAULT 'completed',
    is_finished         INTEGER NOT NULL DEFAULT 0,
    error_attribution   TEXT,
    step_count          INTEGER NOT NULL DEFAULT 0,
    action_count        INTEGER NOT NULL DEFAULT 0,
    time_to_first_action_ms REAL NOT NULL DEFAULT 0.0,
    wall_clock_seconds  REAL NOT NULL DEFAULT 0.0,
    input_text          TEXT NOT NULL DEFAULT '',
    output_text         TEXT NOT NULL DEFAULT '',
    -- Cost breakdown
    cost_llm_input_usd  REAL NOT NULL DEFAULT 0.0,
    cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
    cost_tool_usd       REAL NOT NULL DEFAULT 0.0,
    cost_total_usd      REAL NOT NULL DEFAULT 0.0,
    -- Benchmark cost (eval infrastructure — grader LLM calls, etc.)
    benchmark_cost_llm_input_usd  REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_tool_usd       REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_total_usd      REAL NOT NULL DEFAULT 0.0,
    -- Composition snapshot (JSON blob for tools, memory, governance)
    composition_json    TEXT NOT NULL DEFAULT '{}',
    -- Session semantics (EEE agentic extensions)
    finish_accepted     INTEGER,  -- NULL=unknown, 0=rejected, 1=accepted
    stop_initiated_by   TEXT NOT NULL DEFAULT '',  -- agent/benchmark/infrastructure
    -- Eval fields
    eval_score          REAL,
    eval_passed         INTEGER,
    eval_task_name      TEXT NOT NULL DEFAULT '',
    -- Eval conditions (queryable columns, not buried in JSON)
    eval_conditions_json TEXT NOT NULL DEFAULT '{}',
    -- Timestamps
    created_at          REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_name ON sessions(agent_name);

-- ═══════════════════════════════════════════════════════════════════════════
-- TURNS — per-turn detail within a session
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(session_id),
    turn_number     INTEGER NOT NULL,
    model_used      TEXT NOT NULL DEFAULT '',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    latency_ms      REAL NOT NULL DEFAULT 0.0,
    llm_content     TEXT NOT NULL DEFAULT '',
    -- Cost for this turn
    cost_llm_input_usd  REAL NOT NULL DEFAULT 0.0,
    cost_llm_output_usd REAL NOT NULL DEFAULT 0.0,
    cost_tool_usd       REAL NOT NULL DEFAULT 0.0,
    cost_total_usd      REAL NOT NULL DEFAULT 0.0,
    -- Tool calls/results as JSON arrays
    tool_calls_json     TEXT NOT NULL DEFAULT '[]',
    tool_results_json   TEXT NOT NULL DEFAULT '[]',
    errors_json         TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- ERRORS — structured error log (queryable across sessions)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS errors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(session_id),
    source      TEXT NOT NULL,  -- llm/tool/governance/memory/timeout/unknown
    message     TEXT NOT NULL,
    tool_name   TEXT,
    turn        INTEGER NOT NULL DEFAULT 0,
    recoverable INTEGER NOT NULL DEFAULT 1,
    created_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_errors_session ON errors(session_id);
CREATE INDEX IF NOT EXISTS idx_errors_source ON errors(source);

-- ═══════════════════════════════════════════════════════════════════════════
-- EVOLUTION LEDGER — replaces ledger.json
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS evolution_entries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    version           TEXT NOT NULL,
    previous_version  TEXT NOT NULL,
    proposal_id       TEXT NOT NULL DEFAULT '',
    proposal_title    TEXT NOT NULL DEFAULT '',
    category          TEXT NOT NULL DEFAULT '',
    modification_json TEXT NOT NULL DEFAULT '{}',
    previous_config_json TEXT NOT NULL DEFAULT '{}',
    new_config_json   TEXT NOT NULL DEFAULT '{}',
    reviewer          TEXT NOT NULL DEFAULT '',
    reviewer_note     TEXT NOT NULL DEFAULT '',
    metrics_before_json TEXT NOT NULL DEFAULT '{}',
    metrics_after_json  TEXT NOT NULL DEFAULT '{}',
    impact_json       TEXT NOT NULL DEFAULT '{}',
    created_at        REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_evo_version ON evolution_entries(version);

-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSALS — replaces proposals.json
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS proposals (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL DEFAULT '',
    rationale       TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT '',
    modification_json TEXT NOT NULL DEFAULT '{}',
    priority        REAL NOT NULL DEFAULT 0.0,
    evidence_json   TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending',
    surfaced        INTEGER NOT NULL DEFAULT 0,
    applied_version TEXT NOT NULL DEFAULT '',
    reviewer_note   TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    reviewed_at     REAL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_priority ON proposals(priority);

-- ═══════════════════════════════════════════════════════════════════════════
-- MEMORY: EPISODES — replaces in-memory list (now persistent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS episodes (
    id          TEXT PRIMARY KEY,
    input       TEXT NOT NULL DEFAULT '',
    output      TEXT NOT NULL DEFAULT '',
    outcome     TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- MEMORY: FACTS (semantic) — replaces in-memory dict (now persistent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS facts (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL DEFAULT '""',
    embedding_json TEXT NOT NULL DEFAULT '[]',
    metadata_json  TEXT NOT NULL DEFAULT '{}',
    created_at  REAL NOT NULL DEFAULT (unixepoch('now')),
    updated_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- MEMORY: PROCEDURES — replaces in-memory dict (now persistent)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS procedures (
    name            TEXT PRIMARY KEY,
    description     TEXT NOT NULL DEFAULT '',
    steps_json      TEXT NOT NULL DEFAULT '[]',
    success_count   INTEGER NOT NULL DEFAULT 0,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    last_used       REAL NOT NULL DEFAULT (unixepoch('now'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- COST LEDGER — persistent cost tracking per session
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cost_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL DEFAULT '',
    agent_name  TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL NOT NULL DEFAULT 0.0,
    created_at  REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_cost_created ON cost_ledger(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- EVAL RUNS — aggregate eval reports (one row per `agentos eval` invocation)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS eval_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name      TEXT NOT NULL DEFAULT '',
    agent_version   TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    benchmark_name  TEXT NOT NULL DEFAULT '',
    benchmark_version TEXT NOT NULL DEFAULT '',
    grader_type     TEXT NOT NULL DEFAULT '',
    protocol        TEXT NOT NULL DEFAULT 'agentos',
    -- Aggregate metrics
    total_tasks     INTEGER NOT NULL DEFAULT 0,
    total_trials    INTEGER NOT NULL DEFAULT 0,
    pass_count      INTEGER NOT NULL DEFAULT 0,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    pass_rate       REAL NOT NULL DEFAULT 0.0,
    avg_score       REAL NOT NULL DEFAULT 0.0,
    avg_latency_ms  REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_usd REAL NOT NULL DEFAULT 0.0,
    avg_tool_calls  REAL NOT NULL DEFAULT 0.0,
    tool_efficiency REAL NOT NULL DEFAULT 1.0,
    pass_at_1       REAL,
    pass_at_3       REAL,
    -- Eval conditions
    eval_conditions_json TEXT NOT NULL DEFAULT '{}',
    -- Timestamps
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_agent ON eval_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- SPANS — structured trace spans with parent-child hierarchy
-- "Traces are the source of truth for agents" — Mikyo King, Arize AI
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS spans (
    span_id         TEXT PRIMARY KEY,
    trace_id        TEXT NOT NULL,
    parent_span_id  TEXT,
    session_id      TEXT,
    name            TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL DEFAULT '',  -- session/turn/llm/tool/sub_agent/memory/governance
    status          TEXT NOT NULL DEFAULT 'ok',
    start_time      REAL NOT NULL DEFAULT 0.0,
    end_time        REAL NOT NULL DEFAULT 0.0,
    duration_ms     REAL NOT NULL DEFAULT 0.0,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    events_json     TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- FEEDBACK — human feedback on agent outputs (thumbs up/down, corrections)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feedback (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    turn_number     INTEGER,
    rating          INTEGER NOT NULL DEFAULT 0,  -- -1=bad, 0=neutral, 1=good
    correction      TEXT NOT NULL DEFAULT '',     -- Human-provided corrected output
    comment         TEXT NOT NULL DEFAULT '',     -- Free-text feedback
    tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array of tags
    source          TEXT NOT NULL DEFAULT 'human', -- human/auto/llm
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
"""

# ── Migration from v1 → v2 ─────────────────────────────────────────────────

MIGRATION_V1_TO_V2 = """\
-- Add benchmark cost columns to sessions
ALTER TABLE sessions ADD COLUMN benchmark_cost_llm_input_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE sessions ADD COLUMN benchmark_cost_llm_output_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE sessions ADD COLUMN benchmark_cost_tool_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE sessions ADD COLUMN benchmark_cost_total_usd REAL NOT NULL DEFAULT 0.0;

-- Add session semantics columns
ALTER TABLE sessions ADD COLUMN finish_accepted INTEGER;
ALTER TABLE sessions ADD COLUMN stop_initiated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN eval_conditions_json TEXT NOT NULL DEFAULT '{}';

-- Create eval_runs table
CREATE TABLE IF NOT EXISTS eval_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name      TEXT NOT NULL DEFAULT '',
    agent_version   TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    benchmark_name  TEXT NOT NULL DEFAULT '',
    benchmark_version TEXT NOT NULL DEFAULT '',
    grader_type     TEXT NOT NULL DEFAULT '',
    protocol        TEXT NOT NULL DEFAULT 'agentos',
    total_tasks     INTEGER NOT NULL DEFAULT 0,
    total_trials    INTEGER NOT NULL DEFAULT 0,
    pass_count      INTEGER NOT NULL DEFAULT 0,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    pass_rate       REAL NOT NULL DEFAULT 0.0,
    avg_score       REAL NOT NULL DEFAULT 0.0,
    avg_latency_ms  REAL NOT NULL DEFAULT 0.0,
    total_cost_usd  REAL NOT NULL DEFAULT 0.0,
    benchmark_cost_usd REAL NOT NULL DEFAULT 0.0,
    avg_tool_calls  REAL NOT NULL DEFAULT 0.0,
    tool_efficiency REAL NOT NULL DEFAULT 1.0,
    pass_at_1       REAL,
    pass_at_3       REAL,
    eval_conditions_json TEXT NOT NULL DEFAULT '{}',
    created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_agent ON eval_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at);
"""


# ── Database class ───────────────────────────────────────────────────────────


class AgentDB:
    """SQLite database for agent persistence.

    Usage:
        db = AgentDB("data/agent.db")
        db.initialize()  # Creates tables + WAL mode

        with db.tx() as cur:
            cur.execute("INSERT INTO episodes ...")

        db.close()
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._conn: sqlite3.Connection | None = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = self._connect()
        return self._conn

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Performance pragmas
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def initialize(self) -> None:
        """Create all tables and set schema version. Runs migrations for existing DBs."""
        current = self.schema_version()

        if current == 0:
            # Fresh database — create everything from scratch
            self.conn.executescript(SCHEMA_SQL)
        else:
            # Existing database — apply migrations
            self._migrate(current)

        self.conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self.conn.commit()
        logger.info("Database initialized at %s (schema v%d)", self.path, SCHEMA_VERSION)

    def _migrate(self, from_version: int) -> None:
        """Apply schema migrations incrementally."""
        if from_version < 2:
            logger.info("Migrating database from v%d to v2", from_version)
            # ALTER TABLE doesn't support IF NOT EXISTS, so check first
            existing_cols = {
                row[1]
                for row in self.conn.execute("PRAGMA table_info(sessions)").fetchall()
            }
            for stmt in MIGRATION_V1_TO_V2.split(";"):
                stmt = stmt.strip()
                if not stmt:
                    continue
                # Skip ALTER TABLE for columns that already exist
                if "ALTER TABLE" in stmt and "ADD COLUMN" in stmt:
                    col_name = stmt.split("ADD COLUMN")[1].strip().split()[0]
                    if col_name in existing_cols:
                        continue
                try:
                    self.conn.execute(stmt)
                except sqlite3.OperationalError as exc:
                    if "duplicate column" not in str(exc).lower() and "already exists" not in str(exc).lower():
                        raise
            self.conn.commit()

    @contextmanager
    def tx(self) -> Generator[sqlite3.Cursor, None, None]:
        """Transaction context manager. Auto-commits on success, rolls back on error."""
        cur = self.conn.cursor()
        try:
            yield cur
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    # ── Schema info ──────────────────────────────────────────────────────

    def schema_version(self) -> int:
        try:
            row = self.conn.execute(
                "SELECT value FROM _meta WHERE key = 'schema_version'"
            ).fetchone()
            return int(row["value"]) if row else 0
        except sqlite3.OperationalError:
            return 0

    def table_exists(self, name: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        return row is not None

    # ── Session CRUD ─────────────────────────────────────────────────────

    def insert_session(self, record: dict[str, Any]) -> None:
        """Insert a complete session record (from SessionRecord.to_dict())."""
        comp = record.get("composition", {})
        cost = record.get("cost", {})
        bench_cost = record.get("benchmark_cost", {})
        finish_accepted = record.get("finish_accepted")
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO sessions (
                    session_id, agent_id, agent_name, agent_version, model,
                    status, stop_reason, is_finished, error_attribution,
                    step_count, action_count, time_to_first_action_ms,
                    wall_clock_seconds, input_text, output_text,
                    cost_llm_input_usd, cost_llm_output_usd,
                    cost_tool_usd, cost_total_usd,
                    benchmark_cost_llm_input_usd, benchmark_cost_llm_output_usd,
                    benchmark_cost_tool_usd, benchmark_cost_total_usd,
                    composition_json,
                    finish_accepted, stop_initiated_by,
                    eval_score, eval_passed, eval_task_name,
                    eval_conditions_json,
                    created_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, ?,
                    ?,
                    ?, ?,
                    ?, ?, ?,
                    ?,
                    ?
                )""",
                (
                    record["session_id"],
                    comp.get("agent_id", ""),
                    comp.get("agent_name", record.get("agent_name", "")),
                    comp.get("agent_version", ""),
                    comp.get("model", ""),
                    record.get("status", "unknown"),
                    record.get("stop_reason", "completed"),
                    1 if record.get("is_finished") else 0,
                    record.get("error_attribution"),
                    record.get("step_count", 0),
                    record.get("action_count", 0),
                    record.get("time_to_first_action_ms", 0.0),
                    record.get("wall_clock_seconds", 0.0),
                    record.get("input_text", ""),
                    record.get("output_text", ""),
                    cost.get("llm_input_cost_usd", 0.0),
                    cost.get("llm_output_cost_usd", 0.0),
                    cost.get("tool_cost_usd", 0.0),
                    cost.get("total_usd", 0.0),
                    bench_cost.get("llm_input_cost_usd", 0.0),
                    bench_cost.get("llm_output_cost_usd", 0.0),
                    bench_cost.get("tool_cost_usd", 0.0),
                    bench_cost.get("total_usd", 0.0),
                    json.dumps(comp),
                    1 if finish_accepted else (0 if finish_accepted is not None else None),
                    record.get("stop_initiated_by", ""),
                    record.get("eval_score"),
                    1 if record.get("eval_passed") else (0 if record.get("eval_passed") is not None else None),
                    record.get("eval_task_name", ""),
                    json.dumps(record.get("eval_conditions", {})) if record.get("eval_conditions") else "{}",
                    record.get("timestamp", time.time()),
                ),
            )

    def insert_turns(self, session_id: str, turns: list[dict[str, Any]]) -> None:
        """Insert turn-level records for a session."""
        with self.tx() as cur:
            for turn in turns:
                cost = turn.get("cost", {})
                cur.execute(
                    """INSERT INTO turns (
                        session_id, turn_number, model_used,
                        input_tokens, output_tokens, latency_ms, llm_content,
                        cost_llm_input_usd, cost_llm_output_usd,
                        cost_tool_usd, cost_total_usd,
                        tool_calls_json, tool_results_json, errors_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        session_id,
                        turn.get("turn_number", 0),
                        turn.get("model_used", ""),
                        turn.get("input_tokens", 0),
                        turn.get("output_tokens", 0),
                        turn.get("latency_ms", 0.0),
                        turn.get("llm_content", ""),
                        cost.get("llm_input_cost_usd", 0.0),
                        cost.get("llm_output_cost_usd", 0.0),
                        cost.get("tool_cost_usd", 0.0),
                        cost.get("total_usd", 0.0),
                        json.dumps(turn.get("tool_calls", [])),
                        json.dumps(turn.get("tool_results", [])),
                        json.dumps([
                            {"source": e.get("source", "unknown"), "message": e.get("message", "")}
                            for e in turn.get("errors", [])
                        ]),
                    ),
                )

    def insert_eval_run(self, report: dict[str, Any]) -> int:
        """Insert an aggregate eval run report. Returns the row id."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO eval_runs (
                    agent_name, agent_version, model,
                    benchmark_name, benchmark_version, grader_type, protocol,
                    total_tasks, total_trials, pass_count, fail_count, error_count,
                    pass_rate, avg_score, avg_latency_ms,
                    total_cost_usd, benchmark_cost_usd,
                    avg_tool_calls, tool_efficiency,
                    pass_at_1, pass_at_3,
                    eval_conditions_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    report.get("agent_name", ""),
                    report.get("agent_version", ""),
                    report.get("model", ""),
                    report.get("benchmark_name", ""),
                    report.get("benchmark_version", ""),
                    report.get("grader_type", ""),
                    report.get("protocol", "agentos"),
                    report.get("total_tasks", 0),
                    report.get("total_trials", 0),
                    report.get("pass_count", 0),
                    report.get("fail_count", 0),
                    report.get("error_count", 0),
                    report.get("pass_rate", 0.0),
                    report.get("avg_score", 0.0),
                    report.get("avg_latency_ms", 0.0),
                    report.get("total_cost_usd", 0.0),
                    report.get("benchmark_cost_usd", 0.0),
                    report.get("avg_tool_calls", 0.0),
                    report.get("tool_efficiency", 1.0),
                    report.get("pass_at_1"),
                    report.get("pass_at_3"),
                    json.dumps(report.get("eval_conditions", {})),
                ),
            )
            return cur.lastrowid

    def insert_session_errors(self, session_id: str, errors: list[dict[str, Any]]) -> None:
        """Insert error records for a session."""
        with self.tx() as cur:
            for err in errors:
                cur.execute(
                    """INSERT INTO errors (session_id, source, message, tool_name, turn, recoverable)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        session_id,
                        err.get("source", "unknown"),
                        err.get("message", ""),
                        err.get("tool_name"),
                        err.get("turn", 0),
                        1 if err.get("recoverable", True) else 0,
                    ),
                )

    def query_sessions(
        self,
        agent_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        since: float | None = None,
    ) -> list[dict[str, Any]]:
        """Query sessions with optional filters."""
        sql = "SELECT * FROM sessions WHERE 1=1"
        params: list[Any] = []

        if agent_id:
            sql += " AND agent_id = ?"
            params.append(agent_id)
        if status:
            sql += " AND status = ?"
            params.append(status)
        if since:
            sql += " AND created_at >= ?"
            params.append(since)

        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def session_summary(self, agent_id: str | None = None) -> dict[str, Any]:
        """Aggregate stats across sessions."""
        where = "WHERE agent_id = ?" if agent_id else ""
        params: tuple[Any, ...] = (agent_id,) if agent_id else ()

        row = self.conn.execute(
            f"""SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
                SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeouts,
                SUM(cost_total_usd) as total_cost,
                AVG(step_count) as avg_turns,
                AVG(wall_clock_seconds) as avg_wall_clock
            FROM sessions {where}""",
            params,
        ).fetchone()

        if not row or row["total"] == 0:
            return {"total_sessions": 0}

        return {
            "total_sessions": row["total"],
            "success_rate": row["successes"] / row["total"],
            "successes": row["successes"],
            "errors": row["errors"],
            "timeouts": row["timeouts"],
            "total_cost_usd": row["total_cost"] or 0.0,
            "avg_turns": row["avg_turns"] or 0.0,
            "avg_wall_clock_seconds": row["avg_wall_clock"] or 0.0,
        }

    # ── Evolution CRUD ───────────────────────────────────────────────────

    def insert_evolution_entry(self, entry: dict[str, Any]) -> None:
        """Insert an evolution ledger entry."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO evolution_entries (
                    version, previous_version, proposal_id, proposal_title,
                    category, modification_json, previous_config_json,
                    new_config_json, reviewer, reviewer_note,
                    metrics_before_json, metrics_after_json, impact_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    entry.get("version", ""),
                    entry.get("previous_version", ""),
                    entry.get("proposal_id", ""),
                    entry.get("proposal_title", ""),
                    entry.get("category", ""),
                    json.dumps(entry.get("modification", {})),
                    json.dumps(entry.get("previous_config", {})),
                    json.dumps(entry.get("new_config", {})),
                    entry.get("reviewer", ""),
                    entry.get("reviewer_note", ""),
                    json.dumps(entry.get("metrics_before", {})),
                    json.dumps(entry.get("metrics_after", {})),
                    json.dumps(entry.get("impact", {})),
                    entry.get("timestamp", time.time()),
                ),
            )

    def query_evolution(self, limit: int = 100) -> list[dict[str, Any]]:
        """Get evolution history, newest first."""
        rows = self.conn.execute(
            "SELECT * FROM evolution_entries ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            for col in ("modification_json", "previous_config_json", "new_config_json",
                         "metrics_before_json", "metrics_after_json", "impact_json"):
                if col in d:
                    d[col.replace("_json", "")] = json.loads(d[col])
            results.append(d)
        return results

    def update_evolution_impact(self, version: str, metrics_after: dict[str, float], impact: dict[str, float]) -> None:
        """Update impact metrics for an evolution entry."""
        with self.tx() as cur:
            cur.execute(
                """UPDATE evolution_entries
                SET metrics_after_json = ?, impact_json = ?
                WHERE version = ?""",
                (json.dumps(metrics_after), json.dumps(impact), version),
            )

    # ── Proposal CRUD ────────────────────────────────────────────────────

    def insert_proposal(self, proposal: dict[str, Any]) -> None:
        """Insert a proposal."""
        with self.tx() as cur:
            cur.execute(
                """INSERT OR REPLACE INTO proposals (
                    id, title, rationale, category, modification_json,
                    priority, evidence_json, status, surfaced,
                    reviewer_note, created_at, reviewed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    proposal["id"],
                    proposal.get("title", ""),
                    proposal.get("rationale", ""),
                    proposal.get("category", ""),
                    json.dumps(proposal.get("modification", {})),
                    proposal.get("priority", 0.0),
                    json.dumps(proposal.get("evidence", {})),
                    proposal.get("status", "pending"),
                    1 if proposal.get("surfaced") else 0,
                    proposal.get("reviewer_note", ""),
                    proposal.get("created_at", time.time()),
                    proposal.get("reviewed_at"),
                ),
            )

    def update_proposal_status(self, proposal_id: str, status: str, note: str = "", reviewed_at: float | None = None) -> None:
        """Update a proposal's review status."""
        with self.tx() as cur:
            cur.execute(
                """UPDATE proposals SET status = ?, reviewer_note = ?, reviewed_at = ?
                WHERE id = ?""",
                (status, note, reviewed_at or time.time(), proposal_id),
            )

    # ── Memory: Episodes ─────────────────────────────────────────────────

    def insert_episode(self, episode: dict[str, Any]) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT OR REPLACE INTO episodes (id, input, output, outcome, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    episode["id"],
                    episode.get("input", ""),
                    episode.get("output", ""),
                    episode.get("outcome", ""),
                    json.dumps(episode.get("metadata", {})),
                    episode.get("timestamp", time.time()),
                ),
            )

    def search_episodes(self, query: str, limit: int = 5, ttl_seconds: float = 0) -> list[dict[str, Any]]:
        """Keyword search over episodes, respecting TTL."""
        sql = "SELECT * FROM episodes"
        params: list[Any] = []
        if ttl_seconds > 0:
            sql += " WHERE created_at >= ?"
            params.append(time.time() - ttl_seconds)
        sql += " ORDER BY created_at DESC"

        rows = self.conn.execute(sql, params).fetchall()

        # Score by keyword overlap (same logic as in-memory version)
        query_lower = query.lower()
        words = query_lower.split()
        scored: list[tuple[int, dict[str, Any]]] = []
        for r in rows:
            text = f"{r['input']} {r['output']}".lower()
            score = sum(1 for w in words if w in text)
            if score > 0:
                scored.append((score, dict(r)))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [d for _, d in scored[:limit]]

    def recent_episodes(self, limit: int = 10) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def count_episodes(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) as cnt FROM episodes").fetchone()
        return row["cnt"] if row else 0

    # ── Memory: Facts ────────────────────────────────────────────────────

    def upsert_fact(self, key: str, value: Any, embedding: list[float] | None = None) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO facts (key, value_json, embedding_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    embedding_json = excluded.embedding_json,
                    updated_at = excluded.updated_at""",
                (key, json.dumps(value), json.dumps(embedding or []), time.time()),
            )

    def get_fact(self, key: str) -> Any | None:
        row = self.conn.execute("SELECT value_json FROM facts WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value_json"]) if row else None

    def search_facts_by_keyword(self, keyword: str, limit: int = 10) -> list[dict[str, Any]]:
        keyword_pattern = f"%{keyword}%"
        rows = self.conn.execute(
            """SELECT key, value_json, embedding_json, metadata_json
            FROM facts
            WHERE key LIKE ? OR value_json LIKE ?
            LIMIT ?""",
            (keyword_pattern, keyword_pattern, limit),
        ).fetchall()
        return [
            {"key": r["key"], "value": json.loads(r["value_json"]),
             "embedding": json.loads(r["embedding_json"])}
            for r in rows
        ]

    def delete_fact(self, key: str) -> bool:
        with self.tx() as cur:
            cur.execute("DELETE FROM facts WHERE key = ?", (key,))
            return cur.rowcount > 0

    def count_facts(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) as cnt FROM facts").fetchone()
        return row["cnt"] if row else 0

    # ── Memory: Procedures ───────────────────────────────────────────────

    def upsert_procedure(self, proc: dict[str, Any]) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO procedures (name, description, steps_json, success_count, failure_count, last_used)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    description = excluded.description,
                    steps_json = excluded.steps_json,
                    success_count = excluded.success_count,
                    failure_count = excluded.failure_count,
                    last_used = excluded.last_used""",
                (
                    proc["name"],
                    proc.get("description", ""),
                    json.dumps(proc.get("steps", [])),
                    proc.get("success_count", 0),
                    proc.get("failure_count", 0),
                    proc.get("last_used", time.time()),
                ),
            )

    def get_procedure(self, name: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM procedures WHERE name = ?", (name,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["steps"] = json.loads(d["steps_json"])
        return d

    def record_procedure_outcome(self, name: str, success: bool) -> None:
        col = "success_count" if success else "failure_count"
        with self.tx() as cur:
            cur.execute(
                f"UPDATE procedures SET {col} = {col} + 1, last_used = ? WHERE name = ?",
                (time.time(), name),
            )

    def find_best_procedures(self, task_description: str, limit: int = 3) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM procedures").fetchall()
        task_words = set(task_description.lower().split())
        scored: list[tuple[float, dict[str, Any]]] = []
        for r in rows:
            d = dict(r)
            desc_words = set(f"{d['name']} {d['description']}".lower().split())
            overlap = len(task_words & desc_words)
            if overlap > 0:
                total = d["success_count"] + d["failure_count"]
                rate = d["success_count"] / total if total else 0.0
                score = overlap * (0.5 + 0.5 * rate)
                d["steps"] = json.loads(d["steps_json"])
                scored.append((score, d))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [d for _, d in scored[:limit]]

    # ── Cost ledger ──────────────────────────────────────────────────────

    def record_cost(
        self,
        session_id: str,
        agent_id: str = "",
        agent_name: str = "",
        model: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost_usd: float = 0.0,
    ) -> None:
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO cost_ledger (session_id, agent_id, agent_name, model, input_tokens, output_tokens, cost_usd)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (session_id, agent_id, agent_name, model, input_tokens, output_tokens, cost_usd),
            )

    def total_cost(self, agent_id: str | None = None, since: float | None = None) -> float:
        sql = "SELECT COALESCE(SUM(cost_usd), 0.0) as total FROM cost_ledger WHERE 1=1"
        params: list[Any] = []
        if agent_id:
            sql += " AND agent_id = ?"
            params.append(agent_id)
        if since:
            sql += " AND created_at >= ?"
            params.append(since)
        row = self.conn.execute(sql, params).fetchone()
        return float(row["total"]) if row else 0.0

    # ── Spans (tracing) ─────────────────────────────────────────────────

    def insert_spans(self, spans: list[dict[str, Any]], session_id: str = "") -> None:
        """Insert trace spans (from Tracer.export())."""
        with self.tx() as cur:
            for s in spans:
                cur.execute(
                    """INSERT OR REPLACE INTO spans (
                        span_id, trace_id, parent_span_id, session_id,
                        name, kind, status,
                        start_time, end_time, duration_ms,
                        attributes_json, events_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        s["span_id"],
                        s["trace_id"],
                        s.get("parent_span_id"),
                        session_id,
                        s.get("name", ""),
                        s.get("kind", ""),
                        s.get("status", "ok"),
                        s.get("start_time", 0.0),
                        s.get("end_time", 0.0),
                        s.get("duration_ms", 0.0),
                        json.dumps(s.get("attributes", {})),
                        json.dumps(s.get("events", [])),
                    ),
                )

    def query_trace(self, trace_id: str) -> list[dict[str, Any]]:
        """Get all spans for a trace, ordered by start time."""
        rows = self.conn.execute(
            "SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time",
            (trace_id,),
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["attributes"] = json.loads(d.pop("attributes_json", "{}"))
            d["events"] = json.loads(d.pop("events_json", "[]"))
            result.append(d)
        return result

    def query_spans(
        self,
        session_id: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Query spans with optional filters — programmatic trace API."""
        sql = "SELECT * FROM spans WHERE 1=1"
        params: list[Any] = []
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY start_time DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["attributes"] = json.loads(d.pop("attributes_json", "{}"))
            d["events"] = json.loads(d.pop("events_json", "[]"))
            result.append(d)
        return result

    # ── Feedback ──────────────────────────────────────────────────────────

    def insert_feedback(
        self,
        session_id: str,
        rating: int,
        turn_number: int | None = None,
        correction: str = "",
        comment: str = "",
        tags: list[str] | None = None,
        source: str = "human",
    ) -> int:
        """Record human (or automated) feedback on an agent output."""
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO feedback (
                    session_id, turn_number, rating, correction, comment, tags, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    turn_number,
                    rating,
                    correction,
                    comment,
                    json.dumps(tags or []),
                    source,
                ),
            )
            return cur.lastrowid

    def query_feedback(
        self,
        session_id: str | None = None,
        rating: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Query feedback records."""
        sql = "SELECT * FROM feedback WHERE 1=1"
        params: list[Any] = []
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if rating is not None:
            sql += " AND rating = ?"
            params.append(rating)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.get("tags", "[]"))
            result.append(d)
        return result

    def feedback_summary(self, agent_name: str | None = None) -> dict[str, Any]:
        """Aggregate feedback stats — programmatic API for the agent."""
        if agent_name:
            rows = self.conn.execute(
                """SELECT f.rating, COUNT(*) as cnt
                FROM feedback f
                JOIN sessions s ON f.session_id = s.session_id
                WHERE s.agent_name = ?
                GROUP BY f.rating""",
                (agent_name,),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT rating, COUNT(*) as cnt FROM feedback GROUP BY rating"
            ).fetchall()
        total = sum(r["cnt"] for r in rows)
        by_rating = {r["rating"]: r["cnt"] for r in rows}
        return {
            "total": total,
            "positive": by_rating.get(1, 0),
            "neutral": by_rating.get(0, 0),
            "negative": by_rating.get(-1, 0),
            "approval_rate": by_rating.get(1, 0) / total if total else 0.0,
        }

    # ── Programmatic Trace Query API (Phase 3 — agent consumes its own telemetry) ──

    def trace_summary(self, session_id: str) -> dict[str, Any]:
        """Build a summary an agent can consume to understand its own performance.

        This is the Phase 3 interface: the agent reads its own traces
        to self-improve without human intervention.
        """
        session_rows = self.conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchall()
        if not session_rows:
            return {}

        session = dict(session_rows[0])
        turns = self.conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number",
            (session_id,),
        ).fetchall()
        errors = self.conn.execute(
            "SELECT * FROM errors WHERE session_id = ?", (session_id,)
        ).fetchall()
        feedback_rows = self.conn.execute(
            "SELECT * FROM feedback WHERE session_id = ?", (session_id,)
        ).fetchall()
        spans = self.query_trace(session.get("session_id", ""))

        return {
            "session": {
                "status": session["status"],
                "stop_reason": session["stop_reason"],
                "stop_initiated_by": session.get("stop_initiated_by", ""),
                "finish_accepted": session.get("finish_accepted"),
                "wall_clock_seconds": session["wall_clock_seconds"],
                "step_count": session["step_count"],
                "action_count": session["action_count"],
                "cost_total_usd": session["cost_total_usd"],
                "benchmark_cost_total_usd": session.get("benchmark_cost_total_usd", 0.0),
            },
            "turns": [
                {
                    "turn": dict(t)["turn_number"],
                    "model": dict(t)["model_used"],
                    "latency_ms": dict(t)["latency_ms"],
                    "tokens": dict(t)["input_tokens"] + dict(t)["output_tokens"],
                    "tool_calls": len(json.loads(dict(t).get("tool_calls_json", "[]"))),
                    "errors": len(json.loads(dict(t).get("errors_json", "[]"))),
                }
                for t in turns
            ],
            "errors": [
                {"source": dict(e)["source"], "message": dict(e)["message"], "turn": dict(e)["turn"]}
                for e in errors
            ],
            "feedback": [
                {"rating": dict(f)["rating"], "comment": dict(f)["comment"]}
                for f in feedback_rows
            ],
            "span_count": len(spans),
        }

    # ── Utilities ────────────────────────────────────────────────────────

    def vacuum(self) -> None:
        """Reclaim space after deletions."""
        self.conn.execute("VACUUM")

    def size_bytes(self) -> int:
        """Get database file size."""
        return self.path.stat().st_size if self.path.exists() else 0

    def stats(self) -> dict[str, Any]:
        """Quick overview of database contents."""
        tables = ["sessions", "turns", "errors", "evolution_entries",
                   "proposals", "episodes", "facts", "procedures", "cost_ledger",
                   "eval_runs", "spans", "feedback"]
        counts: dict[str, int] = {}
        for table in tables:
            try:
                row = self.conn.execute(f"SELECT COUNT(*) as cnt FROM {table}").fetchone()
                counts[table] = row["cnt"] if row else 0
            except sqlite3.OperationalError:
                counts[table] = -1
        return {
            "path": str(self.path),
            "size_bytes": self.size_bytes(),
            "schema_version": self.schema_version(),
            "tables": counts,
        }


def create_database(path: str | Path) -> AgentDB:
    """Create and initialize a new agent database. Idempotent."""
    db = AgentDB(path)
    db.initialize()
    return db
