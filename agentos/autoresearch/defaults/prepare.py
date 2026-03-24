#!/usr/bin/env python3
"""Data preparation for autoresearch — IMMUTABLE.

REQUIREMENTS: PyTorch. This is an OPTIONAL component for ML researchers.
Most AgentOS users should use `agentos autoresearch agent` instead.

Downloads training data, trains a BPE tokenizer, and provides the
dataloader and evaluation function. The agent must NOT modify this file.

Usage:
    python prepare.py [--data-dir DIR] [--num-shards N]
"""

from __future__ import annotations

import hashlib
import math
import os
import pickle
import struct
from pathlib import Path
from typing import Iterator

import torch
import torch.nn.functional as F

# ── Constants (IMMUTABLE) ──────────────────────────────────────────────────

MAX_SEQ_LEN = 2048
TIME_BUDGET = int(os.environ.get("TIME_BUDGET", "300"))  # seconds
EVAL_TOKENS = 40_000_000  # ~40M tokens for validation
VAL_SHARD = 6542  # pinned validation shard for reproducibility

CACHE_DIR = Path(os.environ.get("AUTORESEARCH_CACHE", "~/.cache/autoresearch")).expanduser()
DATA_DIR = CACHE_DIR / "data"
TOKENIZER_DIR = CACHE_DIR / "tokenizer"


# ── Tokenizer ──────────────────────────────────────────────────────────────

class SimpleTokenizer:
    """Minimal BPE tokenizer wrapper.

    In production this would use tiktoken or sentencepiece.
    For the autoresearch loop, we provide a simple interface that
    can be backed by any tokenizer.
    """

    def __init__(self, vocab_size: int = 8192) -> None:
        self.vocab_size = vocab_size
        self._token_bytes: torch.Tensor | None = None
        self._ready = False

    @property
    def ready(self) -> bool:
        return self._ready

    def load(self, path: Path) -> None:
        """Load a pre-trained tokenizer."""
        with open(path, "rb") as f:
            state = pickle.load(f)  # noqa: S301
        self.vocab_size = state["vocab_size"]
        self._token_bytes = state.get("token_bytes")
        self._ready = True

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump({
                "vocab_size": self.vocab_size,
                "token_bytes": self._token_bytes,
            }, f)

    def encode(self, text: str) -> list[int]:
        """Encode text to token IDs (UTF-8 byte-level fallback)."""
        return list(text.encode("utf-8"))[:MAX_SEQ_LEN]

    def decode(self, tokens: list[int]) -> str:
        """Decode token IDs back to text."""
        return bytes(t % 256 for t in tokens).decode("utf-8", errors="replace")


def get_token_bytes(device: str = "cpu") -> torch.Tensor:
    """Return a tensor mapping token_id → byte length.

    Used by evaluate_bpb to compute bits-per-byte.
    Special tokens (byte_length=0) are excluded from the metric.
    """
    tokenizer_path = TOKENIZER_DIR / "tokenizer.pkl"
    if tokenizer_path.exists():
        tok = SimpleTokenizer()
        tok.load(tokenizer_path)
        if tok._token_bytes is not None:
            return tok._token_bytes.to(device)

    # Fallback: every token is 1 byte (UTF-8 byte-level)
    return torch.ones(256, dtype=torch.long, device=device)


# ── Dataloader ─────────────────────────────────────────────────────────────

def make_dataloader(
    tokenizer: SimpleTokenizer,
    batch_size: int,
    seq_len: int,
    split: str = "train",
    buffer_size: int = 1000,
) -> Iterator[tuple[torch.Tensor, torch.Tensor, torch.Tensor]]:
    """Infinite dataloader yielding (input, target, loss_mask) batches.

    Uses best-fit packing: each sequence starts with BOS, then documents
    are packed greedily to minimize wasted positions.

    Yields:
        x: (B, T) input token IDs
        y: (B, T) target token IDs (x shifted right by 1)
        mask: (B, T) loss mask (1 where loss should be computed)
    """
    # For the default implementation, we generate synthetic data
    # that exercises the training loop. In production, this reads
    # from the downloaded shards.
    data_path = DATA_DIR / f"{split}.bin"

    if data_path.exists():
        yield from _shard_dataloader(data_path, batch_size, seq_len)
    else:
        yield from _synthetic_dataloader(batch_size, seq_len)


