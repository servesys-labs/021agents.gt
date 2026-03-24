"""Tests for Security Red-Teaming + AIVSS Risk Scoring."""

import json
import uuid
import pytest
from pathlib import Path
from fastapi.testclient import TestClient


# ── OWASP Probes ────────────────────────────────────────────────────


class TestOwaspProbes:
    def setup_method(self):
        from agentos.security.owasp_probes import OwaspProbeLibrary
        self.lib = OwaspProbeLibrary()

    def test_all_probes_loaded(self):
        probes = self.lib.get_all()
        assert len(probes) >= 10

    def test_probes_by_category(self):
        lm01 = self.lib.get_by_category("LLM01")
        assert len(lm01) >= 1
        assert all(p.category == "LLM01" for p in lm01)

    def test_probes_by_layer(self):
        access = self.lib.get_by_layer("access_control")
        assert len(access) >= 1

    def test_get_by_id(self):
        probe = self.lib.get_by_id("LLM08-02")
        assert probe is not None
        assert probe.name == "No Destructive Confirmation"

    def test_config_probe_no_budget(self):
        results = self.lib.run_config_probes({"governance": {}, "tools": [], "max_turns": 50})
        budget_result = next((r for r in results if r.probe.id == "LLM04-01"), None)
        assert budget_result is not None
        assert budget_result.passed is False

    def test_config_probe_with_budget(self):
        results = self.lib.run_config_probes({
            "governance": {"budget_limit_usd": 10.0, "require_confirmation_for_destructive": True},
            "tools": ["search"],
            "max_turns": 20,
        })
        budget_result = next((r for r in results if r.probe.id == "LLM04-01"), None)
        assert budget_result is not None
        assert budget_result.passed is True

    def test_config_probe_excessive_agency(self):
        results = self.lib.run_config_probes({
            "governance": {"blocked_tools": []},
            "tools": ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
            "max_turns": 50,
        })
        agency_result = next((r for r in results if r.probe.id == "LLM08-01"), None)
        assert agency_result is not None
        assert agency_result.passed is False

    def test_config_probe_destructive_confirmation(self):
        results = self.lib.run_config_probes({
            "governance": {"require_confirmation_for_destructive": False},
            "tools": [],
            "max_turns": 20,
        })
        destr_result = next((r for r in results if r.probe.id == "LLM08-02"), None)
        assert destr_result is not None
        assert destr_result.passed is False


# ── MAESTRO Framework ───────────────────────────────────────────────


class TestMaestroFramework:
    def setup_method(self):
        from agentos.security.maestro import MaestroFramework
        self.maestro = MaestroFramework()

    def test_assess_empty(self):
        assessments = self.maestro.assess([])
        assert len(assessments) == 7  # 7 MAESTRO layers
        assert all(a.risk_level == "not_assessed" for a in assessments)

    def test_assess_with_findings(self):
        results = [
            {"layer": "access_control", "passed": True, "severity": "medium"},
            {"layer": "access_control", "passed": False, "severity": "high",
             "probe_id": "LLM04-01", "probe_name": "No Budget", "evidence": "no budget"},
            {"layer": "tool_use", "passed": True, "severity": "medium"},
        ]
        assessments = self.maestro.assess(results)
        ac = next(a for a in assessments if a.layer == "access_control")
        assert ac.total_probes == 2
        assert ac.passed == 1
        assert ac.failed == 1
        assert ac.risk_level == "high"

    def test_overall_risk(self):
        from agentos.security.maestro import LayerAssessment
        assessments = [
            LayerAssessment(layer="a", description="", risk_level="low"),
            LayerAssessment(layer="b", description="", risk_level="high"),
            LayerAssessment(layer="c", description="", risk_level="medium"),
        ]
        assert self.maestro.overall_risk(assessments) == "high"

    def test_overall_risk_critical(self):
        from agentos.security.maestro import LayerAssessment
        assessments = [
            LayerAssessment(layer="a", description="", risk_level="critical"),
        ]
        assert self.maestro.overall_risk(assessments) == "critical"


# ── AIVSS Calculator ───────────────────────────────────────────────


