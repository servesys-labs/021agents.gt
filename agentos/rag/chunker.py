"""Dynamic document chunking for the RAG pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Chunk:
    text: str
    index: int
    metadata: dict[str, str] = field(default_factory=dict)


class DynamicChunker:
    """Splits documents into chunks with configurable size and overlap.

    Uses paragraph/sentence-aware boundaries when possible.
    """

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 64) -> None:
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(self, text: str, metadata: dict[str, str] | None = None) -> list[Chunk]:
        meta = metadata or {}
        if len(text) <= self.chunk_size:
            return [Chunk(text=text, index=0, metadata=meta)]

        chunks: list[Chunk] = []
        start = 0
        idx = 0
        while start < len(text):
            end = start + self.chunk_size
            if end < len(text):
                # Try to break at paragraph or sentence boundary
                segment = text[start:end]
                for delim in ["\n\n", "\n", ". ", "? ", "! "]:
                    last = segment.rfind(delim)
                    if last > self.chunk_size // 2:
                        end = start + last + len(delim)
                        break

            chunk_text = text[start:end].strip()
            if chunk_text:
                chunks.append(Chunk(text=chunk_text, index=idx, metadata=meta))
                idx += 1

            start = end - self.chunk_overlap
            if start >= len(text):
                break
            # Prevent infinite loop
            if end >= len(text):
                break

        return chunks
