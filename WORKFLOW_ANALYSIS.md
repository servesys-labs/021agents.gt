# AgentOS Workflow Analysis & Flow Diagram

## System Flow Diagram

```
                            +------------------+
                            |   USER (CLI)     |
                            +--------+---------+
                                     |
          +-------+-------+-------+--+--+-------+-------+-------+-------+
          |       |       |       |     |       |       |       |       |
          v       v       v       v     v       v       v       v       v
       [init]  [create] [run]  [chat] [eval] [evolve] [ingest] [serve] [deploy]
          |       |       |       |     |       |       |       |       |
          |       |       +---+---+     |       |       |       |       |
          |       |           |         |       |       |       |       |
          |       v           v         |       |       |       |       |
          |  AgentBuilder   Agent       |       |       |       |       |
          |       |       from_name()   |       |       |       |       |
          |       |           |         |       |       |       |       |
          |       v           v         |       |       |       |       |
          |  LLMProvider  +--------+    |       |       |       |       |
          |  (Http/Stub)  | Agent  |    |       |       |       |       |
          |       |       | .__init__|  |       |       |       |       |
          |       |       +----+---+    |       |       |       |       |
          |       |            |        |       |       |       |       |
          |       |    +-------+--------+-------+       |       |       |
          |       |    |                                |       |       |
          |       |    v                                |       |       |
          |       | _build_harness()                    |       |       |
          |       |    |                                |       |       |
          |       |    +--+--+--+--+--+                 |       |       |
          |       |    |  |  |  |  |  |                 |       |       |
          |       |    v  v  v  v  v  v                 |       |       |
          |       |  LLM Gov Mem Tool MCP EventBus      |       |       |
          |       | Router     Mgr Exec Client          |       |       |
          |       |    |  |  |  |  |  |                 |       |       |
          v       v    +--+--+--+--+--+                 |       |       |
  Scaffold |      |            |                        |       |       |
  Project  | save_agent_config |                        |       |       |
     |     |            v                               |       |       |
     v     v     AgentHarness.run()                     |       |       |
  dirs/    |            |                               |       |       |
  files    |     +------+------+                        |       |       |
  git      |     |             |                        |       |       |
  identity |     v             v                        |       |       |
  keys     |  classify()   build_context()              |       |       |
  CI/CD    |  (complexity)  (memory tiers)              |       |       |
           |     |             |                        |       |       |
           |     v             v                        v       |       |
           |  +--------------------+              +---------+   |       |
           |  | Multi-Turn Loop    |              | EvalGym |   |       |
           |  | 1. _call_llm()     |              | .run()  |   |       |
           |  | 2. governance chk  |              +---------+   |       |
           |  | 3. _execute_tools()|                    |       |       |
           |  | 4. store memory    |                    v       |       |
           |  +--------+-----------+            +------------+  |       |
           |           |                        | Grader     |  |       |
           |           v                        | (Exact/    |  |       |
           |    LLMResponse                     |  Contains/ |  |       |
           |    (content, tool_calls,           |  LLM)      |  |       |
           |     cost, usage)                   +-----+------+  |       |
           |           |                              |         |       |
           |           v                              v         |       |
           |     [TurnResult]                   [EvalReport]    |       |
           |           |                              |         |       |
           |           v                              |         v       |
           |    Observer records                      |    RAGPipeline  |
           |    SessionRecord                         |   chunk/index   |
           |           |                              |    retrieve     |
           |           v                              |    rerank       |
           |    AgentDB (SQLite)                      |         |       |
           |           |                              |         v       |
           |           v                              |   data/rag_index|
           |    Tracer → spans                        |                 |
           |                                          |                 |
           |                              +-----------+-----------+     |
           |                              |    EvolutionLoop      |     |
           |                              | 1. observe (EventBus) |     |
           |                              | 2. analyze (Analyzer) |     |
           |                              | 3. propose (ReviewQ)  |     |
           |                              | 4. human review       |     |
           |                              | 5. apply (Ledger)     |     |
           |                              | 6. measure impact     |     |
           |                              | 7. rollback if worse  |     |
           |                              +-----------+-----------+     |
           |                                          |                 |
           |                                          v                 |
           |                                  save_agent_config()       |
           |                                                            |
           |                                                            v
           |     +-------------------+          +-------------------+
           |     | API Server        |          | CF Workers Deploy |
           |     | (FastAPI)         |          | deploy/           |
           |     |   /health         |          | agent-config.json |
           |     |   /run            |          | wrangler.toml     |
           |     |   /agents/*       |          +-------------------+
           |     |   /tools          |
           |     |   /memory/snapshot|
           |     |   /sandbox/*      |
           |     |   /auth/*         |
           |     |   /dashboard      |
           |     +-------------------+
           |
           v
    +------------------+
    | Auth Subsystem   |
    | - JWT tokens     |
    | - OAuth (GH/G)   |
    | - email/password |
    | - middleware      |
    +------------------+
```

