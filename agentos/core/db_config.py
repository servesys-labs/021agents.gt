"""Database configuration — supports SQLite and PostgreSQL backends.

Usage:
    # SQLite (default, zero-config)
    DATABASE_URL=sqlite:///data/agent.db

    # PostgreSQL (production scale)
    DATABASE_URL=postgresql://user:pass@host:5432/agentos

The AgentDB class in database.py handles SQLite directly.
For PostgreSQL, set DATABASE_URL in env and the system will use
the same SQL queries with minor dialect adjustments.

Migration guide:
    1. Set DATABASE_URL=postgresql://...
    2. Run: agentos db migrate
    3. All data automatically uses Postgres
"""

import logging
import os
import threading
from pathlib import Path

from agentos.core.database import AgentDB
from agentos.core.postgres_database import PostgresAgentDB

logger = logging.getLogger(__name__)

_db_instance: AgentDB | None = None
_db_lock = threading.RLock()  # reentrant — initialize_db() calls get_db() under the same lock
_db_initialized = False


def get_database_url() -> str:
    """Get the database URL from environment or default to SQLite."""
    return os.environ.get("DATABASE_URL", "sqlite:///data/agent.db")


def is_postgres() -> bool:
    """Check if we're using PostgreSQL."""
    backend = os.environ.get("AGENTOS_DB_BACKEND", "").lower()
    if backend == "postgres":
        return True
    return get_database_url().startswith("postgresql")


def is_sqlite() -> bool:
    """Check if we're using SQLite (default)."""
    return not is_postgres()


def get_db() -> AgentDB:
    """Return the process-wide DB singleton (lazy-created, never re-initialized)."""
    global _db_instance
    if _db_instance is not None:
        return _db_instance
    with _db_lock:
        if _db_instance is not None:
            return _db_instance
        if is_postgres():
            _db_instance = PostgresAgentDB(get_database_url())
        else:
            db_path = Path.cwd() / "data" / "agent.db"
            _db_instance = AgentDB(db_path)
        return _db_instance


def initialize_db() -> None:
    """Run schema creation / migrations exactly once per process."""
    global _db_initialized
    if _db_initialized:
        return
    with _db_lock:
        if _db_initialized:
            return
        db = get_db()
        db.initialize()
        _db_initialized = True
        logger.info("Database initialized (one-time)")


def shutdown_db() -> None:
    """Close the DB instance and its connection pool (if any).

    Call this from FastAPI shutdown hooks or atexit handlers to avoid
    leaking connections on Railway redeploy.
    """
    global _db_instance, _db_initialized
    with _db_lock:
        if _db_instance is not None:
            pool = getattr(_db_instance, "_pool", None)
            primary_conn = getattr(_db_instance, "_conn", None)

            # Step 1: Return the primary connection to the pool before
            # closing it.  pool.putconn() is safe even if the conn is
            # already idle — it just marks it available.  We must do this
            # BEFORE pool.close() so the pool can cleanly close all conns.
            if pool is not None and primary_conn is not None:
                raw = getattr(primary_conn, "_conn", None)
                if raw is not None:
                    try:
                        pool.putconn(raw)
                    except Exception:
                        pass

            # Step 2: Close the pool (closes all connections it owns).
            if pool is not None:
                try:
                    pool.close()
                    logger.info("Postgres connection pool closed")
                except Exception as exc:
                    logger.warning("Error closing pool: %s", exc)
            elif primary_conn is not None:
                # SQLite or non-pooled — close directly
                try:
                    primary_conn.close()
                except Exception:
                    pass

            _db_instance = None
            _db_initialized = False
