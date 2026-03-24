"""Tests for Gold Images — CRUD, drift detection, compliance, API, CLI."""

import json
import pytest
from pathlib import Path
from fastapi.testclient import TestClient


# ── Gold Image Manager ──────────────────────────────────────────────


class TestGoldImageManager:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "gold_test.db")
        db.initialize()
        yield db
        db.close()

    def test_create_gold_image(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)

        result = manager.create(
            name="test-gold",
            config={"model": "claude-sonnet", "max_turns": 10, "tools": ["search"]},
            org_id="org1",
            description="Test gold image",
            created_by="user1",
        )
        assert result["name"] == "test-gold"
        assert result["image_id"]
        assert result["config_hash"]

    def test_get_gold_image(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)

        result = manager.create(name="get-test", config={"model": "test"})
        image = manager.get(result["image_id"])
        assert image is not None
        assert image["name"] == "get-test"
        assert image["config"]["model"] == "test"

    def test_list_gold_images(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)

        manager.create(name="img-1", config={"a": 1})
        manager.create(name="img-2", config={"b": 2})

        images = manager.list()
        assert len(images) == 2

    def test_update_gold_image(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)

        result = manager.create(name="update-test", config={"model": "old"})
        updated = manager.update(
            result["image_id"],
            name="updated-name",
            config={"model": "new"},
            updated_by="user2",
        )
        assert updated["name"] == "updated-name"
        assert updated["config"]["model"] == "new"

    def test_approve_gold_image(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)

        result = manager.create(name="approve-test", config={"x": 1})
        assert manager.approve(result["image_id"], approved_by="admin") is True

        image = manager.get(result["image_id"])
        assert image["approved_by"] == "admin"
        assert image["approved_at"] is not None

    def test_delete_gold_image(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)

        result = manager.create(name="delete-test", config={"x": 1})
        assert manager.delete(result["image_id"]) is True
        assert manager.get(result["image_id"]) is None

    def test_create_from_agent(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)

        agent_config = {
            "name": "my-agent",
            "model": "claude-sonnet",
            "max_turns": 20,
            "version": "0.2.0",
        }
        result = manager.create_from_agent(agent_config)
        assert result["name"] == "my-agent-gold"
        assert result["version"] == "0.2.0"

    def test_delete_nonexistent(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)
        assert manager.delete("nonexistent") is False

    def test_approve_nonexistent(self, db):
        from agentos.config.gold_image import GoldImageManager
        manager = GoldImageManager(db)
        assert manager.approve("nonexistent", approved_by="admin") is False


# ── Drift Detection ─────────────────────────────────────────────────


class TestDriftDetector:
    def setup_method(self):
        from agentos.config.drift import DriftDetector
        self.detector = DriftDetector()

    def test_no_drift(self):
        config = {"model": "claude", "max_turns": 10}
        report = self.detector.detect(config, config, agent_name="agent1")
        assert report.status == "compliant"
        assert report.total_drifts == 0

    def test_simple_drift(self):
        gold = {"model": "claude-sonnet", "max_turns": 10}
        agent = {"model": "claude-haiku", "max_turns": 10}
        report = self.detector.detect(agent, gold, agent_name="agent1")
        assert report.status == "drifted"
        assert report.total_drifts == 1
        assert report.drifted_fields[0].field == "model"

    def test_governance_drift_is_critical(self):
        gold = {"governance": {"budget_limit_usd": 10.0}}
        agent = {"governance": {"budget_limit_usd": 100.0}}
        report = self.detector.detect(agent, gold, agent_name="agent1")
        assert report.status == "critical"
        assert any(d.severity == "critical" for d in report.drifted_fields)

    def test_nested_dict_comparison(self):
        gold = {"memory": {"working": {"max_items": 50}}}
        agent = {"memory": {"working": {"max_items": 100}}}
        report = self.detector.detect(agent, gold, agent_name="agent1")
        assert report.total_drifts == 1
        assert report.drifted_fields[0].field == "memory.working.max_items"

    def test_list_order_insensitive(self):
        gold = {"tools": ["search", "write"]}
        agent = {"tools": ["write", "search"]}
        report = self.detector.detect(agent, gold, agent_name="agent1")
        assert report.total_drifts == 0  # same tools, different order

    def test_cosmetic_fields_ignored(self):
        gold = {"model": "claude", "agent_id": "abc123"}
        agent = {"model": "claude", "agent_id": "xyz789"}
        report = self.detector.detect(agent, gold, agent_name="agent1")
        assert report.total_drifts == 0  # agent_id is cosmetic

    def test_multiple_drifts(self):
        gold = {"model": "claude", "max_turns": 10, "tools": ["a"]}
        agent = {"model": "gpt", "max_turns": 50, "tools": ["a", "b"]}
        report = self.detector.detect(agent, gold, agent_name="agent1")
        assert report.total_drifts == 3

    def test_to_dict(self):
        gold = {"model": "claude"}
        agent = {"model": "gpt"}
        report = self.detector.detect(agent, gold, agent_name="agent1")
        d = report.to_dict()
        assert "agent_name" in d
        assert "drifted_fields" in d
        assert "status" in d


