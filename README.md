# AgentOS: The Composable Autonomous Agent Framework

A production-grade, composable harness for deploying, managing, and evaluating autonomous AI agents.

## Architecture

AgentOS integrates seven modular subsystems:

| Subsystem | Module | Description |
|-----------|--------|-------------|
| **Core Harness** | `agentos.core` | Orchestration, governance, event bus |
| **LLM Routing** | `agentos.llm` | Dynamic model selection by task complexity |
| **Tool Execution** | `agentos.tools` | MCP-based tool discovery and execution |
| **Memory** | `agentos.memory` | Working, episodic, semantic, procedural tiers |
| **RAG Pipeline** | `agentos.rag` | Hybrid retrieval (dense + BM25), chunking, reranking |
| **Voice** | `agentos.voice` | Real-time STT/TTS with barge-in support |
| **Eval Gym** | `agentos.eval` | Benchmarking, grading, auto-research loop |

## Quick Start

```bash
pip install -e ".[dev]"

# Run tests
pytest

# Start API server
uvicorn agentos.api.app:create_app --factory --host 0.0.0.0 --port 8000
```

## API Endpoints

- `GET /health` — Health check
- `POST /run` — Execute an agent task
- `GET /tools` — List available tools
- `GET /memory/snapshot` — Current working memory

## Usage

```python
import asyncio
from agentos.core.harness import AgentHarness

async def main():
    harness = AgentHarness.from_config_file()
    results = await harness.run("What is the capital of France?")
    print(results[-1].llm_response.content)

asyncio.run(main())
```

## Configuration

Edit `config/default.json` to customize LLM routing, memory limits, RAG parameters, governance policies, and more.

## License

MIT
