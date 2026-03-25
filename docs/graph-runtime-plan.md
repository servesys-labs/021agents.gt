# AgentOS Graph-First Runtime — Implementation Plan

## Goal
Replace harness-first orchestration with a graph-native runtime while preserving agent config compatibility, LLM routing plans, governance, eval quality, and production operability.

## Why Now
- Current harness adds 4-10s overhead per request (memory, middleware, scoring, events)
- No way to skip unnecessary nodes for simple requests
- No parallel tool execution
- No failure recovery / checkpoint resume
- No human-in-the-loop approval gates
- No node-level observability (only session-level)
- Enterprise customers need all of the above

## Architecture

```
GraphRuntime
  ├── ClassifyNode        — detect task type + complexity (can skip for chat)
  ├── MemoryNode          — load context (skip for simple chat)
  ├── LLMNode             — call LLM provider
  ├── ToolDispatchNode    — route tool calls to CF worker
  ├── ToolExecNode        — execute tool (parallel branch for multiple tools)
  ├── GovernanceNode      — budget check, blocked tools, policy enforcement
  ├── ApprovalNode        — human-in-the-loop gate (enterprise)
  ├── CheckpointNode      — save state for resume (enterprise)
  ├── ScoreNode           — quality scoring (skip for chat channels)
  ├── RecordNode          — session/turn recording
  └── RespondNode         — format + return response
```

### Execution Modes

**Fast Chat** (Telegram, Discord):
  ClassifyNode → LLMNode → RespondNode
  Target: <2 seconds

**Standard Agent** (Portal, API):
  ClassifyNode → MemoryNode → LLMNode → [ToolDispatchNode → ToolExecNode]* → GovernanceNode → ScoreNode → RecordNode → RespondNode
  Target: 5-10 seconds

**Enterprise Workflow** (Mission-critical):
  ClassifyNode → MemoryNode → CheckpointNode → LLMNode → GovernanceNode → ApprovalNode → [ToolDispatchNode → ToolExecNode (parallel)]* → CheckpointNode → ScoreNode → RecordNode → RespondNode
  Target: varies (includes human wait time)

## Week-by-Week Plan

### Week 1 — Contracts + Invariants
- Define `GraphNode` interface: `async execute(ctx: GraphContext) -> GraphContext`
- Define `GraphContext`: messages, tools, routing decision, session state, checkpoints
- Define `GraphRuntime`: takes a list of nodes, executes them in order with skip conditions
- Freeze behavior invariants from current harness (termination, retry, budget, reflection)
- Write compatibility tests: old harness vs new graph produce same output
- Deliverable: executable contract tests + RFC

### Week 2 — Core Graph Execution
- Implement `GraphRuntime` executor with typed nodes
- Port harness stages into nodes:
  - `ClassifyNode` (from `LLMRouter.resolve()`)
  - `MemoryNode` (from `MemoryManager.build_context()`)
  - `LLMNode` (from `harness._call_llm()`)
  - `ToolDispatchNode` + `ToolExecNode` (from `harness._execute_tools()`)
  - `GovernanceNode` (from `governance.check_budget()` + `is_tool_allowed()`)
  - `RecordNode` (from observer + session recording)
- Reuse existing router/governance/memory components inside nodes
- Deliverable: graph runtime passes single-turn and multi-turn tests

### Week 3 — Agent Wiring + Runtime Flag
- Update `Agent.__init__` to build graph instead of harness
- `Agent.run()` delegates to graph runtime when `GRAPH_RUNTIME=true`
- Keep `AgentConfig` backward compatible
- Add execution mode detection: chat vs standard vs enterprise
- Deliverable: graph path behind feature flag

### Week 4 — API Unification
- `/runtime-proxy/agent/run` routes through graph runtime
- `/runtime-proxy/chat` becomes just a graph with fewer nodes (not a separate endpoint)
- Workflows API uses same graph model
- Normalize cancellation/timeouts/metadata
- Deliverable: one execution model across all API surfaces

### Week 5 — Observability
- Add `NODE_START`, `NODE_END`, `NODE_ERROR` events
- Schema migration: add `node_name`, `node_latency_ms`, `node_error` to turns table
- Persist node-level spans linked to `session_id` + `trace_id`
- Preserve current observer/session views (backward compat)
- Portal: node-level trace waterfall visualization
- Deliverable: debuggable graph runs

### Week 6 — Eval Integration
- Eval tasks run through graph runtime
- Add `eval_run_id`, `trial_id` linkage to sessions
- Score → trial → trace → node drill-down
- Keep current graders stable
- Deliverable: eval-to-node traceability

### Week 7 — Enterprise Controls
- `CheckpointNode`: save graph state to DB at node boundaries
- `ApprovalNode`: pause execution, wait for human approval via API/webhook
- Policy-aware resume: only resume if policy still allows
- Idempotent retries: retry from checkpoint, not from scratch
- Deliverable: recoverable enterprise-grade runs

### Week 8 — Hard Cut + Cleanup
- Make graph runtime default (`GRAPH_RUNTIME=true`)
- Remove harness fallback path
- Remove `agentos/core/harness.py` (or archive)
- Update docs, codemap
- Deliverable: graph-first runtime in production

## Files

### New
- `agentos/graph/runtime.py` — GraphRuntime executor
- `agentos/graph/context.py` — GraphContext state object
- `agentos/graph/nodes/` — one file per node type
- `agentos/graph/builder.py` — builds graph from AgentConfig + execution mode
- `tests/test_graph_runtime.py` — contract tests

### Modified
- `agentos/agent.py` — Agent.run() delegates to graph
- `agentos/api/routers/runtime_proxy.py` — routes through graph
- `agentos/core/database.py` — schema V17 for node-level observability
- `agentos/core/events.py` — new event types
- `config/default.json` — graph execution mode settings

### Unchanged (reused inside nodes)
- `agentos/llm/router.py` — used by LLMNode
- `agentos/tools/executor.py` — used by ToolExecNode
- `agentos/core/governance.py` — used by GovernanceNode
- `agentos/memory/manager.py` — used by MemoryNode

## Success Criteria
- Simple chat: <2 seconds (currently 4-6s)
- Tool-using agent: <8 seconds (currently 10-15s)
- Existing eval pass rates preserved
- Node-level trace visibility
- Checkpoint/resume works for enterprise
- Zero breaking changes to AgentConfig
