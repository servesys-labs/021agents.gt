"""Autoresearch — autonomous agent self-improvement.

Primary mode (agent research):
    Edit agent config → evaluate via EvalGym → keep if better → repeat.
    No GPU needed. Use: ``agentos autoresearch agent <name> <tasks.json>``

Optional mode (training research, requires PyTorch + GPU):
    Edit train.py → run training → measure val_bpb → keep/discard.
    Use: ``agentos autoresearch init --training`` then ``agentos autoresearch run``
    See ``agentos.autoresearch.ml`` for the training harness.

Cost: ~$0.10 per iteration (LLM calls for proposal + evaluation).
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
