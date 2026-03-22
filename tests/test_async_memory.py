"""Tests for async debounced memory updater."""

from __future__ import annotations

import asyncio
import pytest

from agentos.memory.async_updater import (
    AsyncMemoryUpdater,
    FactCategory,
    MemoryFact,
    MemoryUpdate,
    UserMemory,
)


# ── MemoryFact ─────────────────────────────────────────────────────────


def test_memory_fact_content_hash():
    f1 = MemoryFact(content="Hello world")
    f2 = MemoryFact(content="hello   world")
    assert f1.content_hash == f2.content_hash  # Normalized


def test_memory_fact_different_content_hash():
    f1 = MemoryFact(content="Hello world")
    f2 = MemoryFact(content="Different content")
    assert f1.content_hash != f2.content_hash


def test_memory_fact_to_dict():
    f = MemoryFact(
        id="test-id",
        content="Test fact",
        category=FactCategory.PREFERENCE,
        confidence=0.9,
        source="session-1",
    )
    d = f.to_dict()
    assert d["id"] == "test-id"
    assert d["content"] == "Test fact"
    assert d["category"] == "preference"
    assert d["confidence"] == 0.9
    assert d["source"] == "session-1"


# ── UserMemory ─────────────────────────────────────────────────────────


def test_user_memory_add_fact():
    mem = UserMemory()
    f = MemoryFact(content="I prefer dark mode", category=FactCategory.PREFERENCE)
    assert mem.add_fact(f) is True
    assert len(mem.facts) == 1


def test_user_memory_deduplicate():
    mem = UserMemory()
    f1 = MemoryFact(content="I prefer dark mode")
    f2 = MemoryFact(content="i prefer dark mode")  # Different case but same normalized
    assert mem.add_fact(f1) is True
    assert mem.add_fact(f2) is False  # Duplicate
    assert len(mem.facts) == 1


def test_user_memory_top_facts():
    mem = UserMemory()
    for i in range(10):
        mem.add_fact(MemoryFact(
            content=f"Fact {i}",
            confidence=i * 0.1,
        ))

    top = mem.top_facts(limit=3, min_confidence=0.5)
    assert len(top) == 3
    assert top[0].confidence >= top[1].confidence  # Sorted by confidence


def test_user_memory_to_prompt_section():
    mem = UserMemory(
        work_context="Building an AI platform",
        personal_context="Prefers concise responses",
    )
    mem.add_fact(MemoryFact(content="Uses Python", category=FactCategory.KNOWLEDGE, confidence=0.9))

    section = mem.to_prompt_section()
    assert "<memory>" in section
    assert "Building an AI platform" in section
    assert "Prefers concise responses" in section
    assert "[knowledge] Uses Python" in section
    assert "</memory>" in section


def test_user_memory_to_prompt_section_empty():
    mem = UserMemory()
    assert mem.to_prompt_section() == ""


def test_user_memory_to_dict():
    mem = UserMemory(work_context="test")
    mem.add_fact(MemoryFact(content="fact1"))
    d = mem.to_dict()
    assert d["work_context"] == "test"
    assert len(d["facts"]) == 1


# ── AsyncMemoryUpdater ─────────────────────────────────────────────────


def test_updater_queue_update():
    updater = AsyncMemoryUpdater(debounce_seconds=0.1)
    update = MemoryUpdate(
        user_message="I prefer dark mode",
        assistant_message="Noted!",
        session_id="test-1",
    )
    updater.queue_update(update)
    stats = updater.stats()
    assert stats["total_updates_queued"] == 1
    assert stats["queue_size"] == 1


def test_updater_pattern_extract_preference():
    updater = AsyncMemoryUpdater()
    update = MemoryUpdate(
        user_message="I prefer using Python for everything",
        assistant_message="Got it!",
        session_id="test-1",
    )
    facts = updater._pattern_extract(update)
    assert len(facts) >= 1
    assert facts[0].category == FactCategory.PREFERENCE


def test_updater_pattern_extract_knowledge():
    updater = AsyncMemoryUpdater()
    update = MemoryUpdate(
        user_message="My name is Alice and I work at Acme Corp",
        assistant_message="Nice to meet you!",
        session_id="test-1",
    )
    facts = updater._pattern_extract(update)
    assert len(facts) >= 1
    assert facts[0].category == FactCategory.KNOWLEDGE


def test_updater_pattern_extract_goal():
    updater = AsyncMemoryUpdater()
    update = MemoryUpdate(
        user_message="I'm trying to build a web scraper",
        assistant_message="I can help!",
        session_id="test-1",
    )
    facts = updater._pattern_extract(update)
    assert len(facts) >= 1
    assert facts[0].category == FactCategory.GOAL


def test_updater_pattern_extract_no_match():
    updater = AsyncMemoryUpdater()
    update = MemoryUpdate(
        user_message="What is 2 + 2?",
        assistant_message="4",
        session_id="test-1",
    )
    facts = updater._pattern_extract(update)
    assert len(facts) == 0


@pytest.mark.asyncio
async def test_updater_flush_queue():
    updater = AsyncMemoryUpdater(debounce_seconds=0.01, min_confidence=0.0)
    updater.queue_update(MemoryUpdate(
        user_message="I prefer using dark mode",
        assistant_message="OK!",
        session_id="t1",
    ))
    updater.queue_update(MemoryUpdate(
        user_message="My name is Bob",
        assistant_message="Hi Bob!",
        session_id="t2",
    ))

    await updater._flush_queue()

    stats = updater.stats()
    assert stats["total_updates_processed"] == 2
    assert stats["total_facts_extracted"] >= 1


@pytest.mark.asyncio
async def test_updater_start_stop():
    updater = AsyncMemoryUpdater(debounce_seconds=0.05)
    updater.start()
    assert updater.stats()["running"] is True

    updater.queue_update(MemoryUpdate(
        user_message="I prefer concise responses",
        assistant_message="Noted!",
        session_id="t1",
    ))

    # Give time for processing
    await asyncio.sleep(0.2)

    await updater.stop()
    assert updater.stats()["running"] is False
    assert updater.stats()["total_updates_processed"] >= 1


def test_updater_stats():
    updater = AsyncMemoryUpdater()
    stats = updater.stats()
    assert stats["queue_size"] == 0
    assert stats["total_facts"] == 0
    assert stats["total_updates_queued"] == 0
    assert stats["running"] is False
