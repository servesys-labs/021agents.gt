"""Voice platform integrations — Vapi, ElevenLabs, Retell, Bland, Tavus."""

from agentos.integrations.voice_platforms.vapi import VapiAdapter
from agentos.integrations.voice_platforms.elevenlabs import ElevenLabsAdapter
from agentos.integrations.voice_platforms.retell import RetellAdapter
from agentos.integrations.voice_platforms.bland import BlandAdapter
from agentos.integrations.voice_platforms.tavus import TavusAdapter

__all__ = [
    "VapiAdapter",
    "ElevenLabsAdapter",
    "RetellAdapter",
    "BlandAdapter",
    "TavusAdapter",
]
