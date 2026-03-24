"""AIVSS — AI Vulnerability Scoring System.

CVSS-like scoring for AI agent vulnerabilities.

Vector components:
  AV (Attack Vector): network/adjacent/local/physical
  AC (Attack Complexity): low/high
  PR (Privileges Required): none/low/high
  S  (Scope): unchanged/changed
  CI (Confidentiality Impact): none/low/high
  II (Integrity Impact): none/low/high
  AI (Availability Impact): none/low/high
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


# Score weights per component value
_AV_SCORES = {"network": 0.85, "adjacent": 0.62, "local": 0.55, "physical": 0.20}
_AC_SCORES = {"low": 0.77, "high": 0.44}
_PR_SCORES = {"none": 0.85, "low": 0.62, "high": 0.27}
_SCOPE_MULTIPLIER = {"unchanged": 1.0, "changed": 1.08}
_IMPACT_SCORES = {"none": 0.0, "low": 0.22, "high": 0.56}


@dataclass
class AIVSSVector:
    """AIVSS vector representing attack surface and impact."""

    attack_vector: str = "network"  # network/adjacent/local/physical
    attack_complexity: str = "low"  # low/high
    privileges_required: str = "none"  # none/low/high
    scope: str = "unchanged"  # unchanged/changed
    confidentiality_impact: str = "none"  # none/low/high
    integrity_impact: str = "none"  # none/low/high
    availability_impact: str = "none"  # none/low/high

    def to_string(self) -> str:
        return (
            f"AV:{self.attack_vector[0].upper()}"
            f"/AC:{self.attack_complexity[0].upper()}"
            f"/PR:{self.privileges_required[0].upper()}"
            f"/S:{self.scope[0].upper()}"
            f"/CI:{self.confidentiality_impact[0].upper()}"
            f"/II:{self.integrity_impact[0].upper()}"
            f"/AI:{self.availability_impact[0].upper()}"
        )

    @classmethod
    def from_string(cls, vector_string: str) -> AIVSSVector:
        """Parse a vector string like AV:N/AC:L/PR:N/S:U/CI:H/II:H/AI:H."""
        _abbrev_map = {
            "AV": {"N": "network", "A": "adjacent", "L": "local", "P": "physical"},
            "AC": {"L": "low", "H": "high"},
            "PR": {"N": "none", "L": "low", "H": "high"},
            "S": {"U": "unchanged", "C": "changed"},
            "CI": {"N": "none", "L": "low", "H": "high"},
            "II": {"N": "none", "L": "low", "H": "high"},
            "AI": {"N": "none", "L": "low", "H": "high"},
        }
        _field_map = {
            "AV": "attack_vector", "AC": "attack_complexity",
            "PR": "privileges_required", "S": "scope",
            "CI": "confidentiality_impact", "II": "integrity_impact",
            "AI": "availability_impact",
        }
        kwargs: dict[str, str] = {}
        for part in vector_string.split("/"):
            if ":" not in part:
                continue
            key, abbrev = part.split(":", 1)
            key = key.strip()
            abbrev = abbrev.strip()
            if key in _abbrev_map and abbrev in _abbrev_map[key]:
                kwargs[_field_map[key]] = _abbrev_map[key][abbrev]
        return cls(**kwargs)

    def to_dict(self) -> dict[str, str]:
        return {
            "attack_vector": self.attack_vector,
            "attack_complexity": self.attack_complexity,
            "privileges_required": self.privileges_required,
            "scope": self.scope,
            "confidentiality_impact": self.confidentiality_impact,
            "integrity_impact": self.integrity_impact,
            "availability_impact": self.availability_impact,
            "vector_string": self.to_string(),
        }


class AIVSSCalculator:
    """Calculates AIVSS scores (0.0-10.0 scale like CVSS)."""

    def calculate(self, vector: AIVSSVector) -> float:
        """Calculate AIVSS score from vector components."""
        # Exploitability sub-score
        av = _AV_SCORES.get(vector.attack_vector, 0.5)
        ac = _AC_SCORES.get(vector.attack_complexity, 0.5)
        pr = _PR_SCORES.get(vector.privileges_required, 0.5)

        exploitability = 8.22 * av * ac * pr

        # Impact sub-score
        ci = _IMPACT_SCORES.get(vector.confidentiality_impact, 0.0)
        ii = _IMPACT_SCORES.get(vector.integrity_impact, 0.0)
        ai = _IMPACT_SCORES.get(vector.availability_impact, 0.0)

        impact_base = 1 - ((1 - ci) * (1 - ii) * (1 - ai))
        scope_mult = _SCOPE_MULTIPLIER.get(vector.scope, 1.0)
        impact = 6.42 * impact_base * scope_mult

        if impact <= 0:
            return 0.0

        # Combined score
        score = min(10.0, (exploitability + impact) / 2)
        return round(score, 1)

    def classify_risk(self, score: float) -> str:
        """Classify risk level from AIVSS score."""
        if score >= 9.0:
            return "critical"
        if score >= 7.0:
            return "high"
        if score >= 4.0:
            return "medium"
        if score > 0.0:
            return "low"
        return "none"

    def vector_from_finding(self, finding: dict[str, Any]) -> AIVSSVector:
        """Derive AIVSS vector from a security finding."""
        severity = finding.get("severity", "info")
        category = finding.get("category", "")

        # Default vector based on severity
        if severity == "critical":
            return AIVSSVector(
                attack_vector="network",
                attack_complexity="low",
                privileges_required="none",
                scope="changed",
                confidentiality_impact="high",
                integrity_impact="high",
                availability_impact="high",
            )
        if severity == "high":
            return AIVSSVector(
                attack_vector="network",
                attack_complexity="low",
                privileges_required="low",
                scope="unchanged",
                confidentiality_impact="high" if "LLM06" in category else "low",
                integrity_impact="high" if "LLM01" in category else "low",
                availability_impact="high" if "LLM04" in category else "none",
            )
        if severity == "medium":
            return AIVSSVector(
                attack_vector="network",
                attack_complexity="high",
                privileges_required="low",
                scope="unchanged",
                confidentiality_impact="low",
                integrity_impact="low",
                availability_impact="low" if "LLM04" in category else "none",
            )
        # Low / info
        return AIVSSVector(
            attack_vector="local",
            attack_complexity="high",
            privileges_required="high",
            scope="unchanged",
            confidentiality_impact="none",
            integrity_impact="low" if severity == "low" else "none",
            availability_impact="none",
        )

    def score_finding(self, finding: dict[str, Any]) -> dict[str, Any]:
        """Score a single finding and return enriched data."""
        vector = self.vector_from_finding(finding)
        score = self.calculate(vector)
        risk = self.classify_risk(score)
        return {
            **finding,
            "aivss_vector": vector.to_string(),
            "aivss_score": score,
            "aivss_risk_level": risk,
            "aivss_components": vector.to_dict(),
        }

    def aggregate_risk(self, scores: list[float]) -> dict[str, Any]:
        """Aggregate multiple AIVSS scores into an overall risk profile."""
        if not scores:
            return {"overall_score": 0.0, "risk_level": "none", "max_score": 0.0, "avg_score": 0.0}
        max_score = max(scores)
        avg_score = sum(scores) / len(scores)
        # Overall uses max (worst case) like CVSS
        overall = max_score
        return {
            "overall_score": round(overall, 1),
            "risk_level": self.classify_risk(overall),
            "max_score": round(max_score, 1),
            "avg_score": round(avg_score, 1),
            "total_findings": len(scores),
        }
