"""Failure Analyzer — finds patterns in session records and generates hypotheses.

This is the brain of the outer-loop agent. It looks at accumulated session
records and identifies:
  1. Failure clusters — groups of sessions that fail in similar ways
  2. Cost anomalies — sessions that cost significantly more than average
  3. Latency outliers — sessions that take significantly longer
  4. Tool patterns — tools that fail often, or tools never used
  5. Regression signals — metrics that worsen over time

From these patterns it generates ranked Proposals for improvements that
a human can review and approve.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from agentos.evolution.session_record import ErrorSource, SessionRecord

logger = logging.getLogger(__name__)


@dataclass
class FailureCluster:
    """A group of failures with a common pattern."""
    pattern: str          # e.g., "tool:web-search timeout"
    count: int = 0
    error_source: str = ""
    example_inputs: list[str] = field(default_factory=list)
    example_errors: list[str] = field(default_factory=list)
    severity: float = 0.0  # 0.0 - 1.0 based on frequency and impact


@dataclass
class CostAnomaly:
    """A session whose cost deviates from the norm."""
    session_id: str
    cost_usd: float
    avg_cost_usd: float
    deviation_factor: float  # How many multiples of avg


@dataclass
class AnalysisReport:
    """Output of the Analyzer — what's going wrong and why."""
    total_sessions: int = 0
    success_rate: float = 0.0
    failure_clusters: list[FailureCluster] = field(default_factory=list)
    cost_anomalies: list[CostAnomaly] = field(default_factory=list)
    tool_failure_rates: dict[str, float] = field(default_factory=dict)
    unused_tools: list[str] = field(default_factory=list)
    top_error_sources: list[tuple[str, int]] = field(default_factory=list)
    observability_signals: dict[str, Any] = field(default_factory=dict)
    recommendations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_sessions": self.total_sessions,
            "success_rate": self.success_rate,
            "failure_clusters": [
                {"pattern": fc.pattern, "count": fc.count, "severity": fc.severity}
                for fc in self.failure_clusters
            ],
            "cost_anomalies": [
                {"session_id": ca.session_id, "cost_usd": ca.cost_usd, "factor": ca.deviation_factor}
                for ca in self.cost_anomalies
            ],
            "tool_failure_rates": self.tool_failure_rates,
            "unused_tools": self.unused_tools,
            "top_error_sources": self.top_error_sources,
            "observability_signals": self.observability_signals,
            "recommendations": self.recommendations,
        }


