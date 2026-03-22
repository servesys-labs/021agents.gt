"""Database configuration — supports SQLite (default) and PostgreSQL (production).

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


def get_database_url() -> str:
    """Get the database URL from environment or default to SQLite."""
    return os.environ.get("DATABASE_URL", "sqlite:///data/agent.db")


def is_postgres() -> bool:
    """Check if we're using PostgreSQL."""
    return get_database_url().startswith("postgresql")


def is_sqlite() -> bool:
    """Check if we're using SQLite (default)."""
    return not is_postgres()
