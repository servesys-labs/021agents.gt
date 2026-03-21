"""Real-time voice integration module."""

from __future__ import annotations

from dataclasses import dataclass

from agentos.voice.stt import STTStream, TranscriptSegment
from agentos.voice.tts import AudioChunk, TTSStream


@dataclass
class VoiceConfig:
    stt_model: str = "whisper-1"
    tts_model: str = "tts-1"
    sample_rate: int = 16000
    vad_threshold: float = 0.5


class VoiceModule:
    """Orchestrates real-time voice interaction (STT + TTS).

    Handles:
    - Streaming audio input via STT
    - Barge-in detection (interrupt current TTS output)
    - Endpoint detection (user finished speaking)
    - Streaming audio output via TTS
    """

    def __init__(self, config: VoiceConfig | None = None) -> None:
        cfg = config or VoiceConfig()
        self.stt = STTStream(model=cfg.stt_model, sample_rate=cfg.sample_rate)
        self.tts = TTSStream(model=cfg.tts_model, sample_rate=cfg.sample_rate)
        self._is_speaking = False
        self._barge_in = False

    async def start(self) -> None:
        await self.stt.start()

    async def stop(self) -> None:
        await self.stt.stop()

    async def handle_audio_input(self, chunk: bytes) -> TranscriptSegment | None:
        """Process incoming audio. Returns transcript if endpoint detected."""
        if self._is_speaking:
            # Barge-in: user interrupted TTS output
            self._barge_in = True
            self._is_speaking = False

        await self.stt.feed_audio(chunk)
        segment = await self.stt.read_transcript()
        return segment

    async def speak(self, text: str) -> list[AudioChunk]:
        """Synthesize and stream audio output."""
        self._is_speaking = True
        self._barge_in = False
        await self.tts.synthesize(text)

        chunks: list[AudioChunk] = []
        while True:
            if self._barge_in:
                break
            try:
                chunk = self.tts._audio_queue.get_nowait()
                chunks.append(chunk)
                if chunk.is_last:
                    break
            except Exception:
                break

        self._is_speaking = False
        return chunks
