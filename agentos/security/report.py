"""Security report generator — structured vulnerability reports."""

from __future__ import annotations

from typing import Any


class SecurityReportGenerator:
    """Generates structured security reports from scan results."""

    def generate(self, scan_result: dict[str, Any]) -> dict[str, Any]:
        """Generate a structured report from a scan result."""
        findings = scan_result.get("findings", [])
        layers = scan_result.get("maestro_layers", [])
        aivss = scan_result.get("aivss_summary", {})

        # Group findings by severity
        by_severity: dict[str, list] = {}
        for f in findings:
            sev = f.get("severity", "info")
            by_severity.setdefault(sev, []).append(f)

        # Remediation priorities
        remediations = []
        for f in sorted(findings, key=lambda x: x.get("aivss_score", 0), reverse=True):
            remediations.append({
                "priority": len(remediations) + 1,
                "probe": f.get("probe_name", ""),
                "category": f.get("category", ""),
                "severity": f.get("severity", ""),
                "aivss_score": f.get("aivss_score", 0),
                "recommendation": self._recommend(f),
            })

        return {
            "scan_id": scan_result.get("scan_id", ""),
            "agent_name": scan_result.get("agent_name", ""),
            "scan_type": scan_result.get("scan_type", ""),
            "risk_score": aivss.get("overall_score", 0),
            "risk_level": scan_result.get("risk_level", "unknown"),
            "summary": {
                "total_probes": scan_result.get("total_probes", 0),
                "passed": scan_result.get("passed", 0),
                "failed": scan_result.get("failed", 0),
                "critical_findings": len(by_severity.get("critical", [])),
                "high_findings": len(by_severity.get("high", [])),
                "medium_findings": len(by_severity.get("medium", [])),
                "low_findings": len(by_severity.get("low", [])),
            },
            "maestro_layers": layers,
            "findings_by_severity": {k: len(v) for k, v in by_severity.items()},
            "remediations": remediations[:10],
        }

    def _recommend(self, finding: dict[str, Any]) -> str:
        category = finding.get("category", "")
        recommendations = {
            "LLM01": "Implement input sanitization and prompt injection detection",
            "LLM02": "Sanitize all agent outputs before rendering",
            "LLM04": "Set strict budget and turn limits",
            "LLM05": "Audit and vet all tool plugins",
            "LLM06": "Restrict domain access and add output filtering",
            "LLM07": "Validate all tool inputs before execution",
            "LLM08": "Reduce tool permissions and require confirmation for destructive actions",
            "LLM09": "Add uncertainty markers and fact-checking",
            "LLM10": "Remove model identifiers from public-facing configs",
        }
        return recommendations.get(category, "Review and remediate the identified vulnerability")
