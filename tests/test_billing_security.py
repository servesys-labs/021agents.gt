"""Tests for billing security — org scoping, schema correctness, naming."""

import json
import pytest
from pathlib import Path


class TestBillingOrgScoping:
    """Verify billing data is never leaked across tenants."""

    def setup_method(self, tmp_path=None):
        pass

    def test_billing_summary_filters_by_org(self, tmp_path):
        from agentos.core.database import create_database

        db = create_database(tmp_path / "test.db")

        # Insert billing for two different orgs
        db.record_billing(cost_type="inference", total_cost_usd=0.10, org_id="org-a", model="model-a")
        db.record_billing(cost_type="inference", total_cost_usd=0.20, org_id="org-b", model="model-b")
        db.record_billing(cost_type="connector", total_cost_usd=0.05, org_id="org-a", model="slack")

        # Query for org-a only
        summary = db.billing_summary(org_id="org-a")
        assert summary["total_cost_usd"] == pytest.approx(0.15)
        assert summary["total_records"] == 2
        assert "model-b" not in summary["by_model"]

        # Query for org-b only
        summary_b = db.billing_summary(org_id="org-b")
        assert summary_b["total_cost_usd"] == pytest.approx(0.20)
        assert summary_b["total_records"] == 1

        db.close()

    def test_billing_summary_includes_by_cost_type(self, tmp_path):
        from agentos.core.database import create_database

        db = create_database(tmp_path / "test.db")
        db.record_billing(cost_type="inference", total_cost_usd=0.10, org_id="org-1")
        db.record_billing(cost_type="connector", total_cost_usd=0.02, org_id="org-1")
        db.record_billing(cost_type="gpu_compute", total_cost_usd=3.98, org_id="org-1")

        summary = db.billing_summary(org_id="org-1")
        assert "inference" in summary["by_cost_type"]
        assert "connector" in summary["by_cost_type"]
        assert "gpu_compute" in summary["by_cost_type"]
        assert summary["by_cost_type"]["inference"] == pytest.approx(0.10)
        assert summary["by_cost_type"]["connector"] == pytest.approx(0.02)
        db.close()

    def test_total_billing_records_not_sessions(self, tmp_path):
        """total_records should be billing records count, not session count."""
        from agentos.core.database import create_database

        db = create_database(tmp_path / "test.db")
        # 3 billing records, 0 sessions
        for i in range(3):
            db.record_billing(cost_type="inference", total_cost_usd=0.01, org_id="org-1")

        summary = db.billing_summary(org_id="org-1")
        assert summary["total_records"] == 3
        db.close()


class TestConnectorBillingTracking:
    """Verify connector calls are always billed."""

    def test_hub_records_billing(self, tmp_path, monkeypatch):
        """ConnectorHub.call_tool should record billing regardless of caller."""
        import asyncio
        from unittest.mock import AsyncMock

        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()

        from agentos.core.database import create_database
        db = create_database(tmp_path / "data" / "agent.db")
        db.close()

        from agentos.connectors.hub import ConnectorHub, ConnectorResult, PipedreamProvider

        # Mock the provider to avoid real API calls
        mock_provider = AsyncMock(spec=PipedreamProvider)
        mock_provider.name = "pipedream"
        mock_provider.call_tool = AsyncMock(return_value=ConnectorResult(success=True, data="ok"))

        hub = ConnectorHub.__new__(ConnectorHub)
        hub._provider = mock_provider

        asyncio.run(hub.call_tool("test-tool", {"key": "val"}, org_id="org-test"))

        # Verify billing was recorded
        from agentos.core.database import AgentDB
        db = AgentDB(tmp_path / "data" / "agent.db")
        db.initialize()
        summary = db.billing_summary(org_id="org-test")
        assert summary["total_records"] == 1
        assert summary["by_cost_type"].get("connector", 0) == pytest.approx(0.001)
        db.close()
