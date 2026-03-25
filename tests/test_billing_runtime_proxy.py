"""Billing-focused regression tests for runtime proxy and pricing catalog."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    """Create isolated working dir + reset DB singleton."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "agents").mkdir()
    (tmp_path / "eval").mkdir()
    monkeypatch.setenv("AGENTOS_DB_BACKEND", "sqlite")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    from agentos.core import db_config
    db_config._db_instance = None
    db_config._db_initialized = False

    from agentos.core.database import create_database

    db = create_database(tmp_path / "data" / "agent.db")
    db.initialize()
    db.close()

    yield tmp_path

    db_config._db_instance = None
    db_config._db_initialized = False


def _client(monkeypatch) -> TestClient:
    monkeypatch.setenv("EDGE_INGEST_TOKEN", "edge-test-token")
    from agentos.api.app import create_app
    from agentos.core.harness import AgentHarness

    return TestClient(create_app(AgentHarness()))


def test_record_billing_persists_pricing_snapshot(isolated_db):
    from agentos.core.database import create_database

    db = create_database(Path("data/agent.db"))
    db.initialize()
    db.record_billing(
        cost_type="inference",
        total_cost_usd=0.42,
        org_id="org-a",
        provider="gmi",
        model="deepseek-ai/DeepSeek-V3.2",
        pricing_source="catalog",
        pricing_key="llm:gmi:deepseek-ai/DeepSeek-V3.2:infer",
        unit="token",
        unit_price_usd=0.000002,
        quantity=210000,
        pricing_version="gmi-20260324-000001",
    )
    row = db.conn.execute("SELECT * FROM billing_records ORDER BY id DESC LIMIT 1").fetchone()
    assert row["pricing_source"] == "catalog"
    assert row["pricing_key"].startswith("llm:gmi:")
    assert row["unit"] == "token"
    assert float(row["unit_price_usd"]) == pytest.approx(0.000002)
    assert float(row["quantity"]) == pytest.approx(210000)
    assert row["pricing_version"] == "gmi-20260324-000001"
    db.close()


def test_pricing_catalog_resolution_order(isolated_db):
    from agentos.core.database import create_database

    db = create_database(Path("data/agent.db"))
    db.initialize()
    now = time.time() - 5
    db.upsert_pricing_rate(
        provider="",
        model="",
        resource_type="llm",
        operation="infer",
        unit="input_token",
        unit_price_usd=0.9,
        pricing_version="global-default",
        effective_from=now,
    )
    db.upsert_pricing_rate(
        provider="gmi",
        model="",
        resource_type="llm",
        operation="infer",
        unit="input_token",
        unit_price_usd=0.4,
        pricing_version="provider-default",
        effective_from=now,
    )
    db.upsert_pricing_rate(
        provider="gmi",
        model="model-a",
        resource_type="llm",
        operation="infer",
        unit="input_token",
        unit_price_usd=0.2,
        pricing_version="exact-model",
        effective_from=now,
    )
    exact = db.get_active_pricing_rate(
        resource_type="llm",
        operation="infer",
        unit="input_token",
        provider="gmi",
        model="model-a",
    )
    provider_fallback = db.get_active_pricing_rate(
        resource_type="llm",
        operation="infer",
        unit="input_token",
        provider="gmi",
        model="model-b",
    )
    global_fallback = db.get_active_pricing_rate(
        resource_type="llm",
        operation="infer",
        unit="input_token",
        provider="other",
        model="missing",
    )
    assert float(exact["unit_price_usd"]) == pytest.approx(0.2)
    assert float(provider_fallback["unit_price_usd"]) == pytest.approx(0.4)
    assert float(global_fallback["unit_price_usd"]) == pytest.approx(0.9)
    db.close()


