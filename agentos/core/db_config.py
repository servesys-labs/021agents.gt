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

import os
from pathlib import Path

from agentos.core.database import AgentDB
from agentos.core.postgres_database import PostgresAgentDB


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


def get_db():
    """Create a DB handle for the configured backend."""
    if is_postgres():
        return PostgresAgentDB(get_database_url())
    db_path = Path.cwd() / "data" / "agent.db"
    return AgentDB(db_path)
