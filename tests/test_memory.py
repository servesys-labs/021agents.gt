"""Tests for the hierarchical memory system."""

import pytest

from agentos.memory.episodic import Episode, EpisodicMemory
from agentos.memory.manager import MemoryManager
from agentos.memory.procedural import Procedure, ProceduralMemory
from agentos.memory.semantic import SemanticMemory
from agentos.memory.working import WorkingMemory


class TestWorkingMemory:
    def test_set_and_get(self):
        wm = WorkingMemory(max_items=5)
        wm.set("key1", "value1")
        assert wm.get("key1") == "value1"

    def test_eviction(self):
        wm = WorkingMemory(max_items=2)
        wm.set("a", 1)
        wm.set("b", 2)
        wm.set("c", 3)
        assert wm.get("a") is None
        assert wm.get("b") == 2
        assert wm.get("c") == 3

    def test_delete(self):
        wm = WorkingMemory()
        wm.set("x", 10)
        assert wm.delete("x") is True
        assert wm.get("x") is None


class TestEpisodicMemory:
    def test_store_and_search(self):
        em = EpisodicMemory()
        em.store(Episode(input="How to deploy?", output="Use docker"))
        results = em.search("deploy")
        assert len(results) == 1
        assert "docker" in results[0].output

    def test_recent(self):
        em = EpisodicMemory()
        for i in range(5):
            em.store(Episode(input=f"q{i}", output=f"a{i}"))
        recent = em.recent(limit=3)
        assert len(recent) == 3
        assert recent[0].input == "q4"


class TestSemanticMemory:
    def test_store_and_get(self):
        sm = SemanticMemory()
        sm.store("user_name", "Alice")
        assert sm.get("user_name") == "Alice"

    def test_keyword_search(self):
        sm = SemanticMemory()
        sm.store("favorite_color", "blue")
        sm.store("favorite_food", "pizza")
        results = sm.search_by_keyword("favorite")
        assert len(results) == 2

    def test_vector_search(self):
        sm = SemanticMemory()
        sm.store("doc1", "hello", embedding=[1.0, 0.0, 0.0])
        sm.store("doc2", "world", embedding=[0.0, 1.0, 0.0])
        results = sm.search_by_embedding([1.0, 0.1, 0.0], limit=1)
        assert len(results) == 1
        assert results[0].key == "doc1"


class TestProceduralMemory:
    def test_store_and_find(self):
        pm = ProceduralMemory()
        pm.store(Procedure(
            name="deploy_app",
            steps=[{"tool": "docker", "args": ["build"]}, {"tool": "docker", "args": ["push"]}],
            description="Deploy application using docker",
            success_count=5,
        ))
        results = pm.find_best("deploy application")
        assert len(results) == 1
        assert results[0].name == "deploy_app"

    def test_record_outcome(self):
        pm = ProceduralMemory()
        pm.store(Procedure(name="test", steps=[]))
        pm.record_outcome("test", success=True)
        assert pm.get("test").success_count == 1


class TestMemoryManager:
    @pytest.mark.asyncio
    async def test_build_context(self):
        mm = MemoryManager()
        mm.working.set("session", "active")
        mm.episodic.store(Episode(input="deploy help", output="use docker"))
        mm.semantic.store("deploy_method", "kubernetes")

        context = await mm.build_context("deploy")
        assert "Working Memory" in context
        assert "Episodic Memory" in context
        assert "Semantic Memory" in context

    @pytest.mark.asyncio
    async def test_store_episode(self):
        mm = MemoryManager()
        ep_id = await mm.store_episode("hi", "hello")
        assert ep_id
        assert mm.episodic.count() == 1