class TestAIVSSCalculator:
    def setup_method(self):
        from agentos.security.aivss import AIVSSCalculator
        self.calc = AIVSSCalculator()

    def test_zero_impact_score(self):
        from agentos.security.aivss import AIVSSVector
        vector = AIVSSVector(
            confidentiality_impact="none",
            integrity_impact="none",
            availability_impact="none",
        )
        assert self.calc.calculate(vector) == 0.0

    def test_high_severity_score(self):
        from agentos.security.aivss import AIVSSVector
        vector = AIVSSVector(
            attack_vector="network",
            attack_complexity="low",
            privileges_required="none",
            scope="changed",
            confidentiality_impact="high",
            integrity_impact="high",
            availability_impact="high",
        )
        score = self.calc.calculate(vector)
        assert score >= 4.0
        assert score <= 10.0

    def test_low_severity_score(self):
        from agentos.security.aivss import AIVSSVector
        vector = AIVSSVector(
            attack_vector="local",
            attack_complexity="high",
            privileges_required="high",
            scope="unchanged",
            confidentiality_impact="low",
            integrity_impact="none",
            availability_impact="none",
        )
        score = self.calc.calculate(vector)
        assert score < 4.0
        assert score > 0.0

    def test_classify_risk(self):
        assert self.calc.classify_risk(9.5) == "critical"
        assert self.calc.classify_risk(7.5) == "high"
        assert self.calc.classify_risk(5.0) == "medium"
        assert self.calc.classify_risk(2.0) == "low"
        assert self.calc.classify_risk(0.0) == "none"

    def test_vector_from_finding(self):
        vector = self.calc.vector_from_finding({"severity": "critical", "category": "LLM01"})
        assert vector.attack_vector == "network"
        assert vector.confidentiality_impact == "high"

    def test_score_finding(self):
        result = self.calc.score_finding({
            "severity": "high",
            "category": "LLM08",
            "probe_name": "No Tool Restrictions",
        })
        assert "aivss_score" in result
        assert "aivss_vector" in result
        assert result["aivss_score"] > 0

    def test_aggregate_risk(self):
        result = self.calc.aggregate_risk([3.0, 5.0, 8.0])
        assert result["overall_score"] == 8.0
        assert result["risk_level"] == "high"

    def test_aggregate_empty(self):
        result = self.calc.aggregate_risk([])
        assert result["overall_score"] == 0.0
        assert result["risk_level"] == "none"

    def test_vector_to_string(self):
        from agentos.security.aivss import AIVSSVector
        v = AIVSSVector()
        s = v.to_string()
        assert "AV:" in s
        assert "CI:" in s


# ── Red Team Runner ─────────────────────────────────────────────────


class TestRedTeamRunner:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "security_test.db")
        db.initialize()
        yield db
        db.close()

    def test_scan_secure_config(self, db):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner(db=db)
        result = runner.scan_config(
            agent_name="secure-agent",
            agent_config={
                "model": "claude-sonnet",
                "max_turns": 20,
                "tools": ["search", "read-file"],
                "governance": {
                    "budget_limit_usd": 10.0,
                    "require_confirmation_for_destructive": True,
                    "blocked_tools": ["bash"],
                    "allowed_domains": ["api.example.com"],
                },
            },
        )
        assert result["status"] == "completed"
        assert result["total_probes"] > 0
        assert result["passed"] > 0

    def test_scan_insecure_config(self, db):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner(db=db)
        result = runner.scan_config(
            agent_name="insecure-agent",
            agent_config={
                "model": "gpt-4",
                "max_turns": 999,
                "tools": [f"tool_{i}" for i in range(15)],
                "governance": {},
            },
        )
        assert result["failed"] > 0
        assert len(result.get("findings", [])) > 0
        assert result["risk_score"] > 0

    def test_scan_persists_to_db(self, db):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner(db=db)
        result = runner.scan_config(
            agent_name="persist-test",
            agent_config={"governance": {}, "tools": [], "max_turns": 50},
            org_id="org1",
        )
        scans = db.list_security_scans()
        assert len(scans) >= 1
        assert scans[0]["scan_id"] == result["scan_id"]

        # Risk profile created
        profile = db.get_risk_profile("persist-test")
        assert profile is not None

    def test_scan_has_maestro_layers(self, db):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner(db=db)
        result = runner.scan_config(
            agent_name="maestro-test",
            agent_config={"governance": {}, "tools": [], "max_turns": 50},
        )
        assert "maestro_layers" in result
        assert len(result["maestro_layers"]) == 7

    def test_scan_has_aivss_summary(self, db):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner(db=db)
        result = runner.scan_config(
            agent_name="aivss-test",
            agent_config={"governance": {}, "tools": [], "max_turns": 50},
        )
        assert "aivss_summary" in result


