"""Evolution Ledger — tracks every change to an agent over time.

The Ledger is the version history of an agent's evolution. Every approved
proposal that gets applied creates an EvolutionEntry with:
  - The previous config (for rollback)
  - The new config (after applying the modification)
  - The proposal that triggered the change
  - Before/after metrics (so you can measure impact)

This enables:
  - Full audit trail (which human approved what, when)
  - Rollback to any previous version
  - Impact measurement (did the change actually help?)
  - Compliance reporting (who changed what and why)
"""

from __future__ import annotations

import copy
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _bump_version(version: str) -> str:
    """Bump the patch version: 0.1.0 → 0.1.1."""
    parts = version.split(".")
    if len(parts) == 3:
        parts[2] = str(int(parts[2]) + 1)
    return ".".join(parts)


@dataclass
class EvolutionEntry:
    """One step in the agent's evolution."""

    version: str
    previous_version: str
    timestamp: float = field(default_factory=time.time)
    proposal_id: str = ""
    proposal_title: str = ""
    category: str = ""        # prompt / tools / governance / model / memory
    modification: dict[str, Any] = field(default_factory=dict)
    previous_config: dict[str, Any] = field(default_factory=dict)
    new_config: dict[str, Any] = field(default_factory=dict)
    reviewer: str = ""
    reviewer_note: str = ""

    # Impact tracking (filled in after re-evaluation)
    metrics_before: dict[str, float] = field(default_factory=dict)
    metrics_after: dict[str, float] = field(default_factory=dict)
    impact: dict[str, float] = field(default_factory=dict)  # delta

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "previous_version": self.previous_version,
            "timestamp": self.timestamp,
            "proposal_id": self.proposal_id,
            "proposal_title": self.proposal_title,
            "category": self.category,
            "modification": self.modification,
            "reviewer": self.reviewer,
            "reviewer_note": self.reviewer_note,
            "metrics_before": self.metrics_before,
            "metrics_after": self.metrics_after,
            "impact": self.impact,
        }


