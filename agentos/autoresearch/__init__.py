"""Autoresearch — autonomous self-improvement via the research loop pattern.

Two modes:
    1. **Training research** (karpathy/autoresearch-style):
       Edit train.py → run training → measure val_bpb → keep/discard.
       Use: `agentos autoresearch run`

    2. **Agent research** (meta-agent self-improvement):
       Edit agent config → evaluate via EvalGym → measure pass_rate → keep/discard.
       Use: `agentos autoresearch agent <name> <tasks.json>`

Both share the same core pattern: hypothesis → mutate artifact → evaluate
with a fixed metric → keep if better, discard if not → repeat.

Components:
    driver           — Training-level autoresearch (train.py + val_bpb)
    agent_research   — Agent-level autoresearch (config + EvalGym)
    backends         — Execution backends (in-process, E2B sandbox, GPU cloud)
    results          — TSV experiment log
    program          — program.md generator (agent instructions)
    defaults/        — Starter prepare.py + train.py (nanochat-compatible)

Execution backends:
    in-process       — Local subprocess (CPU). Free. Agent autoresearch uses this.
    e2b              — E2B cloud sandbox (CPU). ~$0.10/hr. Isolated execution.
    gmi / gpu-h100   — GMI Cloud serverless GPU H100 ($2.98/hr). Same GMI_API_KEY as inference.
    gpu-h200         — GMI Cloud serverless GPU H200 ($3.98/hr). Largest models.
"""

from agentos.autoresearch.driver import AutoResearchDriver, ExperimentStatus
from agentos.autoresearch.results import ResultsLog, ExperimentRecord
from agentos.autoresearch.agent_research import AgentResearchLoop
from agentos.autoresearch.backends import (
    ExecutionBackend,
    InProcessBackend,
    E2BSandboxBackend,
    GMICloudGPUBackend,
    GPUCloudBackend,  # alias
    get_backend,
    recommend_backend,
)

__all__ = [
    "AutoResearchDriver",
    "AgentResearchLoop",
    "ExperimentStatus",
    "ResultsLog",
    "ExperimentRecord",
    "ExecutionBackend",
    "InProcessBackend",
    "E2BSandboxBackend",
    "GMICloudGPUBackend",
    "GPUCloudBackend",
    "get_backend",
    "recommend_backend",
]
