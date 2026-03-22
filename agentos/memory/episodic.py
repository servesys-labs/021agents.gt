"""Episodic memory: records of past interactions and outcomes."""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Episode:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    input: str = ""
    output: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)
    outcome: str = ""


class EpisodicMemory:
    """Stores and retrieves records of past interactions.

    When a database is provided, episodes are persisted to SQLite
    and survive across process restarts.
    """

    def __init__(self, max_episodes: int = 10000, ttl_days: int = 90, db: Any = None) -> None:
        self._episodes: list[Episode] = []
        self.max_episodes = max_episodes
        self.ttl_seconds = ttl_days * 86400
        self._db = db

        # Load existing episodes from DB on init
        if self._db is not None:
            self._load_from_db()

    def _load_from_db(self) -> None:
        """Load recent episodes from SQLite into memory."""
        try:
            rows = self._db.recent_episodes(limit=self.max_episodes)
            for row in rows:
                import json as _json
                metadata = row.get("metadata_json", "{}")
                if isinstance(metadata, str):
                    try:
                        metadata = _json.loads(metadata)
                    except Exception:
                        metadata = {}
                self._episodes.append(Episode(
                    id=row["id"],
                    input=row.get("input", ""),
                    output=row.get("output", ""),
                    outcome=row.get("outcome", ""),
                    metadata=metadata,
                    timestamp=row.get("created_at", 0),
                ))
            # Reverse so oldest first (recent_episodes returns newest first)
            self._episodes.reverse()
            if self._episodes:
                logger.info("Loaded %d episodes from database", len(self._episodes))
        except Exception as exc:
            logger.warning("Could not load episodes from DB: %s", exc)

    def store(self, episode: Episode) -> str:
        self._episodes.append(episode)
        if len(self._episodes) > self.max_episodes:
            self._episodes = self._episodes[-self.max_episodes :]

        # Persist to DB
        if self._db is not None:
            try:
                self._db.insert_episode({
                    "id": episode.id,
                    "input": episode.input,
                    "output": episode.output,
                    "outcome": episode.outcome,
                    "metadata": episode.metadata,
                    "timestamp": episode.timestamp,
                })
            except Exception as exc:
                logger.warning("Could not persist episode to DB: %s", exc)

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
