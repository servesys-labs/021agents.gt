"""Authorization regression tests for control-plane security fixes."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    """Create API client backed by SQLite test DB."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("AGENTOS_DB_BACKEND", "sqlite")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///data/agent.db")
    monkeypatch.setenv("AGENTOS_AUTH_REQUIRED", "false")
    (tmp_path / "data").mkdir()
    (tmp_path / "agents").mkdir()
    (tmp_path / "eval").mkdir()

    from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4

    db = create_database(tmp_path / "data" / "agent.db")
    for migration in (MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4):
        for stmt in migration.split(";"):
            stmt = stmt.strip()
            if stmt and not stmt.startswith("--"):
                try:
                    db.conn.execute(stmt)
                except Exception:
                    pass
    # Compatibility shim: some test DB variants may miss fields/tables
    # used by observability ownership/report queries.
    try:
        db.conn.execute("ALTER TABLE eval_runs ADD COLUMN org_id TEXT DEFAULT ''")
    except Exception:
        pass
    db.conn.execute(
        """CREATE TABLE IF NOT EXISTS runtime_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            event_type TEXT,
            event_source TEXT,
            event_ts REAL,
            org_id TEXT,
            agent_name TEXT,
            session_id TEXT,
            trace_id TEXT,
            turn INTEGER DEFAULT 0,
            node_id TEXT,
            status TEXT,
            payload_json TEXT,
            created_at REAL DEFAULT 0
        )""",
    )
    db.conn.commit()
    db.close()

    from agentos.api.app import create_app
    from agentos.core.harness import AgentHarness

    return TestClient(create_app(AgentHarness()))


def _auth_header(user_id: str, email: str, org_id: str) -> dict[str, str]:
    from agentos.auth.jwt import create_token

    token = create_token(
        user_id=user_id,
        email=email,
        extra={"org_id": org_id, "role": "admin"},
    )
    return {"Authorization": f"Bearer {token}"}


def _seed_agent_and_telemetry(agent_name: str, org_id: str) -> None:
    from agentos.api.deps import _get_db

    db = _get_db()
    import time

    now = time.time()
    suffix = str(int(now * 1_000_000))
    db.conn.execute(
        """INSERT OR REPLACE INTO agents (name, org_id, config_json, description, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)""",
        (agent_name, org_id, "{}", "", now, now),
    )
    db.insert_session({
        "session_id": f"sess-{agent_name}-{org_id}-{suffix}",
        "org_id": org_id,
        "agent_name": agent_name,
        "timestamp": now,
        "status": "success",
        "stop_reason": "completed",
        "step_count": 2,
        "wall_clock_seconds": 1.0,
        "trace_id": f"trace-{agent_name}-{org_id}-{suffix}",
        "composition": {"agent_name": agent_name},
        "cost": {"total_usd": 0.01},
        "benchmark_cost": {},
    })
    db.insert_eval_run({
        "agent_name": agent_name,
        "org_id": org_id,
        "benchmark_name": "smoke",
        "total_tasks": 3,
        "total_trials": 9,
        "pass_count": 8,
        "fail_count": 1,
        "error_count": 0,
        "pass_rate": 0.89,
        "avg_score": 0.9,
    })
    db.upsert_meta_proposal({
        "id": f"prop-{agent_name}",
        "agent_name": agent_name,
        "title": "Improve reliability",
        "rationale": "seed",
        "category": "runtime",
        "priority": 0.5,
        "modification": {},
        "evidence": {},
        "status": "pending",
        "created_at": now,
    })


def _write_agent_file(agent_name: str) -> None:
    path = Path("agents") / f"{agent_name}.json"
    cfg = {
        "name": agent_name,
        "description": "seed agent",
        "version": "0.1.0",
        "system_prompt": "You are helpful.",
        "model": "stub-model",
        "tools": [],
        "governance": {"budget_limit_usd": 10.0, "require_confirmation_for_destructive": True, "blocked_tools": []},
        "memory": {"working": {"max_items": 50}, "episodic": {"max_episodes": 100, "ttl_days": 30}, "procedural": {"max_procedures": 50}},
        "max_turns": 5,
        "tags": [],
        "harness": {
            "declarative_graph": {
                "nodes": [{"id": "n1", "kind": "bootstrap"}, {"id": "n2", "kind": "final"}],
                "edges": [{"source": "n1", "target": "n2"}],
            },
        },
    }
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def test_meta_proposals_idor_list_and_review(api_client: TestClient) -> None:
    a_headers = _auth_header("user-a", "org-a@test.com", "org-a")
    b_headers = _auth_header("user-b", "org-b@test.com", "org-b")
    _seed_agent_and_telemetry("agent-alpha", "org-a")

    own = api_client.get("/api/v1/observability/agents/agent-alpha/meta-proposals", headers=a_headers)
    assert own.status_code == 200
    assert own.json()["agent_name"] == "agent-alpha"

    cross_list = api_client.get("/api/v1/observability/agents/agent-alpha/meta-proposals", headers=b_headers)
    assert cross_list.status_code == 404

    cross_review = api_client.post(
        "/api/v1/observability/agents/agent-alpha/meta-proposals/prop-agent-alpha/review",
        params={"approved": "true", "note": "x"},
        headers=b_headers,
    )
    assert cross_review.status_code == 404


