"""Tests for Vapi Voice Platform Integration."""

import json
import uuid
import pytest
from pathlib import Path
from fastapi.testclient import TestClient


# ── Vapi Adapter ────────────────────────────────────────────────────


class TestVapiAdapter:
    def setup_method(self):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        self.adapter = VapiAdapter(webhook_secret="test-secret")

    def test_verify_webhook_valid(self):
        import hmac, hashlib
        payload = b'{"message":{"type":"call.started"}}'
        sig = hmac.new(b"test-secret", payload, hashlib.sha256).hexdigest()
        assert self.adapter.verify_webhook(payload, sig) is True

    def test_verify_webhook_invalid(self):
        payload = b'{"message":{"type":"call.started"}}'
        assert self.adapter.verify_webhook(payload, "invalid-signature") is False

    def test_verify_webhook_no_secret(self):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        adapter = VapiAdapter(webhook_secret="")
        assert adapter.verify_webhook(b"anything", "") is True

    def test_process_call_started(self):
        payload = {
            "message": {
                "type": "call.started",
                "call": {
                    "id": "call-123",
                    "type": "inboundPhoneCall",
                    "customer": {"number": "+1234567890"},
                    "assistantId": "asst-456",
                },
            },
        }
        result = self.adapter.process_webhook(payload)
        assert result["event_type"] == "call.started"
        assert result["call_id"] == "call-123"
        assert result["processed"] is True
        assert "call" in result

    def test_process_call_ended(self):
        payload = {
            "message": {
                "type": "end-of-call-report",
                "call": {"id": "call-123"},
                "durationSeconds": 45.5,
                "cost": 0.25,
                "transcript": "Hello, how can I help?",
            },
        }
        result = self.adapter.process_webhook(payload)
        assert result["event_type"] == "end-of-call-report"
        assert result["duration_seconds"] == 45.5
        assert result["cost_usd"] == 0.25

    def test_process_transcript(self):
        payload = {
            "message": {
                "type": "transcript",
                "transcript": "Hello world",
                "role": "user",
                "transcriptType": "final",
            },
        }
        result = self.adapter.process_webhook(payload)
        assert result["text"] == "Hello world"
        assert result["role"] == "user"
        assert result["is_final"] is True

    def test_process_function_call(self):
        payload = {
            "message": {
                "type": "function-call",
                "functionCall": {
                    "name": "search_knowledge",
                    "parameters": {"query": "pricing"},
                },
            },
        }
        result = self.adapter.process_webhook(payload)
        assert result["function_name"] == "search_knowledge"
        assert result["parameters"]["query"] == "pricing"
        assert result["needs_response"] is True

    def test_process_hang(self):
        payload = {"message": {"type": "hang", "call": {"id": "call-123"}}}
        result = self.adapter.process_webhook(payload)
        assert result["hung_up"] is True

    def test_process_unknown_event(self):
        payload = {"message": {"type": "some.unknown.event"}}
        result = self.adapter.process_webhook(payload)
        assert result["processed"] is True
        assert result["event_type"] == "some.unknown.event"


class TestVapiWebhookEvent:
    def test_from_payload_standard(self):
        from agentos.integrations.voice_platforms.vapi import VapiWebhookEvent
        event = VapiWebhookEvent.from_payload({
            "message": {"type": "call.started", "call": {"id": "c1"}},
        })
        assert event.event_type == "call.started"
        assert event.call_id == "c1"

    def test_from_payload_flat(self):
        from agentos.integrations.voice_platforms.vapi import VapiWebhookEvent
        event = VapiWebhookEvent.from_payload({
            "type": "transcript",
            "call": {"id": "c2"},
        })
        assert event.event_type == "transcript"
        assert event.call_id == "c2"


class TestVapiCall:
    def test_to_dict(self):
        from agentos.integrations.voice_platforms.vapi import VapiCall
        call = VapiCall(call_id="c1", phone_number="+1234", direction="inbound", status="connected")
        d = call.to_dict()
        assert d["call_id"] == "c1"
        assert d["direction"] == "inbound"


