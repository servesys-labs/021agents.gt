"""Hybrid retriever combining dense vector search and sparse BM25 retrieval."""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from agentos.rag.chunker import Chunk


@dataclass
class RetrievalResult:
    chunk: Chunk
    score: float
    source: str = ""


class HybridRetriever:
    """Combines dense vector similarity with sparse BM25 for hybrid retrieval.

    The alpha parameter controls the blend: 1.0 = fully dense, 0.0 = fully sparse.
    """

    def __init__(self, alpha: float = 0.7) -> None:
        self.alpha = alpha
        self._chunks: list[Chunk] = []
        self._embeddings: list[list[float]] = []
        # BM25 parameters
        self._k1 = 1.5
        self._b = 0.75
        self._avgdl = 0.0
        self._doc_freqs: dict[str, int] = {}
        self._doc_lens: list[int] = []
        self._doc_term_counts: list[dict[str, int]] = []

    def index(self, chunks: list[Chunk], embeddings: list[list[float]] | None = None) -> None:
        """Index chunks for both dense and sparse retrieval."""
        self._chunks = chunks
        self._embeddings = embeddings or [[] for _ in chunks]
        self._build_bm25_index()

    def _build_bm25_index(self) -> None:
        self._doc_freqs = {}
        self._doc_lens = []
        self._doc_term_counts = []
        for chunk in self._chunks:
            terms = self._tokenize(chunk.text)
            counts = Counter(terms)
            self._doc_term_counts.append(dict(counts))
            self._doc_lens.append(len(terms))
            for term in set(terms):
                self._doc_freqs[term] = self._doc_freqs.get(term, 0) + 1
        total_len = sum(self._doc_lens)
        self._avgdl = total_len / len(self._chunks) if self._chunks else 1.0

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        return text.lower().split()

    def _bm25_score(self, query_terms: list[str], doc_idx: int) -> float:
        n = len(self._chunks)
        score = 0.0
        dl = self._doc_lens[doc_idx]
        counts = self._doc_term_counts[doc_idx]
        for term in query_terms:
            df = self._doc_freqs.get(term, 0)
            if df == 0:
                continue
            idf = math.log((n - df + 0.5) / (df + 0.5) + 1.0)
            tf = counts.get(term, 0)
            numer = tf * (self._k1 + 1)
            denom = tf + self._k1 * (1 - self._b + self._b * dl / self._avgdl)
            score += idf * numer / denom
        return score

    @staticmethod
    def _cosine(a: list[float], b: list[float]) -> float:
        if len(a) != len(b) or not a:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        return dot / (na * nb) if na and nb else 0.0

    def search(
        self,
        query: str,
        query_embedding: list[float] | None = None,
        top_k: int = 10,
    ) -> list[RetrievalResult]:
        """Perform hybrid search."""
        if not self._chunks:
            return []

        query_terms = self._tokenize(query)

        # Sparse scores (BM25)
        sparse_scores = [self._bm25_score(query_terms, i) for i in range(len(self._chunks))]
        max_sparse = max(sparse_scores) if sparse_scores else 1.0
        if max_sparse > 0:
            sparse_scores = [s / max_sparse for s in sparse_scores]

        # Dense scores
        if query_embedding and any(e for e in self._embeddings):
            dense_scores = [self._cosine(query_embedding, e) for e in self._embeddings]
        else:
            dense_scores = [0.0] * len(self._chunks)

        # Blend
        combined = [
            self.alpha * d + (1 - self.alpha) * s
            for d, s in zip(dense_scores, sparse_scores)
        ]

        indexed = sorted(enumerate(combined), key=lambda x: x[1], reverse=True)
        results: list[RetrievalResult] = []
        for idx, score in indexed[:top_k]:
            results.append(RetrievalResult(chunk=self._chunks[idx], score=score))
        return results