## Detailed Workflow Descriptions

### 1. Init Workflow (`agentos init`)
**Path:** CLI -> cmd_init -> scaffold directories, identity, keys, config, git, CI/CD
**Components:** `cli.py:cmd_init` -> `core/identity.py` -> `core/database.py`

### 2. Create Workflow (`agentos create`)
**Path:** CLI -> cmd_create -> AgentBuilder -> LLMProvider -> AgentConfig -> save
**Components:** `cli.py:cmd_create` -> `builder.py:AgentBuilder` -> `llm/provider.py`

### 3. Run Workflow (`agentos run <name> "task"`)
**Path:** CLI -> cmd_run -> Agent.from_name -> _build_harness -> harness.run -> multi-turn loop
**Components:** `cli.py:cmd_run` -> `agent.py:Agent` -> `core/harness.py:AgentHarness`

### 4. Eval Workflow (`agentos eval`)
**Path:** CLI -> cmd_eval -> Agent -> EvalGym -> Grader -> EvalReport
**Components:** `cli.py:cmd_eval` -> `eval/gym.py:EvalGym` -> `eval/grader.py`

### 5. Evolve Workflow (`agentos evolve`)
**Path:** CLI -> cmd_evolve -> baseline eval -> EvolutionLoop -> analyze -> propose -> human review -> apply
**Components:** `cli.py:cmd_evolve` -> `evolution/loop.py:EvolutionLoop` -> `evolution/analyzer.py`

### 6. Ingest Workflow (`agentos ingest`)
**Path:** CLI -> cmd_ingest -> RAGPipeline -> chunk -> index -> save
**Components:** `cli.py:cmd_ingest` -> `rag/pipeline.py:RAGPipeline`

### 7. API Server Workflow (`agentos serve`)
**Path:** CLI -> cmd_serve -> uvicorn -> FastAPI app -> AgentHarness
**Components:** `cli.py:cmd_serve` -> `api/app.py:create_app`

### 8. Deploy Workflow (`agentos deploy`)
**Path:** CLI -> cmd_deploy -> load config -> write CF config -> npm commands
**Components:** `cli.py:cmd_deploy` -> `deploy/` directory

---

## BROKEN WORKFLOWS IDENTIFIED

### BUG 1: `eval_agent` builtin handler incorrectly processes agent run results
**File:** `agentos/tools/builtins.py:229-237`
**Severity:** HIGH

The `eval_agent` built-in tool handler (used by the orchestrator agent) creates an `agent_fn` that expects `agent.run()` to return a list of dicts with `role`/`content` keys. However, `Agent.run()` returns a `list[TurnResult]` (dataclass objects), not dicts.

```python
# BROKEN CODE (builtins.py:229-237):
async def agent_fn(user_input: str) -> str:
    result = await agent.run(user_input)
    for msg in reversed(result):
        if isinstance(msg, dict) and msg.get("role") == "assistant":  # <-- WRONG: TurnResult is not a dict
            content = msg.get("content", "")
            if isinstance(content, str):
                return content
    return str(result[-1]) if result else ""
```

The correct pattern (already used in `cli.py:_make_agent_fn`) extracts `.llm_response.content` from `TurnResult` objects.

