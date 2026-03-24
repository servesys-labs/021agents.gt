"""PostgreSQL-backed AgentDB compatibility layer.

This is a day-1, Postgres-first backend for control-plane scalability.
It provides an AgentDB-like surface so existing routers can run with
minimal changes.
"""

from __future__ import annotations

import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

from agentos.core.database import (
    AgentDB,
    SCHEMA_SQL,
    SCHEMA_VERSION,
    MIGRATION_V2_TO_V3,
    MIGRATION_V3_TO_V4,
    MIGRATION_V4_TO_V5,
    MIGRATION_V5_TO_V6,
    MIGRATION_V6_TO_V7,
    MIGRATION_V7_TO_V8,
    MIGRATION_V8_TO_V9,
    MIGRATION_V9_TO_V10,
    MIGRATION_V10_TO_V11,
    MIGRATION_V11_TO_V12,
    MIGRATION_V12_TO_V13,
)


def _normalize_sql(sql: str) -> str:
    out = sql
    out = out.replace("unixepoch('now')", "EXTRACT(EPOCH FROM NOW())")
    out = re.sub(r"INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY", out)
    out = re.sub(r"\bREAL\b", "DOUBLE PRECISION", out)
    return out


def _convert_query(sql: str) -> str:
    query = sql
    query = _normalize_sql(query)
    query = query.replace("INSERT OR IGNORE INTO", "INSERT INTO")
    query = query.replace("INSERT OR REPLACE INTO _meta", "INSERT INTO _meta")
    query = query.replace("INSERT OR REPLACE INTO", "INSERT INTO")
    # sqlite uses ? placeholders; psycopg expects %s
    # Only replace ? outside of quoted strings to avoid corrupting string literals
    query = re.sub(r"\?(?=([^']*'[^']*')*[^']*$)", "%s", query)
    if "INSERT INTO _meta" in query and "ON CONFLICT" not in query:
        query += " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    if "INSERT INTO event_types" in query and "ON CONFLICT" not in query:
        query += " ON CONFLICT DO NOTHING"
    return query


class _CursorAdapter:
    def __init__(self, cursor) -> None:
        self._cursor = cursor

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount

    @property
    def lastrowid(self):
        return getattr(self._cursor, "lastrowid", None)

    def execute(self, sql: str, params: Any = None):
        query = _convert_query(sql)
        if params is None:
            self._cursor.execute(query)
        else:
            self._cursor.execute(query, params)
        return self

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self):
        return self._cursor.fetchall()


class _ConnAdapter:
    def __init__(self, conn) -> None:
        self._conn = conn

    def execute(self, sql: str, params: Any = None):
        cur = self._conn.cursor()
        return _CursorAdapter(cur).execute(sql, params)

    def executescript(self, script: str) -> None:
        cur = self._conn.cursor()
        statements = [s.strip() for s in script.split(";") if s.strip()]
        for statement in statements:
            cur.execute(_convert_query(statement))

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()

    def cursor(self):
        return _CursorAdapter(self._conn.cursor())