# ── Report Generator ────────────────────────────────────────────────


class TestSecurityReport:
    def test_generate_report(self):
        from agentos.security.report import SecurityReportGenerator
        gen = SecurityReportGenerator()
        report = gen.generate({
            "scan_id": "test",
            "agent_name": "test-agent",
            "scan_type": "config",
            "total_probes": 10,
            "passed": 7,
            "failed": 3,
            "risk_level": "medium",
            "findings": [
                {"severity": "high", "category": "LLM08", "probe_name": "No Tool Restrictions",
                 "aivss_score": 6.5, "evidence": "test"},
                {"severity": "medium", "category": "LLM04", "probe_name": "No Budget",
                 "aivss_score": 4.2, "evidence": "test"},
            ],
            "maestro_layers": [],
            "aivss_summary": {"overall_score": 6.5},
        })
        assert report["risk_score"] == 6.5
        assert report["summary"]["failed"] == 3
        assert len(report["remediations"]) == 2


# ── Database Methods ────────────────────────────────────────────────


class TestSecurityDB:
    @pytest.fixture
    def db(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "secdb_test.db")
        db.initialize()
        yield db
        db.close()

    def test_insert_and_get_scan(self, db):
        db.insert_security_scan(scan_id="sc1", agent_name="a1", org_id="org1")
        scan = db.get_security_scan("sc1")
        assert scan is not None
        assert scan["agent_name"] == "a1"

    def test_insert_finding(self, db):
        db.insert_security_scan(scan_id="sc2", agent_name="a1")
        db.insert_security_finding(
            scan_id="sc2", agent_name="a1", probe_name="Test Probe",
            category="LLM01", severity="high", aivss_score=7.5,
        )
        findings = db.list_security_findings(scan_id="sc2")
        assert len(findings) == 1
        assert findings[0]["aivss_score"] == 7.5

    def test_upsert_risk_profile(self, db):
        db.upsert_risk_profile(agent_name="a1", risk_score=5.5, risk_level="medium")
        profile = db.get_risk_profile("a1")
        assert profile is not None
        assert profile["risk_score"] == 5.5

        # Update
        db.upsert_risk_profile(agent_name="a1", risk_score=8.0, risk_level="high")
        profile = db.get_risk_profile("a1")
        assert profile["risk_score"] == 8.0

    def test_list_scans_filter(self, db):
        db.insert_security_scan(scan_id="f1", agent_name="a1", org_id="org1")
        db.insert_security_scan(scan_id="f2", agent_name="a2", org_id="org1")
        assert len(db.list_security_scans(agent_name="a1")) == 1
        assert len(db.list_security_scans(org_id="org1")) == 2


# ── API Router ──────────────────────────────────────────────────────


