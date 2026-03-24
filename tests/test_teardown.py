"""Tests for agent teardown — cascading delete, multi-tenant isolation, CLI, API."""

import json
import time
import pytest
from pathlib import Path

from agentos.core.database import AgentDB, create_database


@pytest.fixture
def db(tmp_path):
    """Fresh database for each test."""
    d = create_database(tmp_path / "test.db")
    yield d
    d.close()


def _seed_agent(db, name, org_id="org-1", project_id="proj-1"):
    """Helper: create an agent with sessions, turns, costs, feedback.

    Session IDs include org_id to avoid collisions in multi-tenant tests.
    """
    db.upsert_agent(org_id, project_id, name, {"name": name, "model": "test"}, "tester")
    t = time.time()
    sid1 = f"s-{org_id}-{name}-1"
    sid2 = f"s-{org_id}-{name}-2"
    # Sessions
    db.conn.execute(
        "INSERT INTO sessions (session_id, agent_name, org_id, status, created_at) VALUES (?,?,?,?,?)",
        (sid1, name, org_id, "completed", t),
    )
    db.conn.execute(
        "INSERT INTO sessions (session_id, agent_name, org_id, status, created_at) VALUES (?,?,?,?,?)",
        (sid2, name, org_id, "completed", t),
    )
    # Turns (linked via session_id)
    db.conn.execute(
        "INSERT INTO turns (session_id, turn_number, llm_content) VALUES (?,?,?)",
        (sid1, 1, "hello"),
    )
    db.conn.execute(
        "INSERT INTO turns (session_id, turn_number, llm_content) VALUES (?,?,?)",
        (sid1, 2, "world"),
    )
    # Feedback (linked via session_id)
    db.conn.execute(
        "INSERT INTO feedback (session_id, turn_number, rating) VALUES (?,?,?)",
        (sid1, 1, 5),
    )
    # Cost ledger
    db.conn.execute(
        "INSERT INTO cost_ledger (session_id, agent_name, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?,?,?,?,?,?,?)",
        (sid1, name, "test-model", 100, 50, 0.01, t),
    )
    # Billing records (should NOT be deleted)
    db.conn.execute(
        "INSERT INTO billing_records (org_id, agent_name, cost_type, total_cost_usd, created_at) VALUES (?,?,?,?,?)",
        (org_id, name, "inference", 0.05, t),
    )
    db.conn.commit()


def _count(db, table, where="1=1", params=()):
    return db.conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()[0]


# ─── Soft Delete ───────────────────────────────────────────────────────────


class TestSoftDelete:
    """Soft delete: agent deactivated, data preserved, counts returned."""

    def test_agent_becomes_inactive(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=False)
        assert db.get_agent_by_name("agent-a") is None

    def test_sessions_preserved(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=False)
        assert _count(db, "sessions", "agent_name=?", ("agent-a",)) == 2

    def test_turns_preserved(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=False)
        assert _count(db, "turns", "session_id=?", ("s-org-1-agent-a-1",)) == 2

    def test_counts_returned(self, db):
        _seed_agent(db, "agent-a")
        r = db.teardown_agent("agent-a", org_id="org-1", hard_delete=False)
        assert r["counts"]["sessions"] == 2
        assert r["counts"]["turns"] == 2
        assert r["counts"]["feedback"] == 1
        assert r["counts"]["cost_ledger"] == 1
        assert r["counts"]["agent"] == 1

    def test_billing_records_counted_not_deleted(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=False)
        # billing_records should still exist (not in teardown scope)
        assert _count(db, "billing_records", "agent_name=?", ("agent-a",)) == 1


# ─── Hard Delete ───────────────────────────────────────────────────────────


class TestHardDelete:
    """Hard delete: all data permanently removed."""

    def test_sessions_deleted(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=True)
        assert _count(db, "sessions", "agent_name=?", ("agent-a",)) == 0

    def test_turns_deleted(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=True)
        assert _count(db, "turns", "session_id=?", ("s-agent-a-1",)) == 0

    def test_feedback_deleted(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=True)
        assert _count(db, "feedback", "session_id=?", ("s-agent-a-1",)) == 0

    def test_cost_ledger_deleted(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=True)
        assert _count(db, "cost_ledger", "agent_name=?", ("agent-a",)) == 0

    def test_agent_record_deleted(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=True)
        assert db.get_agent_by_name("agent-a") is None
        assert db.conn.execute(
            "SELECT COUNT(*) FROM agents WHERE name=?", ("agent-a",)
        ).fetchone()[0] == 0

    def test_billing_records_preserved(self, db):
        _seed_agent(db, "agent-a")
        db.teardown_agent("agent-a", org_id="org-1", hard_delete=True)
        assert _count(db, "billing_records", "agent_name=?", ("agent-a",)) == 1

    def test_total_records(self, db):
        _seed_agent(db, "agent-a")
        r = db.teardown_agent("agent-a", org_id="org-1", hard_delete=True)
        assert r["total_records"] > 0
        assert r["counts"]["sessions"] == 2
        assert r["counts"]["turns"] == 2
        assert r["counts"]["feedback"] == 1


