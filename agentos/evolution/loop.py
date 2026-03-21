"""Evolution Loop — the outer-loop agent that continuously improves the inner agent.

This is the orchestrator that ties together:
  Observer → Analyzer → ReviewQueue → Ledger → Agent Config

The loop runs continuously (or on-demand) and:
  1. Observes sessions via the EventBus
  2. Periodically analyzes accumulated session records
  3. Generates improvement proposals ranked by impact
  4. Surfaces the top ~10% for human review
  5. Applies approved changes with versioning
  6. Measures impact of applied changes
  7. Rolls back changes that made things worse

The human stays in the loop for approval — the agent does the analysis
and proposes, but never unilaterally changes itself.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Coroutine

from agentos.agent import AgentConfig, save_agent_config
from agentos.core.events import EventBus
from agentos.evolution.analyzer import AnalysisReport, FailureAnalyzer
from agentos.evolution.ledger import EvolutionLedger
from agentos.evolution.observer import Observer
from agentos.evolution.proposals import Proposal, ProposalStatus, ReviewQueue

logger = logging.getLogger(__name__)

AgentFn = Callable[[str], Coroutine[Any, Any, str]]


class EvolutionLoop:
    """The outer-loop agent — observes, analyzes, proposes, evolves.

    Usage:
        # Set up
        loop = EvolutionLoop.for_agent(agent)

        # After the agent runs some sessions...
        report = loop.analyze()           # What's going wrong?
        proposals = loop.propose(report)  # What should we change?
        loop.show_proposals()             # Print for human review

        # Human reviews
        loop.approve("abc123", note="Looks good")
        loop.reject("def456", note="Too aggressive")

        # Apply approved changes
        new_config = loop.apply_approved()

        # Later, measure impact
        loop.measure_impact(eval_report)
    """

    def __init__(
        self,
        agent_config: AgentConfig,
        event_bus: EventBus | None = None,
        data_dir: Path | None = None,
        surface_ratio: float = 0.1,
        min_sessions_for_analysis: int = 5,
    ) -> None:
        self.agent_config = agent_config
        self.data_dir = data_dir or Path.cwd() / "data" / "evolution" / agent_config.name

        # Components
        self.observer = Observer(
            event_bus=event_bus or EventBus(),
            storage_path=self.data_dir / "sessions.jsonl",
        )
        self.analyzer = FailureAnalyzer(min_sessions=min_sessions_for_analysis)
        self.review_queue = ReviewQueue(
            surface_ratio=surface_ratio,
            storage_path=self.data_dir / "proposals.json",
        )
        self.ledger = EvolutionLedger(
            agent_name=agent_config.name,
            storage_path=self.data_dir / "ledger.json",
        )

        # Attach observer to event bus
        self.observer.attach(
            agent_name=agent_config.name,
            agent_config=agent_config.to_dict(),
        )

        self._latest_report: AnalysisReport | None = None

    @classmethod
    def for_agent(cls, agent: Any, **kwargs) -> EvolutionLoop:
        """Create an EvolutionLoop wired to a live Agent instance."""
        return cls(
            agent_config=agent.config,
            event_bus=agent._harness.event_bus,
            **kwargs,
        )

    # ── Step 1: Analyze ────────────────────────────────────────────

    def analyze(self, db=None) -> AnalysisReport:
        """Analyze all observed sessions for patterns.

        If a database is provided, also incorporates human feedback
        into the analysis recommendations.
        """
        report = self.analyzer.analyze(self.observer.records)

        # Incorporate human feedback from the database
        if db is not None:
            try:
                feedback = db.feedback_summary(self.observer._agent_name)
                self.analyzer.incorporate_feedback(report, feedback)
            except Exception:
                pass  # DB may not have feedback table (v1 schema)

        self._latest_report = report
        return report

    # ── Step 2: Propose ────────────────────────────────────────────

    def propose(self, report: AnalysisReport | None = None) -> list[Proposal]:
        """Generate and surface improvement proposals.

        Returns only the surfaced proposals (the top ~10%).
        """
        report = report or self._latest_report
        if not report:
            report = self.analyze()

        raw = self.analyzer.generate_proposals(report, self.agent_config.to_dict())
        surfaced = self.review_queue.ingest(raw)

        logger.info(
            "Generated %d proposals, surfaced %d for review",
            len(raw), len(surfaced),
        )
        return surfaced

    # ── Step 3: Human Review ───────────────────────────────────────

    def show_proposals(self) -> str:
        """Format pending proposals for human review."""
        pending = self.review_queue.pending
        if not pending:
            return "No proposals pending review."

        lines = [f"Pending proposals ({len(pending)}):"]
        lines.append("-" * 60)
        for i, p in enumerate(pending, 1):
            lines.append(f"\n[{i}] {p.title}")
            lines.append(f"    ID:       {p.id}")
            lines.append(f"    Category: {p.category}")
            lines.append(f"    Priority: {p.priority:.1%}")
            lines.append(f"    Rationale: {p.rationale}")
            if p.modification:
                mod_preview = json.dumps(p.modification, indent=2)
                if len(mod_preview) > 200:
                    mod_preview = mod_preview[:200] + "..."
                lines.append(f"    Change: {mod_preview}")
        return "\n".join(lines)

    def approve(self, proposal_id: str, note: str = "") -> Proposal | None:
        """Human approves a proposal."""
        return self.review_queue.review(proposal_id, approved=True, note=note)

    def reject(self, proposal_id: str, note: str = "") -> Proposal | None:
        """Human rejects a proposal."""
        return self.review_queue.review(proposal_id, approved=False, note=note)

    # ── Step 4: Apply ─────────────────────────────────────────────

    def apply_approved(
        self,
        metrics_before: dict[str, float] | None = None,
    ) -> AgentConfig | None:
        """Apply all approved proposals to the agent config.

        Returns the updated AgentConfig, or None if nothing to apply.
        """
        approved = self.review_queue.approved
        if not approved:
            logger.info("No approved proposals to apply")
            return None

        current = self.agent_config.to_dict()

        for proposal in approved:
            # Apply via ledger (tracks history + enables rollback)
            current = self.ledger.apply(
                current_config=current,
                proposal=proposal,
                metrics_before=metrics_before,
            )
            self.review_queue.mark_applied(proposal.id, current.get("version", ""))

        # Update the live config
        self.agent_config = AgentConfig.from_dict(current)

        # Save to disk
        path = save_agent_config(self.agent_config)
        logger.info("Applied %d proposals → saved to %s", len(approved), path)

        return self.agent_config

    # ── Step 5: Measure Impact ────────────────────────────────────

    def measure_impact(
        self,
        metrics_after: dict[str, float],
        version: str | None = None,
    ) -> dict[str, float] | None:
        """Record post-evolution metrics for the latest (or specified) version."""
        version = version or self.ledger.current_version
        return self.ledger.record_impact(version, metrics_after)

    # ── Step 6: Rollback ──────────────────────────────────────────

    def rollback(self, version: str | None = None) -> AgentConfig | None:
        """Rollback to the config before a specific version.

        If no version specified, rolls back the most recent change.
        """
        version = version or self.ledger.current_version
        old_config = self.ledger.rollback(version)
        if not old_config:
            return None

        self.agent_config = AgentConfig.from_dict(old_config)
        path = save_agent_config(self.agent_config)
        logger.info("Rolled back to pre-%s config → saved to %s", version, path)

        # Mark the proposal as rolled back
        entry = self.ledger._find_by_version(version)
        if entry:
            self.review_queue.mark_rolled_back(entry.proposal_id)

        return self.agent_config

    # ── Convenience ───────────────────────────────────────────────

    def status(self) -> dict[str, Any]:
        """Overall evolution status."""
        return {
            "agent": self.agent_config.name,
            "version": self.agent_config.version,
            "observer": self.observer.summary(),
            "review_queue": self.review_queue.summary(),
            "evolution_timeline": self.ledger.timeline(),
            "latest_analysis": self._latest_report.to_dict() if self._latest_report else None,
        }

    def export(self, path: str | Path | None = None) -> Path:
        """Export complete evolution state for dashboards."""
        path = Path(path) if path else self.data_dir / "evolution_export.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.status(), indent=2, default=str) + "\n")
        return path
