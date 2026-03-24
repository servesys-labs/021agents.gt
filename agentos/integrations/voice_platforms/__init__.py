"""Voice platform integrations — Vapi (phone) + Tavus (video).

ElevenLabs, Retell, and Bland are available via:
  - GMI Cloud API for TTS/STT inference (native multimodal tools)
  - Pipedream MCP for call management / webhooks (3,000+ app connectors)
"""

from agentos.integrations.voice_platforms.vapi import VapiAdapter
from agentos.integrations.voice_platforms.tavus import TavusAdapter

__all__ = [
    "VapiAdapter",
    "TavusAdapter",
]