def test_runtime_proxy_llm_uses_catalog_rate(isolated_db, monkeypatch):
    from agentos.core.database import create_database
    import agentos.api.routers.runtime_proxy as rp

    db = create_database(Path("data/agent.db"))
    db.initialize()
    db.upsert_pricing_rate(
        provider="gmi",
        model="deepseek-ai/DeepSeek-V3.2",
        resource_type="llm",
        operation="infer",
        unit="input_token",
        unit_price_usd=0.000001,
        pricing_version="catalog-v1",
    )
    db.upsert_pricing_rate(
        provider="gmi",
        model="deepseek-ai/DeepSeek-V3.2",
        resource_type="llm",
        operation="infer",
        unit="output_token",
        unit_price_usd=0.000003,
        pricing_version="catalog-v1",
    )
    db.close()

    monkeypatch.setenv("GMI_API_KEY", "dummy-key")

    class _Resp:
        is_success = True

        @staticmethod
        def json():
            return {
                "model": "deepseek-ai/DeepSeek-V3.2",
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50},
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            return _Resp()

    monkeypatch.setattr(rp.httpx, "AsyncClient", lambda timeout=60.0: _Client())

    client = _client(monkeypatch)
    resp = client.post(
        "/api/v1/runtime-proxy/llm/infer",
        headers={"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"},
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "provider": "gmi",
            "model": "deepseek-ai/DeepSeek-V3.2",
            "session_id": "sess-proxy-1",
            "org_id": "org-a",
            "agent_name": "agent-a",
        },
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert float(payload["cost_usd"]) == pytest.approx((100 * 0.000001) + (50 * 0.000003))

    from agentos.core.database import create_database as _db
    db2 = _db(Path("data/agent.db"))
    db2.initialize()
    row = db2.conn.execute("SELECT * FROM billing_records ORDER BY id DESC LIMIT 1").fetchone()
    assert row["pricing_source"] == "catalog"
    assert row["pricing_version"] == "catalog-v1"
    db2.close()


def test_runtime_proxy_tool_and_sandbox_billing_shapes(isolated_db, monkeypatch):
    from agentos.core.database import create_database

    db = create_database(Path("data/agent.db"))
    db.initialize()
    db.upsert_pricing_rate(
        provider="backend-tool-proxy",
        model="",
        resource_type="tool",
        operation="web-search",
        unit="call",
        unit_price_usd=0.002,
        pricing_version="tool-v1",
    )
    db.upsert_pricing_rate(
        provider="backend-sandbox-proxy",
        model="",
        resource_type="sandbox",
        operation="exec_base",
        unit="call",
        unit_price_usd=0.001,
        pricing_version="sandbox-v1",
    )
    db.upsert_pricing_rate(
        provider="backend-sandbox-proxy",
        model="",
        resource_type="sandbox",
        operation="exec",
        unit="second",
        unit_price_usd=0.0005,
        pricing_version="sandbox-v1",
    )
    db.close()

    client = _client(monkeypatch)
    h = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}
    tool_resp = client.post(
        "/api/v1/runtime-proxy/tool/call",
        headers=h,
        json={
            "tool": "web-search",
            "args": {"query": "agent billing"},
            "session_id": "sess-tool-1",
            "org_id": "org-a",
            "agent_name": "agent-a",
        },
    )
    assert tool_resp.status_code == 200
    assert float(tool_resp.json()["cost_usd"]) == pytest.approx(0.002)

    sandbox_resp = client.post(
        "/api/v1/runtime-proxy/sandbox/exec",
        headers=h,
        json={
            "command": "echo ok",
            "timeout_seconds": 5,
            "session_id": "sess-sandbox-1",
            "org_id": "org-a",
            "agent_name": "agent-a",
        },
    )
    assert sandbox_resp.status_code == 200
    assert float(sandbox_resp.json()["cost_usd"]) >= 0.001

    db2 = create_database(Path("data/agent.db"))
    db2.initialize()
    rows = db2.conn.execute(
        "SELECT cost_type, pricing_source, unit, unit_price_usd FROM billing_records WHERE org_id = ? ORDER BY id DESC LIMIT 2",
        ("org-a",),
    ).fetchall()
    assert len(rows) == 2
    assert all(r["cost_type"] == "tool_execution" for r in rows)
    assert all(r["pricing_source"] in ("catalog", "fallback_env") for r in rows)
    db2.close()