# ── Compliance Checker ──────────────────────────────────────────────


class TestComplianceChecker:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "compliance_test.db")
        db.initialize()
        yield db
        db.close()

    def test_check_against_specific_image(self, db):
        from agentos.config.gold_image import GoldImageManager
        from agentos.config.compliance import ComplianceChecker

        manager = GoldImageManager(db)
        result = manager.create(name="gold-1", config={"model": "claude", "max_turns": 10})

        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name="my-agent",
            agent_config={"model": "claude", "max_turns": 10},
            image_id=result["image_id"],
        )
        assert report.status == "compliant"
        assert report.total_drifts == 0

    def test_check_with_drift(self, db):
        from agentos.config.gold_image import GoldImageManager
        from agentos.config.compliance import ComplianceChecker

        manager = GoldImageManager(db)
        result = manager.create(name="gold-strict", config={"model": "claude", "max_turns": 10})

        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name="drifted-agent",
            agent_config={"model": "gpt-4", "max_turns": 50},
            image_id=result["image_id"],
        )
        assert report.status == "drifted"
        assert report.total_drifts > 0

        # Verify persisted
        checks = db.list_compliance_checks()
        assert len(checks) == 1
        assert checks[0]["status"] == "drifted"

    def test_check_no_gold_images(self, db):
        from agentos.config.compliance import ComplianceChecker
        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name="orphan-agent",
            agent_config={"model": "test"},
        )
        assert report.status == "no_gold_images"

    def test_check_nonexistent_image(self, db):
        from agentos.config.compliance import ComplianceChecker
        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name="agent",
            agent_config={"model": "test"},
            image_id="nonexistent",
        )
        assert report.status == "error"

    def test_best_match_selection(self, db):
        from agentos.config.gold_image import GoldImageManager
        from agentos.config.compliance import ComplianceChecker

        manager = GoldImageManager(db)
        manager.create(name="gold-a", config={"model": "claude", "max_turns": 10, "tools": ["a"]})
        manager.create(name="gold-b", config={"model": "claude", "max_turns": 10, "tools": ["b"]})

        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name="close-agent",
            agent_config={"model": "claude", "max_turns": 10, "tools": ["a"]},
        )
        # Should match gold-a (0 drifts vs 1 drift for gold-b)
        assert report.image_name == "gold-a"
        assert report.total_drifts == 0

    def test_compliance_summary(self, db):
        from agentos.config.compliance import ComplianceChecker
        checker = ComplianceChecker(db)

        # No checks yet
        summary = checker.compliance_summary()
        assert summary["total_checks"] == 0

        # Add some checks
        db.insert_compliance_check(
            org_id="org1", agent_name="a1", image_id="img1", image_name="gold",
            status="compliant", drift_count=0, drift_fields=[], drift_details={},
        )
        db.insert_compliance_check(
            org_id="org1", agent_name="a2", image_id="img1", image_name="gold",
            status="drifted", drift_count=3, drift_fields=["model", "tools", "max_turns"],
            drift_details={},
        )

        summary = checker.compliance_summary()
        assert summary["total_checks"] == 2
        assert summary["compliant"] == 1
        assert summary["drifted"] == 1