class FailureAnalyzer:
    """Analyzes session records to find patterns and generate improvement ideas.

    Usage:
        analyzer = FailureAnalyzer()
        report = analyzer.analyze(observer.records)
        proposals = analyzer.generate_proposals(report, agent_config)
    """

    def __init__(self, min_sessions: int = 5) -> None:
        self.min_sessions = min_sessions

    def analyze(self, records: list[SessionRecord]) -> AnalysisReport:
        """Analyze a batch of session records for patterns."""
        if len(records) < self.min_sessions:
            logger.info(
                "Only %d sessions (need %d) — skipping analysis",
                len(records), self.min_sessions,
            )
            return AnalysisReport(
                total_sessions=len(records),
                recommendations=[
                    f"Need at least {self.min_sessions} sessions for meaningful analysis. "
                    f"Currently have {len(records)}."
                ],
            )

        report = AnalysisReport(total_sessions=len(records))

        # Success rate
        successes = sum(1 for r in records if r.status == "success")
        report.success_rate = successes / len(records)

        # Failure clustering
        report.failure_clusters = self._cluster_failures(records)

        # Cost anomalies
        report.cost_anomalies = self._find_cost_anomalies(records)

        # Tool analysis
        report.tool_failure_rates = self._tool_failure_rates(records)
        report.unused_tools = self._find_unused_tools(records)

        # Error source ranking
        report.top_error_sources = self._rank_error_sources(records)

        # Generate recommendations from patterns
        report.recommendations = self._generate_recommendations(report, records)

        return report

    def _cluster_failures(self, records: list[SessionRecord]) -> list[FailureCluster]:
        """Group failures by common patterns."""
        failed = [r for r in records if r.status != "success"]
        if not failed:
            return []

        # Cluster by error source + tool name combination
        pattern_map: dict[str, FailureCluster] = {}
        for rec in failed:
            for err in rec.errors:
                key = f"{err.source.value}"
                if err.tool_name:
                    key += f":{err.tool_name}"

                if key not in pattern_map:
                    pattern_map[key] = FailureCluster(
                        pattern=key,
                        error_source=err.source.value,
                    )

                cluster = pattern_map[key]
                cluster.count += 1
                if len(cluster.example_inputs) < 3:
                    cluster.example_inputs.append(rec.input_text[:100])
                if len(cluster.example_errors) < 3:
                    cluster.example_errors.append(err.message[:200])

        # Calculate severity: frequency * (1 if unrecoverable, 0.5 if recoverable)
        for cluster in pattern_map.values():
            frequency = cluster.count / len(records)
            cluster.severity = min(1.0, frequency * 2)

        return sorted(pattern_map.values(), key=lambda c: c.severity, reverse=True)

    def _find_cost_anomalies(self, records: list[SessionRecord]) -> list[CostAnomaly]:
        """Find sessions whose cost is significantly above average."""
        costs = [r.cost.total_usd for r in records if r.cost.total_usd > 0]
        if not costs:
            return []

        avg = sum(costs) / len(costs)
        if avg == 0:
            return []

        anomalies = []
        for rec in records:
            if rec.cost.total_usd > avg * 3:  # 3x average is anomalous
                anomalies.append(CostAnomaly(
                    session_id=rec.session_id,
                    cost_usd=rec.cost.total_usd,
                    avg_cost_usd=avg,
                    deviation_factor=rec.cost.total_usd / avg,
                ))

        return sorted(anomalies, key=lambda a: a.deviation_factor, reverse=True)[:5]

    def _tool_failure_rates(self, records: list[SessionRecord]) -> dict[str, float]:
        """Calculate per-tool failure rate."""
        tool_calls: dict[str, int] = Counter()
        tool_failures: dict[str, int] = Counter()

        for rec in records:
            for turn in rec.turns:
                for tc in turn.tool_calls:
                    name = tc.get("name", "unknown")
                    tool_calls[name] += 1
                for tr in turn.tool_results:
                    name = tr.get("tool", "unknown")
                    if "error" in tr:
                        tool_failures[name] += 1

        rates = {}
        for tool, total in tool_calls.items():
            fails = tool_failures.get(tool, 0)
            rates[tool] = fails / total if total > 0 else 0.0

        return dict(sorted(rates.items(), key=lambda x: x[1], reverse=True))

    def _find_unused_tools(self, records: list[SessionRecord]) -> list[str]:
        """Find tools that are available but never called."""
        available: set[str] = set()
        used: set[str] = set()

        for rec in records:
            available.update(rec.composition.tools_available)
            for turn in rec.turns:
                for tc in turn.tool_calls:
                    used.add(tc.get("name", ""))

        return sorted(available - used)

    def _rank_error_sources(self, records: list[SessionRecord]) -> list[tuple[str, int]]:
        """Rank error sources by frequency."""
        sources: Counter = Counter()
        for rec in records:
            for err in rec.errors:
                sources[err.source.value] += 1
        return sources.most_common(10)

    def incorporate_feedback(
        self,
        report: AnalysisReport,
        feedback_summary: dict[str, Any],
    ) -> None:
        """Enrich analysis with human feedback data.

        Connects the feedback collection system to the evolution loop —
        human signals (thumbs up/down, corrections) inform recommendations.
        """
        if not feedback_summary or feedback_summary.get("total", 0) == 0:
            return

        total = feedback_summary["total"]
        negative = feedback_summary.get("negative", 0)
        approval = feedback_summary.get("approval_rate", 0.0)

        if negative > 0 and approval < 0.5:
            report.recommendations.append(
                f"Human feedback: {negative}/{total} responses rated negative "
                f"(approval rate {approval:.0%}). Review corrections and common "
                "complaint patterns to improve system prompt or tool behavior."
            )
        elif approval >= 0.8:
            report.recommendations.append(
                f"Human feedback is positive ({approval:.0%} approval rate, "
                f"{total} responses rated). Current agent behavior is well-received."
            )

    def incorporate_meta_observability(
        self,
        report: AnalysisReport,
        telemetry_report: dict[str, Any],
    ) -> None:
        """Enrich analysis with end-to-end runtime telemetry signals."""
        if not telemetry_report:
            return
        signals = telemetry_report.get("signals", {})
        if isinstance(signals, dict):
            report.observability_signals = signals
        for rec in telemetry_report.get("recommendations", []):
            if isinstance(rec, str) and rec and rec not in report.recommendations:
                report.recommendations.append(rec)

    def _generate_recommendations(
        self,
        report: AnalysisReport,
        records: list[SessionRecord],
    ) -> list[str]:
        """Generate human-readable recommendations from patterns."""
        recs: list[str] = []

        # Low success rate
        if report.success_rate < 0.7:
            recs.append(
                f"Success rate is {report.success_rate:.0%} — below 70% threshold. "
                "Review the top failure clusters for root causes."
            )

        # Dominant failure cluster
        if report.failure_clusters:
            top = report.failure_clusters[0]
            if top.count >= len(records) * 0.2:
                recs.append(
                    f"'{top.pattern}' accounts for {top.count} failures "
                    f"({top.count/len(records):.0%} of sessions). "
                    f"Example: {top.example_errors[0][:100] if top.example_errors else 'N/A'}"
                )

        # Tool failures
        for tool, rate in report.tool_failure_rates.items():
            if rate > 0.3:
                recs.append(
                    f"Tool '{tool}' fails {rate:.0%} of the time. "
                    "Consider: fixing the tool, adding retry logic, or providing a fallback."
                )

        # Unused tools
        if report.unused_tools:
            recs.append(
                f"Tools never used: {', '.join(report.unused_tools[:5])}. "
                "Consider removing them to reduce prompt size and complexity."
            )

        # Cost anomalies
        if report.cost_anomalies:
            worst = report.cost_anomalies[0]
            recs.append(
                f"Cost anomaly: session {worst.session_id} cost ${worst.cost_usd:.4f} "
                f"({worst.deviation_factor:.1f}x average). Check for runaway tool loops."
            )

        # High turn count
        avg_turns = sum(r.step_count for r in records) / len(records)
        if avg_turns > 10:
            recs.append(
                f"Average turn count is {avg_turns:.1f} — agent may be inefficient. "
                "Consider: improving system prompt instructions, adding few-shot examples, "
                "or tuning tool descriptions."
            )

        # High-performing agent — suggest optimizations
        if report.success_rate >= 0.9 and len(records) >= 3:
            recs.append(
                f"Agent performs well ({report.success_rate:.0%} success). "
                "Consider: trying a cheaper/faster model, reducing max_turns, "
                "or tightening the budget to optimize cost."
            )

        return recs

    def generate_proposals(
        self,
        report: AnalysisReport,
        agent_config: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Generate concrete modification proposals from an analysis report.

        Returns raw proposal dicts (not Proposal objects) — the caller
        wraps these into the ReviewQueue.

        Each proposal is a dict with:
          - title: Short description
          - rationale: Why this change
          - category: What kind of change (prompt/tools/governance/model/memory)
          - modification: Concrete config diff to apply
          - priority: 0.0-1.0 based on expected impact
          - evidence: Supporting data from the report
        """
        proposals: list[dict[str, Any]] = []

        # Proposal: Remove unused tools
        if report.unused_tools:
            current_tools = agent_config.get("tools", [])
            pruned = [t for t in current_tools if _tool_name(t) not in report.unused_tools]
            if len(pruned) < len(current_tools):
                proposals.append({
                    "title": f"Remove {len(current_tools) - len(pruned)} unused tools",
                    "rationale": (
                        f"Tools {report.unused_tools[:3]} are available but never called. "
                        "Removing them reduces prompt token overhead and LLM confusion."
                    ),
                    "category": "tools",
                    "modification": {"tools": pruned},
                    "priority": 0.3,
                    "evidence": {"unused_tools": report.unused_tools},
                })

        # Proposal: Add retry/fallback guidance for failing tools
        for tool, rate in report.tool_failure_rates.items():
            if rate > 0.3:
                current_prompt = agent_config.get("system_prompt", "")
                addition = (
                    f"\n\nIMPORTANT: The tool '{tool}' may fail. "
                    f"If it fails, try an alternative approach instead of retrying the same call."
                )
                proposals.append({
                    "title": f"Add failure guidance for tool '{tool}'",
                    "rationale": (
                        f"Tool '{tool}' fails {rate:.0%} of calls. Adding explicit "
                        "fallback instructions to the system prompt may reduce cascading failures."
                    ),
                    "category": "prompt",
                    "modification": {"system_prompt": current_prompt + addition},
                    "priority": min(0.9, rate + 0.3),
                    "evidence": {"tool": tool, "failure_rate": rate},
                })

        # Proposal: Increase budget if budget exhaustion is common
        budget_exhaustions = sum(
            1 for fc in report.failure_clusters
            if "governance" in fc.pattern or "budget" in fc.pattern.lower()
        )
        if budget_exhaustions > 0:
            current_budget = agent_config.get("governance", {}).get("budget_limit_usd", 10.0)
            proposals.append({
                "title": f"Increase budget from ${current_budget} to ${current_budget * 2}",
                "rationale": (
                    f"{budget_exhaustions} failure cluster(s) related to governance/budget. "
                    "Agent may be running out of budget before completing tasks."
                ),
                "category": "governance",
                "modification": {
                    "governance": {
                        **agent_config.get("governance", {}),
                        "budget_limit_usd": current_budget * 2,
                    }
                },
                "priority": 0.6,
                "evidence": {"budget_exhaustions": budget_exhaustions},
            })

        # Proposal: Reduce max_turns if agent is looping
        avg_turns_data = report.total_sessions  # Proxy
        high_turn_clusters = [
            fc for fc in report.failure_clusters
            if fc.count > report.total_sessions * 0.1
        ]
        if high_turn_clusters and agent_config.get("max_turns", 50) > 20:
            proposals.append({
                "title": "Reduce max_turns to prevent runaway loops",
                "rationale": (
                    "Multiple failure clusters suggest the agent enters long loops. "
                    "Reducing max_turns forces earlier termination and saves cost."
                ),
                "category": "governance",
                "modification": {"max_turns": max(10, agent_config.get("max_turns", 50) // 2)},
                "priority": 0.5,
                "evidence": {"cluster_count": len(high_turn_clusters)},
            })

        # Proposal: Low success rate → suggest system prompt review
        if report.success_rate < 0.5:
            proposals.append({
                "title": "Review and improve system prompt (success rate below 50%)",
                "rationale": (
                    f"Success rate is {report.success_rate:.0%}. The system prompt may need "
                    "clearer task instructions, better formatting guidance, or few-shot examples."
                ),
                "category": "prompt",
                "modification": {},  # Empty — requires human authoring
                "priority": 0.9,
                "evidence": {"success_rate": report.success_rate},
            })

        # Proposal: High-performing agent — try a cheaper/faster model
        if report.success_rate >= 0.9 and report.total_sessions >= 3:
            current_model = agent_config.get("model", "")
            # Suggest downgrading to a cheaper model if using an expensive one
            cheaper_models = {
                "anthropic/claude-sonnet-4.6": ("anthropic/claude-sonnet-4.6", "Sonnet 4.6"),
                "anthropic/claude-opus-4.6": ("anthropic/claude-sonnet-4.6", "Sonnet 4.6"),
                "gpt-5.4": ("gpt-5.4-mini", "GPT-5.4 Mini"),
                "gpt-5.4-mini": ("gpt-5.4-nano", "GPT-5.4 Nano"),
                "gpt-4o": ("gpt-4o-mini", "GPT-4o Mini"),
            }
            if current_model in cheaper_models:
                new_model, model_label = cheaper_models[current_model]
                proposals.append({
                    "title": f"Try cheaper model ({model_label}) — agent passes {report.success_rate:.0%}",
                    "rationale": (
                        f"Agent achieves {report.success_rate:.0%} success rate with {current_model}. "
                        f"A cheaper model ({new_model}) may maintain quality at lower cost. "
                        "Run eval after switching to verify."
                    ),
                    "category": "model",
                    "modification": {"model": new_model},
                    "priority": 0.4,
                    "evidence": {"success_rate": report.success_rate, "current_model": current_model},
                })

        # Proposal: High-performing agent — reduce max_turns to save cost
        current_max_turns = agent_config.get("max_turns", 50)
        if report.success_rate >= 0.9 and report.total_sessions >= 3 and current_max_turns > 10:
            # For simple agents (no tool failures, high success), max_turns is likely over-provisioned
            proposals.append({
                "title": f"Reduce max_turns from {current_max_turns} to {max(5, current_max_turns // 3)}",
                "rationale": (
                    f"Agent achieves {report.success_rate:.0%} success rate. "
                    f"Current max_turns ({current_max_turns}) is likely over-provisioned. "
                    f"Reducing to {max(5, current_max_turns // 3)} lowers worst-case cost while maintaining headroom."
                ),
                "category": "governance",
                "modification": {"max_turns": max(5, current_max_turns // 3)},
                "priority": 0.25,
                "evidence": {"current_max_turns": current_max_turns},
            })

        # Sort by priority (highest first)
        proposals.sort(key=lambda p: p["priority"], reverse=True)

        return proposals


def _tool_name(tool: str | dict) -> str:
    if isinstance(tool, str):
        return tool
    return tool.get("name", "")
