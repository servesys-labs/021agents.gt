"""Text-to-Speech streaming module."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass


@dataclass
class AudioChunk:
    data: bytes
    sample_rate: int = 16000
    is_last: bool = False


class TTSStream:
    """Streaming text-to-speech synthesizer.

    In production, connects to a TTS service via WebSocket.
    """

    def __init__(self, model: str = "tts-1", sample_rate: int = 16000) -> None:
        self.model = model
        self.sample_rate = sample_rate
        self._audio_queue: asyncio.Queue[AudioChunk] = asyncio.Queue()

    async def synthesize(self, text: str) -> None:
        """Convert text to speech and queue audio chunks."""
        # Stub: produce a synthetic audio chunk per sentence.
        sentences = [s.strip() for s in text.split(".") if s.strip()]
        for i, sentence in enumerate(sentences):
            chunk = AudioChunk(
                data=sentence.encode("utf-8"),
                sample_rate=self.sample_rate,
                is_last=(i == len(sentences) - 1),
            )
            await self._audio_queue.put(chunk)

    async def read_audio(self) -> AudioChunk:
        return await self._audio_queue.get()