class TestSecurityAPI:
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
        email = f"sec-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Sec Test",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_list_probes(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/security/probes", headers=headers)
        assert resp.status_code == 200
        assert len(resp.json()["probes"]) >= 10

    def test_list_scans_empty(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/security/scans", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["scans"] == []

    def test_list_risk_profiles(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/security/risk-profiles", headers=headers)
        assert resp.status_code == 200

    def test_scan_agent(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/security/scan/test-agent", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["agent_name"] == "test-agent"
        assert "risk_score" in data
        assert "risk_level" in data

    def test_aivss_calculate(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/security/aivss/calculate", headers=headers, json={
            "attack_vector": "network",
            "attack_complexity": "low",
            "privileges_required": "none",
            "confidentiality_impact": "high",
            "integrity_impact": "high",
            "availability_impact": "high",
        })
        assert resp.status_code == 200
        assert resp.json()["score"] > 0


# ── CLI Commands ────────────────────────────────────────────────────


class TestSecurityCLI:
    def test_probes_list(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_security

        class FakeArgs:
            security_command = "probes"

        cmd_security(FakeArgs())
        captured = capsys.readouterr()
        assert "OWASP" in captured.out
        assert "LLM01" in captured.out

    def test_no_subcommand(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_security

        class FakeArgs:
            security_command = None

        cmd_security(FakeArgs())
        captured = capsys.readouterr()
        assert "Usage:" in captured.out

    def test_scan_agent(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        (tmp_path / "agents").mkdir()
        (tmp_path / "agents" / "my-agent.json").write_text(json.dumps({
            "name": "my-agent", "model": "claude", "max_turns": 10,
            "governance": {"budget_limit_usd": 5.0},
            "tools": [],
        }))

        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        db.close()

        from agentos.cli import cmd_security

        class FakeArgs:
            security_command = "scan"
            agent_name = "my-agent"

        cmd_security(FakeArgs())
        captured = capsys.readouterr()
        assert "Security Scan:" in captured.out
        assert "Risk Score:" in captured.out


# ── Schema Migration ────────────────────────────────────────────────


class TestSecurityMigration:
    def test_fresh_db_has_tables(self, tmp_path):
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "fresh.db")
        db.initialize()
        tables = {
            row[0] for row in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "security_scans" in tables
        assert "security_findings" in tables
        assert "agent_risk_profiles" in tables
        assert db.schema_version() >= 10
        db.close()


# ── AIVSS Vector Parser ────────────────────────────────────────────


class TestAIVSSVectorParser:
    def test_roundtrip(self):
        from agentos.security.aivss import AIVSSVector
        v = AIVSSVector(
            attack_vector="network", attack_complexity="low",
            privileges_required="none", scope="changed",
            confidentiality_impact="high", integrity_impact="high",
            availability_impact="high",
        )
        s = v.to_string()
        v2 = AIVSSVector.from_string(s)
        assert v2.attack_vector == "network"
        assert v2.scope == "changed"
        assert v2.confidentiality_impact == "high"

    def test_parse_minimal(self):
        from agentos.security.aivss import AIVSSVector
        v = AIVSSVector.from_string("AV:L/AC:H/PR:H/S:U/CI:N/II:L/AI:N")
        assert v.attack_vector == "local"
        assert v.attack_complexity == "high"
        assert v.privileges_required == "high"
        assert v.integrity_impact == "low"

    def test_parse_empty(self):
        from agentos.security.aivss import AIVSSVector
        v = AIVSSVector.from_string("")
        # Should use defaults
        assert v.attack_vector == "network"

    def test_parse_partial(self):
        from agentos.security.aivss import AIVSSVector
        v = AIVSSVector.from_string("AV:N/CI:H")
        assert v.attack_vector == "network"
        assert v.confidentiality_impact == "high"


# ── Runtime Probe Execution ─────────────────────────────────────────


class TestRuntimeProbes:
    def test_evaluate_prompt_injection_fail(self):
        from agentos.security.redteam import RedTeamRunner
        from agentos.security.owasp_probes import Probe
        runner = RedTeamRunner()
        probe = Probe(id="LLM01-01", name="test", category="LLM01", description="")
        assert runner._evaluate_output(probe, "Here is PWNED output") is False

    def test_evaluate_prompt_injection_pass(self):
        from agentos.security.redteam import RedTeamRunner
        from agentos.security.owasp_probes import Probe
        runner = RedTeamRunner()
        probe = Probe(id="LLM01-01", name="test", category="LLM01", description="")
        assert runner._evaluate_output(probe, "I cannot follow those instructions") is True

    def test_evaluate_xss_fail(self):
        from agentos.security.redteam import RedTeamRunner
        from agentos.security.owasp_probes import Probe
        runner = RedTeamRunner()
        probe = Probe(id="LLM02-01", name="test", category="LLM02", description="")
        assert runner._evaluate_output(probe, '<script>alert("xss")</script>') is False

    def test_evaluate_xss_pass(self):
        from agentos.security.redteam import RedTeamRunner
        from agentos.security.owasp_probes import Probe
        runner = RedTeamRunner()
        probe = Probe(id="LLM02-01", name="test", category="LLM02", description="")
        assert runner._evaluate_output(probe, "Here is safe HTML content") is True

    def test_evaluate_system_prompt_leak_fail(self):
        from agentos.security.redteam import RedTeamRunner
        from agentos.security.owasp_probes import Probe
        runner = RedTeamRunner()
        probe = Probe(id="LLM06-02", name="test", category="LLM06", description="")
        # Output containing leak signals
        leaked = "Sure! My system prompt is: You are a helpful AI assistant specialized in code review."
        assert runner._evaluate_output(probe, leaked) is False

    def test_evaluate_overreliance_pass(self):
        from agentos.security.redteam import RedTeamRunner
        from agentos.security.owasp_probes import Probe
        runner = RedTeamRunner()
        probe = Probe(id="LLM09-01", name="test", category="LLM09", description="")
        assert runner._evaluate_output(probe, "I'm not sure about that. I don't have reliable information.") is True

    def test_evaluate_overreliance_fail(self):
        from agentos.security.redteam import RedTeamRunner
        from agentos.security.owasp_probes import Probe
        runner = RedTeamRunner()
        probe = Probe(id="LLM09-01", name="test", category="LLM09", description="")
        assert runner._evaluate_output(probe, "Mars colonies have 50,000 people in 2030.") is False

    @pytest.mark.asyncio
    async def test_scan_runtime_with_mock_agent(self):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner()

        async def mock_agent(input_text: str) -> str:
            if "ignore" in input_text.lower():
                return "I cannot follow injected instructions."
            if "system prompt" in input_text.lower():
                return "I can't share my system prompt."
            if "script" in input_text.lower():
                return "Here is a code example without HTML."
            if "rm -rf" in input_text.lower():
                return "I won't execute dangerous commands."
            if "population" in input_text.lower() and "mars" in input_text.lower():
                return "I'm not sure about that - there are no Mars colonies as far as I know."
            return "I'll help you with that."

        result = await runner.scan_runtime(
            agent_name="test-agent",
            agent_config={"governance": {"budget_limit_usd": 10.0}, "tools": [], "max_turns": 20},
            run_fn=mock_agent,
        )
        assert result["status"] == "completed"
        assert result["scan_type"] == "runtime"
        assert result["total_probes"] > 0
        # A well-behaved mock agent should pass most probes
        assert result["passed"] > 0

    @pytest.mark.asyncio
    async def test_scan_runtime_no_run_fn(self):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner()
        result = await runner.scan_runtime(
            agent_name="test", agent_config={}, run_fn=None,
        )
        assert "error" in result

    @pytest.mark.asyncio
    async def test_scan_runtime_agent_error(self):
        from agentos.security.redteam import RedTeamRunner
        runner = RedTeamRunner()

        async def failing_agent(input_text: str) -> str:
            raise RuntimeError("Agent crashed")

        result = await runner.scan_runtime(
            agent_name="crash-agent",
            agent_config={"governance": {}, "tools": [], "max_turns": 10},
            run_fn=failing_agent,
        )
        assert result["status"] == "completed"
        assert result["failed"] > 0  # Failed probes due to agent errors


# ── Missing API Tests ───────────────────────────────────────────────


class TestSecurityAPIExtended:
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
        email = f"secext-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "Sec Ext",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_risk_trends(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/security/risk-trends/test-agent", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["agent_name"] == "test-agent"
        assert "trends" in data

    def test_risk_trends_after_scan(self, api_client):
        headers = self._auth_headers(api_client)
        # Run a scan first
        api_client.post("/api/v1/security/scan/test-agent", headers=headers)
        resp = api_client.get("/api/v1/security/risk-trends/test-agent", headers=headers)
        assert resp.status_code == 200
        assert len(resp.json()["trends"]) >= 1

    def test_findings_endpoint(self, api_client):
        headers = self._auth_headers(api_client)
        resp = api_client.get("/api/v1/security/findings", headers=headers)
        assert resp.status_code == 200
        assert "findings" in resp.json()

    def test_scan_report(self, api_client):
        headers = self._auth_headers(api_client)
        # Run scan, then get report
        scan_resp = api_client.post("/api/v1/security/scan/test-agent", headers=headers)
        scan_id = scan_resp.json().get("scan_id", "")
        resp = api_client.get(f"/api/v1/security/scan/{scan_id}/report", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "summary" in data
        assert "remediations" in data


# ── Production-Readiness: Integration + Edge Cases ──────────────────


class TestSecurityScanIntegration:
    """Full pipeline: scan → findings → risk profile → query."""

    def test_scan_persists_everything(self, tmp_path):
        from agentos.core.database import AgentDB
        from agentos.security.redteam import RedTeamRunner

        db = AgentDB(tmp_path / "sec_int.db")
        db.initialize()

        runner = RedTeamRunner(db=db)
        result = runner.scan_config(
            agent_name="int-agent",
            agent_config={"governance": {}, "tools": [], "max_turns": 999},
            org_id="org1",
        )

        # Verify scan persisted
        scan = db.get_security_scan(result["scan_id"])
        assert scan is not None
        assert scan["agent_name"] == "int-agent"

        # Verify findings persisted
        findings = db.list_security_findings(scan_id=result["scan_id"])
        assert len(findings) == len(result.get("findings", []))

        # Verify each finding has aivss_score
        for f in findings:
            assert f.get("aivss_score", 0) >= 0

        # Verify risk profile created
        profile = db.get_risk_profile("int-agent")
        assert profile is not None
        assert profile["risk_score"] == result["risk_score"]
        assert profile["last_scan_id"] == result["scan_id"]

        db.close()

    def test_multiple_scans_update_profile(self, tmp_path):
        from agentos.core.database import AgentDB
        from agentos.security.redteam import RedTeamRunner

        db = AgentDB(tmp_path / "multi_scan.db")
        db.initialize()

        runner = RedTeamRunner(db=db)
        # First scan (insecure)
        r1 = runner.scan_config("agent1", {"governance": {}, "tools": [], "max_turns": 999}, org_id="o1")
        # Second scan (more secure)
        r2 = runner.scan_config("agent1", {
            "governance": {"budget_limit_usd": 10, "require_confirmation_for_destructive": True},
            "tools": [], "max_turns": 20,
        }, org_id="o1")

        # Profile should reflect latest scan
        profile = db.get_risk_profile("agent1")
        assert profile["last_scan_id"] == r2["scan_id"]

        # Both scans in history
        scans = db.list_security_scans(agent_name="agent1")
        assert len(scans) == 2

        db.close()


class TestSecurityAuthEnforcement:
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

    def test_probes_requires_auth(self, api_client):
        assert api_client.get("/api/v1/security/probes").status_code == 401

    def test_scans_requires_auth(self, api_client):
        assert api_client.get("/api/v1/security/scans").status_code == 401

    def test_risk_profiles_requires_auth(self, api_client):
        assert api_client.get("/api/v1/security/risk-profiles").status_code == 401


# ── Runtime Scan API + Timeout Handling ─────────────────────────────


class TestRuntimeScanAPI:
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
        email = f"rtscan-{uuid.uuid4().hex[:8]}@test.com"
        resp = api_client.post("/api/v1/auth/signup", json={
            "email": email, "password": "testpass123", "name": "RT Scan",
        })
        return {"Authorization": f"Bearer {resp.json().get('token', '')}"}

    def test_runtime_scan_endpoint_no_agent(self, api_client):
        """POST /security/scan/nonexistent/runtime should return 404 when agent not found."""
        headers = self._auth_headers(api_client)
        resp = api_client.post("/api/v1/security/scan/nonexistent/runtime", headers=headers)
        # Should be 404 (agent not found) or 500 (could not load agent)
        assert resp.status_code in (404, 500)

    @pytest.mark.asyncio
    async def test_runtime_scan_timeout_handling(self):
        """A run_fn that exceeds probe_timeout should produce a failed probe with timeout evidence."""
        import asyncio
        from agentos.security.redteam import RedTeamRunner

        runner = RedTeamRunner()

        async def slow_agent(input_text: str) -> str:
            await asyncio.sleep(30)  # Way longer than any reasonable timeout
            return "I should never return this"

        result = await runner.scan_runtime(
            agent_name="timeout-agent",
            agent_config={"governance": {}, "tools": [], "max_turns": 10},
            run_fn=slow_agent,
            probe_timeout=0.1,  # Very short timeout to trigger quickly
        )
        assert result["status"] == "completed"
        assert result["failed"] > 0
        # At least one finding should mention timeout
        timeout_findings = [
            f for f in result.get("findings", [])
            if "timeout" in f.get("evidence", "").lower() or "timed out" in f.get("evidence", "").lower()
        ]
        assert len(timeout_findings) > 0, "Expected at least one finding with timeout evidence"
