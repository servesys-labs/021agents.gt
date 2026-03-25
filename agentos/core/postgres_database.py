"""PostgreSQL-backed AgentDB compatibility layer.

This is a day-1, Postgres-first backend for control-plane scalability.
It provides an AgentDB-like surface so existing routers can run with
minimal changes.

Connection pooling: uses psycopg_pool.ConnectionPool for bounded,
reusable connections (min=2, max=20 by default, configurable via
POSTGRES_POOL_MIN / POSTGRES_POOL_MAX env vars).
"""

from __future__ import annotations

import logging
import os
import re
import threading
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
    MIGRATION_V14_TO_V15,
    MIGRATION_V15_TO_V16,
)

_log = logging.getLogger(__name__)


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
    # SQLite DATE(col, 'unixepoch') → Postgres TO_TIMESTAMP(col)::DATE
    query = re.sub(
        r"DATE\((\w+),\s*'unixepoch'\)",
        r"TO_TIMESTAMP(\1)::DATE",
        query,
    )
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
    """Wraps a raw psycopg connection with query translation and auto-recovery."""

    def __init__(self, conn) -> None:
        self._conn = conn

    def execute(self, sql: str, params: Any = None):
        try:
            cur = self._conn.cursor()
            return _CursorAdapter(cur).execute(sql, params)
        except Exception as exc:
            # Auto-recover from InFailedSqlTransaction by rolling back
            if "InFailedSqlTransaction" in type(exc).__name__ or "aborted" in str(exc).lower():
                self._conn.rollback()
                cur = self._conn.cursor()
                return _CursorAdapter(cur).execute(sql, params)
            raise

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
    """Postgres-backed AgentDB with connection pooling.

    Pool size is configurable via environment variables:
      POSTGRES_POOL_MIN (default: 2)
      POSTGRES_POOL_MAX (default: 20)
    """

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.path = Path("postgres")
        self._conn = None
        self._pool = None
        self._pool_lock = threading.Lock()

    def _get_pool(self):
        """Lazy-initialize the connection pool (thread-safe)."""
        if self._pool is not None:
            return self._pool
        with self._pool_lock:
            # Double-check after acquiring lock
            if self._pool is not None:
                return self._pool
            try:
                from psycopg_pool import ConnectionPool
                from psycopg.rows import dict_row
            except ImportError as exc:
                raise RuntimeError(
                    "Postgres backend requires psycopg + psycopg_pool. "
                    "Install with: pip install 'psycopg[binary]' psycopg_pool"
                ) from exc

            min_size = int(os.environ.get("POSTGRES_POOL_MIN", "2"))
            max_size = int(os.environ.get("POSTGRES_POOL_MAX", "20"))
            _log.info("Creating Postgres connection pool (min=%d, max=%d)", min_size, max_size)

            self._pool = ConnectionPool(
                conninfo=self.database_url,
                min_size=min_size,
                max_size=max_size,
                kwargs={"row_factory": dict_row},
                # Wait up to 30s for a connection from pool
                timeout=30.0,
                # Recycle connections after 30 minutes to avoid stale state
                max_lifetime=1800.0,
                # Check connection health before handing it out
                check=ConnectionPool.check_connection,
            )
            return self._pool

    def _connect(self):
        """Get a long-lived primary connection for the AgentDB.conn property.

        This connection is cached by the parent class and used for all
        self.conn.execute() calls across the application (44 routers,
        migrations, etc.).  It is NOT returned to the pool during normal
        operation — it lives for the lifetime of the process and is
        released by shutdown_db() or process exit.

        For request-scoped work that should not hold a connection between
        requests, use checkout() instead.
        """
        pool = self._get_pool()
        raw_conn = pool.getconn()
        adapter = _ConnAdapter(raw_conn)
        return adapter

    @contextmanager
    def checkout(self) -> Generator[_ConnAdapter, None, None]:
        """Check out a pooled connection for a block of work.

        Usage:
            with db.checkout() as conn:
                conn.execute("SELECT ...")
                conn.commit()

        The connection is automatically returned to the pool.
        """
        pool = self._get_pool()
        raw_conn = pool.getconn()
        adapter = _ConnAdapter(raw_conn)
        try:
            yield adapter
        except Exception:
            raw_conn.rollback()
            raise
        finally:
            pool.putconn(raw_conn)

    def pool_stats(self) -> dict[str, Any]:
        """Return pool health stats for monitoring endpoints."""
        pool = self._get_pool()
        raw = pool.get_stats()
        # psycopg_pool returns a dict in 3.2+; convert defensively
        stats = dict(raw) if not isinstance(raw, dict) else raw
        return {
            "pool_size": stats.get("pool_size", 0),
            "pool_available": stats.get("pool_available", 0),
            "requests_waiting": stats.get("requests_waiting", 0),
            "requests_num": stats.get("requests_num", 0),
            "requests_errors": stats.get("requests_errors", 0),
            "connections_lost": stats.get("connections_lost", 0),
        }

    def initialize(self) -> None:
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
        if current < 15:
            self._executescript_safe(MIGRATION_V14_TO_V15)
        if current < 16:
            self._executescript_safe(MIGRATION_V15_TO_V16)
        self._ensure_runtime_tables()
        self._ensure_runtime_columns()
        self.conn.execute(
            "INSERT INTO _meta (key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self.conn.commit()
        _log.info("Postgres schema upgraded to v%d", SCHEMA_VERSION)

    def _safe_add_column(self, table: str, col: str, ddl: str) -> None:
        """Add a column if it doesn't exist. Rolls back on error."""
        try:
            row = self.conn.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
                (table, col),
            ).fetchone()
            if row:
                return
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
            self.conn.commit()
        except Exception:
            self.conn.rollback()

    def _ensure_runtime_columns(self) -> None:
        """Add runtime observability columns for legacy Postgres databases."""
        for col, ddl in (
            ("execution_mode", "TEXT NOT NULL DEFAULT 'sequential'"),
            ("plan_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("reflection_json", "TEXT NOT NULL DEFAULT '{}'"),
        ):
            self._safe_add_column("turns", col, ddl)
        for col, ddl in (
            ("dag_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("reflection_json", "TEXT NOT NULL DEFAULT '{}'"),
        ):
            self._safe_add_column("workflow_runs", col, ddl)
        for col, ddl in (
            ("org_id", "TEXT NOT NULL DEFAULT ''"),
            ("project_id", "TEXT NOT NULL DEFAULT ''"),
        ):
            self._safe_add_column("sessions", col, ddl)
        for col, ddl in (
            ("project_id", "TEXT NOT NULL DEFAULT ''"),
            ("env", "TEXT NOT NULL DEFAULT ''"),
        ):
            self._safe_add_column("api_keys", col, ddl)
        for col, ddl in (
            ("fix_applied", "INTEGER NOT NULL DEFAULT 0"),
            ("assigned_to", "TEXT NOT NULL DEFAULT ''"),
            ("resolved_by", "TEXT NOT NULL DEFAULT ''"),
            ("resolved_at", "DOUBLE PRECISION"),
        ):
            self._safe_add_column("issues", col, ddl)
        for col, ddl in (
            ("pricing_source", "TEXT NOT NULL DEFAULT 'fallback_env'"),
            ("pricing_key", "TEXT NOT NULL DEFAULT ''"),
            ("unit", "TEXT NOT NULL DEFAULT ''"),
            ("unit_price_usd", "DOUBLE PRECISION NOT NULL DEFAULT 0.0"),
            ("quantity", "DOUBLE PRECISION NOT NULL DEFAULT 0.0"),
            ("pricing_version", "TEXT NOT NULL DEFAULT ''"),
        ):
            self._safe_add_column("billing_records", col, ddl)
        try:
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)")
            self.conn.commit()
        except Exception:
            self.conn.rollback()

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
            self.conn.rollback()
            return 0
