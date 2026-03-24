"""Optional ML training subsystem for autoresearch.

REQUIRES: PyTorch + CUDA GPU.

This package contains the Karpathy-style training harness (train.py +
prepare.py) for autonomous ML training research. Most AgentOS users
should use ``agentos autoresearch agent`` instead — it improves agent
configs via LLM API calls and needs no GPU.

Install PyTorch first:
    pip install torch

Then scaffold a training workspace:
    agentos autoresearch init --training
"""