def test_maintenance_ownership_denies_cross_org_even_with_file(api_client: TestClient) -> None:
    a_headers = _auth_header("user-a", "own-maint@test.com", "org-a")
    b_headers = _auth_header("user-b", "other-maint@test.com", "org-b")
    _seed_agent_and_telemetry("agent-alpha", "org-a")
    _write_agent_file("agent-alpha")

    denied = api_client.post(
        "/api/v1/observability/agents/agent-alpha/autonomous-maintenance-run",
        json={"dry_run": True},
        headers=b_headers,
    )
    assert denied.status_code == 404

    own = api_client.post(
        "/api/v1/observability/agents/agent-alpha/autonomous-maintenance-run",
        json={"dry_run": True},
        headers=a_headers,
    )
    assert own.status_code == 200


def test_gate_pack_scopes_agent_name_even_with_inline_graph(api_client: TestClient) -> None:
    a_headers = _auth_header("user-a", "own-gate@test.com", "org-a")
    b_headers = _auth_header("user-b", "other-gate@test.com", "org-b")
    _seed_agent_and_telemetry("agent-alpha", "org-a")

    denied_no_graph = api_client.post(
        "/api/v1/graphs/gate-pack",
        json={"agent_name": "agent-alpha"},
        headers=b_headers,
    )
    assert denied_no_graph.status_code == 404

    denied_inline = api_client.post(
        "/api/v1/graphs/gate-pack",
        json={
            "agent_name": "agent-alpha",
            "graph": {"nodes": [{"id": "a", "kind": "bootstrap"}, {"id": "b", "kind": "final"}], "edges": [{"source": "a", "target": "b"}]},
        },
        headers=b_headers,
    )
    assert denied_inline.status_code == 404

    own = api_client.post(
        "/api/v1/graphs/gate-pack",
        json={
            "agent_name": "agent-alpha",
            "graph": {"nodes": [{"id": "a", "kind": "bootstrap"}, {"id": "b", "kind": "final"}], "edges": [{"source": "a", "target": "b"}]},
        },
        headers=a_headers,
    )
    assert own.status_code == 200


def test_hold_override_requires_reason(api_client: TestClient) -> None:
    headers = _auth_header("user-a", "hold-override@test.com", "org-a")

    empty_reason = api_client.post(
        "/api/v1/agents/create-from-description",
        params={
            "description": "Create a support agent",
            "name": "hold-override-no-reason",
            "draft_only": "false",
            "auto_graph": "true",
            "strict_graph_lint": "true",
            "override_hold": "true",
            "override_reason": "",
        },
        headers=headers,
    )
    assert empty_reason.status_code == 422

    with_reason = api_client.post(
        "/api/v1/agents/create-from-description",
        params={
            "description": "Create a support agent",
            "name": "hold-override-with-reason",
            "draft_only": "false",
            "auto_graph": "true",
            "strict_graph_lint": "true",
            "override_hold": "true",
            "override_reason": "Approved by operator after manual review",
        },
        headers=headers,
    )
    assert with_reason.status_code == 200
    assert with_reason.json().get("hold_override_applied") is True


def test_dry_run_guard_prevents_persist(api_client: TestClient) -> None:
    headers = _auth_header("user-a", "dryrun@test.com", "org-a")
    _seed_agent_and_telemetry("agent-alpha", "org-a")
    _write_agent_file("agent-alpha")

    from agentos.api.deps import _get_db

    db = _get_db()
    before = len(db.list_meta_proposals(agent_name="agent-alpha", status="", limit=1000))

    dry = api_client.post(
        "/api/v1/observability/agents/agent-alpha/autonomous-maintenance-run",
        json={"dry_run": True, "persist_proposals": True, "max_proposals": 5},
        headers=headers,
    )
    assert dry.status_code == 200
    assert dry.json()["proposals"]["persisted"] is False
    after_dry = len(db.list_meta_proposals(agent_name="agent-alpha", status="", limit=1000))
    assert after_dry == before

    nondry = api_client.post(
        "/api/v1/observability/agents/agent-alpha/autonomous-maintenance-run",
        json={"dry_run": False, "persist_proposals": True, "max_proposals": 5},
        headers=headers,
    )
    assert nondry.status_code == 200
    assert nondry.json()["proposals"]["persisted"] is True
