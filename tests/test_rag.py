"""Tests for the RAG pipeline."""

import pytest

from agentos.rag.chunker import DynamicChunker
from agentos.rag.pipeline import RAGPipeline
from agentos.rag.query_transform import QueryTransformer
from agentos.rag.reranker import Reranker
from agentos.rag.retriever import HybridRetriever, RetrievalResult


class TestDynamicChunker:
    def test_short_text(self):
        chunker = DynamicChunker(chunk_size=100)
        chunks = chunker.chunk("Hello world")
        assert len(chunks) == 1

    def test_long_text(self):
        chunker = DynamicChunker(chunk_size=50, chunk_overlap=10)
        text = "This is a test sentence. " * 20
        chunks = chunker.chunk(text)
        assert len(chunks) > 1

    def test_metadata_preserved(self):
        chunker = DynamicChunker()
        chunks = chunker.chunk("Hello", metadata={"source": "test"})
        assert chunks[0].metadata["source"] == "test"


class TestHybridRetriever:
    def test_bm25_search(self):
        retriever = HybridRetriever(alpha=0.0)  # pure BM25
        chunker = DynamicChunker(chunk_size=1000)
        chunks = chunker.chunk("Python is a programming language")
        chunks += chunker.chunk("Java is also a programming language")
        chunks += chunker.chunk("Cooking recipes for dinner")
        retriever.index(chunks)

        results = retriever.search("Python programming", top_k=2)
        assert len(results) > 0
        assert "Python" in results[0].chunk.text

    def test_empty_index(self):
        retriever = HybridRetriever()
        results = retriever.search("anything")
        assert results == []


class TestReranker:
    def test_rerank(self):
        chunker = DynamicChunker()
        c1 = chunker.chunk("Machine learning algorithms")[0]
        c2 = chunker.chunk("Python machine learning")[0]
        results = [
            RetrievalResult(chunk=c1, score=0.8),
            RetrievalResult(chunk=c2, score=0.7),
        ]
        reranker = Reranker(top_n=2)
        reranked = reranker.rerank("machine learning Python", results)
        assert len(reranked) == 2


class TestQueryTransformer:
    def test_synonym_expansion(self):
        qt = QueryTransformer()
        result = qt.transform("fix the error in auth")
        assert len(result.synonyms) > 0
        assert "resolve" in result.synonyms or "exception" in result.synonyms

    def test_no_synonyms(self):
        qt = QueryTransformer()
        result = qt.transform("hello world")
        assert result.expanded == "hello world"

    def test_decomposition(self):
        qt = QueryTransformer()
        result = qt.transform("search the database and deploy the app")
        assert len(result.sub_queries) == 2

    def test_expanded_query_includes_synonyms(self):
        qt = QueryTransformer()
        result = qt.transform("deploy the api")
        assert "deploy" in result.expanded
        # Should include synonyms for both "deploy" and "api"
        assert len(result.expanded) > len(result.original)


class TestRAGPipeline:
    def test_ingest_and_query(self):
        pipeline = RAGPipeline(chunk_size=100, top_k=5, rerank_top_n=3)
        docs = [
            "AgentOS is a composable autonomous agent framework for production deployments.",
            "The RAG pipeline uses hybrid retrieval combining dense and sparse methods.",
            "Voice integration supports real-time speech-to-text and text-to-speech.",
        ]
        num_chunks = pipeline.ingest(docs)
        assert num_chunks >= 3

        results = pipeline.query("agent framework")
        assert len(results) > 0

    def test_query_text(self):
        pipeline = RAGPipeline(chunk_size=200)
        pipeline.ingest(["Hello world. This is a test document."])
        text = pipeline.query_text("hello")
        assert "Hello" in text

    def test_query_with_expansion(self):
        """Verify that query transformation improves recall."""
        pipeline = RAGPipeline(chunk_size=200, top_k=5, rerank_top_n=3)
        pipeline.ingest([
            "The authentication system uses OAuth tokens for login.",
            "Error handling resolves exceptions gracefully.",
            "Cooking recipes for pasta and salad.",
        ])
        # "auth error" should expand to include "authentication", "exception", etc.
        results = pipeline.query("auth error")
        texts = " ".join(r.chunk.text for r in results)
        assert "authentication" in texts.lower() or "error" in texts.lower()
