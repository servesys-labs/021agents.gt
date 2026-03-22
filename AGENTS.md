# AGENTS.md — AgentOS Development Guide

## Architecture Overview

AgentOS uses a **Harness Pattern** where the `AgentHarness` is the central orchestrator wiring together all subsystems. An `Agent` is a configured, runnable entity defined declaratively in JSON/YAML.

```
User Input
    │
    ▼
┌──────────────────────────────────────────────┐
│              AgentHarness                    │
│  ┌────────────┐  ┌──────────┐  ┌──────────┐ │
│  │ LLMRouter  │  │ Memory   │  │ Tools    │ │
│  │ (per-tier) │  │ Manager  │  │ (MCP)    │ │
│  └────────────┘  └──────────┘  └──────────┘ │
│  ┌────────────┐  ┌──────────┐               │
│  │ Governance │  │ EventBus │               │
│  └────────────┘  └──────────┘               │
└──────────────────────────────────────────────┘
    │
    ▼
TurnResult[]
```

## Key Subsystems

### Agent Definition (`agentos/agent.py`)
- `AgentConfig`: Declarative definition (name, model, tools, memory, governance)
- `Agent`: Runtime wrapper that builds a harness from config
- Loaded from JSON/YAML files in `agents/` directory

### LLM Routing (`agentos/llm/router.py`)
- Routes requests to different models based on complexity classification
- Three tiers: `SIMPLE` (Haiku), `MODERATE` (Sonnet), `COMPLEX` (Opus)
- Per-tier models configured in `config/default.json` under `llm.routing`
- Heuristic-based classification using keyword signals and text length

### Memory (`agentos/memory/`)
Four-tier memory system:
1. **Working Memory** — session-scoped scratchpad (max items)
2. **Episodic Memory** — past interaction history (TTL-based expiry)
3. **Semantic Memory** — facts with embeddings in SQLite (persistent)
4. **Procedural Memory** — learned tool sequences (persistent)

### RAG (`agentos/rag/`)
- `DynamicChunker`: Paragraph/sentence-aware chunking
- `HybridRetriever`: BM25 sparse + optional dense vector search
- `QueryTransformer`: Query expansion and synonym injection
- `Reranker`: Term-overlap re-scoring
- Chunks persisted to `data/rag_chunks.db` (SQLite) for fast startup

### Tools (`agentos/tools/`)
- MCP (Model Context Protocol) for tool integration
- `ToolRegistry` discovers tools from `tools/` directory
- `ToolExecutor` handles execution with governance checks
- Built-in tools: create-agent, eval-agent, evolve-agent, knowledge-search, list-agents, list-tools, store-knowledge, web-search

### Governance (`agentos/core/governance.py`)
- Budget tracking (USD limit per session)
- Tool blocking (deny-list)
- Destructive action confirmation
- Policy enforced via `GovernanceLayer` before every tool call

### Event Bus (`agentos/core/events.py`)
- Loose coupling between subsystems
- Events: SESSION_START/END, TURN_START/END, LLM_REQUEST/RESPONSE, TOOL_CALL/RESULT, TASK_RECEIVED
- Used by Observer, Tracer, and Evolution subsystems

## Agent Definition Schema

```json
{
  "name": "my-agent",
  "description": "What this agent does",
  "version": "0.1.0",
  "system_prompt": "You are a helpful assistant...",
  "personality": "Friendly and concise",
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "temperature": 0.0,
  "tools": ["web-search", "store-knowledge"],
  "memory": {
    "working": {"max_items": 100},
    "episodic": {"max_episodes": 10000, "ttl_days": 90},
    "procedural": {"max_procedures": 500}
  },
  "governance": {
    "budget_limit_usd": 10.0,
    "blocked_tools": [],
    "require_confirmation_for_destructive": true
  },
  "max_turns": 50,
  "timeout_seconds": 300,
  "tags": ["research"]
}
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `agentos init` | Scaffold project structure |
| `agentos create` | Build agent via LLM conversation |
| `agentos create --one-shot "..."` | Create agent from one-line description |
| `agentos run <name> "<input>"` | Execute agent on a task |
| `agentos chat <name>` | Interactive agent conversation |
| `agentos eval <name> -t tasks.json` | Benchmark with EvalGym |
| `agentos evolve <name>` | Self-improvement loop |
| `agentos ingest <files>` | Index documents for RAG |
| `agentos serve` | Start FastAPI server + dashboard |
| `agentos deploy` | Deploy to Cloudflare Workers |

## Coding Standards

### Imports
- Use `from __future__ import annotations` in all modules
- Group: stdlib, third-party, local (separated by blank lines)
- Prefer lazy imports inside functions for optional heavy dependencies

### Type Hints
- Use modern Python syntax: `list[str]`, `dict[str, Any]`, `X | None`
- Use `Protocol` for duck-typed interfaces (see `LLMProvider`)

### Testing
- Tests live in `tests/` with `test_` prefix
- Use `pytest` with `pytest-asyncio` for async tests
- Unit tests per module + integration tests for workflows
- Bug fix regressions go in `tests/test_bug_fixes.py`

### Error Handling
- Graceful degradation: warn and continue, don't crash
- Use `logger.warning()` for recoverable issues
- Guard optional features with `try/except ImportError`

### Data Persistence
- SQLite in `data/agent.db` for sessions, memory, costs, spans
- RAG chunks in `data/rag_chunks.db`
- RAG index metadata in `data/rag_index.json`
- Agent definitions in `agents/*.json`

## Multi-Turn Agent Loop

Each `harness.run(input)` executes:

1. **Classify** — determine complexity (SIMPLE/MODERATE/COMPLEX)
2. **Build context** — retrieve from all memory tiers + RAG
3. **Discover tools** — list available tools via MCP
4. **LLM call** — route to appropriate model based on complexity
5. **Governance check** — verify budget and tool permissions
6. **Execute tools** — run any requested tool calls
7. **Store memory** — episodic (interaction) + procedural (tool sequences)
8. **Repeat or complete** — loop until done or max turns reached

## Adding a New Tool

1. Create `tools/my-tool.json` with MCP tool definition
2. Optionally add a handler in `agentos/tools/builtin_handlers.py`
3. Reference by name in agent config: `"tools": ["my-tool"]`

## Adding a New LLM Provider

1. Implement the `LLMProvider` protocol (see `agentos/llm/provider.py`)
2. Must provide: `model_id` property + `complete()` async method
3. Register with `LLMRouter.register(complexity, provider, max_tokens)`
