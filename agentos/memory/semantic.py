"""Semantic memory: persistent factual knowledge store.

Two search paths:
  - Keyword search: SQLite LIKE queries (fast, always available)
  - Embedding search: VectorStore (cosine similarity)

Local dev:  LocalVectorStore (brute-force cosine, backed by SQLite facts table)
Cloudflare: Vectorize via env.VECTORIZE binding

When no VectorStore is provided, falls back to the original in-memory dict
with brute-force cosine — works fine for small fact sets.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from agentos.memory.vector_store import VectorStore


@dataclass
class Fact:
    key: str
    value: Any
    embedding: list[float] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class SemanticMemory:
    """Persistent factual knowledge store with vector similarity search.

    Usage (local dev, in-memory):
        mem = SemanticMemory()

    Usage (local dev, SQLite-backed vectors):
        from agentos.memory.vector_store import LocalVectorStore
        store = LocalVectorStore(db=agent_db)
        mem = SemanticMemory(vector_store=store)

    Usage (Cloudflare, Vectorize):
        # In the Worker, VectorizeStore wraps env.VECTORIZE
        mem = SemanticMemory(vector_store=vectorize_store)

    The SQLite facts table always stores key-value metadata.
    The VectorStore handles embedding storage and similarity search.
    """

    def __init__(
        self,
        vector_store: VectorStore | None = None,
        db: Any | None = None,
    ) -> None:
        self._facts: dict[str, Fact] = {}
        self._vector_store = vector_store
        self._db = db  # AgentDB for keyword search fallback

    def store(self, key: str, value: Any, embedding: list[float] | None = None) -> None:
        """Store a fact, optionally with an embedding vector."""
        fact = Fact(key=key, value=value, embedding=embedding or [])
        self._facts[key] = fact

        # Persist to SQLite if available
        if self._db is not None:
            self._db.upsert_fact(key, value, embedding)

        # Upsert embedding into vector store if available
        if self._vector_store is not None and embedding:
            from agentos.memory.vector_store import Vector
            self._vector_store.upsert([Vector(
                id=key,
                values=embedding,
                metadata={"value": value, "key": key},
            )])

    def get(self, key: str) -> Any | None:
        """Get a fact by exact key."""
        # Check in-memory cache first
        fact = self._facts.get(key)
        if fact:
            return fact.value
        # Fall back to SQLite
        if self._db is not None:
            return self._db.get_fact(key)
        return None

    def search_by_embedding(self, query_embedding: list[float], limit: int = 5) -> list[Fact]:
        """Search by vector similarity. Uses VectorStore if available."""
        if self._vector_store is not None:
            matches = self._vector_store.query(query_embedding, top_k=limit)
            return [
                Fact(
                    key=m.id,
                    value=m.metadata.get("value", ""),
                    embedding=m.values,
                    metadata=m.metadata,
                )
                for m in matches
            ]

        # Fallback: brute-force cosine over in-memory facts
        scored: list[tuple[float, Fact]] = []
        for fact in self._facts.values():
            if fact.embedding:
                score = _cosine_similarity(query_embedding, fact.embedding)
                scored.append((score, fact))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [f for _, f in scored[:limit]]

    def search_by_keyword(self, keyword: str, limit: int = 10) -> list[Fact]:
        """Search by keyword match. Uses SQLite LIKE if available."""
        if self._db is not None:
            rows = self._db.search_facts_by_keyword(keyword, limit=limit)
            return [
                Fact(key=r["key"], value=r["value"], embedding=r.get("embedding", []))
                for r in rows
            ]

        # Fallback: in-memory scan
        keyword_lower = keyword.lower()
        results: list[Fact] = []
        for fact in self._facts.values():
            if keyword_lower in fact.key.lower() or keyword_lower in str(fact.value).lower():
                results.append(fact)
                if len(results) >= limit:
                    break
        return results

    def delete(self, key: str) -> bool:
        deleted = key in self._facts
        self._facts.pop(key, None)
        if self._db is not None:
            self._db.delete_fact(key)
        if self._vector_store is not None:
            self._vector_store.delete([key])
        return deleted

    def count(self) -> int:
        if self._db is not None:
            return self._db.count_facts()
        return len(self._facts)