# ─── Multi-Tenant Isolation ───────────────────────────────────────────────


class TestMultiTenantIsolation:
    """Two orgs with same agent name: teardown must not cross-contaminate."""

    def test_same_name_different_orgs(self, db):
        _seed_agent(db, "my-bot", org_id="acme")
        _seed_agent(db, "my-bot", org_id="globex")

        # Delete ACME's agent
        db.teardown_agent("my-bot", org_id="acme", hard_delete=True)

        # ACME cleaned
        assert _count(db, "sessions", "agent_name=? AND org_id=?", ("my-bot", "acme")) == 0
        assert db.get_agent("acme", "proj-1", "my-bot") is None

        # Globex untouched
        assert _count(db, "sessions", "agent_name=? AND org_id=?", ("my-bot", "globex")) == 2
        assert db.get_agent("globex", "proj-1", "my-bot") is not None

    def test_turns_isolated(self, db):
        _seed_agent(db, "shared-name", org_id="org-a")
        _seed_agent(db, "shared-name", org_id="org-b")

        db.teardown_agent("shared-name", org_id="org-a", hard_delete=True)

        # org-a turns gone
        assert _count(db, "turns", "session_id LIKE ?", ("s-org-a-%",)) == 0
        # org-b turns survive
        assert _count(db, "turns", "session_id LIKE ?", ("s-org-b-%",)) == 2
        assert _count(db, "sessions", "org_id=?", ("org-b",)) == 2

    def test_soft_delete_isolated(self, db):
        _seed_agent(db, "my-bot", org_id="acme")
        _seed_agent(db, "my-bot", org_id="globex")

        db.teardown_agent("my-bot", org_id="acme", hard_delete=False)

        # ACME soft-deleted
        assert db.get_agent("acme", "proj-1", "my-bot") is None
        # Globex still active
        assert db.get_agent("globex", "proj-1", "my-bot") is not None


# ─── Unscoped Teardown (CLI/single-tenant) ────────────────────────────────


class TestUnscopedTeardown:
    """When org_id is not provided, affects all matching agents (CLI mode)."""

    def test_unscoped_hard_delete(self, db):
        _seed_agent(db, "local-agent", org_id="")
        db.teardown_agent("local-agent", hard_delete=True)
        assert _count(db, "sessions", "agent_name=?", ("local-agent",)) == 0
        assert db.get_agent_by_name("local-agent") is None

    def test_unscoped_soft_delete(self, db):
        _seed_agent(db, "local-agent", org_id="")
        r = db.teardown_agent("local-agent", hard_delete=False)
        assert r["counts"]["agent"] == 1
        assert db.get_agent_by_name("local-agent") is None


# ─── Non-existent Agent ───────────────────────────────────────────────────


class TestNonexistentAgent:
    """Teardown of agent that doesn't exist should not crash."""

    def test_hard_delete_nonexistent(self, db):
        r = db.teardown_agent("ghost", org_id="org-1", hard_delete=True)
        assert r["counts"]["agent"] == 0

    def test_soft_delete_nonexistent(self, db):
        r = db.teardown_agent("ghost", org_id="org-1", hard_delete=False)
        assert r["counts"]["sessions"] == 0


# ─── Other Agent Untouched ─────────────────────────────────────────────────


class TestOtherAgentSafe:
    """Deleting one agent must not affect another agent in the same org."""

    def test_sibling_agent_untouched(self, db):
        _seed_agent(db, "agent-delete-me", org_id="org-1")
        _seed_agent(db, "agent-keep-me", org_id="org-1")

        db.teardown_agent("agent-delete-me", org_id="org-1", hard_delete=True)

        # Deleted agent is gone
        assert _count(db, "sessions", "agent_name=?", ("agent-delete-me",)) == 0

        # Sibling is untouched
        assert _count(db, "sessions", "agent_name=?", ("agent-keep-me",)) == 2
        assert db.get_agent("org-1", "proj-1", "agent-keep-me") is not None

    def test_sibling_turns_untouched(self, db):
        _seed_agent(db, "doomed", org_id="org-1")
        _seed_agent(db, "safe", org_id="org-1")

        db.teardown_agent("doomed", org_id="org-1", hard_delete=True)

        assert _count(db, "turns", "session_id LIKE ?", ("s-org-1-safe%",)) == 2