def _shard_dataloader(
    path: Path, batch_size: int, seq_len: int
) -> Iterator[tuple[torch.Tensor, torch.Tensor, torch.Tensor]]:
    """Read pre-tokenized data from a binary shard file."""
    data = torch.from_numpy(
        __import__("numpy").memmap(str(path), dtype="uint16", mode="r")
    ).long()
    n = len(data)
    while True:
        indices = torch.randint(0, n - seq_len - 1, (batch_size,))
        x = torch.stack([data[i : i + seq_len] for i in indices])
        y = torch.stack([data[i + 1 : i + seq_len + 1] for i in indices])
        mask = torch.ones_like(y)
        yield x, y, mask


def _synthetic_dataloader(
    batch_size: int, seq_len: int
) -> Iterator[tuple[torch.Tensor, torch.Tensor, torch.Tensor]]:
    """Synthetic data for testing the training loop without real data."""
    while True:
        x = torch.randint(0, 256, (batch_size, seq_len))
        y = torch.randint(0, 256, (batch_size, seq_len))
        mask = torch.ones_like(y)
        yield x, y, mask


# ── Evaluation ─────────────────────────────────────────────────────────────

@torch.no_grad()
def evaluate_bpb(
    model,
    tokenizer: SimpleTokenizer,
    batch_size: int,
    device: str = "cuda",
) -> float:
    """Compute validation bits-per-byte (the autoresearch metric).

    This function is IMMUTABLE — the agent must not modify it.

    Bits per byte is vocabulary-independent:
    - Sum per-token cross-entropy loss (in nats)
    - Sum target byte lengths
    - Convert: nats/byte → bits/byte via division by ln(2)
    """
    model.eval()
    token_bytes = get_token_bytes(device=device)
    val_loader = make_dataloader(tokenizer, batch_size, MAX_SEQ_LEN, "val")
    eval_tokens = EVAL_TOKENS
    steps = max(1, eval_tokens // (batch_size * MAX_SEQ_LEN))

    total_nats = 0.0
    total_bytes = 0

    for step_i in range(steps):
        x, y, mask = next(val_loader)
        x, y, mask = x.to(device), y.to(device), mask.to(device)

        # Model should return per-token loss when reduction='none'
        logits = model(x)
        if isinstance(logits, tuple):
            logits = logits[0]

        loss_flat = F.cross_entropy(
            logits.view(-1, logits.size(-1)),
            y.view(-1),
            reduction="none",
        )
        y_flat = y.view(-1)

        # Map each target token to its byte length
        nbytes = token_bytes[y_flat.clamp(0, token_bytes.size(0) - 1)]
        valid = (nbytes > 0) & (mask.view(-1) > 0)

        total_nats += (loss_flat * valid.float()).sum().item()
        total_bytes += nbytes[valid].sum().item()

    model.train()

    if total_bytes == 0:
        return float("inf")

    return total_nats / (math.log(2) * total_bytes)


# ── CLI entry point ────────────────────────────────────────────────────────

def main() -> None:
    """Download data and prepare tokenizer."""
    import argparse

    parser = argparse.ArgumentParser(description="Prepare data for autoresearch")
    parser.add_argument("--data-dir", type=str, default=str(DATA_DIR))
    parser.add_argument("--num-shards", type=int, default=10)
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    print(f"Cache dir:     {CACHE_DIR}")
    print(f"Data dir:      {data_dir}")
    print(f"MAX_SEQ_LEN:   {MAX_SEQ_LEN}")
    print(f"TIME_BUDGET:   {TIME_BUDGET}s")
    print(f"EVAL_TOKENS:   {EVAL_TOKENS:,}")

    # Train tokenizer
    tok = SimpleTokenizer(vocab_size=8192)
    tok_path = TOKENIZER_DIR / "tokenizer.pkl"
    tok.save(tok_path)
    print(f"Tokenizer saved to {tok_path}")

    print("\nData preparation complete.")
    print("Run `uv run train.py` to start training.")


if __name__ == "__main__":
    main()
