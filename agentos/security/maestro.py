"""MAESTRO framework — 7-layer AI threat model.

Layers:
  1. Foundation Model — model-level risks (hallucination, bias)
  2. Access Control — authentication, budget, rate limiting
  3. System Prompt — prompt injection, prompt leaking
  4. Tool Use — tool permissions, input validation
  5. RAG Pipeline — data poisoning, retrieval injection
  6. Agent Orchestration — multi-agent trust, delegation
  7. Deployment — infrastructure, API security
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


MAESTRO_LAYERS = [
    "foundation_model",
    "access_control",
    "system_prompt",
    "tool_use",
    "rag_pipeline",
    "agent_orchestration",
    "deployment",
]

LAYER_DESCRIPTIONS = {
    "foundation_model": "Model-level risks: hallucination, bias, overreliance",
    "access_control": "Authentication, budget limits, rate limiting, RBAC",
    "system_prompt": "Prompt injection, prompt leaking, jailbreaking",
    "tool_use": "Tool permissions, input validation, dangerous operations",
    "rag_pipeline": "Data poisoning, retrieval injection, context manipulation",
    "agent_orchestration": "Multi-agent trust, delegation chains, sub-agent risks",
    "deployment": "Infrastructure security, API exposure, model theft",
}


@dataclass
class LayerAssessment:
    """Assessment of a single MAESTRO layer."""

    layer: str
    description: str
    total_probes: int = 0
    passed: int = 0
    failed: int = 0
    risk_level: str = "unknown"  # low, medium, high, critical
    findings: list[dict[str, Any]] = None

    def __post_init__(self):
        if self.findings is None:
            self.findings = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "layer": self.layer,
            "description": self.description,
            "total_probes": self.total_probes,
            "passed": self.passed,
            "failed": self.failed,
            "risk_level": self.risk_level,
            "findings": self.findings,
        }


class MaestroFramework:
    """Evaluates an agent across all 7 MAESTRO layers."""

    def assess(self, probe_results: list[dict[str, Any]]) -> list[LayerAssessment]:
        """Aggregate probe results into MAESTRO layer assessments."""
        layer_map: dict[str, LayerAssessment] = {}

        for layer in MAESTRO_LAYERS:
            layer_map[layer] = LayerAssessment(
                layer=layer,
                description=LAYER_DESCRIPTIONS.get(layer, ""),
            )

        for result in probe_results:
            layer = result.get("layer", "")
            if layer not in layer_map:
                continue

            assessment = layer_map[layer]
            assessment.total_probes += 1
            if result.get("passed"):
                assessment.passed += 1
            else:
                assessment.failed += 1
                assessment.findings.append({
                    "probe_id": result.get("probe_id", ""),
                    "probe_name": result.get("probe_name", ""),
                    "severity": result.get("severity", "info"),
                    "evidence": result.get("evidence", ""),
                })

        # Compute risk levels
        for assessment in layer_map.values():
            if assessment.total_probes == 0:
                assessment.risk_level = "not_assessed"
            elif assessment.failed == 0:
                assessment.risk_level = "low"
            else:
                has_critical = any(f["severity"] == "critical" for f in assessment.findings)
                has_high = any(f["severity"] == "high" for f in assessment.findings)
                if has_critical:
                    assessment.risk_level = "critical"
                elif has_high:
                    assessment.risk_level = "high"
                elif assessment.failed > assessment.passed:
                    assessment.risk_level = "high"
                else:
                    assessment.risk_level = "medium"

        return list(layer_map.values())

    def overall_risk(self, assessments: list[LayerAssessment]) -> str:
        """Compute overall risk level from layer assessments."""
        levels = [a.risk_level for a in assessments if a.risk_level != "not_assessed"]
        if not levels:
            return "unknown"
        if "critical" in levels:
            return "critical"
        if "high" in levels:
            return "high"
        if "medium" in levels:
            return "medium"
        return "low"
