#!/usr/bin/env python3
"""Autoresearch training script — THE AGENT EDITS THIS FILE.

REQUIREMENTS: PyTorch + CUDA GPU. This is an OPTIONAL component for ML
researchers who want to use AgentOS for training research. Most users
should use `agentos autoresearch agent` instead (no GPU needed).

    pip install torch  # ~800MB, GPU recommended

A minimal GPT implementation with AdamW optimizer.
The agent may modify anything in this file EXCEPT:
- MAX_SEQ_LEN and TIME_BUDGET (set by prepare.py)
- The evaluate_bpb call (immutable evaluation)
- External dependencies

Goal: minimize val_bpb (validation bits-per-byte).

Based on the nanochat architecture from karpathy/autoresearch.
"""

from __future__ import annotations

import math
import os
import sys
import time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

# Add parent to path so we can import prepare
sys.path.insert(0, str(Path(__file__).parent))
from prepare import (
    MAX_SEQ_LEN,
    TIME_BUDGET,
    SimpleTokenizer,
    evaluate_bpb,
    make_dataloader,
)

# ── Hyperparameters (AGENT MAY EDIT) ──────────────────────────────────────

# Model architecture
DEPTH = 8                    # transformer layers
ASPECT_RATIO = 64            # model_dim = DEPTH * ASPECT_RATIO
HEAD_DIM = 128               # target head dimension
WINDOW_PATTERN = "SSSL"      # sliding window: L=full attention, S=half context

# Optimization
TOTAL_BATCH_SIZE = 2**19     # ~524K tokens per step
DEVICE_BATCH_SIZE = 64       # per-device batch size
LEARNING_RATE = 0.04         # main learning rate for 2D matrices (Muon)
EMBEDDING_LR = 0.6           # token embedding learning rate
UNEMBEDDING_LR = 0.004       # lm_head learning rate
SCALAR_LR = 0.5              # per-layer scalars learning rate
WEIGHT_DECAY = 0.2           # weight decay
ADAM_BETAS = (0.8, 0.95)     # Adam betas for 1D parameters
WARMUP_RATIO = 0.0           # fraction of training for warmup
WARMDOWN_RATIO = 0.5         # fraction of training for cooldown
FINAL_LR_FRAC = 0.0          # final LR as fraction of peak LR

