"""Token counting utilities for the LLM routing layer."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Model-to-encoding mapping for tiktoken
_MODEL_ENCODINGS: dict[str, str] = {
    "gpt-4": "cl100k_base",
    "gpt-4o": "o200k_base",
    "gpt-3.5-turbo": "cl100k_base",
    "claude": "cl100k_base",  # approximate
}


def _get_encoding(model: str = "cl100k_base"):
    """Get tiktoken encoding, falling back to cl100k_base."""
    try:
        import tiktoken
        # Try model-specific encoding first
        for prefix, enc_name in _MODEL_ENCODINGS.items():
            if prefix in model.lower():
                return tiktoken.get_encoding(enc_name)
        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None


def count_tokens(text: str, model: str = "cl100k_base") -> int:
    """Count tokens in a text string.

    Uses tiktoken when available, falls back to a word-based estimate.
    """
    encoding = _get_encoding(model)
    if encoding is not None:
        return len(encoding.encode(text))
    # Fallback: rough estimate of ~4 chars per token
    return max(1, len(text) // 4)


def count_message_tokens(messages: list[dict[str, str]], model: str = "cl100k_base") -> int:
    """Count total tokens across a list of chat messages.

    Includes per-message overhead (~4 tokens per message for role/formatting).
    """
    total = 0
    for msg in messages:
        total += 4  # role + formatting overhead
        total += count_tokens(msg.get("content", ""), model)
    total += 2  # priming tokens
    return total


def estimate_cost(
    input_tokens: int,
    output_tokens: int,
    model: str = "claude-sonnet-4-20250514",
) -> float:
    """Estimate API cost in USD based on token counts.

    Uses approximate pricing per 1M tokens.
    """
    pricing: dict[str, tuple[float, float]] = {
        "claude-opus": (15.0, 75.0),
        "claude-sonnet": (3.0, 15.0),
        "claude-haiku": (0.25, 1.25),
        "gpt-4o": (2.50, 10.0),
        "gpt-4": (30.0, 60.0),
        "gpt-3.5": (0.50, 1.50),
    }
    input_rate, output_rate = 3.0, 15.0  # default
    for prefix, (i_rate, o_rate) in pricing.items():
        if prefix in model.lower():
            input_rate, output_rate = i_rate, o_rate
            break
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000
