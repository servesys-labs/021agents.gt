"""VectorStore abstraction — swappable backends for embedding search.

Local dev:  LocalVectorStore   — brute-force cosine over in-memory + SQLite
Production: VectorizeStore     — Cloudflare Vectorize (same interface)

The interface mirrors Cloudflare Vectorize's API so the deploy layer
can swap backends with zero code changes:
  - upsert(vectors)    → insert/update embeddings
  - query(vector, top_k) → nearest-neighbor search
  - delete(ids)        → remove vectors
  - get_by_ids(ids)    → fetch by ID

This keeps semantic memory and RAG decoupled from the storage backend.

Design:
  - SQLite stores the fact metadata (key, value, created_at)
  - VectorStore stores the embeddings + handles similarity search
  - On Cloudflare, Vectorize replaces the local store entirely
  - Embedding generation is the caller's responsibility (Workers AI / local model)
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class VectorMatch:
    """A single search result from the vector store."""
    id: str
    score: float
    metadata: dict[str, Any] = field(default_factory=dict)
    values: list[float] = field(default_factory=list)


@dataclass
class Vector:
    """A vector to upsert into the store."""
    id: str
    values: list[float]
    metadata: dict[str, Any] = field(default_factory=dict)


class VectorStore(ABC):
    """Abstract vector store — implement for each backend."""

    @abstractmethod
    def upsert(self, vectors: list[Vector]) -> int:
        """Insert or update vectors. Returns count upserted."""
        ...

    @abstractmethod
    def query(
        self,
        vector: list[float],
        top_k: int = 5,
        filter_metadata: dict[str, Any] | None = None,
    ) -> list[VectorMatch]:
        """Find nearest neighbors. Returns matches sorted by score descending."""
        ...

    @abstractmethod
    def delete(self, ids: list[str]) -> int:
        """Delete vectors by ID. Returns count deleted."""
        ...

    @abstractmethod
    def get_by_ids(self, ids: list[str]) -> list[Vector]:
        """Fetch vectors by ID."""
        ...

    @abstractmethod
    def count(self) -> int:
        """Total number of vectors stored."""
        ...


# ── Local backend (dev) ─────────────────────────────────────────────────────


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class LocalVectorStore(VectorStore):
    """In-memory vector store with brute-force cosine similarity.

    Good enough for local dev with <10k vectors. For production,
    swap to VectorizeStore (Cloudflare) or any ANN backend.

    Optionally backed by SQLite for persistence across restarts:
        db = AgentDB("data/agent.db")
        store = LocalVectorStore(db=db)
    """

    def __init__(self, db: Any | None = None) -> None:
        self._vectors: dict[str, Vector] = {}
        self._db = db
        if db is not None:
            self._load_from_db()

    def _load_from_db(self) -> None:
        """Load vectors from SQLite facts table (embedding_json column)."""
        try:
            import json
            rows = self._db.conn.execute(
                "SELECT key, value_json, embedding_json, metadata_json FROM facts"
            ).fetchall()
            for r in rows:
                embedding = json.loads(r["embedding_json"])
                if embedding:  # Only load facts that have embeddings
                    metadata = json.loads(r["metadata_json"])
                    metadata["value"] = json.loads(r["value_json"])
                    self._vectors[r["key"]] = Vector(
                        id=r["key"],
                        values=embedding,
                        metadata=metadata,
                    )
        except Exception:
            pass  # Table might not exist yet

    def upsert(self, vectors: list[Vector]) -> int:
        """Insert or update vectors in memory (and optionally SQLite)."""
        count = 0
        for v in vectors:
            self._vectors[v.id] = v
            count += 1
            if self._db is not None:
                self._db.upsert_fact(
                    key=v.id,
                    value=v.metadata.get("value", ""),
                    embedding=v.values,
                )
        return count

    def query(
        self,
        vector: list[float],
        top_k: int = 5,
        filter_metadata: dict[str, Any] | None = None,
    ) -> list[VectorMatch]:
        """Brute-force cosine similarity search."""
        scored: list[VectorMatch] = []
        for v in self._vectors.values():
            if not v.values:
                continue
            # Apply metadata filter if provided
            if filter_metadata:
                if not all(v.metadata.get(k) == val for k, val in filter_metadata.items()):
                    continue
            score = _cosine_similarity(vector, v.values)
            scored.append(VectorMatch(
                id=v.id,
                score=score,
                metadata=v.metadata,
                values=v.values,
            ))
        scored.sort(key=lambda m: m.score, reverse=True)
        return scored[:top_k]

    def delete(self, ids: list[str]) -> int:
        """Delete vectors by ID."""
        count = 0
        for vid in ids:
            if vid in self._vectors:
                del self._vectors[vid]
                count += 1
                if self._db is not None:
                    self._db.delete_fact(vid)
        return count

    def get_by_ids(self, ids: list[str]) -> list[Vector]:
        """Fetch vectors by ID."""
        return [self._vectors[vid] for vid in ids if vid in self._vectors]

    def count(self) -> int:
        return len(self._vectors)


class VectorizeStore(VectorStore):
    """Cloudflare Vectorize backend — used in production deploy.

    This is a reference implementation showing the interface contract.
    The actual Cloudflare binding (env.VECTORIZE) is used in deploy/src/index.ts.
    This class exists so Python-side code can type-check against the same interface.

    In the Cloudflare Worker, the equivalent calls are:
        env.VECTORIZE.upsert(vectors)
        env.VECTORIZE.query(vector, { topK, filter })
        env.VECTORIZE.deleteByIds(ids)
        env.VECTORIZE.getByIds(ids)
    """

    def __init__(self, index_name: str = "agentos-knowledge") -> None:
        self.index_name = index_name
        # In production, this wraps the Vectorize binding
        # For local dev, fall back to LocalVectorStore
        raise NotImplementedError(
            "VectorizeStore requires Cloudflare Workers runtime. "
            "Use LocalVectorStore for local development."
        )

    def upsert(self, vectors: list[Vector]) -> int:
        raise NotImplementedError

    def query(self, vector: list[float], top_k: int = 5,
              filter_metadata: dict[str, Any] | None = None) -> list[VectorMatch]:
        raise NotImplementedError

    def delete(self, ids: list[str]) -> int:
        raise NotImplementedError

    def get_by_ids(self, ids: list[str]) -> list[Vector]:
        raise NotImplementedError

    def count(self) -> int:
        raise NotImplementedError