# Derived
MODEL_DIM = DEPTH * ASPECT_RATIO
NUM_HEADS = max(1, MODEL_DIM // HEAD_DIM)
VOCAB_SIZE = 8192  # must match tokenizer


# ── Model ──────────────────────────────────────────────────────────────────

class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        rms = torch.sqrt(torch.mean(x * x, dim=-1, keepdim=True) + self.eps)
        return x / rms * self.weight


class RotaryEmbedding(nn.Module):
    """Rotary Position Embedding (RoPE)."""

    def __init__(self, dim: int, max_len: int = MAX_SEQ_LEN):
        super().__init__()
        inv_freq = 1.0 / (10000 ** (torch.arange(0, dim, 2).float() / dim))
        self.register_buffer("inv_freq", inv_freq)
        self.max_len = max_len

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        seq_len = x.size(1)
        t = torch.arange(seq_len, device=x.device, dtype=self.inv_freq.dtype)
        freqs = torch.einsum("i,j->ij", t, self.inv_freq)
        cos = freqs.cos()
        sin = freqs.sin()
        return cos, sin


def apply_rotary(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    """Apply rotary embedding to input tensor."""
    d = x.shape[-1] // 2
    x1, x2 = x[..., :d], x[..., d:]
    return torch.cat([x1 * cos - x2 * sin, x2 * cos + x1 * sin], dim=-1)


class CausalSelfAttention(nn.Module):
    def __init__(self, dim: int, num_heads: int, window_size: int | None = None):
        super().__init__()
        self.num_heads = num_heads
        self.head_dim = dim // num_heads
        self.window_size = window_size

        self.qkv = nn.Linear(dim, 3 * dim, bias=False)
        self.out_proj = nn.Linear(dim, dim, bias=False)
        self.rope = RotaryEmbedding(self.head_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        qkv = self.qkv(x).reshape(B, T, 3, self.num_heads, self.head_dim)
        q, k, v = qkv.unbind(2)  # (B, T, H, D)
        q, k, v = q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)

        cos, sin = self.rope(x)
        q = apply_rotary(q, cos, sin)
        k = apply_rotary(k, cos, sin)

        # Scaled dot-product attention with causal mask
        scale = 1.0 / math.sqrt(self.head_dim)
        attn = torch.matmul(q, k.transpose(-2, -1)) * scale

        # Causal mask
        causal_mask = torch.triu(
            torch.ones(T, T, device=x.device, dtype=torch.bool), diagonal=1
        )
        attn.masked_fill_(causal_mask, float("-inf"))

        # Optional sliding window
        if self.window_size is not None:
            window_mask = torch.ones(T, T, device=x.device, dtype=torch.bool)
            for i in range(T):
                start = max(0, i - self.window_size + 1)
                window_mask[i, start : i + 1] = False
            attn.masked_fill_(window_mask, float("-inf"))

        attn = F.softmax(attn, dim=-1)
        out = torch.matmul(attn, v)
        out = out.transpose(1, 2).reshape(B, T, C)
        return self.out_proj(out)


class MLP(nn.Module):
    def __init__(self, dim: int, hidden_mult: float = 4.0):
        super().__init__()
        hidden = int(dim * hidden_mult)
        self.fc1 = nn.Linear(dim, hidden, bias=False)
        self.fc2 = nn.Linear(hidden, dim, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(F.gelu(self.fc1(x)))


class TransformerBlock(nn.Module):
    def __init__(
        self,
        dim: int,
        num_heads: int,
        window_size: int | None = None,
    ):
        super().__init__()
        self.norm1 = RMSNorm(dim)
        self.attn = CausalSelfAttention(dim, num_heads, window_size)
        self.norm2 = RMSNorm(dim)
        self.mlp = MLP(dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.norm1(x))
        x = x + self.mlp(self.norm2(x))
        return x


class GPT(nn.Module):
    """Minimal GPT model for autoresearch."""

    def __init__(
        self,
        vocab_size: int = VOCAB_SIZE,
        dim: int = MODEL_DIM,
        depth: int = DEPTH,
        num_heads: int = NUM_HEADS,
    ):
        super().__init__()
        self.tok_emb = nn.Embedding(vocab_size, dim)
        self.blocks = nn.ModuleList()

        for i in range(depth):
            pattern_char = WINDOW_PATTERN[i % len(WINDOW_PATTERN)]
            window_size = MAX_SEQ_LEN if pattern_char == "L" else MAX_SEQ_LEN // 2
            self.blocks.append(TransformerBlock(dim, num_heads, window_size))

        self.norm = RMSNorm(dim)
        self.lm_head = nn.Linear(dim, vocab_size, bias=False)

        # Weight tying
        self.lm_head.weight = self.tok_emb.weight

        self._init_weights()

    def _init_weights(self) -> None:
        for module in self.modules():
            if isinstance(module, nn.Linear):
                nn.init.normal_(module.weight, std=0.02)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, nn.Embedding):
                nn.init.normal_(module.weight, std=0.02)

    def forward(
        self,
        x: torch.Tensor,
        targets: torch.Tensor | None = None,
        reduction: str = "mean",
    ) -> torch.Tensor:
        x = self.tok_emb(x)
        for block in self.blocks:
            x = block(x)
        x = self.norm(x)
        logits = self.lm_head(x)

        # Softcap to prevent logit explosion
        logits = 15.0 * torch.tanh(logits / 15.0)

        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, logits.size(-1)),
                targets.view(-1),
                reduction=reduction,
            )
            return loss

        return logits

    @property
    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())


# ── Optimizer ──────────────────────────────────────────────────────────────

def configure_optimizer(model: GPT) -> torch.optim.Optimizer:
    """Set up separate param groups for different LRs.

    In the full autoresearch stack this would use Muon for 2D matrices
    and AdamW for 1D parameters. This simplified version uses AdamW
    with per-group learning rates.
    """
    embed_params = [model.tok_emb.weight]
    scalar_params = []
    matrix_params = []

    for name, param in model.named_parameters():
        if "tok_emb" in name or "lm_head" in name:
            continue  # handled separately (weight-tied)
        if param.dim() == 1:
            scalar_params.append(param)
        else:
            matrix_params.append(param)

    param_groups = [
        {"params": embed_params, "lr": EMBEDDING_LR, "weight_decay": 0.0},
        {"params": matrix_params, "lr": LEARNING_RATE, "weight_decay": WEIGHT_DECAY},
        {"params": scalar_params, "lr": SCALAR_LR, "weight_decay": 0.0},
    ]

    return torch.optim.AdamW(param_groups, betas=ADAM_BETAS)


