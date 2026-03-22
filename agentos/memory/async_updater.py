"""Async debounced memory updater.

Instead of writing to memory synchronously during agent execution,
messages are queued and processed in a background task after a debounce
period. This prevents memory writes from blocking the agent loop.

Features:
- Debounced batching: waits N seconds before processing queued messages
- Background processing: runs in a separate asyncio task
- Fact extraction with confidence scoring and deduplication
- Category-based organization (preference, knowledge, context, behavior, goal)
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class FactCategory(str, Enum):
    PREFERENCE = "preference"
    KNOWLEDGE = "knowledge"
    CONTEXT = "context"
    BEHAVIOR = "behavior"
    GOAL = "goal"


@dataclass
class MemoryFact:
    """A single extracted fact with confidence scoring."""

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    content: str = ""
    category: FactCategory = FactCategory.CONTEXT
    confidence: float = 0.8
    source: str = ""  # session_id or "manual"
    created_at: float = field(default_factory=time.time)

    @property
    def content_hash(self) -> str:
        """Normalized hash for deduplication."""
        normalized = " ".join(self.content.lower().split())
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "category": self.category.value,
            "confidence": self.confidence,
            "source": self.source,
            "created_at": self.created_at,
        }


@dataclass
class MemoryUpdate:
    """A queued memory update request."""

    user_message: str
    assistant_message: str
    session_id: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class UserMemory:
    """Structured user memory with context summaries and facts."""

    work_context: str = ""
    personal_context: str = ""
    top_of_mind: str = ""
    facts: list[MemoryFact] = field(default_factory=list)
    last_updated: float = field(default_factory=time.time)

    def add_fact(self, fact: MemoryFact) -> bool:
        """Add a fact, deduplicating by content hash. Returns True if new."""
        existing_hashes = {f.content_hash for f in self.facts}
        if fact.content_hash in existing_hashes:
            return False
        self.facts.append(fact)
        self.last_updated = time.time()
        return True

    def top_facts(self, limit: int = 15, min_confidence: float = 0.7) -> list[MemoryFact]:
        """Get top facts by confidence, filtered by minimum threshold."""
        filtered = [f for f in self.facts if f.confidence >= min_confidence]
        return sorted(filtered, key=lambda f: f.confidence, reverse=True)[:limit]

    def to_prompt_section(self, max_facts: int = 15) -> str:
        """Format memory for system prompt injection."""
        parts = []
        if self.work_context:
            parts.append(f"Work context: {self.work_context}")
        if self.personal_context:
            parts.append(f"Personal context: {self.personal_context}")
        if self.top_of_mind:
            parts.append(f"Top of mind: {self.top_of_mind}")

        facts = self.top_facts(limit=max_facts)
        if facts:
            fact_lines = [f"- [{f.category.value}] {f.content}" for f in facts]
            parts.append("Known facts:\n" + "\n".join(fact_lines))

        if not parts:
            return ""
        return "<memory>\n" + "\n".join(parts) + "\n</memory>"

    def to_dict(self) -> dict[str, Any]:
        return {
            "work_context": self.work_context,
            "personal_context": self.personal_context,
            "top_of_mind": self.top_of_mind,
            "facts": [f.to_dict() for f in self.facts],
            "last_updated": self.last_updated,
        }


class AsyncMemoryUpdater:
    """Background memory updater with debounced batch processing.

    Usage:
        updater = AsyncMemoryUpdater()
        updater.start()

        # Queue updates (non-blocking)
        updater.queue_update(MemoryUpdate(
            user_message="I prefer dark mode",
            assistant_message="I'll remember that preference.",
            session_id="abc123",
        ))

        # Later, stop gracefully
        await updater.stop()
    """

    def __init__(
        self,
        debounce_seconds: float = 30.0,
        max_facts: int = 100,
        min_confidence: float = 0.7,
        extract_fn: Any | None = None,
    ) -> None:
        self.debounce_seconds = debounce_seconds
        self.max_facts = max_facts
        self.min_confidence = min_confidence
        self._extract_fn = extract_fn  # Optional LLM-based extractor

        self._queue: asyncio.Queue[MemoryUpdate] = asyncio.Queue()
        self._memory = UserMemory()
        self._task: asyncio.Task | None = None
        self._running = False

        # Stats
        self._total_updates_queued: int = 0
        self._total_updates_processed: int = 0
        self._total_facts_extracted: int = 0
        self._total_facts_deduplicated: int = 0

    @property
    def memory(self) -> UserMemory:
        return self._memory

    def start(self) -> None:
        """Start the background processing task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.ensure_future(self._process_loop())
        logger.info("AsyncMemoryUpdater started (debounce=%.1fs)", self.debounce_seconds)

    async def stop(self) -> None:
        """Stop the background task and process remaining updates."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # Process any remaining items
        await self._flush_queue()

    def queue_update(self, update: MemoryUpdate) -> None:
        """Queue a memory update for background processing (non-blocking)."""
        self._total_updates_queued += 1
        try:
            self._queue.put_nowait(update)
        except asyncio.QueueFull:
            logger.warning("Memory update queue full, dropping update")

    async def _process_loop(self) -> None:
        """Background loop: collect updates, debounce, process batch."""
        while self._running:
            try:
                # Wait for at least one update
                await asyncio.wait_for(
                    self._wait_for_update(),
                    timeout=60.0,
                )
                # Debounce: wait for more updates to accumulate
                await asyncio.sleep(self.debounce_seconds)
                # Process all queued updates
                await self._flush_queue()
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Memory updater error: %s", exc)
                await asyncio.sleep(5.0)

    async def _wait_for_update(self) -> None:
        """Wait until at least one update is in the queue."""
        while self._queue.empty() and self._running:
            await asyncio.sleep(0.5)

    async def _flush_queue(self) -> None:
        """Process all pending updates in the queue."""
        batch: list[MemoryUpdate] = []
        while not self._queue.empty():
            try:
                batch.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break

        if not batch:
            return

        self._total_updates_processed += len(batch)
        facts = self._extract_facts(batch)

        for fact in facts:
            if fact.confidence >= self.min_confidence:
                added = self._memory.add_fact(fact)
                if added:
                    self._total_facts_extracted += 1
                    # Persist fact to database
                    try:
                        from pathlib import Path as _Path
                        from agentos.core.database import AgentDB
                        db_path = _Path.cwd() / "data" / "agent.db"
                        if db_path.exists():
                            db = AgentDB(db_path)
                            db.initialize()
                            db.insert_memory_fact(fact.to_dict())
                            db.conn.close()
                    except Exception as exc:
                        logger.debug("Could not persist fact to DB: %s", exc)
                else:
                    self._total_facts_deduplicated += 1

        # Prune oldest facts if over limit
        if len(self._memory.facts) > self.max_facts:
            self._memory.facts.sort(key=lambda f: f.confidence, reverse=True)
            self._memory.facts = self._memory.facts[:self.max_facts]

        logger.info(
            "Processed %d memory updates, extracted %d facts",
            len(batch), len(facts),
        )

    def _extract_facts(self, batch: list[MemoryUpdate]) -> list[MemoryFact]:
        """Extract facts from a batch of updates.

        Uses pattern matching for common fact patterns. When an LLM-based
        extractor is provided, delegates to it for richer extraction.
        """
        if self._extract_fn:
            try:
                return self._extract_fn(batch)
            except Exception as exc:
                logger.warning("LLM fact extraction failed, falling back: %s", exc)

        # Pattern-based extraction (no LLM required)
        facts: list[MemoryFact] = []
        for update in batch:
            extracted = self._pattern_extract(update)
            facts.extend(extracted)
        return facts

    def _pattern_extract(self, update: MemoryUpdate) -> list[MemoryFact]:
        """Simple pattern-based fact extraction."""
        facts = []
        text = update.user_message.lower()

        # Preference patterns
        preference_patterns = [
            "i prefer", "i like", "i want", "i need",
            "i always", "i never", "i usually",
        ]
        for pattern in preference_patterns:
            if pattern in text:
                facts.append(MemoryFact(
                    content=update.user_message[:200],
                    category=FactCategory.PREFERENCE,
                    confidence=0.8,
                    source=update.session_id,
                ))
                break

        # Knowledge patterns
        knowledge_patterns = [
            "my name is", "i work at", "i am a", "i live in",
            "my email", "my phone", "my team",
        ]
        for pattern in knowledge_patterns:
            if pattern in text:
                facts.append(MemoryFact(
                    content=update.user_message[:200],
                    category=FactCategory.KNOWLEDGE,
                    confidence=0.9,
                    source=update.session_id,
                ))
                break

        # Goal patterns
        goal_patterns = [
            "i'm trying to", "i want to", "my goal is",
            "i'm working on", "i need to",
        ]
        for pattern in goal_patterns:
            if pattern in text:
                facts.append(MemoryFact(
                    content=update.user_message[:200],
                    category=FactCategory.GOAL,
                    confidence=0.75,
                    source=update.session_id,
                ))
                break

        return facts

    def stats(self) -> dict[str, Any]:
        return {
            "queue_size": self._queue.qsize(),
            "total_facts": len(self._memory.facts),
            "total_updates_queued": self._total_updates_queued,
            "total_updates_processed": self._total_updates_processed,
            "total_facts_extracted": self._total_facts_extracted,
            "total_facts_deduplicated": self._total_facts_deduplicated,
            "running": self._running,
        }
