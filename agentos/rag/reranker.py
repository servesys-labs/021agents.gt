"""Re-ranking module for improving retrieval precision."""

from __future__ import annotations

from agentos.rag.retriever import RetrievalResult


class Reranker:
    """Re-ranks retrieval results to improve precision.

    Uses a simple term-overlap heuristic by default. Can be extended to use
    a cross-encoder model for higher quality re-ranking.
    """

    def __init__(self, top_n: int = 5) -> None:
        self.top_n = top_n

    def rerank(self, query: str, results: list[RetrievalResult]) -> list[RetrievalResult]:
        """Re-rank results based on query-document relevance."""
        query_terms = set(query.lower().split())

        for result in results:
            doc_terms = set(result.chunk.text.lower().split())
            overlap = len(query_terms & doc_terms)
            total = len(query_terms) if query_terms else 1
            relevance_boost = overlap / total
            result.score = 0.6 * result.score + 0.4 * relevance_boost

        results.sort(key=lambda r: r.score, reverse=True)
        return results[: self.top_n]