def get_lr_multiplier(step: int, total_steps: int) -> float:
    """Cosine schedule with warmup and cooldown."""
    warmup_steps = int(total_steps * WARMUP_RATIO)
    warmdown_start = int(total_steps * (1.0 - WARMDOWN_RATIO))

    if step < warmup_steps:
        return (step + 1) / max(1, warmup_steps)
    elif step >= warmdown_start:
        progress = (step - warmdown_start) / max(1, total_steps - warmdown_start)
        return FINAL_LR_FRAC + (1.0 - FINAL_LR_FRAC) * 0.5 * (1.0 + math.cos(math.pi * progress))
    else:
        return 1.0


# ── Training loop ──────────────────────────────────────────────────────────

def train() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    print(f"Model: dim={MODEL_DIM}, depth={DEPTH}, heads={NUM_HEADS}")

    # Setup
    tokenizer = SimpleTokenizer(vocab_size=VOCAB_SIZE)
    model = GPT().to(device)
    optimizer = configure_optimizer(model)

    num_params_m = model.num_params / 1e6
    print(f"Parameters: {num_params_m:.1f}M")

    # Dataloader
    grad_accum_steps = max(1, TOTAL_BATCH_SIZE // (DEVICE_BATCH_SIZE * MAX_SEQ_LEN))
    loader = make_dataloader(tokenizer, DEVICE_BATCH_SIZE, MAX_SEQ_LEN, "train")

    # Training
    model.train()
    total_training_time = 0.0
    total_tokens = 0
    step = 0
    best_loss = float("inf")

    print(f"\nTraining with TIME_BUDGET={TIME_BUDGET}s")
    print(f"Batch size: {TOTAL_BATCH_SIZE} (grad_accum={grad_accum_steps})")
    print("-" * 60)

    while True:
        t0 = time.time()

        # Gradient accumulation
        optimizer.zero_grad()
        total_loss = 0.0

        for micro_step in range(grad_accum_steps):
            x, y, mask = next(loader)
            x, y = x.to(device), y.to(device)
            loss = model(x, y) / grad_accum_steps
            loss.backward()
            total_loss += loss.item()

        # Gradient clipping
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)

        # LR schedule (estimate total steps from time budget)
        estimated_total_steps = max(100, int(TIME_BUDGET / max(0.01, total_training_time / max(1, step))))
        lr_mult = get_lr_multiplier(step, estimated_total_steps)
        for group in optimizer.param_groups:
            group["lr_actual"] = group["lr"] * lr_mult

        optimizer.step()

        t1 = time.time()
        dt = t1 - t0

        # Only count training time after warmup (skip compilation)
        if step > 10:
            total_training_time += dt

        tokens_this_step = TOTAL_BATCH_SIZE
        total_tokens += tokens_this_step

        # Logging
        if step % 50 == 0:
            print(
                f"step={step:>5d} | loss={total_loss:.4f} | "
                f"dt={dt*1000:.0f}ms | "
                f"tokens={total_tokens/1e6:.1f}M | "
                f"time={total_training_time:.1f}s/{TIME_BUDGET}s"
            )

        step += 1

        # Time budget check
        if step > 10 and total_training_time >= TIME_BUDGET:
            break

    print(f"\nTraining complete: {step} steps, {total_tokens/1e6:.1f}M tokens")

    # Evaluation
    print("\nEvaluating...")
    val_bpb = evaluate_bpb(model, tokenizer, DEVICE_BATCH_SIZE, device=device)

    # Memory stats
    if device == "cuda":
        peak_vram_mb = torch.cuda.max_memory_allocated() / 1e6
    else:
        peak_vram_mb = 0.0

    # MFU estimate (simplified)
    flops_per_token = 6 * model.num_params  # rough estimate
    total_flops = flops_per_token * total_tokens
    if total_training_time > 0 and device == "cuda":
        # Assume A100 80GB peak = 312 TFLOPS bf16
        gpu_peak_tflops = float(os.environ.get("GPU_PEAK_TFLOPS", "312"))
        achieved_tflops = total_flops / total_training_time / 1e12
        mfu = achieved_tflops / gpu_peak_tflops * 100
    else:
        mfu = 0.0

    # Print results in the format the driver expects
    print("\n---")
    print(f"val_bpb:          {val_bpb:.6f}")
    print(f"training_seconds: {total_training_time:.1f}")
    print(f"total_seconds:    {time.time() - t0:.1f}")
    print(f"peak_vram_mb:     {peak_vram_mb:.1f}")
    print(f"mfu_percent:      {mfu:.2f}")
    print(f"total_tokens_M:   {total_tokens/1e6:.1f}")
    print(f"num_steps:        {step}")
    print(f"num_params_M:     {num_params_m:.1f}")
    print(f"depth:            {DEPTH}")


if __name__ == "__main__":
    train()
