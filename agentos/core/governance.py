"""Governance layer: safety, permissions, budgets."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class GovernancePolicy:
    """Policy configuration for the governance layer."""

    require_confirmation_for_destructive: bool = True
    budget_limit_usd: float = 10.0
    allowed_domains: list[str] = field(default_factory=list)
    blocked_tools: list[str] = field(default_factory=list)
    max_tokens_per_turn: int = 8192


class GovernanceLayer:
    """Enforces safety boundaries, budget limits, and tool permissions."""

    def __init__(self, policy: GovernancePolicy | None = None) -> None:
        self.policy = policy or GovernancePolicy()
        self._spent_usd: float = 0.0

    @property
    def remaining_budget(self) -> float:
        return max(0.0, self.policy.budget_limit_usd - self._spent_usd)

    def record_cost(self, cost_usd: float) -> None:
        self._spent_usd += cost_usd

    def reset_for_session(self) -> None:
        """Reset budget tracking for a new run/session."""
        self._spent_usd = 0.0

    def check_budget(self, estimated_cost: float) -> bool:
        return (self._spent_usd + estimated_cost) <= self.policy.budget_limit_usd

    def is_tool_allowed(self, tool_name: str) -> bool:
        return tool_name not in self.policy.blocked_tools

    def requires_confirmation(self, action: dict[str, Any]) -> bool:
        if not self.policy.require_confirmation_for_destructive:
            return False
        destructive_keywords = {"delete", "drop", "remove", "destroy", "kill", "force"}
        action_str = str(action).lower()
        return any(kw in action_str for kw in destructive_keywords)

    def check_domain(self, url: str) -> bool:
        if not self.policy.allowed_domains:
            return True
        return any(domain in url for domain in self.policy.allowed_domains)