# ── Database Methods ────────────────────────────────────────────────


class TestGoldImageDB:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "golddb_test.db")
        db.initialize()
        yield db
        db.close()

    def test_insert_and_get(self, db):
        db.insert_gold_image(
            image_id="img1", name="test-gold",
            config_json='{"model": "claude"}', config_hash="abc123",
        )
        image = db.get_gold_image("img1")
        assert image is not None
        assert image["name"] == "test-gold"
        assert image["config"]["model"] == "claude"

    def test_config_audit(self, db):
        db.insert_config_audit(
            org_id="org1", agent_name="agent1",
            action="gold_image.created",
            field_changed="*", new_value="test-gold",
            changed_by="user1",
        )
        entries = db.list_config_audit(org_id="org1")
        assert len(entries) == 1
        assert entries[0]["action"] == "gold_image.created"

    def test_compliance_check_persistence(self, db):
        db.insert_compliance_check(
            org_id="org1", agent_name="agent1",
            image_id="img1", image_name="gold-1",
            status="compliant", drift_count=0,
            drift_fields=[], drift_details={},
        )
        checks = db.list_compliance_checks(org_id="org1")
        assert len(checks) == 1
        assert checks[0]["status"] == "compliant"


# ── API Router ──────────────────────────────────────────────────────