class PostgresAgentDB(AgentDB):
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.path = Path("postgres")
        self._conn = None

    def _connect(self):
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError(
                "Postgres backend requires psycopg. Install with: pip install psycopg[binary]"
            ) from exc
        raw_conn = psycopg.connect(self.database_url, row_factory=dict_row)
        return _ConnAdapter(raw_conn)

    def initialize(self) -> None:
        import logging
        _log = logging.getLogger(__name__)

        current = self.schema_version()
        if current >= SCHEMA_VERSION:
            # Keep runtime tables/columns in sync even when schema is already current.
            self._ensure_runtime_tables()
            self._ensure_runtime_columns()
            _log.info("Postgres schema already at v%d — skipping migrations", current)
            return

        # Day-1 or upgrade path: create base schema and apply migrations.
        _log.info("Postgres schema at v%d, target v%d — running migrations...", current, SCHEMA_VERSION)
        if current == 0:
            self._executescript_safe(SCHEMA_SQL)
        if current < 3:
            self._executescript_safe(MIGRATION_V2_TO_V3)
        if current < 4:
            self._executescript_safe(MIGRATION_V3_TO_V4)
        if current < 5:
            self._executescript_safe(MIGRATION_V4_TO_V5)
        if current < 6:
            self._executescript_safe(MIGRATION_V5_TO_V6)
        if current < 7:
            self._executescript_safe(MIGRATION_V6_TO_V7)
        if current < 8:
            self._executescript_safe(MIGRATION_V7_TO_V8)
        if current < 9:
            self._executescript_safe(MIGRATION_V8_TO_V9)
        if current < 10:
            self._executescript_safe(MIGRATION_V9_TO_V10)
        if current < 11:
            self._executescript_safe(MIGRATION_V10_TO_V11)
        if current < 12:
            self._executescript_safe(MIGRATION_V11_TO_V12)
        if current < 13:
            self._executescript_safe(MIGRATION_V12_TO_V13)
        self._ensure_runtime_tables()
        self._ensure_runtime_columns()
        self.conn.execute(
            "INSERT INTO _meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self.conn.commit()
        _log.info("Postgres schema upgraded to v%d", SCHEMA_VERSION)

    def _ensure_runtime_columns(self) -> None:
        """Add runtime observability columns for legacy Postgres databases."""
        checks = (
            ("execution_mode", "TEXT NOT NULL DEFAULT 'sequential'"),
            ("plan_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("reflection_json", "TEXT NOT NULL DEFAULT '{}'"),
        )
        for col, ddl in checks:
            row = self.conn.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                ("turns", col),
            ).fetchone()
            if row:
                continue
            self.conn.execute(f"ALTER TABLE turns ADD COLUMN {col} {ddl}")
        workflow_checks = (
            ("dag_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("reflection_json", "TEXT NOT NULL DEFAULT '{}'"),
        )
        for col, ddl in workflow_checks:
            row = self.conn.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                ("workflow_runs", col),
            ).fetchone()
            if row:
                continue
            self.conn.execute(f"ALTER TABLE workflow_runs ADD COLUMN {col} {ddl}")
        session_checks = (
            ("org_id", "TEXT NOT NULL DEFAULT ''"),
            ("project_id", "TEXT NOT NULL DEFAULT ''"),
        )
        for col, ddl in session_checks:
            row = self.conn.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                ("sessions", col),
            ).fetchone()
            if row:
                continue
            self.conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {ddl}")
        api_key_checks = (
            ("project_id", "TEXT NOT NULL DEFAULT ''"),
            ("env", "TEXT NOT NULL DEFAULT ''"),
        )
        for col, ddl in api_key_checks:
            row = self.conn.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                ("api_keys", col),
            ).fetchone()
            if row:
                continue
            self.conn.execute(f"ALTER TABLE api_keys ADD COLUMN {col} {ddl}")
        issue_checks = (
            ("fix_applied", "INTEGER NOT NULL DEFAULT 0"),
            ("assigned_to", "TEXT NOT NULL DEFAULT ''"),
            ("resolved_by", "TEXT NOT NULL DEFAULT ''"),
            ("resolved_at", "DOUBLE PRECISION"),
        )
        for col, ddl in issue_checks:
            row = self.conn.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                ("issues", col),
            ).fetchone()
            if row:
                continue
            self.conn.execute(f"ALTER TABLE issues ADD COLUMN {col} {ddl}")
        billing_checks = (
            ("pricing_source", "TEXT NOT NULL DEFAULT 'fallback_env'"),
            ("pricing_key", "TEXT NOT NULL DEFAULT ''"),
            ("unit", "TEXT NOT NULL DEFAULT ''"),
            ("unit_price_usd", "DOUBLE PRECISION NOT NULL DEFAULT 0.0"),
            ("quantity", "DOUBLE PRECISION NOT NULL DEFAULT 0.0"),
            ("pricing_version", "TEXT NOT NULL DEFAULT ''"),
        )
        for col, ddl in billing_checks:
            row = self.conn.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                ("billing_records", col),
            ).fetchone()
            if row:
                continue
            self.conn.execute(f"ALTER TABLE billing_records ADD COLUMN {col} {ddl}")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)")

    def _executescript_safe(self, script: str) -> None:
        """Execute SQL script while tolerating idempotent already-exists errors."""
        statements = [s.strip() for s in script.split(";") if s.strip()]
        for statement in statements:
            try:
                self.conn.execute(statement)
                self.conn.commit()
            except Exception as exc:
                msg = str(exc).lower()
                if (
                    "already exists" in msg
                    or "duplicate column" in msg
                    or "multiple primary keys" in msg
                    or "already a primary key" in msg
                    or ("does not exist" in msg and statement.upper().startswith("CREATE INDEX"))
                ):
                    self.conn.rollback()
                    continue
                raise

    def dequeue_job(self) -> dict[str, Any] | None:
        """Get the next pending job atomically (Postgres-safe)."""
        now = time.time()
        row = self.conn.execute(
            """SELECT * FROM job_queue WHERE status = 'pending'
            AND (scheduled_at IS NULL OR scheduled_at <= ?)
            ORDER BY priority DESC, created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED""",
            (now,),
        ).fetchone()
        if not row:
            self.conn.commit()
            return None
        job = dict(row)
        self.conn.execute(
            "UPDATE job_queue SET status = 'running', started_at = ? WHERE job_id = ?",
            (now, job["job_id"]),
        )
        self.conn.commit()
        return job

    @contextmanager
    def tx(self) -> Generator[Any, None, None]:
        cur = self.conn.cursor()
        try:
            yield cur
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def schema_version(self) -> int:
        try:
            row = self.conn.execute(
                "SELECT value FROM _meta WHERE key = 'schema_version'"
            ).fetchone()
            return int(row["value"]) if row else 0
        except Exception:
            return 0
