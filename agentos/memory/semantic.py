"""Semantic memory: persistent factual knowledge store."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


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
    """Persistent factual knowledge store with vector similarity search."""

    def __init__(self) -> None:
        self._facts: dict[str, Fact] = {}

    def store(self, key: str, value: Any, embedding: list[float] | None = None) -> None:
        self._facts[key] = Fact(key=key, value=value, embedding=embedding or [])

    def get(self, key: str) -> Any | None:
        fact = self._facts.get(key)
        return fact.value if fact else None

    def search_by_embedding(self, query_embedding: list[float], limit: int = 5) -> list[Fact]:
        scored: list[tuple[float, Fact]] = []
        for fact in self._facts.values():
            if fact.embedding:
                score = _cosine_similarity(query_embedding, fact.embedding)
                scored.append((score, fact))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [f for _, f in scored[:limit]]

    def search_by_keyword(self, keyword: str, limit: int = 10) -> list[Fact]:
        keyword_lower = keyword.lower()
        results: list[Fact] = []
        for fact in self._facts.values():
            if keyword_lower in fact.key.lower() or keyword_lower in str(fact.value).lower():
                results.append(fact)
                if len(results) >= limit:
                    break
        return results

    def delete(self, key: str) -> bool:
        if key in self._facts:
            del self._facts[key]
            return True
        return False

    def count(self) -> int:
        return len(self._facts)
