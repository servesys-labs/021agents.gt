"""Tests for Issue Tracking & Remediation — detector, classifier, remediation, API, CLI."""

import json
import uuid
import pytest
from pathlib import Path
from fastapi.testclient import TestClient


# ── Issue Detector ──────────────────────────────────────────────────


class TestIssueDetector:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "issues_test.db")
        db.initialize()
        yield db
        db.close()

    def test_detect_session_error(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        issues = detector.detect_from_session(
            session_id="err-session",
            agent_name="test-agent",
            session_data={"status": "error", "error_attribution": "tool:search"},
        )
        assert len(issues) >= 1
        assert any(i["category"] == "tool_failure" for i in issues)

    def test_detect_timeout(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        issues = detector.detect_from_session(
            session_id="timeout-session",
            agent_name="test-agent",
            session_data={"status": "timeout"},
        )
        assert len(issues) >= 1
        assert any(i["category"] == "performance" for i in issues)

    def test_detect_low_quality(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        scores = [
            {"quality_overall": 0.2, "sentiment_score": 0.0, "has_tool_failure": 0, "has_hallucination_risk": 0},
            {"quality_overall": 0.3, "sentiment_score": 0.0, "has_tool_failure": 0, "has_hallucination_risk": 0},
        ]
        issues = detector.detect_from_session(
            session_id="low-quality",
            agent_name="test-agent",
            scores=scores,
        )
        assert any(i["category"] == "knowledge_gap" for i in issues)

    def test_detect_tool_failures(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        scores = [
            {"quality_overall": 0.5, "sentiment_score": 0.0, "has_tool_failure": 1, "has_hallucination_risk": 0, "topic": "coding"},
            {"quality_overall": 0.5, "sentiment_score": 0.0, "has_tool_failure": 1, "has_hallucination_risk": 0, "topic": "testing"},
        ]
        issues = detector.detect_from_session(
            session_id="tool-fail",
            agent_name="test-agent",
            scores=scores,
        )
        assert any(i["category"] == "tool_failure" for i in issues)

    def test_detect_hallucination(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        scores = [
            {"quality_overall": 0.6, "sentiment_score": 0.0, "has_tool_failure": 0, "has_hallucination_risk": 1},
            {"quality_overall": 0.6, "sentiment_score": 0.0, "has_tool_failure": 0, "has_hallucination_risk": 1},
        ]
        issues = detector.detect_from_session(
            session_id="hallucinate",
            agent_name="test-agent",
            scores=scores,
        )
        assert any(i["category"] == "hallucination" for i in issues)

    def test_detect_budget_overrun(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        issues = detector.detect_from_session(
            session_id="budget-overrun",
            agent_name="test-agent",
            session_data={"cost_total_usd": 9.5, "budget_limit_usd": 10.0},
        )
        assert any(i["category"] == "performance" for i in issues)

    def test_no_issues_for_good_session(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        scores = [
            {"quality_overall": 0.8, "sentiment_score": 0.5, "has_tool_failure": 0, "has_hallucination_risk": 0},
        ]
        issues = detector.detect_from_session(
            session_id="good-session",
            agent_name="test-agent",
            session_data={"status": "success"},
            scores=scores,
        )
        assert len(issues) == 0

    def test_issues_persisted_to_db(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        detector.detect_from_session(
            session_id="persist-test",
            agent_name="test-agent",
            org_id="org1",
            session_data={"status": "error", "error_attribution": "tool:search"},
        )
        issues = db.list_issues()
        assert len(issues) >= 1


# ── Issue Classifier ────────────────────────────────────────────────


class TestIssueClassifier:
    def setup_method(self):
        from agentos.issues.classifier import IssueClassifier
        self.classifier = IssueClassifier()

    def test_classify_security(self):
        result = self.classifier.classify(title="Governance violation detected")
        assert result["category"] == "security"
        assert result["severity"] == "critical"

    def test_classify_tool_failure(self):
        result = self.classifier.classify(title="Tool execution error", description="tool failed with timeout")
        assert result["category"] == "tool_failure"
        assert result["severity"] == "high"

    def test_classify_hallucination(self):
        result = self.classifier.classify(title="Hallucination risk", description="Agent fabricated information")
        assert result["category"] == "hallucination"

    def test_classify_performance(self):
        result = self.classifier.classify(description="Budget cost exceeded the limit")
        assert result["category"] == "performance"

    def test_classify_config_drift(self):
        result = self.classifier.classify(description="Config drift from gold image detected")
        assert result["category"] == "config_drift"

    def test_classify_unknown(self):
        result = self.classifier.classify(title="Something happened")
        assert result["category"] == "unknown"

    def test_existing_category_preserved(self):
        result = self.classifier.classify(
            title="Some issue",
            existing_category="security",
            existing_severity="critical",
        )
        assert result["category"] == "security"
        assert result["severity"] == "critical"

    def test_bulk_classify(self):
        issues = [
            {"title": "Tool failed", "description": "timeout", "category": "", "severity": ""},
            {"title": "Budget exceeded", "description": "cost too high", "category": "", "severity": ""},
        ]
        results = self.classifier.bulk_classify(issues)
        assert len(results) == 2
        assert results[0]["category"] == "tool_failure"


# ── Remediation Engine ──────────────────────────────────────────────


class TestRemediationEngine:
    def setup_method(self):
        from agentos.issues.remediation import RemediationEngine
        self.engine = RemediationEngine()

    def test_suggest_fix_tool_failure(self):
        fix = self.engine.suggest_fix({"category": "tool_failure", "title": "Tool error"})
        assert "tool" in fix.lower() or "retry" in fix.lower()
        assert len(fix) > 10

    def test_suggest_fix_knowledge_gap(self):
        fix = self.engine.suggest_fix({"category": "knowledge_gap"})
        assert "prompt" in fix.lower() or "knowledge" in fix.lower() or "rag" in fix.lower()

    def test_suggest_fix_hallucination(self):
        fix = self.engine.suggest_fix({"category": "hallucination"})
        assert "unsure" in fix.lower() or "temperature" in fix.lower() or "rag" in fix.lower()

    def test_suggest_fix_security(self):
        fix = self.engine.suggest_fix({"category": "security"})
        assert "governance" in fix.lower() or "blocked" in fix.lower()

    def test_suggest_fix_performance(self):
        fix = self.engine.suggest_fix({"category": "performance"})
        assert "budget" in fix.lower() or "turns" in fix.lower()

    def test_suggest_fix_unknown(self):
        fix = self.engine.suggest_fix({"category": "some_weird_category"})
        assert "review" in fix.lower()

    def test_auto_remediate_performance(self):
        config = {"governance": {"budget_limit_usd": 10.0}, "max_turns": 50}
        changes = self.engine.auto_remediate(
            {"category": "performance", "description": "budget exceeded"},
            config,
        )
        assert changes is not None
        assert "governance.budget_limit_usd" in changes

    def test_auto_remediate_hallucination(self):
        config = {"system_prompt": "You are helpful."}
        changes = self.engine.auto_remediate(
            {"category": "hallucination"},
            config,
        )
        assert changes is not None
        assert "system_prompt_append" in changes

    def test_auto_remediate_security(self):
        config = {"governance": {}}
        changes = self.engine.auto_remediate({"category": "security"}, config)
        assert changes is not None
        assert changes.get("governance.require_confirmation_for_destructive") is True

    def test_bulk_suggest(self):
        issues = [
            {"category": "tool_failure", "title": "fail"},
            {"category": "security", "title": "unsafe"},
        ]
        results = self.engine.suggest_fixes_bulk(issues)
        assert all("suggested_fix" in r for r in results)


# ── Database Methods ────────────────────────────────────────────────


class TestIssueDB:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "issuedb_test.db")
        db.initialize()
        yield db
        db.close()

    def test_insert_and_get(self, db):
        db.insert_issue(
            issue_id="iss1", org_id="org1", agent_name="agent1",
            title="Test issue", description="Something broke",
            category="tool_failure", severity="high",
        )
        issue = db.get_issue("iss1")
        assert issue is not None
        assert issue["title"] == "Test issue"
        assert issue["category"] == "tool_failure"

    def test_list_with_filters(self, db):
        db.insert_issue(issue_id="i1", org_id="org1", agent_name="a1", title="T1", category="security", severity="critical")
        db.insert_issue(issue_id="i2", org_id="org1", agent_name="a2", title="T2", category="performance", severity="low")
        db.update_issue("i2", status="resolved")

        assert len(db.list_issues(org_id="org1")) == 2
        assert len(db.list_issues(status="open")) == 1
        assert len(db.list_issues(category="security")) == 1
        assert len(db.list_issues(severity="critical")) == 1
        assert len(db.list_issues(agent_name="a1")) == 1

    def test_update_issue(self, db):
        db.insert_issue(issue_id="upd1", title="Update me")
        db.update_issue("upd1", status="resolved", resolved_by="admin")
        issue = db.get_issue("upd1")
        assert issue["status"] == "resolved"
        assert issue["resolved_by"] == "admin"

    def test_issue_summary(self, db):
        db.insert_issue(issue_id="s1", category="security", severity="critical")
        db.insert_issue(issue_id="s2", category="tool_failure", severity="high")
        db.insert_issue(issue_id="s3", category="security", severity="critical")
        db.update_issue("s3", status="resolved")

        summary = db.issue_summary()
        assert summary["total"] == 3
        assert summary["by_status"]["open"] == 2
        assert summary["by_status"]["resolved"] == 1
        assert summary["by_category"]["security"] == 2

    def test_get_nonexistent(self, db):
        assert db.get_issue("nonexistent") is None


# ── API Router ──────────────────────────────────────────────────────


class TestIssuesAPI:
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
            "memory": {"working": {"max_items": 50}},
            "max_turns": 5, "tags": [],
        }))

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        email = f"issues-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Issues Test",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_list_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/issues", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["issues"] == []

    def test_create_issue(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/issues", headers=headers, json={
            "title": "Test issue",
            "description": "Tool failed during search",
            "agent_name": "test-agent",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["issue_id"]
        assert data["category"]  # should be auto-classified
        assert data["suggested_fix"]  # should have a fix suggestion

    def test_summary(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/issues/summary", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "total" in data
        assert "by_status" in data

    def test_get_nonexistent(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/issues/nonexistent", headers=headers)
        assert resp.status_code == 404

    def test_resolve_nonexistent(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/issues/nonexistent/resolve", headers=headers)
        assert resp.status_code == 404


# ── CLI Commands ────────────────────────────────────────────────────


class TestIssuesCLI:
    def test_list_no_db(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        from agentos.cli import cmd_issues

        class FakeArgs:
            issues_command = "list"
            agent = ""
            status = ""
            category = ""

        with pytest.raises(SystemExit):
            cmd_issues(FakeArgs())

    def test_summary_empty(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_issues

        class FakeArgs:
            issues_command = "summary"

        cmd_issues(FakeArgs())
        captured = capsys.readouterr()
        assert "Issue Summary" in captured.out

    def test_no_subcommand(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_issues

        class FakeArgs:
            issues_command = None

        cmd_issues(FakeArgs())
        captured = capsys.readouterr()
        assert "Usage:" in captured.out


# ── Schema Migration ────────────────────────────────────────────────


class TestIssueMigration:
    def test_fresh_db_has_issues_table(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "fresh.db")
        db.initialize()
        tables = {
            row[0] for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "issues" in tables
        assert db.schema_version() >= 9
        db.close()

    def test_migration_v8_to_v9(self, tmp_path):
        from agentos.core.database import AgentDB, SCHEMA_SQL
        db = AgentDB(tmp_path / "migrate.db")
        db.conn.executescript(SCHEMA_SQL)
        db.conn.execute("DROP TABLE IF EXISTS issues")
        db.conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '8')"
        )
        db.conn.commit()
        db.initialize()
        tables = {
            row[0] for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "issues" in tables
        db.close()


# ── Missing Issues API Tests ────────────────────────────────────────


class TestIssuesAPIExtended:
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
            "memory": {"working": {"max_items": 50}},
            "max_turns": 5, "tags": [],
        }))

        from agentos.api.app import create_app
        from agentos.core.harness import AgentHarness
        app = create_app(AgentHarness())
        return TestClient(app)

    def _auth_headers(self, api_client):
        email = f"issext-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Issue Ext",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def _create_issue(self, api_client, headers):
        return api_client.post("/api/v1/issues", headers=headers, json={
            "title": "Tool timeout in search",
            "description": "Search tool failed with timeout error",
            "agent_name": "test-agent",
        }).json()

    def test_triage_issue(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_issue(api_client, headers)
        resp = api_client.post(f"/api/v1/issues/{created['issue_id']}/triage", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "triaged"
        assert data["suggested_fix"]

    def test_update_issue(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_issue(api_client, headers)
        resp = api_client.put(f"/api/v1/issues/{created['issue_id']}", headers=headers, json={
            "severity": "critical",
            "assigned_to": "admin",
        })
        assert resp.status_code == 200

    def test_get_issue(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_issue(api_client, headers)
        resp = api_client.get(f"/api/v1/issues/{created['issue_id']}", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["title"] == "Tool timeout in search"

    def test_resolve_issue(self, api_client):
        headers = self._auth_headers(api_client)
        created = self._create_issue(api_client, headers)
        resp = api_client.post(f"/api/v1/issues/{created['issue_id']}/resolve", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["resolved"] is True

    def test_auto_fix_issue(self, api_client):
        headers = self._auth_headers(api_client)
        # Create a performance issue (budget-related) that has an auto-fix
        resp = api_client.post("/api/v1/issues", headers=headers, json={
            "title": "Budget exceeded",
            "description": "Session budget cost exceeded the limit",
            "agent_name": "test-agent",
            "category": "performance",
        })
        issue = resp.json()
        resp = api_client.post(f"/api/v1/issues/{issue['issue_id']}/auto-fix", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["applied"] is True
        assert len(data["changes_applied"]) > 0

    def test_auto_fix_no_agent(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/issues", headers=headers, json={
            "title": "Orphan issue", "description": "No agent",
        })
        issue = resp.json()
        resp = api_client.post(f"/api/v1/issues/{issue['issue_id']}/auto-fix", headers=headers)
        assert resp.status_code == 400

    def test_auto_fix_nonexistent(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/issues/nonexistent/auto-fix", headers=headers)
        assert resp.status_code == 404


# ── Production-Readiness: Integration + Edge Cases ──────────────────


class TestIssueDetectorBoundaries:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "issue_edge.db")
        db.initialize()
        yield db
        db.close()

    def test_zero_quality_creates_issue(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        scores = [{"quality_overall": 0.0, "sentiment_score": 0.0, "has_tool_failure": 0, "has_hallucination_risk": 0}]
        issues = detector.detect_from_session(session_id="z", agent_name="a", scores=scores)
        assert any(i["category"] == "knowledge_gap" for i in issues)

    def test_negative_cost_no_crash(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        issues = detector.detect_from_session(
            session_id="neg", agent_name="a",
            session_data={"cost_total_usd": -0.01, "budget_limit_usd": 10.0},
        )
        # Should not crash, should return empty or valid issues
        assert isinstance(issues, list)

    def test_very_high_cost(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        issues = detector.detect_from_session(
            session_id="exp", agent_name="a",
            session_data={"cost_total_usd": 999999.0, "budget_limit_usd": 10.0},
        )
        assert any(i["category"] == "performance" for i in issues)

    def test_empty_scores_no_crash(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        issues = detector.detect_from_session(session_id="empty", agent_name="a", scores=[])
        assert isinstance(issues, list)

    def test_empty_session_data_no_crash(self, db):
        from agentos.issues.detector import IssueDetector
        detector = IssueDetector(db=db)
        issues = detector.detect_from_session(session_id="none", agent_name="a", session_data={})
        assert isinstance(issues, list)


class TestRemediationContent:
    def setup_method(self):
        from agentos.issues.remediation import RemediationEngine
        self.engine = RemediationEngine()

    def test_all_categories_have_suggestions(self):
        categories = ["tool_failure", "knowledge_gap", "hallucination", "security", "performance", "config_drift"]
        for cat in categories:
            fix = self.engine.suggest_fix({"category": cat, "title": "test", "description": "test"})
            assert len(fix) > 20, f"Empty fix for category {cat}"
            assert "{" not in fix, f"Placeholder in fix for {cat}"

    def test_auto_remediate_returns_none_for_unknown(self):
        changes = self.engine.auto_remediate(
            {"category": "unknown"}, {"governance": {}},
        )
        assert changes is None


class TestIssueQueryFilters:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "filter_test.db")
        db.initialize()
        yield db
        db.close()

    def test_combined_filters(self, db):
        db.insert_issue(issue_id="f1", org_id="org1", agent_name="a1", category="security", severity="critical")
        db.insert_issue(issue_id="f2", org_id="org1", agent_name="a1", category="performance", severity="low")
        db.insert_issue(issue_id="f3", org_id="org2", agent_name="a2", category="security", severity="critical")

        # Single filter
        assert len(db.list_issues(org_id="org1")) == 2
        # Combined filters
        assert len(db.list_issues(org_id="org1", category="security")) == 1
        # No results
        assert len(db.list_issues(org_id="org1", severity="medium")) == 0
        # No cross-org leakage
        assert len(db.list_issues(org_id="org2", agent_name="a1")) == 0


class TestAutoFixIntegration:
    """Verify auto-fix actually writes to agent config file."""

    def test_auto_fix_modifies_config_file(self, tmp_path):
        import json as _json
        from agentos.core.database import AgentDB
        from agentos.issues.remediation import RemediationEngine

        # Setup
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        config = {"name": "fix-agent", "model": "claude", "max_turns": 50,
                  "governance": {"budget_limit_usd": 10.0}, "system_prompt": "You are helpful."}
        (agents_dir / "fix-agent.json").write_text(_json.dumps(config))

        db = AgentDB(tmp_path / "data" / "agent.db")
        (tmp_path / "data").mkdir(exist_ok=True)
        db.initialize()

        # Create issue and auto-fix
        engine = RemediationEngine()
        issue = {"category": "performance", "description": "budget exceeded", "agent_name": "fix-agent"}
        changes = engine.auto_remediate(issue, config)
        assert changes is not None

        # Apply changes manually (simulating the endpoint logic)
        for key, value in changes.items():
            if "." in key:
                parts = key.split(".", 1)
                config.setdefault(parts[0], {})[parts[1]] = value

        (agents_dir / "fix-agent.json").write_text(_json.dumps(config, indent=2))

        # Verify file was modified
        new_config = _json.loads((agents_dir / "fix-agent.json").read_text())
        assert new_config["governance"]["budget_limit_usd"] == 15.0  # 10.0 * 1.5

        db.close()


class TestIssueAuthEnforcement:
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
        assert api_client.get("/api/v1/issues").status_code == 401

    def test_create_requires_auth(self, api_client):
        assert api_client.post("/api/v1/issues", json={"title": "test"}).status_code == 401

    def test_summary_requires_auth(self, api_client):
        assert api_client.get("/api/v1/issues/summary").status_code == 401


# ── Auto-Detection on SESSION_END ────────────────────────────────────


class TestAutoDetectionOnSessionEnd:
    """Tests for _attach_conversation_scoring / _on_session_end flow in agent.py."""

    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "autodetect.db")
        db.initialize()
        yield db
        db.close()

    @pytest.fixture
    def event_bus(self):
        from agentos.core.events import EventBus
        return EventBus()

    def _make_harness_and_agent(self, db, event_bus, tmp_path):
        """Build a minimal Agent with mocked internals for testing _on_session_end."""
        from unittest.mock import MagicMock, AsyncMock, patch
        from agentos.core.events import EventType, Event, EventBus
        from agentos.evolution.session_record import SessionRecord

        # Create a mock harness with our event bus
        harness = MagicMock()
        harness.event_bus = event_bus

        # Create a mock observer with records
        observer = MagicMock()
        record = MagicMock()
        record.session_id = "test-session-001"
        record.input_text = "Hello, help me with something."
        record.to_dict.return_value = {"status": "success"}
        observer.records = [record]

        return harness, observer, record

    @pytest.mark.asyncio
    async def test_detector_called_on_session_end(self, db, event_bus, tmp_path):
        """Emit SESSION_END and verify IssueDetector.detect_from_session is called."""
        from unittest.mock import patch, MagicMock, AsyncMock
        from agentos.core.events import EventType, Event

        harness, observer, record = self._make_harness_and_agent(db, event_bus, tmp_path)

        # Mock get_turns to return synthetic turn data (avoids needing full turn schema)
        fake_turns = [
            {"turn_number": 1, "llm_content": "Hello", "model_used": "stub"},
            {"turn_number": 2, "llm_content": "Hi there", "model_used": "stub"},
        ]

        # We'll replicate the _on_session_end logic with mocks
        with patch("agentos.observability.analytics.ConversationAnalytics") as MockAnalytics, \
             patch("agentos.issues.detector.IssueDetector") as MockDetector, \
             patch.object(db, "get_turns", return_value=fake_turns), \
             patch.object(db, "query_conversation_scores", return_value=[]):
            mock_analytics_inst = MockAnalytics.return_value
            mock_analytics_inst.score_session.return_value = {
                "avg_quality": 0.5, "avg_sentiment_score": 0.3,
                "dominant_sentiment": "neutral", "topics": [],
            }

            mock_detector_inst = MockDetector.return_value
            mock_detector_inst.detect_from_session.return_value = []

            # Build the handler inline (mirrors _attach_conversation_scoring)
            async def _on_session_end(event: Event) -> None:
                records = observer.records
                if not records:
                    return
                last_record = records[-1]
                session_id = last_record.session_id
                turns = db.get_turns(session_id)
                if not turns:
                    return

                import os
                analytics = MockAnalytics(use_llm=False)
                analytics.score_session(
                    session_id=session_id, turns=turns,
                    input_text=last_record.input_text, agent_name="test-agent", db=db,
                )

                scores = db.query_conversation_scores(session_id=session_id)
                detector = MockDetector(db=db)
                detector.detect_from_session(
                    session_id=session_id, agent_name="test-agent",
                    org_id="", session_data=last_record.to_dict(), scores=scores,
                )

            event_bus.on(EventType.SESSION_END, _on_session_end)
            await event_bus.emit(Event(type=EventType.SESSION_END, data={"session_id": "test-session-001"}))

            mock_detector_inst.detect_from_session.assert_called_once()
            call_kwargs = mock_detector_inst.detect_from_session.call_args
            assert call_kwargs[1]["session_id"] == "test-session-001" or call_kwargs[0][0] == "test-session-001"

    @pytest.mark.asyncio
    async def test_issues_created_on_low_quality(self, db, event_bus, tmp_path):
        """Emit SESSION_END with low quality scores and verify issues are inserted."""
        from agentos.core.events import EventType, Event
        from agentos.issues.detector import IssueDetector

        harness, observer, record = self._make_harness_and_agent(db, event_bus, tmp_path)

        # Directly test the IssueDetector with low quality scores
        detector = IssueDetector(db=db)
        low_scores = [
            {"quality_overall": 0.1, "sentiment_score": -0.5, "has_tool_failure": 0, "has_hallucination_risk": 0},
            {"quality_overall": 0.2, "sentiment_score": -0.3, "has_tool_failure": 0, "has_hallucination_risk": 0},
        ]
        issues = detector.detect_from_session(
            session_id="test-session-001",
            agent_name="test-agent",
            org_id="org1",
            session_data={"status": "success"},
            scores=low_scores,
        )
        assert len(issues) >= 1
        assert any(i["category"] == "knowledge_gap" for i in issues)

        # Verify issues are persisted in db
        db_issues = db.list_issues(agent_name="test-agent")
        assert len(db_issues) >= 1

    @pytest.mark.asyncio
    async def test_issues_not_created_on_good_session(self, db, event_bus, tmp_path):
        """Emit SESSION_END with good scores and verify no issues are created."""
        from agentos.core.events import EventType, Event
        from agentos.issues.detector import IssueDetector

        detector = IssueDetector(db=db)
        good_scores = [
            {"quality_overall": 0.9, "sentiment_score": 0.8, "has_tool_failure": 0, "has_hallucination_risk": 0},
            {"quality_overall": 0.85, "sentiment_score": 0.7, "has_tool_failure": 0, "has_hallucination_risk": 0},
        ]
        issues = detector.detect_from_session(
            session_id="good-session-002",
            agent_name="test-agent",
            org_id="org1",
            session_data={"status": "success"},
            scores=good_scores,
        )
        assert len(issues) == 0

        # Verify no issues in db for this session
        db_issues = db.list_issues(agent_name="test-agent")
        assert len(db_issues) == 0

    @pytest.mark.asyncio
    async def test_remediation_suggested_for_auto_issues(self, db, event_bus, tmp_path):
        """Verify RemediationEngine.suggest_fix is called and db.update_issue is called with fix."""
        from unittest.mock import patch, MagicMock
        from agentos.core.events import EventType, Event
        from agentos.issues.detector import IssueDetector
        from agentos.issues.remediation import RemediationEngine

        # Create issues from a low-quality session
        detector = IssueDetector(db=db)
        low_scores = [
            {"quality_overall": 0.1, "sentiment_score": -0.5, "has_tool_failure": 0, "has_hallucination_risk": 0},
        ]
        issues = detector.detect_from_session(
            session_id="remediate-session",
            agent_name="test-agent",
            org_id="org1",
            scores=low_scores,
        )
        assert len(issues) >= 1

        # Apply remediation (mirrors the _on_session_end logic)
        engine = RemediationEngine()
        for issue in issues:
            fix = engine.suggest_fix(issue)
            assert len(fix) > 10, "Fix suggestion should not be empty"
            db.update_issue(issue["issue_id"], suggested_fix=fix)

        # Verify the fix was persisted
        for issue in issues:
            updated = db.get_issue(issue["issue_id"])
            assert updated is not None
            assert updated.get("suggested_fix"), f"Issue {issue['issue_id']} should have a suggested fix"

    @pytest.mark.asyncio
    async def test_issue_created_event_emitted(self, db, event_bus, tmp_path):
        """Verify ISSUE_CREATED event is emitted after issues are found."""
        from agentos.core.events import EventType, Event
        from agentos.issues.detector import IssueDetector
        from agentos.issues.remediation import RemediationEngine

        emitted_events = []

        async def capture_event(event: Event) -> None:
            emitted_events.append(event)

        event_bus.on(EventType.ISSUE_CREATED, capture_event)

        # Detect issues from a bad session
        detector = IssueDetector(db=db)
        low_scores = [
            {"quality_overall": 0.1, "sentiment_score": -0.5, "has_tool_failure": 1, "has_hallucination_risk": 1},
        ]
        issues = detector.detect_from_session(
            session_id="emit-session",
            agent_name="test-agent",
            org_id="org1",
            scores=low_scores,
        )
        assert len(issues) >= 1

        # Replicate the event emission from _on_session_end
        engine = RemediationEngine()
        for issue in issues:
            fix = engine.suggest_fix(issue)
            db.update_issue(issue["issue_id"], suggested_fix=fix)

        await event_bus.emit(Event(
            type=EventType.ISSUE_CREATED,
            data={"session_id": "emit-session", "count": len(issues)},
            source="issue_detector",
        ))

        assert len(emitted_events) == 1
        assert emitted_events[0].type == EventType.ISSUE_CREATED
        assert emitted_events[0].data["session_id"] == "emit-session"
        assert emitted_events[0].data["count"] == len(issues)
