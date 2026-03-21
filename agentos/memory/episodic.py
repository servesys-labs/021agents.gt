"""Episodic memory: records of past interactions and outcomes."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Episode:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    input: str = ""
    output: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)
    outcome: str = ""


class EpisodicMemory:
    """Stores and retrieves records of past interactions."""

    def __init__(self, max_episodes: int = 10000, ttl_days: int = 90) -> None:
        self._episodes: list[Episode] = []
        self.max_episodes = max_episodes
        self.ttl_seconds = ttl_days * 86400

    def store(self, episode: Episode) -> str:
        self._episodes.append(episode)
        if len(self._episodes) > self.max_episodes:
            self._episodes = self._episodes[-self.max_episodes :]
        return episode.id

    def search(self, query: str, limit: int = 5) -> list[Episode]:
        """Simple keyword search over episodes."""
        query_lower = query.lower()
        scored: list[tuple[float, Episode]] = []
        now = time.time()
        for ep in self._episodes:
            if self.ttl_seconds and (now - ep.timestamp) > self.ttl_seconds:
                continue
            text = f"{ep.input} {ep.output}".lower()
            words = query_lower.split()
            score = sum(1 for w in words if w in text)
            if score > 0:
                scored.append((score, ep))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [ep for _, ep in scored[:limit]]

    def recent(self, limit: int = 10) -> list[Episode]:
        return list(reversed(self._episodes[-limit:]))

    def count(self) -> int:
        return len(self._episodes)
