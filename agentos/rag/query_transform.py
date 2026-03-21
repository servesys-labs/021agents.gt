"""Query transformation for improving RAG recall.

Implements expansion and rewriting strategies to improve retrieval quality.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class TransformedQuery:
    """A query after transformation, with the original and expanded forms."""

    original: str
    expanded: str
    synonyms: list[str] = field(default_factory=list)
    sub_queries: list[str] = field(default_factory=list)


# Common synonyms for query expansion
_SYNONYM_MAP: dict[str, list[str]] = {
    "error": ["exception", "failure", "bug", "issue"],
    "fix": ["resolve", "repair", "patch", "correct"],
    "deploy": ["release", "ship", "publish", "launch"],
    "config": ["configuration", "settings", "setup"],
    "auth": ["authentication", "authorization", "login", "credentials"],
    "db": ["database", "datastore", "storage"],
    "api": ["endpoint", "interface", "service"],
    "test": ["spec", "assertion", "verification", "check"],
    "build": ["compile", "construct", "assemble"],
    "delete": ["remove", "drop", "destroy", "purge"],
    "create": ["add", "insert", "generate", "make"],
    "update": ["modify", "change", "edit", "alter"],
    "search": ["find", "query", "lookup", "retrieve"],
    "fast": ["quick", "rapid", "performant", "efficient"],
    "slow": ["latency", "bottleneck", "performance"],
}


class QueryTransformer:
    """Transforms queries via expansion, synonym injection, and decomposition.

    Strategies:
    - Synonym expansion: adds related terms to broaden recall
    - Sub-query decomposition: splits compound queries into atomic parts
    - Acronym expansion: expands common abbreviations
    """

    def __init__(self, synonym_map: dict[str, list[str]] | None = None) -> None:
        self._synonyms = synonym_map or _SYNONYM_MAP

    def transform(self, query: str) -> TransformedQuery:
        """Apply all transformation strategies to a query."""
        synonyms = self._expand_synonyms(query)
        sub_queries = self._decompose(query)
        expanded = self._build_expanded(query, synonyms)
        return TransformedQuery(
            original=query,
            expanded=expanded,
            synonyms=synonyms,
            sub_queries=sub_queries,
        )

    def _expand_synonyms(self, query: str) -> list[str]:
        """Find synonym expansions for words in the query."""
        words = query.lower().split()
        found: list[str] = []
        for word in words:
            clean = re.sub(r"[^\w]", "", word)
            if clean in self._synonyms:
                found.extend(self._synonyms[clean])
        return found

    def _decompose(self, query: str) -> list[str]:
        """Decompose compound queries into sub-queries."""
        # Split on conjunctions and question boundaries
        parts = re.split(r"\b(?:and|also|plus|as well as)\b|[;]", query, flags=re.IGNORECASE)
        sub_queries = [p.strip() for p in parts if p.strip()]
        if len(sub_queries) <= 1:
            return []
        return sub_queries

    def _build_expanded(self, query: str, synonyms: list[str]) -> str:
        """Build the expanded query string."""
        if not synonyms:
            return query
        unique = list(dict.fromkeys(synonyms))  # preserve order, deduplicate
        return f"{query} {' '.join(unique)}"