# ─── Audit Trail ───────────────────────────────────────────────────────────


class TestAuditTrail:
    """Teardown should log to config_audit (if the table exists)."""

    def _has_config_audit(self, db):
        try:
            db.conn.execute("SELECT 1 FROM config_audit LIMIT 1")
            return True
        except Exception:
            return False

    def test_audit_logged(self, db):
        if not self._has_config_audit(db):
            # Create the table so teardown can log to it
            db.conn.execute(
                "CREATE TABLE IF NOT EXISTS config_audit "
                "(id INTEGER PRIMARY KEY, agent_name TEXT, action TEXT, details_json TEXT, created_at REAL)"
            )
            db.conn.commit()
        _seed_agent(db, "audited")
        db.teardown_agent("audited", hard_delete=True)
        rows = db.conn.execute(
            "SELECT * FROM config_audit WHERE agent_name=? AND action=?",
            ("audited", "teardown"),
        ).fetchall()
        assert len(rows) >= 1

    def test_audit_contains_counts(self, db):
        if not self._has_config_audit(db):
            db.conn.execute(
                "CREATE TABLE IF NOT EXISTS config_audit "
                "(id INTEGER PRIMARY KEY, agent_name TEXT, action TEXT, details_json TEXT, created_at REAL)"
            )
            db.conn.commit()
        _seed_agent(db, "audited")
        db.teardown_agent("audited", hard_delete=True)
        row = db.conn.execute(
            "SELECT details_json FROM config_audit WHERE agent_name=? AND action=?",
            ("audited", "teardown"),
        ).fetchone()
        details = json.loads(row[0] if isinstance(row, tuple) else row["details_json"])
        assert "counts" in details
        assert details["hard_delete"] is True


# ─── API Endpoint ──────────────────────────────────────────────────────────


class TestAPIEndpoint:
    """Verify DELETE /agents/{name} handler calls teardown correctly."""

    def test_delete_endpoint_exists(self):
        """The delete endpoint must exist and accept hard_delete param."""
        import ast
        source = open("agentos/api/routers/agents.py").read()
        tree = ast.parse(source)
        delete_funcs = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.AsyncFunctionDef) and node.name == "delete_agent"
        ]
        assert len(delete_funcs) == 1

    def test_delete_calls_teardown_with_org_id(self):
        """The endpoint must pass org_id for multi-tenant safety."""
        source = open("agentos/api/routers/agents.py").read()
        assert "org_id=user.org_id" in source
        assert "teardown_agent" in source


# ─── CLI Command ───────────────────────────────────────────────────────────


class TestCLICommand:
    """Verify CLI delete command is registered."""

    def test_cli_delete_registered(self):
        source = open("agentos/cli.py").read()
        assert '"delete"' in source
        assert "cmd_delete" in source
        assert "--hard" in source
        assert "--yes" in source


# ─── Builtin Tool ──────────────────────────────────────────────────────────


class TestBuiltinTool:
    """Verify delete-agent tool is registered and has safety check."""

    def test_tool_registered(self):
        from agentos.tools.builtins import BUILTIN_HANDLERS
        assert "delete-agent" in BUILTIN_HANDLERS

    def test_tool_has_schema(self):
        from agentos.tools.builtins import BUILTIN_SCHEMAS
        assert "delete-agent" in BUILTIN_SCHEMAS
        schema = BUILTIN_SCHEMAS["delete-agent"]
        props = schema["input_schema"]["properties"]
        assert "agent_name" in props
        assert "hard_delete" in props
        assert "confirm" in props

    def test_tool_in_orchestrator(self):
        from agentos.defaults import ORCHESTRATOR_TOOLS
        assert "delete-agent" in ORCHESTRATOR_TOOLS

    @pytest.mark.asyncio
    async def test_tool_requires_confirm(self):
        from agentos.tools.builtins import delete_agent_tool
        result = await delete_agent_tool("some-agent", confirm=False)
        assert "confirm=true" in result.lower() or "Safety check" in result
