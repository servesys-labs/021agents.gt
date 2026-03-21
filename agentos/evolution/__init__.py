"""Evolution subsystem — the outer-loop agent that observes, evaluates, and evolves."""

from agentos.evolution.session_record import SessionRecord, TurnRecord, StopReason
from agentos.evolution.observer import Observer
from agentos.evolution.analyzer import FailureAnalyzer, FailureCluster
from agentos.evolution.proposals import Proposal, ProposalStatus, ReviewQueue
from agentos.evolution.ledger import EvolutionLedger, EvolutionEntry

__all__ = [
    "SessionRecord",
    "TurnRecord",
    "StopReason",
    "Observer",
    "FailureAnalyzer",
    "FailureCluster",
    "Proposal",
    "ProposalStatus",
    "ReviewQueue",
    "EvolutionLedger",
    "EvolutionEntry",
]
