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
SCHEMA_VERSION = 1

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
    -- Composition snapshot (JSON blob for tools, memory, governance)
    composition_json    TEXT NOT NULL DEFAULT '{}',
    -- Eval fields
    eval_score          REAL,
    eval_passed         INTEGER,
    eval_task_name      TEXT NOT NULL DEFAULT '',
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
        """Create all tables and set schema version. Idempotent."""
        self.conn.executescript(SCHEMA_SQL)
        self.conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self.conn.commit()
        logger.info("Database initialized at %s (schema v%d)", self.path, SCHEMA_VERSION)

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
        with self.tx() as cur:
            cur.execute(
                """INSERT INTO sessions (
                    session_id, agent_id, agent_name, agent_version, model,
                    status, stop_reason, is_finished, error_attribution,
                    step_count, action_count, time_to_first_action_ms,
                    wall_clock_seconds, input_text, output_text,
                    cost_llm_input_usd, cost_llm_output_usd,
                    cost_tool_usd, cost_total_usd,
                    composition_json,
                    eval_score, eval_passed, eval_task_name,
                    created_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?,
                    ?, ?, ?,
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
                    record.get("cost", {}).get("llm_input_cost_usd", 0.0),
                    record.get("cost", {}).get("llm_output_cost_usd", 0.0),
                    record.get("cost", {}).get("tool_cost_usd", 0.0),
                    record.get("cost", {}).get("total_usd", 0.0),
                    json.dumps(comp),
                    record.get("eval_score"),
                    1 if record.get("eval_passed") else (0 if record.get("eval_passed") is not None else None),
                    record.get("eval_task_name", ""),
                    record.get("timestamp", time.time()),
                ),
            )

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
                   "proposals", "episodes", "facts", "procedures", "cost_ledger"]
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