class TestGoldImagesAPI:
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

        agent_config = {
            "name": "test-agent", "description": "test", "version": "0.1.0",
            "system_prompt": "You are helpful.", "model": "stub",
            "tools": [], "governance": {"budget_limit_usd": 10.0},
            "memory": {"working": {"max_items": 50}},
            "max_turns": 5, "tags": [],
        }
        (tmp_path / "agents" / "test-agent.json").write_text(json.dumps(agent_config))

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        import uuid
        email = f"gold-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Gold Test",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_list_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/gold-images", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["images"] == []

    def test_create_gold_image(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/gold-images", headers=headers, json={
            "name": "test-gold",
            "config": {"model": "claude", "max_turns": 10},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "test-gold"
        assert data["image_id"]

    def test_create_requires_name(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/gold-images", headers=headers, json={
            "config": {"model": "test"},
        })
        assert resp.status_code == 400

    def test_compliance_summary(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/gold-images/compliance/summary", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "total_checks" in data
        assert "compliance_rate" in data

    def test_compliance_checks_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/gold-images/compliance/checks", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["checks"] == []

    def test_audit_log_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/gold-images/audit", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["entries"] == []


# ── CLI Commands ────────────────────────────────────────────────────


class TestGoldImageCLI:
    def test_list_no_db(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from agentos.cli import cmd_gold_image

        class FakeArgs:
            gold_command = "list"

        with pytest.raises(SystemExit):
            cmd_gold_image(FakeArgs())

    def test_list_empty(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_gold_image

        class FakeArgs:
            gold_command = "list"

        cmd_gold_image(FakeArgs())
        captured = capsys.readouterr()
        assert "No gold images found" in captured.out

    def test_no_subcommand(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_gold_image

        class FakeArgs:
            gold_command = None

        cmd_gold_image(FakeArgs())
        captured = capsys.readouterr()
        assert "Usage:" in captured.out

    def test_create_from_agent(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        (tmp_path / "agents" / "my-agent.json").write_text(json.dumps({
            "name": "my-agent", "model": "claude", "max_turns": 10,
        }))

        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_gold_image

        class FakeArgs:
            gold_command = "create"
            agent_name = "my-agent"
            name = ""

        cmd_gold_image(FakeArgs())
        captured = capsys.readouterr()
        assert "Gold image created" in captured.out
        assert "my-agent-gold" in captured.out


# ── Schema Migration ────────────────────────────────────────────────


class TestGoldImageMigration:
    def test_fresh_db_has_tables(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "fresh.db")
        db.initialize()

        tables = {
            row[0]
            for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "gold_images" in tables
        assert "compliance_checks" in tables
        assert "config_audit_log" in tables
        assert db.schema_version() >= 7
        db.close()

    def test_migration_v6_to_v7(self, tmp_path):
        from agentos.core.database import AgentDB, SCHEMA_SQL
        db = AgentDB(tmp_path / "migrate.db")

        db.conn.executescript(SCHEMA_SQL)
        db.conn.execute("DROP TABLE IF EXISTS gold_images")
        db.conn.execute("DROP TABLE IF EXISTS compliance_checks")
        db.conn.execute("DROP TABLE IF EXISTS config_audit_log")
        db.conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '6')"
        )
        db.conn.commit()

        db.initialize()

        tables = {
            row[0]
            for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "gold_images" in tables
        assert "compliance_checks" in tables
        assert "config_audit_log" in tables
        db.close()


# ── Missing Gold Images API Tests ───────────────────────────────────


class TestGoldImagesAPIExtended:
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

        (tmp_path / "agents" / "test-agent.json").write_text(json.dumps({
            "name": "test-agent", "description": "test", "version": "0.1.0",
            "system_prompt": "You are helpful.", "model": "stub",
            "tools": [], "governance": {"budget_limit_usd": 10.0},
            "max_turns": 5, "tags": [],
        }))

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        import uuid
        email = f"goldext-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Gold Ext",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def _create_image(self, api_client, headers):
        resp = api_client.post("/api/v1/gold-images", headers=headers, json={
            "name": "ext-test-gold",
            "config": {"model": "claude", "max_turns": 10},
        })
        return resp.json()

    def test_get_gold_image(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_image(api_client, headers)
        resp = api_client.get(f"/api/v1/gold-images/{created['image_id']}", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["name"] == "ext-test-gold"

    def test_update_gold_image(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_image(api_client, headers)
        resp = api_client.put(f"/api/v1/gold-images/{created['image_id']}", headers=headers, json={
            "name": "updated-name", "version": "2.0.0",
        })
        assert resp.status_code == 200
        assert resp.json()["name"] == "updated-name"

    def test_approve_gold_image(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_image(api_client, headers)
        resp = api_client.post(f"/api/v1/gold-images/{created['image_id']}/approve", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["approved"] is True

    def test_delete_gold_image(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_image(api_client, headers)
        resp = api_client.delete(f"/api/v1/gold-images/{created['image_id']}", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

    def test_create_from_agent(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/gold-images/from-agent/test-agent", headers=headers)
        assert resp.status_code == 200
        assert "image_id" in resp.json()

    def test_compliance_check(self, api_client):
        headers = self._auth_headers(api_client)
        # Create gold image then check agent against it
        created = self._create_image(api_client, headers)
        resp = api_client.post(
            f"/api/v1/gold-images/compliance/check/test-agent?image_id={created['image_id']}",
            headers=headers,
        )
        assert resp.status_code == 200
        assert "status" in resp.json()

    def test_drift_detection(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_image(api_client, headers)
        resp = api_client.post(
            f"/api/v1/gold-images/drift/test-agent/{created['image_id']}",
            headers=headers,
        )
        assert resp.status_code == 200
        assert "drifted_fields" in resp.json()


# ── Production-Readiness: Integration + Edge Cases ──────────────────


class TestDriftEdgeCases:
    def setup_method(self):
        from agentos.config.drift import DriftDetector
        self.detector = DriftDetector()

    def test_unicode_field_names(self):
        gold = {"système_prompt": "bonjour", "model": "claude"}
        agent = {"système_prompt": "bonjour", "model": "claude"}
        report = self.detector.detect(agent, gold, agent_name="a1")
        assert report.total_drifts == 0

    def test_deeply_nested_drift(self):
        gold = {"a": {"b": {"c": {"d": 1}}}}
        agent = {"a": {"b": {"c": {"d": 2}}}}
        report = self.detector.detect(agent, gold, agent_name="a1")
        assert report.total_drifts == 1
        assert report.drifted_fields[0].field == "a.b.c.d"

    def test_extra_fields_in_agent(self):
        gold = {"model": "claude"}
        agent = {"model": "claude", "extra_field": "value"}
        report = self.detector.detect(agent, gold, agent_name="a1")
        assert report.total_drifts == 1  # extra field counts as drift

    def test_missing_fields_in_agent(self):
        gold = {"model": "claude", "max_turns": 10}
        agent = {"model": "claude"}
        report = self.detector.detect(agent, gold, agent_name="a1")
        assert report.total_drifts == 1  # missing field counts as drift

    def test_empty_configs(self):
        report = self.detector.detect({}, {}, agent_name="a1")
        assert report.total_drifts == 0
        assert report.status == "compliant"


class TestComplianceIntegration:
    """Full pipeline: create gold image → check agent → persist check."""

    def test_full_compliance_pipeline(self, tmp_path):
        from agentos.core.database import AgentDB
        from agentos.config.gold_image import GoldImageManager
        from agentos.config.compliance import ComplianceChecker

        db = AgentDB(tmp_path / "compliance_int.db")
        db.initialize()

        # Create gold image
        mgr = GoldImageManager(db)
        gold = mgr.create(
            name="prod-gold", org_id="org1",
            config={"model": "claude", "max_turns": 10, "governance": {"budget_limit_usd": 5.0}},
        )

        # Check compliant agent
        checker = ComplianceChecker(db)
        report = checker.check_agent(
            agent_name="good-agent",
            agent_config={"model": "claude", "max_turns": 10, "governance": {"budget_limit_usd": 5.0}},
            image_id=gold["image_id"], org_id="org1",
        )
        assert report.status == "compliant"

        # Check drifted agent
        report2 = checker.check_agent(
            agent_name="bad-agent",
            agent_config={"model": "gpt-4", "max_turns": 100, "governance": {"budget_limit_usd": 500.0}},
            image_id=gold["image_id"], org_id="org1",
        )
        assert report2.status in ("drifted", "critical")
        assert report2.total_drifts >= 2

        # Verify persisted checks
        checks = db.list_compliance_checks(org_id="org1")
        assert len(checks) == 2

        # Verify audit trail
        audit = db.list_config_audit(org_id="org1")
        assert len(audit) >= 1  # gold image creation logged

        # Summary
        summary = checker.compliance_summary(org_id="org1")
        assert summary["total_checks"] == 2
        assert summary["compliant"] == 1

        db.close()


class TestGoldImageAuthEnforcement:
    """Verify all endpoints require auth."""

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

    def test_list_requires_auth(self, api_client):
        assert api_client.get("/api/v1/gold-images").status_code == 401

    def test_create_requires_auth(self, api_client):
        assert api_client.post("/api/v1/gold-images", json={"name": "x", "config": {}}).status_code == 401

    def test_compliance_requires_auth(self, api_client):
        assert api_client.get("/api/v1/gold-images/compliance/summary").status_code == 401

    def test_audit_requires_auth(self, api_client):
        assert api_client.get("/api/v1/gold-images/audit").status_code == 401


# ── Compliance Enforcement (pre-run gate) ──────────────────────────


class TestComplianceEnforcement:
    """Tests for _enforce_compliance() blocking agent execution."""

    def _make_agent(self, name="test-agent", config_dict=None):
        """Build a mock agent with a config that has .name and .to_dict()."""
        from unittest.mock import MagicMock
        agent = MagicMock()
        agent.config.name = name
        agent.config.to_dict.return_value = config_dict or {"model": "claude"}
        return agent

    def _make_user(self, org_id="org1", user_id="u1"):
        from unittest.mock import MagicMock
        user = MagicMock()
        user.org_id = org_id
        user.user_id = user_id
        return user

    def test_no_gold_images_allows_run(self):
        """When no gold images exist, agent runs fine (status != critical)."""
        from unittest.mock import patch, MagicMock
        from agentos.api.routers.agents import _enforce_compliance

        mock_report = MagicMock()
        mock_report.status = "no_gold_images"

        mock_checker_instance = MagicMock()
        mock_checker_instance.check_agent.return_value = mock_report

        with patch("agentos.api.routers.agents._get_db"), \
             patch("agentos.config.compliance.ComplianceChecker", return_value=mock_checker_instance):
            # Should not raise
            _enforce_compliance(self._make_agent(), self._make_user())

    def test_compliant_agent_allows_run(self):
        """Agent matches gold image — no block."""
        from unittest.mock import patch, MagicMock
        from agentos.api.routers.agents import _enforce_compliance

        mock_report = MagicMock()
        mock_report.status = "compliant"

        mock_checker_instance = MagicMock()
        mock_checker_instance.check_agent.return_value = mock_report

        with patch("agentos.api.routers.agents._get_db"), \
             patch("agentos.config.compliance.ComplianceChecker", return_value=mock_checker_instance):
            _enforce_compliance(self._make_agent(), self._make_user())

    def test_critical_drift_blocks_run(self):
        """Agent has critical drift — raises HTTPException 403."""
        from unittest.mock import patch, MagicMock
        from fastapi import HTTPException
        from agentos.api.routers.agents import _enforce_compliance

        mock_drift = MagicMock()
        mock_drift.field = "governance.budget_limit_usd"

        mock_report = MagicMock()
        mock_report.status = "critical"
        mock_report.image_name = "prod-gold"
        mock_report.drifted_fields = [mock_drift]

        mock_checker_instance = MagicMock()
        mock_checker_instance.check_agent.return_value = mock_report

        with patch("agentos.api.routers.agents._get_db"), \
             patch("agentos.config.compliance.ComplianceChecker", return_value=mock_checker_instance):
            with pytest.raises(HTTPException) as exc_info:
                _enforce_compliance(self._make_agent(name="bad-agent"), self._make_user())
            assert exc_info.value.status_code == 403

    def test_drifted_agent_allows_run(self):
        """Non-critical drift — allowed to proceed."""
        from unittest.mock import patch, MagicMock
        from agentos.api.routers.agents import _enforce_compliance

        mock_report = MagicMock()
        mock_report.status = "drifted"

        mock_checker_instance = MagicMock()
        mock_checker_instance.check_agent.return_value = mock_report

        with patch("agentos.api.routers.agents._get_db"), \
             patch("agentos.config.compliance.ComplianceChecker", return_value=mock_checker_instance):
            _enforce_compliance(self._make_agent(), self._make_user())

    def test_db_error_allows_run(self):
        """If DB fails, don't block (best-effort)."""
        from unittest.mock import patch
        from agentos.api.routers.agents import _enforce_compliance

        with patch("agentos.api.routers.agents._get_db", side_effect=RuntimeError("DB unavailable")):
            # Should not raise — best-effort compliance
            _enforce_compliance(self._make_agent(), self._make_user())

    def test_error_message_includes_agent_name(self):
        """Verify the 403 message includes agent name and drift fields."""
        from unittest.mock import patch, MagicMock
        from fastapi import HTTPException
        from agentos.api.routers.agents import _enforce_compliance

        mock_drift_1 = MagicMock()
        mock_drift_1.field = "governance.budget_limit_usd"
        mock_drift_2 = MagicMock()
        mock_drift_2.field = "model"

        mock_report = MagicMock()
        mock_report.status = "critical"
        mock_report.image_name = "prod-gold"
        mock_report.drifted_fields = [mock_drift_1, mock_drift_2]

        mock_checker_instance = MagicMock()
        mock_checker_instance.check_agent.return_value = mock_report

        with patch("agentos.api.routers.agents._get_db"), \
             patch("agentos.config.compliance.ComplianceChecker", return_value=mock_checker_instance):
            with pytest.raises(HTTPException) as exc_info:
                _enforce_compliance(self._make_agent(name="rogue-agent"), self._make_user())
            detail = exc_info.value.detail
            assert "rogue-agent" in detail
            assert "governance.budget_limit_usd" in detail
            assert "model" in detail
            assert "prod-gold" in detail
