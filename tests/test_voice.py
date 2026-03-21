"""Tests for the voice integration module."""

import pytest

from agentos.voice.module import VoiceModule
from agentos.voice.stt import STTStream
from agentos.voice.tts import TTSStream


class TestSTTStream:
    @pytest.mark.asyncio
    async def test_feed_and_finalize(self):
        stt = STTStream()
        await stt.start()
        await stt.feed_audio(b"audio_data_chunk")
        segment = await stt.read_transcript()
        assert not segment.is_final

        final = await stt.finalize()
        assert final.is_final
        await stt.stop()


class TestTTSStream:
    @pytest.mark.asyncio
    async def test_synthesize(self):
        tts = TTSStream()
        await tts.synthesize("Hello world. How are you.")
        chunk1 = await tts.read_audio()
        assert chunk1.data == b"Hello world"
        chunk2 = await tts.read_audio()
        assert chunk2.is_last


class TestVoiceModule:
    @pytest.mark.asyncio
    async def test_speak(self):
        vm = VoiceModule()
        await vm.start()
        chunks = await vm.speak("Hello. World.")
        assert len(chunks) >= 1
        await vm.stop()

    @pytest.mark.asyncio
    async def test_audio_input(self):
        vm = VoiceModule()
        await vm.start()
        segment = await vm.handle_audio_input(b"test_audio")
        assert segment is not None
        await vm.stop()
