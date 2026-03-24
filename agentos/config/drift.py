"""Drift detection — compare agent config vs its gold image.

Produces a structured diff report showing which fields have drifted
and by how much, enabling compliance enforcement.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class DriftField:
    """A single field that has drifted from the gold image."""

    field: str
    gold_value: Any
    agent_value: Any
    severity: str = "info"  # info, warning, critical

    def to_dict(self) -> dict[str, Any]:
        return {
            "field": self.field,
            "gold_value": self.gold_value,
            "agent_value": self.agent_value,
            "severity": self.severity,
        }


@dataclass
class DriftReport:
    """Result of comparing an agent config to a gold image."""

    agent_name: str
    image_id: str
    image_name: str
    total_drifts: int = 0
    drifted_fields: list[DriftField] = field(default_factory=list)
    status: str = "compliant"  # compliant, drifted, critical

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_name": self.agent_name,
            "image_id": self.image_id,
            "image_name": self.image_name,
            "total_drifts": self.total_drifts,
            "status": self.status,
            "drifted_fields": [f.to_dict() for f in self.drifted_fields],
        }


# Fields and their drift severity
_CRITICAL_FIELDS = {
    "governance", "governance.budget_limit_usd", "governance.blocked_tools",
    "governance.require_confirmation_for_destructive",
}
_WARNING_FIELDS = {
    "model", "max_turns", "timeout_seconds", "plan", "tools",
}


class DriftDetector:
    """Compares agent configs to gold images and produces drift reports."""

    def detect(
        self,
        agent_config: dict[str, Any],
        gold_config: dict[str, Any],
        agent_name: str = "",
        image_id: str = "",
        image_name: str = "",
    ) -> DriftReport:
        """Compare agent config against gold image config."""
        drifts: list[DriftField] = []

        self._compare_dicts(
            gold=gold_config,
            agent=agent_config,
            prefix="",
            drifts=drifts,
        )

        # Determine overall status
        has_critical = any(d.severity == "critical" for d in drifts)
        has_warning = any(d.severity == "warning" for d in drifts)

        if has_critical:
            status = "critical"
        elif has_warning or drifts:
            status = "drifted"
        else:
            status = "compliant"

        return DriftReport(
            agent_name=agent_name,
            image_id=image_id,
            image_name=image_name,
            total_drifts=len(drifts),
            drifted_fields=drifts,
            status=status,
        )

    def _compare_dicts(
        self,
        gold: dict[str, Any],
        agent: dict[str, Any],
        prefix: str,
        drifts: list[DriftField],
    ) -> None:
        """Recursively compare two dicts and collect drifts."""
        # Fields that are cosmetic / not meaningful for compliance
        skip_fields = {"agent_id", "created_at", "updated_at", "version"}

        all_keys = set(gold.keys()) | set(agent.keys())
        for key in sorted(all_keys):
            if key in skip_fields:
                continue

            full_key = f"{prefix}.{key}" if prefix else key
            gold_val = gold.get(key)
            agent_val = agent.get(key)

            if gold_val == agent_val:
                continue

            # Recurse into nested dicts
            if isinstance(gold_val, dict) and isinstance(agent_val, dict):
                self._compare_dicts(gold_val, agent_val, full_key, drifts)
                continue

            # Normalize lists for comparison
            if isinstance(gold_val, list) and isinstance(agent_val, list):
                if sorted(str(x) for x in gold_val) == sorted(str(x) for x in agent_val):
                    continue

            severity = self._classify_severity(full_key)
            drifts.append(DriftField(
                field=full_key,
                gold_value=gold_val,
                agent_value=agent_val,
                severity=severity,
            ))

    def _classify_severity(self, field_path: str) -> str:
        """Classify the severity of a drift based on the field."""
        if field_path in _CRITICAL_FIELDS:
            return "critical"
        for critical in _CRITICAL_FIELDS:
            if field_path.startswith(critical + "."):
                return "critical"
        if field_path in _WARNING_FIELDS:
            return "warning"
        return "info"
