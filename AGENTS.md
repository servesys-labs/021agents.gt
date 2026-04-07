# AGENTS.md — AgentOS Development Guide

> **Source of truth:** The TypeScript codebase (`control-plane/`, `deploy/`, `portal/`) is the
> active implementation. The Python `agentos/` directory is **deprecated** and retained only for
> reference. All new work targets the TS stack.

## Quick Orientation

| Directory | Role | Stack | Entry Point |
|-----------|------|-------|-------------|
| `control-plane/` | API & business logic | Hono + Supabase (CF Workers) | `src/index.ts` |
| `deploy/` | Edge agent runtime | Durable Objects + Agents SDK | `src/index.ts` |
| `portal/` | Web dashboard | React + Refine + Tailwind | `src/App.tsx` |
| `mvp/` | Slim product shell (personal + SMB) | React + Vite + Tailwind | `src/main.tsx` |
| `agentos/` | **(deprecated)** Python backend | FastAPI + SQLite | — |

**MVP product plan (personas, scope, API flows, telemetry):** `docs/mvp-product-plan.md`.

## Architecture Overview

```
Browser / API Client
    |
    v
+---------------------------+      +---------------------------+
|    control-plane (Hono)   |      |      portal (React)       |
|  43 route families        |      |  28 pages, canvas builder |
|  Auth (JWT/Clerk/API key) |      |  Session trace viewer     |
|  Graph lint + validate    |      |  Agent management UI      |
|  Gate-pack (eval gates)   |      +---------------------------+
|  Release channels         |
+---------------------------+
    |
    v
+---------------------------+
|    deploy (CF Workers)    |
|  Durable Object agent     |
|  Deterministic graph exec |
|  4-tier memory system     |
|  Checkpoint / resume      |
|  10-scope codemode        |
|  Circuit breaker + loop   |
+---------------------------+
    |
    v
Supabase (Postgres) + R2 + Vectorize + Queue
```

## Key Subsystems (deeper docs)

### Control Plane (`control-plane/src/`)

| Area | Key Files | What It Does |
|------|-----------|--------------|
| Auth & RBAC | `auth/`, `middleware/auth.ts` | JWT + Clerk + API keys, 50+ scopes, role hierarchy |
| Agent CRUD | `routes/agents.ts` | Create, update, version, import/export agents |
| Graph validation | `logic/graph-lint.ts`, `logic/graph-validate.ts` | Design-time rules, cycle detection, autofix |
| Eval gates | `logic/gate-pack.ts` | Pass-rate gates before release promotion |
| Release channels | `routes/releases.ts` | draft -> staging -> production, canary splits |
| Workflows | `routes/workflows.ts`, `logic/workflow-validator.ts` | DAG pipelines with approval gates |
| Sessions | `routes/sessions.ts` | Session listing, stats, traces, feedback |
| Security | `logic/security-scanner.ts`, `logic/prompt-injection.ts` | OWASP probes, PII detection |
| Scope matrix | `SCOPE_MATRIX.md` | Full authorization matrix (34 scope families) |
| TS migration status | `PARITY_SCORECARD.md` | Test coverage across 9 implementation waves |

### Edge Runtime (`deploy/src/runtime/`)

| Area | Key Files | What It Does |
|------|-----------|--------------|
| Session lifecycle | `engine.ts` | `edgeRun` / `edgeResume` / `edgeBatch` |
| Graph executor | `edge_graph.ts` | Deterministic node graph: bootstrap -> budget -> LLM -> tools -> loop |
| Memory | `memory.ts` | 4-tier: working (DO RAM), episodic (Supabase), semantic (Vectorize), procedural |
| Tools | `tools.ts` | Execution, circuit breaker (5-fail threshold), per-tool cost model |
| Loop detection | `middleware.ts` | Signature tracking, progressive warnings, hard halt at 5 repeats |
| Code execution | `codemode.ts` | 10 scopes (agent, graph_node, transform, validator, ...) in V8 isolates |
| Streaming | `stream.ts` | WebSocket: tokens, tool_progress (5s heartbeat), turn_end, done |
| Persistence | `db.ts` | Sessions, turns, events, billing, time-travel replay |
| Checkpoints | `engine.ts` | Approval gates, full state serialization, cross-session resume |
| Workspace | `workspace.ts` | R2 file sync for persistent sandbox state |
| Progress tracking | `progress.ts` | Cross-session progress log for multi-session continuity |

### Portal (`portal/src/`)

| Area | Key Files | What It Does |
|------|-----------|--------------|
| Dashboard | `pages/dashboard/index.tsx` | 8 KPIs, agent cards, system health, cost overview |
| Agent management | `pages/agents/` | List, create, detail (10 tabs), deploy, playground |
| Session tracking | `pages/sessions/index.tsx` | Real-time session list, turn-by-turn trace viewer |
| Canvas builder | `components/canvas/` | Visual agent composition (XY Flow nodes) |
| Intelligence | `pages/intelligence/index.tsx` | Quality scores, sentiment, trends |

