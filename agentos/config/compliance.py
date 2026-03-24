"""Compliance enforcement — agents must derive from approved gold images.

Orchestrates drift detection and persists compliance check results.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agentos.config.drift import DriftDetector, DriftReport

logger = logging.getLogger(__name__)


class ComplianceChecker:
    """Check agent compliance against gold images."""

    def __init__(self, db: Any):
        self.db = db
        self.detector = DriftDetector()

    def check_agent(
        self,
        agent_name: str,
        agent_config: dict[str, Any],
        image_id: str = "",
        org_id: str = "",
        checked_by: str = "",
    ) -> DriftReport:
        """Check an agent's config against a specific gold image.

        If no image_id is provided, checks against all active gold images
        and returns the best match (fewest drifts).
        """
        if image_id:
            gold = self.db.get_gold_image(image_id)
            if not gold:
                return DriftReport(
                    agent_name=agent_name,
                    image_id=image_id,
                    image_name="unknown",
                    status="error",
                )
            return self._check_against_image(
                agent_name=agent_name,
                agent_config=agent_config,
                gold=gold,
                org_id=org_id,
                checked_by=checked_by,
            )

        # Check against all active gold images, find best match
        images = self.db.list_gold_images(org_id=org_id, active_only=True)
        if not images:
            return DriftReport(
                agent_name=agent_name,
                image_id="",
                image_name="none",
                status="no_gold_images",
            )

        best_report: DriftReport | None = None
        for gold in images:
            report = self._check_against_image(
                agent_name=agent_name,
                agent_config=agent_config,
                gold=gold,
                org_id=org_id,
                checked_by=checked_by,
            )
            if best_report is None or report.total_drifts < best_report.total_drifts:
                best_report = report

        return best_report or DriftReport(
            agent_name=agent_name,
            image_id="",
            image_name="none",
            status="no_gold_images",
        )

    def _check_against_image(
        self,
        agent_name: str,
        agent_config: dict[str, Any],
        gold: dict[str, Any],
        org_id: str = "",
        checked_by: str = "",
    ) -> DriftReport:
        """Check agent against a single gold image and persist the result."""
        gold_config = gold.get("config", {})
        if isinstance(gold_config, str):
            gold_config = json.loads(gold_config)

        report = self.detector.detect(
            agent_config=agent_config,
            gold_config=gold_config,
            agent_name=agent_name,
            image_id=gold.get("image_id", ""),
            image_name=gold.get("name", ""),
        )

        # Persist compliance check
        try:
            self.db.insert_compliance_check(
                org_id=org_id,
                agent_name=agent_name,
                image_id=gold.get("image_id", ""),
                image_name=gold.get("name", ""),
                status=report.status,
                drift_count=report.total_drifts,
                drift_fields=[d.field for d in report.drifted_fields],
                drift_details=report.to_dict(),
                checked_by=checked_by,
            )
        except Exception as exc:
            logger.debug("Failed to persist compliance check: %s", exc)

        return report

    def check_all_agents(
        self,
        agents: list[dict[str, Any]],
        org_id: str = "",
        checked_by: str = "",
    ) -> list[DriftReport]:
        """Check all agents against their best-matching gold images."""
        reports = []
        for agent in agents:
            name = agent.get("name", "")
            report = self.check_agent(
                agent_name=name,
                agent_config=agent,
                org_id=org_id,
                checked_by=checked_by,
            )
            reports.append(report)
        return reports

    def compliance_summary(self, org_id: str = "") -> dict[str, Any]:
        """Get aggregate compliance status."""
        checks = self.db.list_compliance_checks(org_id=org_id, limit=200)
        if not checks:
            return {
                "total_checks": 0,
                "compliant": 0,
                "drifted": 0,
                "critical": 0,
                "compliance_rate": 0.0,
            }

        # Dedupe by agent (latest check per agent)
        latest: dict[str, dict] = {}
        for c in checks:
            name = c.get("agent_name", "")
            if name not in latest:
                latest[name] = c

        statuses = [c.get("status", "unchecked") for c in latest.values()]
        compliant = sum(1 for s in statuses if s == "compliant")
        drifted = sum(1 for s in statuses if s == "drifted")
        critical = sum(1 for s in statuses if s == "critical")
        total = len(statuses)

        return {
            "total_checks": total,
            "compliant": compliant,
            "drifted": drifted,
            "critical": critical,
            "compliance_rate": round(compliant / total, 3) if total else 0.0,
            "agents_checked": list(latest.keys()),
        }
