"""Review Queue — surfaces improvement proposals for human approval.

The idea: the analyzer generates many possible improvements, but only
the top ~10% should be shown to a human. The human approves, rejects,
or modifies each proposal. Approved proposals go to the Ledger for
application and versioning.

This implements the "human gives 10% of the suggestions" pattern:
  - Agent generates 100% of the proposals
  - System ranks and filters to the most impactful ~10%
  - Human reviews and approves/rejects
  - Approved changes are applied and tracked
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class ProposalStatus(str, Enum):
    PENDING = "pending"       # Awaiting human review
    APPROVED = "approved"     # Human approved — ready to apply
    REJECTED = "rejected"     # Human rejected
    APPLIED = "applied"       # Successfully applied to agent config
    ROLLED_BACK = "rolled_back"  # Applied but then reverted


@dataclass
class Proposal:
    """A concrete improvement proposal for human review."""

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = ""
    rationale: str = ""
    category: str = ""        # prompt / tools / governance / model / memory
    modification: dict[str, Any] = field(default_factory=dict)
    priority: float = 0.0     # 0.0 - 1.0 (higher = more impactful)
    evidence: dict[str, Any] = field(default_factory=dict)
    status: ProposalStatus = ProposalStatus.PENDING
    created_at: float = field(default_factory=time.time)
    reviewed_at: float | None = None
    reviewer_note: str = ""   # Human's note on why approved/rejected
    applied_version: str = "" # Agent version after application

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "rationale": self.rationale,
            "category": self.category,
            "modification": self.modification,
            "priority": self.priority,
            "evidence": self.evidence,
            "status": self.status.value,
            "created_at": self.created_at,
            "reviewed_at": self.reviewed_at,
            "reviewer_note": self.reviewer_note,
        }


class ReviewQueue:
    """Manages the pipeline: raw proposals → filtered → human review → applied.

    The queue filters proposals to surface only the top N% by priority,
    avoiding overwhelming the human reviewer with noise.
    """

    def __init__(
        self,
        surface_ratio: float = 0.1,  # Show top 10% to humans
        min_priority: float = 0.2,   # Floor priority to surface
        storage_path: Path | None = None,
        db: Any | None = None,
    ) -> None:
        self.surface_ratio = surface_ratio
        self.min_priority = min_priority
        self.storage_path = storage_path
        self._db = db  # AgentDB instance (optional, preferred over JSON file)
        self._all_proposals: list[Proposal] = []
        self._surfaced: list[Proposal] = []

    @property
    def pending(self) -> list[Proposal]:
        """Proposals awaiting human review."""
        return [p for p in self._surfaced if p.status == ProposalStatus.PENDING]

    @property
    def approved(self) -> list[Proposal]:
        """Proposals approved and ready to apply."""
        return [p for p in self._all_proposals if p.status == ProposalStatus.APPROVED]

    @property
    def history(self) -> list[Proposal]:
        """All proposals ever generated."""
        return list(self._all_proposals)

    def ingest(self, raw_proposals: list[dict[str, Any]]) -> list[Proposal]:
        """Take raw proposals from the Analyzer, filter, and surface the best.

        Returns the surfaced proposals (the ones a human should see).
        """
        # Convert to Proposal objects
        proposals = [
            Proposal(
                title=p.get("title", ""),
                rationale=p.get("rationale", ""),
                category=p.get("category", ""),
                modification=p.get("modification", {}),
                priority=p.get("priority", 0.0),
                evidence=p.get("evidence", {}),
            )
            for p in raw_proposals
        ]

        self._all_proposals.extend(proposals)

        # Filter: minimum priority threshold
        eligible = [p for p in proposals if p.priority >= self.min_priority]

        # Surface top N%
        n = max(1, int(len(eligible) * self.surface_ratio)) if eligible else 0
        surfaced = sorted(eligible, key=lambda p: p.priority, reverse=True)[:max(n, 1)]

        # But always surface at least 1 if any eligible exist
        if eligible and not surfaced:
            surfaced = [eligible[0]]

        self._surfaced.extend(surfaced)

        if self._db is not None:
            for p in proposals:
                self._persist_proposal_to_db(p, surfaced=p in surfaced)
        elif self.storage_path:
            self._persist()

        return surfaced

    def review(
        self,
        proposal_id: str,
        approved: bool,
        note: str = "",
    ) -> Proposal | None:
        """Human reviews a proposal — approve or reject."""
        proposal = self._find(proposal_id)
        if not proposal:
            return None

        proposal.status = ProposalStatus.APPROVED if approved else ProposalStatus.REJECTED
        proposal.reviewed_at = time.time()
        proposal.reviewer_note = note

        if self._db is not None:
            self._db.update_proposal_status(
                proposal.id, proposal.status.value, note, proposal.reviewed_at,
            )
        elif self.storage_path:
            self._persist()

        return proposal

    def mark_applied(self, proposal_id: str, version: str) -> None:
        """Mark a proposal as successfully applied."""
        proposal = self._find(proposal_id)
        if proposal:
            proposal.status = ProposalStatus.APPLIED
            proposal.applied_version = version

    def mark_rolled_back(self, proposal_id: str) -> None:
        """Mark a proposal as rolled back."""
        proposal = self._find(proposal_id)
        if proposal:
            proposal.status = ProposalStatus.ROLLED_BACK

    def _find(self, proposal_id: str) -> Proposal | None:
        for p in self._all_proposals:
            if p.id == proposal_id:
                return p
        return None

    def _persist(self) -> None:
        if not self.storage_path:
            return
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        data = [p.to_dict() for p in self._all_proposals]
        self.storage_path.write_text(json.dumps(data, indent=2) + "\n")

    def _persist_proposal_to_db(self, proposal: Proposal, surfaced: bool = False) -> None:
        """Persist a proposal to SQLite."""
        data = proposal.to_dict()
        data["surfaced"] = surfaced
        self._db.insert_proposal(data)

    def summary(self) -> dict[str, Any]:
        """Summary stats for the review queue."""
        return {
            "total_generated": len(self._all_proposals),
            "surfaced_for_review": len(self._surfaced),
            "pending": len(self.pending),
            "approved": len(self.approved),
            "rejected": sum(1 for p in self._all_proposals if p.status == ProposalStatus.REJECTED),
            "applied": sum(1 for p in self._all_proposals if p.status == ProposalStatus.APPLIED),
            "rolled_back": sum(1 for p in self._all_proposals if p.status == ProposalStatus.ROLLED_BACK),
            "surface_ratio": self.surface_ratio,
        }