def test_sync_gmi_internal_marks_removed_and_writes_audit(isolated_db, monkeypatch):
    import agentos.api.routers.billing as billing_router
    from agentos.core.database import create_database

    monkeypatch.setenv("GMI_API_KEY", "dummy-key")
    monkeypatch.setenv("GMI_PRICE_ALERT_DELTA_PCT", "0.01")

    db = create_database(Path("data/agent.db"))
    db.initialize()
    # Pre-existing model that should be marked inactive.
    db.upsert_pricing_rate(
        provider="gmi",
        model="old-model",
        resource_type="llm",
        operation="infer",
        unit="input_token",
        unit_price_usd=0.001,
        pricing_version="old",
    )
    db.close()

    class _Resp:
        is_success = True

        @staticmethod
        def json():
            return {
                "data": [
                    {
                        "id": "new-model",
                        "status": "active",
                        "pricing": {"input_per_million": 1.0, "output_per_million": 2.0},
                    },
                    {
                        "id": "deprecated-model",
                        "status": "deprecated",
                        "pricing": {"input_per_million": 3.0, "output_per_million": 6.0},
                    },
                ]
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, *args, **kwargs):
            return _Resp()

    monkeypatch.setattr(billing_router.httpx, "AsyncClient", lambda timeout=30.0: _Client())

    result = asyncio.run(billing_router.sync_gmi_pricing_catalog_internal(dry_run=False, actor="test-sync"))
    assert result["ok"] is True
    assert result["models_seen"] == 2
    assert result["models_marked_inactive"] >= 1
    assert result["alerts_count"] >= 1

    db2 = create_database(Path("data/agent.db"))
    db2.initialize()
    old_active = db2.conn.execute(
        """SELECT COUNT(*) AS cnt FROM pricing_catalog
           WHERE provider='gmi' AND model='old-model' AND resource_type='llm' AND operation='infer' AND is_active=1"""
    ).fetchone()
    assert int(old_active["cnt"]) == 0
    audit_rows = db2.conn.execute(
        "SELECT COUNT(*) AS cnt FROM audit_log WHERE action IN ('pricing.sync.gmi','pricing.sync.gmi.alert')"
    ).fetchone()
    assert int(audit_rows["cnt"]) >= 1
    db2.close()


def test_runtime_proxy_agent_run_uses_request_scoped_override_without_mutating_cache(isolated_db, monkeypatch):
    import agentos.api.routers.runtime_proxy as rp
    from agentos.core.harness import TurnResult
    from agentos.llm.provider import LLMResponse

    class _DummyAgent:
        def __init__(self, runtime_mode: str, output: str):
            self.config = type("Cfg", (), {"harness": {"runtime_mode": runtime_mode}})()
            self.output = output
            self.calls = 0

        def set_runtime_context(self, **kwargs):
            return None

        async def run(self, task: str):
            self.calls += 1
            return [TurnResult(
                turn_number=1,
                llm_response=LLMResponse(content=self.output, model="stub"),
                done=True,
                stop_reason="completed",
            )]

    cached_agent = _DummyAgent(runtime_mode="graph", output="cached")
    override_agent = _DummyAgent(runtime_mode="graph", output="override")

    monkeypatch.setattr(rp, "_get_cached_agent", lambda name: cached_agent)
    monkeypatch.setattr(rp.Agent, "from_name", classmethod(lambda cls, name: override_agent))

    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}
    resp = client.post(
        "/api/v1/runtime-proxy/agent/run",
        headers=headers,
        json={"agent_name": "test-agent", "task": "hello", "enable_checkpoints": True},
    )

    assert resp.status_code == 200
    assert resp.json()["success"] is True
    assert resp.json()["output"] == "override"
    assert override_agent.calls == 1
    assert cached_agent.calls == 0
    assert cached_agent.config.harness["runtime_mode"] == "graph"

