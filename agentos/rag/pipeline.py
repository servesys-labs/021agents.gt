"""Full RAG pipeline: chunk, index, retrieve, rerank."""

from __future__ import annotations

from agentos.rag.chunker import Chunk, DynamicChunker
from agentos.rag.reranker import Reranker
from agentos.rag.retriever import HybridRetriever, RetrievalResult


class RAGPipeline:
    """End-to-end RAG pipeline for knowledge-grounded generation.

    1. Chunk documents with DynamicChunker
    2. Index chunks in HybridRetriever
    3. Search with hybrid dense+sparse
    4. Rerank for precision
    """

    def __init__(
        self,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        top_k: int = 10,
        rerank_top_n: int = 5,
        hybrid_alpha: float = 0.7,
    ) -> None:
        self.chunker = DynamicChunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        self.retriever = HybridRetriever(alpha=hybrid_alpha)
        self.reranker = Reranker(top_n=rerank_top_n)
        self.top_k = top_k
        self._documents: list[str] = []

    def ingest(self, documents: list[str], metadatas: list[dict[str, str]] | None = None) -> int:
        """Chunk and index a batch of documents. Returns number of chunks."""
        all_chunks: list[Chunk] = []
        for i, doc in enumerate(documents):
            meta = metadatas[i] if metadatas and i < len(metadatas) else {}
            chunks = self.chunker.chunk(doc, metadata=meta)
            all_chunks.extend(chunks)
        self._documents.extend(documents)
        self.retriever.index(all_chunks)
        return len(all_chunks)

    def query(
        self,
        query: str,
        query_embedding: list[float] | None = None,
    ) -> list[RetrievalResult]:
        """Retrieve and rerank relevant chunks for a query."""
        results = self.retriever.search(query, query_embedding=query_embedding, top_k=self.top_k)
        return self.reranker.rerank(query, results)

    def query_text(self, query: str) -> str:
        """Return a concatenated context string from top results."""
        results = self.query(query)
        return "\n\n---\n\n".join(r.chunk.text for r in results)
