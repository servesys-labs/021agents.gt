# AgentOS: The Composable Autonomous Agent Framework

Build, run, and deploy autonomous AI agents from the command line.

## Quick Start

```bash
pip install -e ".[dev]"

# Initialize a new project
agentos init

# Create an agent via conversation with an LLM
export ANTHROPIC_API_KEY=sk-...
agentos create

# Or create one in a single command
agentos create --one-shot "a research assistant that finds and summarizes papers"

# Run an agent
agentos run research-assistant "What are the latest advances in RLHF?"

# Interactive chat
agentos chat research-assistant

# List agents and tools
agentos list
agentos tools
```

## How It Works

### 1. Define agents (not infrastructure)

An agent is a JSON/YAML file in the `agents/` directory:

```json
{
  "name": "my-agent",
  "description": "What this agent does",
  "system_prompt": "You are a helpful assistant specialized in...",
  "model": "claude-sonnet-4-20250514",
  "tools": ["web-search", "store-knowledge"],
  "governance": {
    "budget_limit_usd": 5.0,
    "require_confirmation_for_destructive": true
  }
}
```

### 2. Let an agent build your agents

```bash
agentos create
# > What kind of agent do you want to build?
# > A customer support bot that handles refund requests...
# (The builder agent asks questions, then generates the full definition)
```

### 3. Add tools as plugins

Drop JSON or Python files into the `tools/` directory:

```json
// tools/my-api.json
{
  "name": "my-api",
  "description": "Call my company's API",
  "input_schema": {
    "type": "object",
    "properties": {
      "endpoint": {"type": "string"},
      "params": {"type": "object"}
    },
    "required": ["endpoint"]
  }
}
```

Or Python with handlers:

```python
# tools/calculator.py
async def calculate(expression: str) -> str:
    return str(eval(expression))  # (use a safe parser in production)

TOOLS = [{
    "name": "calculator",
    "description": "Evaluate math expressions",
    "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]},
    "handler": calculate,
}]
```

### 4. Use programmatically

```python
from agentos import Agent, AgentConfig

# From a file
agent = Agent.from_file("agents/research-assistant.json")
results = await agent.run("Summarize recent ML papers on alignment")

# From code
config = AgentConfig(
    name="quick-bot",
    system_prompt="You are a concise assistant.",
    tools=["web-search"],
)
agent = Agent(config)
results = await agent.run("What's the weather today?")
```

### 5. Deploy to Cloudflare Workers

```bash
agentos deploy my-agent
cd deploy && npm run setup
```

## Architecture

AgentOS integrates seven modular subsystems under a unified Agent abstraction:

| Subsystem | Module | Description |
|-----------|--------|-------------|
| **Agent** | `agentos.agent` | First-class agent definition, loading, execution |
| **Builder** | `agentos.builder` | Meta-agent that builds agents via LLM conversation |
| **CLI** | `agentos.cli` | Command-line interface for all operations |
| **Core Harness** | `agentos.core` | Orchestration, governance, event bus |
| **LLM Routing** | `agentos.llm` | Dynamic model selection by task complexity |
| **Tool Execution** | `agentos.tools` | MCP-based tools + plugin registry |
| **Memory** | `agentos.memory` | Working, episodic, semantic, procedural tiers |
| **RAG Pipeline** | `agentos.rag` | Hybrid retrieval (dense + BM25), chunking, reranking |
| **Voice** | `agentos.voice` | Real-time STT/TTS with barge-in support |
| **Eval Gym** | `agentos.eval` | Benchmarking, grading, auto-research loop |

## Project Structure

```
agents/             # Agent definitions (JSON/YAML)
tools/              # Tool plugins (JSON/Python)
data/               # Documents for RAG ingestion
agentos/
  agent.py          # Agent class + config loader
  builder.py        # AgentBuilder meta-agent
  cli.py            # CLI entry point
  core/             # Harness, governance, events
  llm/              # LLM providers and routing
  tools/            # MCP client + tool registry
  memory/           # 4-tier memory system
  rag/              # Retrieval-augmented generation
  voice/            # Speech-to-text / text-to-speech
  eval/             # Evaluation and benchmarking
  api/              # REST API
config/             # Default configuration
deploy/             # Cloudflare Workers deployment
tests/              # Test suite
```

## Example Agents

- `agents/research-assistant.json` — Researches topics and produces summaries
- `agents/customer-support.json` — Handles support inquiries with knowledge base
- `agents/code-reviewer.json` — Reviews code for bugs, security, and style
- `agents/data-analyst.json` — Analyzes data and produces insights

## API Server

```bash
uvicorn agentos.api.app:create_app --factory --host 0.0.0.0 --port 8000
```

- `GET /health` — Health check
- `POST /run` — Execute an agent task
- `GET /tools` — List available tools
- `GET /memory/snapshot` — Current working memory

## Configuration

Edit `config/default.json` for global defaults, or set per-agent in the agent definition file.

## License

MIT
