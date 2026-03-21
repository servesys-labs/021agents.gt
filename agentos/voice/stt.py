"""Speech-to-Text streaming module."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class TranscriptSegment:
    text: str
    is_final: bool = False
    confidence: float = 1.0
    start_time: float = 0.0
    end_time: float = 0.0


class STTStream:
    """Streaming speech-to-text processor.

    Accepts audio chunks and yields transcript segments.
    In production, this would connect to a real STT service via WebSocket.
    """

    def __init__(self, model: str = "whisper-1", sample_rate: int = 16000) -> None:
        self.model = model
        self.sample_rate = sample_rate
        self._buffer: list[bytes] = []
        self._running = False
        self._transcript_queue: asyncio.Queue[TranscriptSegment] = asyncio.Queue()

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def feed_audio(self, chunk: bytes) -> None:
        """Feed an audio chunk for processing."""
        if not self._running:
            return
        self._buffer.append(chunk)
        # In production, this would stream to the STT service.
        # For now, produce a stub transcript per chunk.
        segment = TranscriptSegment(
            text=f"[audio:{len(chunk)}b]",
            is_final=False,
        )
        await self._transcript_queue.put(segment)

    async def finalize(self) -> TranscriptSegment:
        """Finalize the current utterance."""
        total_bytes = sum(len(c) for c in self._buffer)
        self._buffer.clear()
        segment = TranscriptSegment(
            text=f"[finalized:{total_bytes}b]",
            is_final=True,
        )
        await self._transcript_queue.put(segment)
        return segment

    async def read_transcript(self) -> TranscriptSegment:
        return await self._transcript_queue.get()
