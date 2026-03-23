"""PostgreSQL-backed AgentDB compatibility layer.

This is a day-1, Postgres-first backend for control-plane scalability.
It provides an AgentDB-like surface so existing routers can run with
minimal changes.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

from agentos.core.database import AgentDB, SCHEMA_SQL


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
        # Day-1 path: create full schema from current DDL.
        self.conn.executescript(SCHEMA_SQL)
        self._ensure_runtime_tables()
        self._ensure_runtime_columns()
        self.conn.execute(
            "INSERT INTO _meta (key, value) VALUES (?, ?)",
            ("schema_version", "4"),
        )
        self.conn.commit()

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
