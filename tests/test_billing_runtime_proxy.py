"""Billing-focused regression tests for runtime proxy and pricing catalog."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REQUIRED_RUNNABLE_METADATA_KEYS = {
    "success",
    "turns",
    "tool_calls",
    "cost_usd",
    "latency_ms",
    "session_id",
    "trace_id",
    "run_id",
    "stop_reason",
    "checkpoint_id",
    "parent_session_id",
    "resumed_from_checkpoint",
    "run_name",
    "tags",
    "metadata",
    "input_raw",
}


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
        provider="workers-ai",
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
        provider="workers-ai",
        model="",
        resource_type="llm",
        operation="infer",
        unit="input_token",
        unit_price_usd=0.4,
        pricing_version="provider-default",
        effective_from=now,
    )
    db.upsert_pricing_rate(
        provider="workers-ai",
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
        provider="workers-ai",
        model="model-a",
    )
    provider_fallback = db.get_active_pricing_rate(
        resource_type="llm",
        operation="infer",
        unit="input_token",
        provider="workers-ai",
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


_RUNTIME_PROXY_REMOVED = pytest.mark.skip(
    reason="Backend runtime-proxy endpoints removed; runtime is edge-only.",
)


@_RUNTIME_PROXY_REMOVED
def test_runtime_proxy_llm_uses_catalog_rate(isolated_db, monkeypatch):
    from agentos.core.database import create_database
    import agentos.api.routers.runtime_proxy as rp

    db = create_database(Path("data/agent.db"))
    db.initialize()
    db.upsert_pricing_rate(
        provider="workers-ai",
        model="deepseek-ai/DeepSeek-V3.2",
        resource_type="llm",
        operation="infer",
        unit="input_token",
        unit_price_usd=0.000001,
        pricing_version="catalog-v1",
    )
    db.upsert_pricing_rate(
        provider="workers-ai",
        model="deepseek-ai/DeepSeek-V3.2",
        resource_type="llm",
        operation="infer",
        unit="output_token",
        unit_price_usd=0.000003,
        pricing_version="catalog-v1",
    )
    db.close()

    monkeypatch.setenv("AGENTOS_WORKER_URL", "http://fake-worker")
    monkeypatch.setenv("EDGE_INGEST_TOKEN", "edge-test-token")

    # Mock the CloudflareClient used by the /llm/infer endpoint
    class _FakeCFClient:
        async def llm_infer(self, model, messages, max_tokens=1024, temperature=0.0, tools=None):
            return {
                "content": "ok",
                "model": "deepseek-ai/DeepSeek-V3.2",
                "tool_calls": [],
                "input_tokens": 100,
                "output_tokens": 50,
            }

    import agentos.infra.cloudflare_client as cf_mod
    monkeypatch.setattr(cf_mod, "get_cf_client", lambda: _FakeCFClient())

    client = _client(monkeypatch)
    resp = client.post(
        "/api/v1/runtime-proxy/llm/infer",
        headers={"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"},
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "provider": "workers-ai",
            "model": "deepseek-ai/DeepSeek-V3.2",
            "session_id": "sess-proxy-1",
            "org_id": "org-a",
            "agent_name": "agent-a",
        },
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert float(payload["cost_usd"]) == pytest.approx((100 * 0.000001) + (50 * 0.000003))

    # Billing is fire-and-forget — give the background task time to complete.
    import time
    time.sleep(0.1)

    from agentos.core.database import create_database as _db
    db2 = _db(Path("data/agent.db"))
    db2.initialize()
    row = db2.conn.execute("SELECT * FROM billing_records ORDER BY id DESC LIMIT 1").fetchone()
    assert row["pricing_source"] == "catalog"
    assert row["pricing_version"] == "catalog-v1"
    db2.close()


@_RUNTIME_PROXY_REMOVED
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


@_RUNTIME_PROXY_REMOVED
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
    monkeypatch.setattr(rp, "_get_request_scoped_agent", lambda name: override_agent)

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


@_RUNTIME_PROXY_REMOVED
def test_runtime_proxy_agent_resume_from_checkpoint(isolated_db, monkeypatch):
    import agentos.api.routers.runtime_proxy as rp
    from agentos.core.database import create_database
    from agentos.core.harness import TurnResult
    from agentos.llm.provider import LLMResponse

    class _PauseAgent:
        def __init__(self):
            self.config = type("Cfg", (), {"harness": {"runtime_mode": "graph"}})()
            self._harness = type("Harness", (), {"_pending_graph_resume_payload": None})()
            self._observer = None
            self.calls = 0
            self.resume_calls = 0

        def set_runtime_context(self, **kwargs):
            return None

        async def run(self, task: str):
            self.calls += 1
            self._harness._pending_graph_resume_payload = {
                "checkpoint_id": "cp-runtime-proxy-1",
                "messages": [{"role": "user", "content": task}],
                "llm_response": {"content": "call tool", "model": "stub", "tool_calls": []},
                "current_turn": 1,
                "cumulative_cost_usd": 0.0,
                "trace_id": "trace-1",
                "session_id": "sess-1",
            }
            return [TurnResult(
                turn_number=1,
                llm_response=LLMResponse(content="waiting approval", model="stub"),
                done=True,
                stop_reason="human_approval_required",
            )]

        async def resume_from_checkpoint(self, checkpoint_payload: dict):
            self.resume_calls += 1
            return [TurnResult(
                turn_number=1,
                llm_response=LLMResponse(content="resumed done", model="stub"),
                done=True,
                stop_reason="completed",
            )]

    cached_agent = _PauseAgent()
    request_scoped_agent = _PauseAgent()
    monkeypatch.setattr(rp, "_get_cached_agent", lambda name: cached_agent)
    monkeypatch.setattr(rp, "_get_request_scoped_agent", lambda name: request_scoped_agent)
    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}

    first = client.post(
        "/api/v1/runtime-proxy/agent/run",
        headers=headers,
        json={"agent_name": "test-agent", "task": "hello", "require_human_approval": True},
    )
    assert first.status_code == 200
    body = first.json()
    assert body["stop_reason"] == "human_approval_required"
    assert body["checkpoint_id"] == "cp-runtime-proxy-1"

    db = create_database(Path("data/agent.db"))
    row = db.get_graph_checkpoint("cp-runtime-proxy-1")
    assert row is not None
    assert row["status"] == "pending_approval"
    db.close()

    second = client.post(
        "/api/v1/runtime-proxy/agent/run/checkpoints/cp-runtime-proxy-1/resume",
        headers=headers,
        json={"agent_name": "test-agent"},
    )
    assert second.status_code == 200
    resumed = second.json()
    assert resumed["success"] is True
    assert resumed["output"] == "resumed done"
    assert resumed["stop_reason"] == "completed"

    db2 = create_database(Path("data/agent.db"))
    row2 = db2.get_graph_checkpoint("cp-runtime-proxy-1")
    assert row2 is not None
    assert row2["status"] == "resumed"
    db2.close()


@_RUNTIME_PROXY_REMOVED
def test_runtime_proxy_runnable_invoke_batch_and_events(isolated_db, monkeypatch):
    import agentos.api.routers.runtime_proxy as rp
    from agentos.core.harness import TurnResult
    from agentos.llm.provider import LLMResponse

    class _DummyAgent:
        def __init__(self, output: str):
            self.config = type("Cfg", (), {"harness": {"runtime_mode": "graph"}})()
            self.output = output

        def set_runtime_context(self, **kwargs):
            return None

        async def run(self, task: str):
            return [TurnResult(
                turn_number=1,
                llm_response=LLMResponse(content=f"{self.output}:{task}", model="stub"),
                done=True,
                stop_reason="completed",
            )]

    monkeypatch.setattr(rp, "_get_request_scoped_agent", lambda name: _DummyAgent("ok"))
    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}

    inv = client.post(
        "/api/v1/runtime-proxy/runnable/invoke",
        headers=headers,
        json={
            "agent_name": "test-agent",
            "input": {"input": "hello"},
            "config": {"run_name": "r1", "tags": ["a"], "metadata": {"k": "v"}},
        },
    )
    assert inv.status_code == 200
    body = inv.json()
    assert body["output"] == "ok:hello"
    assert body["metadata"]["success"] is True
    assert body["metadata"]["run_name"] == "r1"
    assert body["metadata"]["tags"] == ["a"]
    assert body["metadata"]["metadata"] == {"k": "v"}
    assert REQUIRED_RUNNABLE_METADATA_KEYS.issubset(set(body["metadata"].keys()))

    bat = client.post(
        "/api/v1/runtime-proxy/runnable/batch",
        headers=headers,
        json={
            "agent_name": "test-agent",
            "inputs": ["one", {"query": "two"}],
            "config": {"max_concurrency": 2},
        },
    )
    assert bat.status_code == 200
    b = bat.json()
    assert len(b["outputs"]) == 2
    assert b["batch_metadata"]["max_concurrency"] == 2
    assert b["outputs"][0]["ok"] is True
    assert b["outputs"][0]["output"] == "ok:one"
    assert b["outputs"][1]["output"] == "ok:two"
    assert REQUIRED_RUNNABLE_METADATA_KEYS.issubset(set(b["outputs"][0]["metadata"].keys()))
    assert REQUIRED_RUNNABLE_METADATA_KEYS.issubset(set(b["outputs"][1]["metadata"].keys()))

    evt = client.post(
        "/api/v1/runtime-proxy/runnable/stream-events",
        headers=headers,
        json={"agent_name": "test-agent", "input": "events"},
    )
    assert evt.status_code == 200
    events = evt.json()["events"]
    assert events[0]["event"] == "on_chain_start"
    assert events[-1]["event"] == "on_chain_end"


@_RUNTIME_PROXY_REMOVED
def test_runtime_proxy_runnable_stream_events_uses_runtime_event_log(isolated_db, monkeypatch):
    import agentos.api.routers.runtime_proxy as rp
    from agentos.core.database import create_database
    from agentos.core.harness import TurnResult
    from agentos.llm.provider import LLMResponse

    db = create_database(Path("data/agent.db"))
    db.initialize()
    db.insert_runtime_event(
        {
            "event_id": "evt1",
            "event_type": "llm_request",
            "trace_id": "trace-evt",
            "session_id": "sess-evt",
            "payload": {"turn": 1},
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "evt2",
            "event_type": "llm_response",
            "trace_id": "trace-evt",
            "session_id": "sess-evt",
            "payload": {"turn": 1, "model": "stub"},
        }
    )
    db.close()

    class _Observer:
        def __init__(self):
            self.records = [type("Rec", (), {"session_id": "sess-evt", "trace_id": "trace-evt"})()]

    class _DummyAgent:
        def __init__(self):
            self.config = type("Cfg", (), {"harness": {"runtime_mode": "graph"}})()
            self._observer = _Observer()

        def set_runtime_context(self, **kwargs):
            return None

        async def run(self, task: str):
            return [TurnResult(
                turn_number=1,
                llm_response=LLMResponse(content=f"ok:{task}", model="stub"),
                done=True,
                stop_reason="completed",
            )]

    monkeypatch.setattr(rp, "_get_request_scoped_agent", lambda name: _DummyAgent())
    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}
    resp = client.post(
        "/api/v1/runtime-proxy/runnable/stream-events",
        headers=headers,
        json={"agent_name": "test-agent", "input": "hello"},
    )
    assert resp.status_code == 200
    events = resp.json()["events"]
    names = [e["event"] for e in events]
    assert "on_llm_start" in names
    assert "on_llm_end" in names


@_RUNTIME_PROXY_REMOVED
def test_runtime_proxy_runnable_latency_breakdown(isolated_db, monkeypatch):
    from agentos.core.database import create_database

    db = create_database(Path("data/agent.db"))
    db.initialize()
    base = time.time()
    db.insert_runtime_event(
        {
            "event_id": "a1",
            "event_type": "llm_request",
            "trace_id": "trace-lat",
            "session_id": "sess-lat",
            "event_ts": base,
            "payload": {"turn": 1},
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "a2",
            "event_type": "llm_response",
            "trace_id": "trace-lat",
            "session_id": "sess-lat",
            "event_ts": base + 0.4,
            "payload": {"turn": 1},
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "a3",
            "event_type": "tool_call",
            "trace_id": "trace-lat",
            "session_id": "sess-lat",
            "event_ts": base + 0.45,
            "payload": {"turn": 1},
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "a4",
            "event_type": "tool_result",
            "trace_id": "trace-lat",
            "session_id": "sess-lat",
            "event_ts": base + 0.95,
            "payload": {"turn": 1},
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "a5",
            "event_type": "node_end",
            "trace_id": "trace-lat",
            "session_id": "sess-lat",
            "event_ts": base + 1.0,
            "node_id": "llm",
            "latency_ms": 410.0,
            "payload": {"latency_ms": 410.0},
        }
    )
    db.close()

    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}
    resp = client.post(
        "/api/v1/runtime-proxy/runnable/latency-breakdown",
        headers=headers,
        json={"trace_id": "trace-lat"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["trace_id"] == "trace-lat"
    assert body["event_count"] >= 5
    assert body["llm_calls"] == 1
    assert body["tool_calls"] == 1
    assert float(body["llm_ms"]) == pytest.approx(400.0, abs=2.0)
    assert float(body["tool_ms"]) == pytest.approx(500.0, abs=2.0)
    assert float(body["node_reported_ms"]) == pytest.approx(410.0, abs=2.0)
    assert body["diagnosis"] == "tool_bound"
    assert any("Tool execution dominates runtime" in r for r in body["diagnosis_reasons"])


@_RUNTIME_PROXY_REMOVED
def test_runtime_proxy_runnable_events_pagination_and_watermark(isolated_db, monkeypatch):
    from agentos.core.database import create_database

    db = create_database(Path("data/agent.db"))
    db.initialize()
    base = time.time()
    db.insert_runtime_event(
        {
            "event_id": "evt-page-1",
            "event_type": "session_start",
            "trace_id": "trace-page",
            "session_id": "sess-page",
            "event_ts": base,
            "payload": {
                "run_name": "page_run",
                "tags": ["p0"],
                "metadata": {"source": "test"},
                "input_raw": {"q": "hello"},
            },
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "evt-page-2",
            "event_type": "llm_request",
            "trace_id": "trace-page",
            "session_id": "sess-page",
            "event_ts": base + 0.01,
            "payload": {"turn": 1},
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "evt-page-3",
            "event_type": "llm_response",
            "trace_id": "trace-page",
            "session_id": "sess-page",
            "event_ts": base + 0.02,
            "payload": {"turn": 1},
        }
    )
    db.close()

    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}
    first = client.post(
        "/api/v1/runtime-proxy/runnable/events",
        headers=headers,
        json={"session_id": "sess-page", "limit": 1},
    )
    assert first.status_code == 200
    first_body = first.json()
    assert len(first_body["events"]) == 1
    assert first_body["has_more"] is True
    assert first_body["metadata"]["run_name"] == "page_run"
    assert first_body["metadata"]["tags"] == ["p0"]
    assert first_body["metadata"]["metadata"] == {"source": "test"}
    assert REQUIRED_RUNNABLE_METADATA_KEYS.issubset(set(first_body["metadata"].keys()))
    watermark = first_body["watermark_cursor"]
    cursor = first_body["next_cursor"]

    second = client.post(
        "/api/v1/runtime-proxy/runnable/events",
        headers=headers,
        json={"session_id": "sess-page", "limit": 2, "cursor": cursor, "watermark_cursor": watermark},
    )
    assert second.status_code == 200
    second_body = second.json()
    assert len(second_body["events"]) >= 1
    ids_first = {e["event_id"] for e in first_body["events"]}
    ids_second = {e["event_id"] for e in second_body["events"]}
    assert ids_first.isdisjoint(ids_second)

    final = client.post(
        "/api/v1/runtime-proxy/runnable/events",
        headers=headers,
        json={"session_id": "sess-page", "cursor": watermark, "watermark_cursor": watermark},
    )
    assert final.status_code == 200
    final_body = final.json()
    assert final_body["events"] == []
    assert final_body["has_more"] is False


@_RUNTIME_PROXY_REMOVED
def test_runtime_proxy_runnable_runs_tree_bundle(isolated_db, monkeypatch):
    from agentos.core.database import create_database

    db = create_database(Path("data/agent.db"))
    db.initialize()
    base = time.time()
    db.insert_runtime_event(
        {
            "event_id": "evt-tree-1",
            "event_type": "session_start",
            "trace_id": "trace-tree",
            "session_id": "sess-tree",
            "event_ts": base,
            "payload": {
                "run_name": "tree_run",
                "tags": ["edge", "tree"],
                "metadata": {"k": "v"},
            },
        }
    )
    db.insert_runtime_event(
        {
            "event_id": "evt-tree-2",
            "event_type": "node_end",
            "trace_id": "trace-tree",
            "session_id": "sess-tree",
            "event_ts": base + 0.01,
            "node_id": "llm",
            "latency_ms": 20.0,
            "payload": {"node_id": "llm", "latency_ms": 20.0},
        }
    )
    db.upsert_graph_checkpoint(
        checkpoint_id="cp-tree-1",
        agent_name="test-agent",
        session_id="sess-tree",
        trace_id="trace-tree",
        status="pending_approval",
        payload={"checkpoint_id": "cp-tree-1"},
        metadata={"source": "test"},
    )
    db.insert_eval_trials(
        eval_run_id=1,
        trials=[
            {
                "task_name": "tree-eval",
                "trial": 1,
                "score": 1.0,
                "passed": True,
                "latency_ms": 10.0,
                "cost_usd": 0.001,
                "tool_calls_count": 0,
                "session_id": "sess-tree",
                "trace_id": "trace-tree",
            }
        ],
    )
    db.insert_trace_annotation(
        trace_id="trace-tree",
        author="tester",
        annotation_type="note",
        message="tree annotation",
    )
    db.close()

    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer edge-test-token", "X-Edge-Token": "edge-test-token"}
    resp = client.post(
        "/api/v1/runtime-proxy/runnable/runs/tree",
        headers=headers,
        json={"trace_id": "trace-tree"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["trace_id"] == "trace-tree"
    assert int(body["counts"]["runtime_events"]) >= 2
    assert int(body["counts"]["checkpoints"]) >= 1
    assert int(body["counts"]["eval_trials"]) >= 1
    assert int(body["counts"]["annotations"]) >= 1
    assert body["metadata"]["run_name"] == "tree_run"
    assert body["metadata"]["tags"] == ["edge", "tree"]
    assert REQUIRED_RUNNABLE_METADATA_KEYS.issubset(set(body["metadata"].keys()))

