"""Procedural memory: learned workflows and tool sequences."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Procedure:
    name: str
    steps: list[dict[str, Any]]
    description: str = ""
    success_count: int = 0
    failure_count: int = 0
    last_used: float = field(default_factory=time.time)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total else 0.0


class ProceduralMemory:
    """Stores and retrieves learned workflows and tool sequences."""

    def __init__(self, max_procedures: int = 500) -> None:
        self._procedures: dict[str, Procedure] = {}
        self.max_procedures = max_procedures

    def store(self, procedure: Procedure) -> None:
        self._procedures[procedure.name] = procedure
        if len(self._procedures) > self.max_procedures:
            # Evict the least successful procedure
            worst = min(self._procedures.values(), key=lambda p: p.success_rate)
            del self._procedures[worst.name]

    def get(self, name: str) -> Procedure | None:
        return self._procedures.get(name)

    def record_outcome(self, name: str, success: bool) -> None:
        proc = self._procedures.get(name)
        if proc:
            if success:
                proc.success_count += 1
            else:
                proc.failure_count += 1
            proc.last_used = time.time()

    def find_best(self, task_description: str, limit: int = 3) -> list[Procedure]:
        """Find procedures matching the task description by keyword overlap."""
        task_words = set(task_description.lower().split())
        scored: list[tuple[float, Procedure]] = []
        for proc in self._procedures.values():
            desc_words = set(f"{proc.name} {proc.description}".lower().split())
            overlap = len(task_words & desc_words)
            if overlap > 0:
                score = overlap * (0.5 + 0.5 * proc.success_rate)
                scored.append((score, proc))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [p for _, p in scored[:limit]]

    def list_all(self) -> list[Procedure]:
        return list(self._procedures.values())
