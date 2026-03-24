"""Tests for Tavus voice platform adapter + generic voice DB + API endpoints.

ElevenLabs, Retell, and Bland adapters were removed — TTS/STT now via GMI
native tools, call management via Pipedream MCP if needed.
"""

import hashlib
import hmac
import json
import uuid

import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient


# ── Tavus Adapter ──────────────────────────────────────────────────


class TestTavusAdapter:
    def setup_method(self):
        from agentos.integrations.voice_platforms.tavus import TavusAdapter

        self.adapter = TavusAdapter(webhook_secret="tavus-secret")

    def test_verify_webhook_no_secret(self):
        from agentos.integrations.voice_platforms.tavus import TavusAdapter

        adapter = TavusAdapter(webhook_secret="")
        assert adapter.verify_webhook(b"anything", "") is True

    def test_verify_webhook_valid_signature(self):
        payload = b'{"event":"conversation.started"}'
        sig = hmac.new(b"tavus-secret", payload, hashlib.sha256).hexdigest()
        assert self.adapter.verify_webhook(payload, sig) is True

    def test_process_webhook_conversation_started(self):
        payload = {
            "event": "conversation.started",
            "conversation_id": "tc-1",
            "persona_id": "persona-abc",
        }
        result = self.adapter.process_webhook(payload, org_id="org1")
        assert result["event_type"] == "conversation.started"
        assert result["conversation_id"] == "tc-1"
        assert result["processed"] is True
        assert "conversation" in result

    def test_process_webhook_conversation_ended(self):
        payload = {
            "event": "conversation.ended",
            "conversation_id": "tc-2",
            "duration": 95.0,
            "transcript": "Video agent conversation transcript.",
        }
        result = self.adapter.process_webhook(payload)
        assert result["event_type"] == "conversation.ended"
        assert result["duration_seconds"] == 95.0
        assert result["transcript_length"] == len("Video agent conversation transcript.")


# ── Generic Voice DB ────────────────────────────────────────────────


class TestGenericVoiceDB:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB

        db = AgentDB(tmp_path / "voice_test.db")
        db.initialize()
        yield db
        db.close()

    def test_insert_and_get_voice_call(self, db):
        db.insert_voice_call(
            call_id="vc-el1", platform="elevenlabs", org_id="org1",
            agent_name="demo-agent", status="pending",
        )
        call = db.get_voice_call("vc-el1")
        assert call is not None
        assert call["platform"] == "elevenlabs"
        assert call["org_id"] == "org1"

    def test_list_voice_calls_by_platform(self, db):
        db.insert_voice_call(call_id="lp-1", platform="elevenlabs", org_id="org1")
        db.insert_voice_call(call_id="lp-2", platform="tavus", org_id="org1")
        db.insert_voice_call(call_id="lp-3", platform="elevenlabs", org_id="org1")

        el_calls = db.list_voice_calls(platform="elevenlabs")
        assert len(el_calls) == 2
        tavus_calls = db.list_voice_calls(platform="tavus")
        assert len(tavus_calls) == 1

    def test_update_voice_call(self, db):
        db.insert_voice_call(call_id="up-1", platform="tavus", status="pending")
        db.update_voice_call("up-1", status="ended", duration_seconds=60.0)
        call = db.get_voice_call("up-1")
        assert call["status"] == "ended"
        assert call["duration_seconds"] == 60.0

    def test_insert_voice_event(self, db):
        db.insert_voice_event(
            call_id="ev-1", platform="tavus",
            event_type="conversation.started", payload_json='{"event":"started"}',
        )
        db.insert_voice_event(
            call_id="ev-1", platform="tavus",
            event_type="conversation.ended", payload_json='{"event":"ended"}',
        )
        events = db.list_voice_events("ev-1")
        assert len(events) == 2

    def test_voice_call_summary(self, db):
        db.insert_voice_call(call_id="s1", platform="elevenlabs", org_id="org1")
        db.update_voice_call("s1", status="ended", duration_seconds=30, cost_usd=0.10)
        db.insert_voice_call(call_id="s2", platform="tavus", org_id="org1")
        db.update_voice_call("s2", status="ended", duration_seconds=60, cost_usd=0.20)

        summary = db.voice_call_summary(org_id="org1")
        assert summary["total_calls"] == 2
        assert summary["total_cost_usd"] == 0.30
        assert summary["total_duration_seconds"] == 90.0

    def test_voice_call_summary_by_platform(self, db):
        db.insert_voice_call(call_id="sp1", platform="elevenlabs", org_id="org1")
        db.update_voice_call("sp1", status="ended", duration_seconds=30, cost_usd=0.10)
        db.insert_voice_call(call_id="sp2", platform="tavus", org_id="org1")
        db.update_voice_call("sp2", status="ended", duration_seconds=60, cost_usd=0.20)

        el_summary = db.voice_call_summary(platform="elevenlabs", org_id="org1")
        assert el_summary["total_calls"] == 1
        assert el_summary["total_cost_usd"] == 0.10

        tavus_summary = db.voice_call_summary(platform="tavus", org_id="org1")
        assert tavus_summary["total_calls"] == 1
        assert tavus_summary["total_cost_usd"] == 0.20


# ── Voice API Endpoints ─────────────────────────────────────────────


class TestVoiceAPIEndpoints:
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
        email = f"voice-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Voice Test",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_platform_webhook_tavus(self, api_client):
        resp = api_client.post("/api/v1/voice/tavus/webhook", json={
            "event": "conversation.started",
            "conversation_id": "api-conv-1",
        })
        assert resp.status_code == 200
        assert resp.json()["processed"] is True
        assert resp.json()["event_type"] == "conversation.started"

    def test_platform_webhook_unknown(self, api_client):
        resp = api_client.post("/api/v1/voice/unknown/webhook", json={
            "event": "test",
        })
        assert resp.status_code == 404

    def test_platform_webhook_removed_bland(self, api_client):
        """Bland was removed — should return 404."""
        resp = api_client.post("/api/v1/voice/bland/webhook", json={
            "event": "call.started",
        })
        assert resp.status_code == 404

    def test_list_tavus_calls(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/voice/tavus/calls", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["calls"] == []
        assert resp.json()["platform"] == "tavus"

    def test_all_platforms_summary(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/voice/all/summary", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "total_calls" in data
        assert "total_cost_usd" in data
        assert "total_duration_seconds" in data
        assert "vapi" in data
        assert "platforms" in data
