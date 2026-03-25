# Graph Runtime Rollout Notes

## Scope

This release completes the graph runtime rollout controls while keeping `harness` as the default execution mode.

## Implemented

- Runtime selection in `Agent.run()` with explicit precedence:
  1. `config.harness.runtime_mode` when set (`harness` or `graph`)
  2. `GRAPH_RUNTIME` env flag
  3. `AGENTOS_RUNTIME_MODE` env flag
- Per-request runtime mode overrides on:
  - `POST /api/v1/agents/{name}/run`
  - `POST /api/v1/agents/{name}/run/stream`
  - `POST /api/v1/runtime-proxy/agent/run`
- Runtime-proxy override safety:
  - per-request overrides do not mutate shared cached agent config
  - override requests use a request-scoped agent instance

## Compatibility

- Default behavior remains unchanged (`harness` mode).
- No schema-breaking changes to existing agent files.
- API runtime override fields are optional; omitting them preserves saved agent config behavior.

## Validation Summary

- Runtime mode precedence tests pass.
- Graph adapter lifecycle, timeout, tool parity, and event payload parity tests pass.
- Broader runtime regression subset passes for middleware and DAG/runtime behavior.

## Operational Rollout Checklist

1. Keep default `harness.runtime_mode = "harness"` in production.
2. Enable `graph` mode on selected agents first.
3. Compare pass rate/cost/latency against baseline eval tasks.
4. Expand graph mode gradually after parity and observability checks.