# ── Adapter with DB ─────────────────────────────────────────────────


class TestVapiWithDB:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "vapi_test.db")
        db.initialize()
        yield db
        db.close()

    def test_webhook_persists_call(self, db):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        adapter = VapiAdapter(db=db)
        adapter.process_webhook({
            "message": {
                "type": "call.started",
                "call": {"id": "persist-call", "customer": {"number": "+1234"}},
            },
        }, org_id="org1")

        call = db.get_vapi_call("persist-call")
        assert call is not None
        assert call["status"] == "connected"

    def test_webhook_persists_event(self, db):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        adapter = VapiAdapter(db=db)
        adapter.process_webhook({
            "message": {
                "type": "transcript",
                "call": {"id": "evt-call"},
                "transcript": "Hello",
            },
        })

        events = db.list_vapi_events("evt-call")
        assert len(events) >= 1

    def test_call_ended_updates(self, db):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        adapter = VapiAdapter(db=db)

        # Start call
        adapter.process_webhook({
            "message": {"type": "call.started", "call": {"id": "end-call"}},
        })

        # End call
        adapter.process_webhook({
            "message": {
                "type": "end-of-call-report",
                "call": {"id": "end-call"},
                "durationSeconds": 30,
                "cost": 0.15,
                "transcript": "Thank you for calling",
            },
        })

        call = db.get_vapi_call("end-call")
        assert call is not None
        assert call["status"] == "ended"
        assert call["duration_seconds"] == 30.0
        assert call["cost_usd"] == 0.15


# ── Database Methods ────────────────────────────────────────────────


class TestVapiDB:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "vapidb_test.db")
        db.initialize()
        yield db
        db.close()

    def test_insert_and_get_call(self, db):
        db.insert_vapi_call(call_id="vc1", org_id="org1", phone_number="+1234", direction="outbound")
        call = db.get_vapi_call("vc1")
        assert call is not None
        assert call["phone_number"] == "+1234"

    def test_update_call(self, db):
        db.insert_vapi_call(call_id="vc2", status="pending")
        db.update_vapi_call("vc2", status="ended", duration_seconds=45.0, cost_usd=0.30)
        call = db.get_vapi_call("vc2")
        assert call["status"] == "ended"
        assert call["duration_seconds"] == 45.0

    def test_list_calls(self, db):
        db.insert_vapi_call(call_id="lc1", org_id="org1", agent_name="a1")
        db.insert_vapi_call(call_id="lc2", org_id="org1", agent_name="a2")
        assert len(db.list_vapi_calls(org_id="org1")) == 2
        assert len(db.list_vapi_calls(agent_name="a1")) == 1

    def test_insert_and_list_events(self, db):
        db.insert_vapi_event(call_id="ec1", event_type="call.started")
        db.insert_vapi_event(call_id="ec1", event_type="transcript")
        events = db.list_vapi_events("ec1")
        assert len(events) == 2

    def test_call_summary(self, db):
        db.insert_vapi_call(call_id="sc1", org_id="org1")
        db.update_vapi_call("sc1", status="ended", duration_seconds=30, cost_usd=0.10)
        db.insert_vapi_call(call_id="sc2", org_id="org1")
        db.update_vapi_call("sc2", status="ended", duration_seconds=60, cost_usd=0.20)

        summary = db.vapi_call_summary(org_id="org1")
        assert summary["total_calls"] == 2
        assert summary["total_cost_usd"] == 0.30
        assert summary["total_duration_seconds"] == 90.0

    def test_get_nonexistent(self, db):
        assert db.get_vapi_call("nonexistent") is None


# ── API Router ──────────────────────────────────────────────────────