### BUG 2: Ingested RAG data is not persistent across runs
**File:** `agentos/cli.py:1031-1090` (cmd_ingest) + `agentos/agent.py:241-348` (_build_harness)
**Severity:** HIGH

The `ingest` command creates a `RAGPipeline` instance, indexes documents **in memory**, and saves only metadata to `data/rag_index.json`. However, the actual indexed chunks and embeddings exist only in the in-memory `HybridRetriever`. When the agent later runs via `agentos run`, a **new** `Agent` instance is built with a **fresh** `MemoryManager` that has **no RAG pipeline attached**. The `_build_harness` method in `agent.py` never creates or loads a `RAGPipeline`, so `MemoryManager.rag` is always `None` at runtime. The ingested documents are lost.

**Impact:** The `agentos ingest` command appears to work but has no effect on agent behavior. The entire RAG subsystem is disconnected from the agent runtime.

### BUG 3: Dashboard directory doesn't exist
**File:** `agentos/api/app.py:83-85`
**Severity:** LOW

The API server tries to mount a `dashboard/` directory at `/static`:
```python
dashboard_dir = Path(__file__).parent.parent / "dashboard"
if dashboard_dir.is_dir():
    app.mount("/static", StaticFiles(...), name="static")
```

No `dashboard/` directory exists in the codebase. The `/dashboard` endpoint returns `{"error": "Dashboard not found. Run 'agentos init' first."}`, but `agentos init` also doesn't create a dashboard. The `cmd_serve` advertises `Dashboard: http://...:{port}/dashboard` which always 404s or returns an error.

### BUG 4: Harness doesn't track costs correctly across turns in `TurnResult`
**File:** `agentos/core/harness.py:201-209`
**Severity:** MEDIUM

In the harness run loop, when the agent completes (no tool calls), `cost_usd` is set to `llm_response.cost_usd` for only that **final turn's** LLM call. All intermediate turns that had tool calls produce `TurnResult` with `cost_usd=0.0`. The `cmd_run` function in CLI compensates by summing `r.llm_response.cost_usd` across all results, but the `TurnResult.cost_usd` field itself is misleading — it only captures the final turn's cost.

### BUG 5: `Complexity` enum mismatch between config and router
**File:** `agentos/llm/router.py:14-17` vs `config/default.json:10-23`
**Severity:** LOW

The router defines three complexity levels: `SIMPLE`, `MODERATE`, `COMPLEX`. The config file uses tiers: `simple`, `complex`, `frontier`. The `MODERATE` tier is never configurable from the config, and the `frontier` tier in config doesn't map to any router complexity level. The config's `routing` section is never actually parsed by anything — the router is configured programmatically in `Agent._build_harness()` which registers the same provider for all tiers.

### BUG 6: Sandbox instantiation at import time in API app
**File:** `agentos/api/app.py:170-171`
**Severity:** MEDIUM

```python
from agentos.sandbox import SandboxManager
_sandbox_mgr = SandboxManager()
```

These lines execute at module-level inside `create_app()`, but `SandboxManager` imports `httpx` at module level (`sandbox/manager.py:15`). If `httpx` is installed (it's a dependency), this works, but the sandbox manager is always instantiated even when sandbox features aren't needed, and its import of `httpx` happens before the app is fully configured.

More critically, if `create_app()` is called multiple times (e.g., in tests), each creates a new `SandboxManager` with isolated state.

### BUG 7: Evolution observer is doubly attached
**File:** `agentos/agent.py:374-382` + `agentos/evolution/loop.py:87-91`
**Severity:** LOW

When `cmd_evolve` calls `EvolutionLoop.for_agent(agent)`, the loop creates its own `Observer` and attaches it to the same `EventBus`. But `Agent.__init__` already attached an `Observer` via `_attach_observability()`. This means two observers listen to the same event bus — the evolution loop's observer and the agent's observer — potentially causing double-counting of sessions.

However, since `EvolutionLoop.for_agent()` uses the agent's `_harness.event_bus`, and the loop's observer has its own `records` list, the analysis works on the loop's records. The agent's observer records go unused during evolve, so this is wasteful but not data-corrupting.