class EvolutionLedger:
    """Tracks the complete evolution history of an agent.

    Usage:
        ledger = EvolutionLedger(agent_name="my-agent")

        # Apply an approved proposal
        new_config = ledger.apply(
            current_config=agent.config.to_dict(),
            proposal=approved_proposal,
            metrics_before={"pass_rate": 0.6, "avg_cost": 0.05},
        )

        # Later, measure impact
        ledger.record_impact(version="0.1.1", metrics_after={"pass_rate": 0.75})

        # If it made things worse, rollback
        old_config = ledger.rollback(version="0.1.1")
    """

    def __init__(
        self,
        agent_name: str = "",
        storage_path: Path | None = None,
        db: Any | None = None,
    ) -> None:
        self.agent_name = agent_name
        self.storage_path = storage_path
        self._db = db  # AgentDB instance (optional, preferred over JSON file)
        self._entries: list[EvolutionEntry] = []

        if db is not None:
            self._load_from_db()
        elif storage_path and storage_path.exists():
            self._load()

    @property
    def entries(self) -> list[EvolutionEntry]:
        return list(self._entries)

    @property
    def current_version(self) -> str:
        if self._entries:
            return self._entries[-1].version
        return "0.1.0"

    def apply(
        self,
        current_config: dict[str, Any],
        proposal: Any,  # Proposal object
        metrics_before: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        """Apply a proposal's modification to the agent config.

        Returns the new config dict. Does NOT save to disk — caller
        is responsible for persisting (via save_agent_config).
        """
        previous_version = current_config.get("version", self.current_version)
        new_version = _bump_version(previous_version)

        # Deep copy and apply modification
        new_config = copy.deepcopy(current_config)
        modification = proposal.modification

        for key, value in modification.items():
            if isinstance(value, dict) and isinstance(new_config.get(key), dict):
                new_config[key].update(value)
            else:
                new_config[key] = value

        new_config["version"] = new_version

        # Create ledger entry
        entry = EvolutionEntry(
            version=new_version,
            previous_version=previous_version,
            proposal_id=proposal.id,
            proposal_title=proposal.title,
            category=proposal.category,
            modification=modification,
            previous_config=copy.deepcopy(current_config),
            new_config=copy.deepcopy(new_config),
            reviewer_note=getattr(proposal, "reviewer_note", ""),
            metrics_before=metrics_before or {},
        )
        self._entries.append(entry)

        if self._db is not None:
            self._persist_entry_to_db(entry)
        elif self.storage_path:
            self._persist()

        logger.info(
            "Evolution %s → %s: %s",
            previous_version, new_version, proposal.title,
        )

        return new_config

    def record_impact(
        self,
        version: str,
        metrics_after: dict[str, float],
    ) -> dict[str, float] | None:
        """Record post-evolution metrics and compute impact delta."""
        entry = self._find_by_version(version)
        if not entry:
            return None

        entry.metrics_after = metrics_after
        entry.impact = {
            key: metrics_after.get(key, 0) - entry.metrics_before.get(key, 0)
            for key in set(entry.metrics_before) | set(metrics_after)
        }

        if self._db is not None:
            self._db.update_evolution_impact(version, metrics_after, entry.impact)
        elif self.storage_path:
            self._persist()

        return entry.impact

    def rollback(self, version: str) -> dict[str, Any] | None:
        """Get the config from before a specific version was applied.

        Returns the previous_config so the caller can save it.
        """
        entry = self._find_by_version(version)
        if not entry:
            logger.warning("Version %s not found in ledger", version)
            return None

        logger.info("Rolling back from %s to %s", version, entry.previous_version)
        return copy.deepcopy(entry.previous_config)

    def timeline(self) -> list[dict[str, Any]]:
        """Human-readable evolution timeline."""
        return [
            {
                "version": e.version,
                "date": time.strftime("%Y-%m-%d %H:%M", time.localtime(e.timestamp)),
                "change": e.proposal_title,
                "category": e.category,
                "impact": e.impact or "pending measurement",
            }
            for e in self._entries
        ]

    def _find_by_version(self, version: str) -> EvolutionEntry | None:
        for e in self._entries:
            if e.version == version:
                return e
        return None

    def _persist(self) -> None:
        if not self.storage_path:
            return
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        data = [e.to_dict() for e in self._entries]
        self.storage_path.write_text(json.dumps(data, indent=2) + "\n")

    def _load(self) -> None:
        try:
            data = json.loads(self.storage_path.read_text())
            for d in data:
                self._entries.append(EvolutionEntry(
                    version=d.get("version", ""),
                    previous_version=d.get("previous_version", ""),
                    timestamp=d.get("timestamp", 0),
                    proposal_id=d.get("proposal_id", ""),
                    proposal_title=d.get("proposal_title", ""),
                    category=d.get("category", ""),
                    modification=d.get("modification", {}),
                    reviewer_note=d.get("reviewer_note", ""),
                    metrics_before=d.get("metrics_before", {}),
                    metrics_after=d.get("metrics_after", {}),
                    impact=d.get("impact", {}),
                ))
        except Exception as exc:
            logger.warning("Could not load ledger: %s", exc)

    def _load_from_db(self) -> None:
        """Load evolution entries from SQLite."""
        try:
            rows = self._db.query_evolution(limit=10000)
            for d in reversed(rows):  # query returns newest-first, we want oldest-first
                self._entries.append(EvolutionEntry(
                    version=d.get("version", ""),
                    previous_version=d.get("previous_version", ""),
                    timestamp=d.get("created_at", 0),
                    proposal_id=d.get("proposal_id", ""),
                    proposal_title=d.get("proposal_title", ""),
                    category=d.get("category", ""),
                    modification=d.get("modification", {}),
                    reviewer_note=d.get("reviewer_note", ""),
                    metrics_before=d.get("metrics_before", {}),
                    metrics_after=d.get("metrics_after", {}),
                    impact=d.get("impact", {}),
                ))
        except Exception as exc:
            logger.warning("Could not load ledger from database: %s", exc)

    def _persist_entry_to_db(self, entry: EvolutionEntry) -> None:
        """Persist a single evolution entry to SQLite."""
        self._db.insert_evolution_entry({
            "version": entry.version,
            "previous_version": entry.previous_version,
            "timestamp": entry.timestamp,
            "proposal_id": entry.proposal_id,
            "proposal_title": entry.proposal_title,
            "category": entry.category,
            "modification": entry.modification,
            "previous_config": entry.previous_config,
            "new_config": entry.new_config,
            "reviewer": entry.reviewer,
            "reviewer_note": entry.reviewer_note,
            "metrics_before": entry.metrics_before,
            "metrics_after": entry.metrics_after,
            "impact": entry.impact,
        })