class TestVapiAPI:
    @pytest.fixture
    def api_client(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        (tmp_path / "eval").mkdir()

        from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4
        db = create_database(tmp_path / "data" / "agent.db")
        for migration in [MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4]:
            for stmt in migration.split(";"):
                stmt = stmt.strip()
                if stmt and not stmt.startswith("--"):
                    try:
                        db.conn.execute(stmt)
                    except Exception:
                        pass
        db.conn.commit()
        db.close()

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        email = f"vapi-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Vapi Test",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_webhook_endpoint(self, api_client):
        resp = api_client.post("/api/v1/voice/vapi/webhook", json={
            "message": {"type": "call.started", "call": {"id": "api-call-1"}},
        })
        assert resp.status_code == 200
        assert resp.json()["processed"] is True

    def test_list_calls_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/voice/vapi/calls", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["calls"] == []

    def test_call_summary(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/voice/vapi/calls/summary", headers=headers)
        assert resp.status_code == 200
        assert "total_calls" in resp.json()

    def test_get_call_not_found(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/voice/vapi/calls/nonexistent", headers=headers)
        assert resp.status_code == 404


# ── CLI Commands ────────────────────────────────────────────────────


class TestVoiceCLI:
    def test_summary_empty(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_voice

        class FakeArgs:
            voice_command = "summary"

        cmd_voice(FakeArgs())
        captured = capsys.readouterr()
        assert "Vapi Call Summary" in captured.out

    def test_no_subcommand(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_voice

        class FakeArgs:
            voice_command = None

        cmd_voice(FakeArgs())
        captured = capsys.readouterr()
        assert "Usage:" in captured.out


# ── Schema Migration ────────────────────────────────────────────────


class TestVapiMigration:
    def test_fresh_db_has_tables(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "fresh.db")
        db.initialize()
        tables = {
            row[0] for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "vapi_calls" in tables
        assert "vapi_events" in tables
        assert db.schema_version() >= 11
        db.close()


# ── Missing Vapi API Tests ──────────────────────────────────────────


class TestVapiAPIExtended:
    @pytest.fixture
    def api_client(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        (tmp_path / "eval").mkdir()

        from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4
        db = create_database(tmp_path / "data" / "agent.db")
        for migration in [MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4]:
            for stmt in migration.split(";"):
                stmt = stmt.strip()
                if stmt and not stmt.startswith("--"):
                    try:
                        db.conn.execute(stmt)
                    except Exception:
                        pass
        db.conn.commit()
        db.close()

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        email = f"vapiext-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Vapi Ext",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_create_call_no_api_key(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/voice/vapi/calls", headers=headers, json={
            "phone_number": "+1234567890", "agent_name": "test",
        })
        assert resp.status_code == 400  # VAPI_API_KEY not configured

    def test_end_call_no_api_key(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.delete("/api/v1/voice/vapi/calls/nonexistent", headers=headers)
        assert resp.status_code == 400  # No API key

    def test_call_events_empty(self, api_client):
        headers = self._auth_headers(api_client)
        # First create call via webhook
        api_client.post("/api/v1/voice/vapi/webhook", json={
            "message": {"type": "call.started", "call": {"id": "events-test-call"}},
        })
        resp = api_client.get("/api/v1/voice/vapi/calls/events-test-call/events", headers=headers)
        assert resp.status_code == 200
        assert "events" in resp.json()

    def test_webhook_call_lifecycle(self, api_client):
        """Test full call lifecycle through webhooks."""
        # Start
        resp1 = api_client.post("/api/v1/voice/vapi/webhook", json={
            "message": {"type": "call.started", "call": {"id": "lifecycle-call", "customer": {"number": "+1234"}}},
        })
        assert resp1.status_code == 200

        # Transcript
        resp2 = api_client.post("/api/v1/voice/vapi/webhook", json={
            "message": {"type": "transcript", "call": {"id": "lifecycle-call"}, "transcript": "Hello", "role": "user"},
        })
        assert resp2.status_code == 200

        # End
        resp3 = api_client.post("/api/v1/voice/vapi/webhook", json={
            "message": {"type": "end-of-call-report", "call": {"id": "lifecycle-call"}, "durationSeconds": 30, "cost": 0.10},
        })
        assert resp3.status_code == 200
        assert resp3.json()["duration_seconds"] == 30


# ── Production-Readiness: Integration + Edge Cases ──────────────────


class TestVapiFullLifecycleIntegration:
    """Verify call + events are both persisted through webhooks."""

    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "vapi_int.db")
        db.initialize()
        yield db
        db.close()

    def test_full_lifecycle_persists_call_and_events(self, db):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        adapter = VapiAdapter(db=db)

        # Start
        adapter.process_webhook({
            "message": {"type": "call.started", "call": {"id": "lc-1", "customer": {"number": "+1234"}}},
        }, org_id="org1")

        call = db.get_vapi_call("lc-1")
        assert call is not None
        assert call["status"] == "connected"

        # Transcript
        adapter.process_webhook({
            "message": {"type": "transcript", "call": {"id": "lc-1"}, "transcript": "Hello", "role": "user"},
        })

        # Function call
        adapter.process_webhook({
            "message": {"type": "function-call", "call": {"id": "lc-1"},
                        "functionCall": {"name": "search", "parameters": {"q": "test"}}},
        })

        # End
        adapter.process_webhook({
            "message": {"type": "end-of-call-report", "call": {"id": "lc-1"},
                        "durationSeconds": 60, "cost": 0.25, "transcript": "Full transcript here"},
        })

        # Verify call updated
        call = db.get_vapi_call("lc-1")
        assert call["status"] == "ended"
        assert call["duration_seconds"] == 60.0
        assert call["cost_usd"] == 0.25
        assert call["transcript"] == "Full transcript here"

        # Verify ALL events persisted
        events = db.list_vapi_events("lc-1")
        assert len(events) >= 3  # transcript, function-call, end-of-call
        event_types = {e["event_type"] for e in events}
        assert "transcript" in event_types
        assert "function-call" in event_types

    def test_summary_with_zero_costs(self, db):
        db.insert_vapi_call(call_id="z1", org_id="org1")
        db.insert_vapi_call(call_id="z2", org_id="org1")
        summary = db.vapi_call_summary(org_id="org1")
        assert summary["total_calls"] == 2
        assert summary["total_cost_usd"] == 0.0
        assert summary["total_duration_seconds"] == 0.0


class TestVapiWebhookEdgeCases:
    def test_empty_payload(self):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        adapter = VapiAdapter()
        result = adapter.process_webhook({})
        assert result["processed"] is True

    def test_missing_call_id(self):
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        adapter = VapiAdapter()
        result = adapter.process_webhook({"message": {"type": "transcript", "transcript": "hi"}})
        assert result["processed"] is True

    def test_duplicate_call_started(self):
        """Second call.started for same ID should not crash."""
        from agentos.integrations.voice_platforms.vapi import VapiAdapter
        from agentos.core.database import AgentDB
        import tempfile
        db = AgentDB(tempfile.mktemp(suffix=".db"))
        db.initialize()
        adapter = VapiAdapter(db=db)

        adapter.process_webhook({"message": {"type": "call.started", "call": {"id": "dup-1"}}})
        # Second start for same call — should handle gracefully (INSERT OR IGNORE)
        adapter.process_webhook({"message": {"type": "call.started", "call": {"id": "dup-1"}}})
        call = db.get_vapi_call("dup-1")
        assert call is not None
        db.close()


class TestVapiAuthEnforcement:
    @pytest.fixture
    def api_client(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        from agentos.core.database import create_database, MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4
        db = create_database(tmp_path / "data" / "agent.db")
        for m in [MIGRATION_V2_TO_V3, MIGRATION_V3_TO_V4]:
            for s in m.split(";"):
                s = s.strip()
                if s and not s.startswith("--"):
                    try: db.conn.execute(s)
                    except: pass
        db.conn.commit(); db.close()
        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        return TestClient(create_app(AgentHarness()))

    def test_webhook_bypasses_auth(self, api_client):
        """Webhooks should NOT require auth."""
        resp = api_client.post("/api/v1/voice/vapi/webhook", json={"message": {"type": "test"}})
        assert resp.status_code == 200

    def test_calls_require_auth(self, api_client):
        assert api_client.get("/api/v1/voice/vapi/calls").status_code == 401

    def test_summary_requires_auth(self, api_client):
        assert api_client.get("/api/v1/voice/vapi/calls/summary").status_code == 401