## Harness Development Patterns

This project follows the **harness engineering** discipline described in the article
"The Harness is Everything." Key patterns enforced in this codebase:

### 1. Progressive Disclosure
- This file is the **map**, not the territory. Follow links to deeper docs.
- Memory context caps: working (10 items), episodic (3 episodes), semantic (5 facts).
- Search results are capped everywhere (web: 5, grep: 20, memory: 3-10).

### 2. Repository as System of Record
- `feature_list.json` — structured feature registry (the cognitive anchor). Read this first.
- `claude-progress.txt` — cross-session progress log. Update at end of every session.
- `docs/` — architecture plans, specs, gap analyses.
- Agent configs live in `agents/*.json`.

### 3. Mechanical Architecture Enforcement
- Graph linting: `control-plane/src/logic/graph-lint.ts` (background node placement, idempotency keys, async fan-in).
- Gate-pack: `control-plane/src/logic/gate-pack.ts` (eval pass-rate gates before promotion).
- Circuit breaker: `deploy/src/runtime/tools.ts` (prevents cascading tool failures).
- Loop detection: `deploy/src/runtime/middleware.ts` (progressive warnings -> hard halt).

### 4. Integrated Feedback Loops
- Lint on every graph edit (design-time, not post-hoc).
- Checkpoint + resume for human-in-the-loop approval.
- WebSocket streaming for real-time tool progress (5s heartbeats).
- Time-travel trace replay for debugging (`db.ts:replayOtelEventsAtCursor`).

### 5. Git Worktree Isolation
- Each agent session runs in an isolated Durable Object with its own SQLite.
- Sandbox code execution runs in isolated V8 isolates with scope-based ACLs.
- Workspaces are synced to R2 per-agent, per-org for persistence.

## Dev Environment Setup

Run `./init.sh` to bootstrap the development environment. It installs dependencies
for all three packages and verifies the setup.

## IDE assistant skills (Cursor + Claude Code)

Portable skills for editors live under `.cursor/skills/<skill-name>/SKILL.md` (YAML frontmatter with `name` and `description`). The same folders are mirrored under `.claude/skills/` for Claude Code. After editing skills under `.cursor/skills/`, run `./scripts/sync-ide-skills.sh` from the repo root to refresh `.claude/skills/`, or copy manually if you prefer.

## Coding Standards (TypeScript)

### Imports
- Use named imports; avoid `import *`.
- Group: node builtins, third-party, local (separated by blank lines).
- Prefer lazy `await import()` inside functions for heavy optional deps (codemode, sandbox).

### Type Safety
- Strict mode enabled (`tsconfig.json`).
- Use Zod schemas for API input validation (see `routes/agents.ts`).
- Define interfaces in `types.ts` files; export from `index.ts`.

### Testing
- **Control plane:** Vitest in `control-plane/test/` (174+ tests across 9 waves).
- **Portal:** Vitest in `portal/src/lib/` for utils.
- Test helpers: `test/helpers/test-env.ts` (mock env, R2, fetcher, JWT).
- Every route needs: happy-path, authz-negative, malformed-input, contract parity.

### Error Handling
- Graceful degradation: `try/catch` with `console.error`, never crash the worker.
- Best-effort for non-critical paths (telemetry, observability, workspace sync).
- Circuit breaker for external tool calls (5-failure threshold, 30s cooldown).

### Data Persistence
- Supabase (Postgres) via Hyperdrive for durable state.
- DO SQLite for fast local conversation cache (pruned to 100 messages).
- R2 for file storage (workspace snapshots, eval datasets).
- Vectorize for semantic search (768-dim, BGE model).

## Adding a New API Route

1. Create route handler in `control-plane/src/routes/my-route.ts`.
2. Add scope constants in `auth/types.ts`.
3. Wire into `index.ts` with `app.route("/api/v1/my-route", myRoute)`.
4. Guard with `requireScope("my-route:read")` or `requireScope("my-route:write")`.
5. Add tests in `control-plane/test/routes-my-route.test.ts`.

## Adding a New Runtime Tool

1. Add tool definition in `deploy/src/runtime/tools.ts` (`getToolDefinitions`).
2. Add handler in the tool execution switch.
3. Add cost entry in `TOOL_COSTS` if it has external API costs.
4. Reference by name in agent config: `"tools": ["my-tool"]`.

## Adding a New Portal Page

1. Create page in `portal/src/pages/my-page/index.tsx`.
2. Add lazy route in `App.tsx`.
3. Add sidebar entry in `components/layout/Sidebar.tsx`.
4. Use `useApiQuery` for data fetching, `QueryState` for loading/error states.
