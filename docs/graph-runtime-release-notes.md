# Graph Runtime Rollout Notes

## Changelog Entry (2026-03-24)

- Hard-cut runtime to graph-first execution in `Agent.run()` and removed legacy harness fallback behavior.
- Standardized runtime-mode API contracts to graph-only while preserving request-scoped override safety in runtime-proxy.
- Added node-level graph observability (`NODE_START`/`NODE_END`/`NODE_ERROR`) with persisted node spans linked by `trace_id` and `session_id`.
- Linked eval persistence end-to-end with per-trial `session_id`/`trace_id` records for drill-down from eval runs to traces.
- Added initial enterprise controls (`enable_checkpoints`, `require_human_approval`) in graph execution path and API request surfaces.
- Added approval pause/resume contract with durable graph checkpoints and resume endpoints on both agent and runtime-proxy surfaces.

## Scope

This release completes the graph runtime hard cut. `Agent.run()` now executes via graph runtime.

## Implemented

- Graph runtime is now the active execution path in `Agent.run()`.
- Runtime-mode request fields are graph-only (`"graph"` when supplied) on:
  - `POST /api/v1/agents/{name}/run`
  - `POST /api/v1/agents/{name}/run/stream`
  - `POST /api/v1/runtime-proxy/agent/run`
  - `POST /api/v1/workflows/{workflow_id}/run`
- Runtime-proxy override safety:
  - per-request overrides do not mutate shared cached agent config
  - override requests use a request-scoped agent instance
- Approval-gated pause/resume:
  - run responses include `stop_reason` and `checkpoint_id`
  - paused runs persist checkpoint payloads to `graph_checkpoints`
  - resume endpoints:
    - `POST /api/v1/agents/{name}/run/checkpoints/{checkpoint_id}/resume`
    - `POST /api/v1/runtime-proxy/agent/run/checkpoints/{checkpoint_id}/resume`
- Node-level graph observability:
  - `NODE_START`, `NODE_END`, `NODE_ERROR` events emitted
  - node spans persisted with `trace_id` + `session_id`
- Eval linkage:
  - aggregate eval runs persisted to `eval_runs`
  - per-trial records persisted to `eval_trials` with `session_id`/`trace_id`
- Enterprise controls:
  - optional `enable_checkpoints` and `require_human_approval` runtime flags
  - approvals can interrupt execution and resume from persisted checkpoint

## Compatibility

- Default behavior is graph runtime.
- No schema-breaking changes to existing agent files.
- API runtime override fields are optional; omitting them still runs graph runtime.

## Validation Summary

- Graph-only runtime tests pass.
- Graph adapter lifecycle, timeout, tool parity, and event payload parity tests pass.
- Broader runtime regression subset passes for middleware and DAG/runtime behavior.
- Node span and eval trial-linkage regression tests pass.

## Operational Rollout Checklist

1. Keep `harness.runtime_mode = "graph"` in agent configs.
2. Monitor pass rate/cost/latency against eval baselines.
3. Use `eval_trials` trace/session linkage for drill-down on regressions.
4. Use `enable_checkpoints` and `require_human_approval` for enterprise workflows as needed.
