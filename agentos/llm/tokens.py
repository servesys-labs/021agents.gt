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
    model: str = "claude-sonnet-4-6-20250627",
) -> float:
    """Estimate API cost in USD based on token counts.

    Uses approximate pricing per 1M tokens.
    """
    # Pricing per 1M tokens (input, output) — from GMI Cloud catalog March 2026
    pricing: dict[str, tuple[float, float]] = {
        # ── Anthropic ─────────────────────────────────────────────
        "claude-opus-4-6": (5.0, 25.0),
        "claude-opus-4-5": (5.0, 25.0),
        "claude-opus-4-1": (15.0, 75.0),
        "claude-sonnet-4-6": (3.0, 15.0),
        "claude-sonnet-4-5": (3.0, 15.0),
        "claude-sonnet-4": (3.0, 15.0),
        "claude-haiku": (1.0, 5.0),
        # Prefix fallbacks
        "claude-opus": (5.0, 25.0),
        "claude-sonnet": (3.0, 15.0),
        # ── OpenAI ────────────────────────────────────────────────
        "gpt-5.4-pro": (30.0, 180.0),
        "gpt-5.4": (2.50, 15.0),
        "gpt-5.3": (1.75, 14.0),
        "gpt-5.2-codex": (1.75, 14.0),
        "gpt-5.2": (1.75, 14.0),
        "gpt-5.1": (1.25, 10.0),
        "gpt-5": (1.25, 10.0),
        "gpt-4o-mini": (0.15, 0.60),
        "gpt-4o": (2.50, 10.0),
        "gpt-oss-120b": (0.05, 0.25),
        "gpt-oss-20b": (0.04, 0.15),
        # ── Google Gemini ─────────────────────────────────────────
        "gemini-3.1-pro": (2.0, 12.0),
        "gemini-3.1-flash-lite": (0.25, 1.50),
        "gemini-3-pro": (2.0, 12.0),
        "gemini-3-flash": (0.50, 3.0),
        "gemini": (2.0, 12.0),
        # ── DeepSeek ──────────────────────────────────────────────
        "deepseek-v3.2-speciale": (0.28, 0.40),
        "deepseek-v3.2-exp": (0.27, 0.41),
        "deepseek-v3.2": (0.20, 0.32),
        "deepseek-v3.1": (0.27, 1.0),
        "deepseek-v3": (0.18, 0.60),
        "deepseek-r1-distill-llama-70b": (0.25, 0.75),
        "deepseek-r1-distill-llama-8b": (0.14, 0.39),
        "deepseek-r1-distill-qwen-32b": (0.50, 0.90),
        "deepseek-r1-distill-qwen-14b": (0.20, 0.20),
        "deepseek-r1-distill-qwen-7b": (0.10, 0.20),
        "deepseek-r1": (0.50, 2.18),
        "deepseek-prover": (0.50, 2.18),
        "deepseek": (0.40, 1.80),
        # ── Meta Llama ────────────────────────────────────────────
        "llama-4-maverick": (0.25, 0.80),
        "llama-4-scout": (0.08, 0.50),
        "llama-3.3-70b": (0.25, 0.75),
        "llama": (0.25, 0.75),
        # ── Qwen ─────────────────────────────────────────────────
        "qwen3.5-397b": (0.60, 3.60),
        "qwen3.5-122b": (0.40, 3.20),
        "qwen3.5-35b": (0.25, 2.0),
        "qwen3.5-27b": (0.30, 2.40),
        "qwen3-coder-480b": (0.35, 1.60),
        "qwen3-235b": (0.17, 1.09),
        "qwen3-next-80b": (0.15, 1.50),
        "qwen3-32b": (0.10, 0.60),
        "qwen3-30b": (0.08, 0.25),
        "qwen": (0.15, 1.0),
        # ── MiniMax ───────────────────────────────────────────────
        "minimax-m2": (0.30, 1.20),
        "minimax": (0.30, 1.20),
        # ── Moonshot Kimi ─────────────────────────────────────────
        "kimi-k2.5": (0.60, 3.0),
        "kimi-k2-thinking": (0.80, 1.20),
        "kimi": (0.60, 3.0),
        # ── ZAI GLM ──────────────────────────────────────────────
        "glm-5": (1.0, 3.20),
        "glm-4.7-flash": (0.07, 0.40),
        "glm-4.7": (0.33, 1.50),
        "glm-4.6": (0.60, 2.0),
        "glm-4.5": (0.20, 1.10),
        "glm": (0.60, 2.0),
        # ── ByteDance Seed ────────────────────────────────────────
        "seed-2.0": (0.10, 0.40),
        # ── Mistral ───────────────────────────────────────────────
        "mistral-large": (2.0, 6.0),
        "mistral": (2.0, 6.0),
        # ── Cloudflare Workers AI (free tier) ─────────────────────
        "@cf/": (0.0, 0.0),
        # ── Local models (free — your own hardware) ───────────────
        "local": (0.0, 0.0),
    }
    input_rate, output_rate = 3.0, 15.0  # default
    for prefix, (i_rate, o_rate) in pricing.items():
        if prefix in model.lower():
            input_rate, output_rate = i_rate, o_rate
            break
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000
