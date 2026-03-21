"""Unified memory manager coordinating all memory tiers."""

from __future__ import annotations

from agentos.memory.episodic import Episode, EpisodicMemory
from agentos.memory.procedural import ProceduralMemory
from agentos.memory.semantic import SemanticMemory
from agentos.memory.working import WorkingMemory


class MemoryManager:
    """Coordinates working, episodic, semantic, and procedural memory."""

    def __init__(
        self,
        working: WorkingMemory | None = None,
        episodic: EpisodicMemory | None = None,
        semantic: SemanticMemory | None = None,
        procedural: ProceduralMemory | None = None,
    ) -> None:
        self.working = working or WorkingMemory()
        self.episodic = episodic or EpisodicMemory()
        self.semantic = semantic or SemanticMemory()
        self.procedural = procedural or ProceduralMemory()

    async def build_context(self, query: str) -> str:
        """Build a unified context string from all memory tiers."""
        sections: list[str] = []

        # Working memory snapshot
        snapshot = self.working.snapshot()
        if snapshot:
            items = "; ".join(f"{k}={v}" for k, v in list(snapshot.items())[:10])
            sections.append(f"[Working Memory] {items}")

        # Episodic recall
        episodes = self.episodic.search(query, limit=3)
        if episodes:
            ep_lines = [f"- Q: {e.input[:80]} A: {e.output[:80]}" for e in episodes]
            sections.append("[Episodic Memory]\n" + "\n".join(ep_lines))

        # Semantic facts
        facts = self.semantic.search_by_keyword(query, limit=3)
        if facts:
            fact_lines = [f"- {f.key}: {f.value}" for f in facts]
            sections.append("[Semantic Memory]\n" + "\n".join(fact_lines))

        # Procedural suggestions
        procedures = self.procedural.find_best(query, limit=2)
        if procedures:
            proc_lines = [
                f"- {p.name} (success={p.success_rate:.0%}): {p.description[:60]}"
                for p in procedures
            ]
            sections.append("[Procedural Memory]\n" + "\n".join(proc_lines))

        return "\n\n".join(sections)

    async def store_episode(self, user_input: str, agent_output: str) -> str:
        episode = Episode(input=user_input, output=agent_output)
        return self.episodic.store(episode)
