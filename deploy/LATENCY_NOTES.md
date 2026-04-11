# Agent Startup Latency — Root Cause & Fixes

Captured during the April 2026 review session. The user-visible symptom was a
~20-second gap between submitting a question and the UI showing any agent
activity — not first token out, but the earliest sign of reasoning or tool
use.

This note exists so the context behind the fixes isn't lost once the session
ends. It can be deleted or moved wherever the team keeps operational docs.

## Root Causes

Tracing `workflow.ts` from `run()` entry to the first LLM turn surfaced five
stacked contributors, ordered by impact:

1. **UI blind until `step.do("bootstrap")` returned.** Nothing was emitted to
   KV before the bootstrap step finished. The WS poller (250 ms interval)
   therefore had no events to render for 1-4 seconds while bootstrap ran.
   Bootstrap itself was cheap (config load, feature flag probes, reasoning
   strategy selection) but the `step.do` checkpoint overhead alone added
   300-1000 ms of framework cost.

2. **`hydrate-workspace` was a separate blocking `step.do` between bootstrap
   and `turn_start`.** It was triggered whenever the *agent config* contained
   any sandbox tool (`bash`, `read-file`, etc.), regardless of whether the
   current query would actually use those tools. Cold sandbox container boot
   is 5-10 seconds.

3. **`hydrateWorkspace` downloaded files serially.** The old
   `for (entry of manifest.files)` loop awaited an R2 `get` plus a
   `sandbox.writeFile` RPC per file, plus one `mkdir -p` shell call per
   directory. Ten files ≈ 2-5 seconds on top of container boot.

4. **Three serialized `step.do` checkpoints before the first LLM call** —
   `bootstrap` → `hydrate-workspace` → `llm-1`. Each paid ~300-1000 ms of
   CF Workflows checkpoint overhead regardless of the work inside.

5. **KV eventual consistency plus the 250 ms WS poll interval** added
   another ~500 ms-1.5 s on top of every `emit()` before the browser actually
   rendered the event.

Worst-case on a cold run: ~5-18 seconds stacked, hitting 20 s in the wild
when the sandbox was truly cold.

## Fixes Applied

All fixes live in commits `22a6df05`, `a9a20708`, `25f1e1e8` on `main`.

### 1. Emit `session_start` immediately at workflow entry (`workflow.ts`)
Before any awaited work. The WS poller now sees an event inside the first
250 ms poll tick instead of waiting for bootstrap to complete. A second
`logger.info("session_start", …)` event still fires later with the richer
fields (channel, config_version, config_migrated) that aren't known yet at
the top of `run()`.

### 2. Inline `bootstrap` (remove the `step.do` wrapper)
All the work inside is idempotent and already handles its own failures:

- `loadAgentConfig` has a DB fallback to minimal restricted defaults.
- `isEnabled` feature-flag checks default to `DEFAULTS` on KV failure.
- `shouldCoordinate` + `loadAgentList` are wrapped in `try/catch`.

Losing step-level retry costs nothing because every sub-call is resilient.
On workflow resume the body re-runs — cheap, idempotent, correct. Saves
the 300-1000 ms per-step checkpoint overhead.

### 3. Hydrate-workspace as a background barrier
`hydrate-workspace` no longer blocks `turn_start`. It's kicked off as a
fire-and-forget `hydrationBarrier: Promise<void>` right after config load,
then awaited lazily inside the tool-execution step via
`awaitHydrationIfNeeded(tc.name)` — and only if the tool being executed is
actually a sandbox-using tool.

Common patterns and how they behave now:

- **Chat / research ("LLM plans, then calls `web-search`")** — hydration
  finishes entirely in the background and nothing ever waits on it.
- **Coding ("LLM plans, then calls `bash` or `read-file`")** — hydration
  overlaps the first LLM turn (typically 2-5 s of think time), so by the
  time the sandbox tool fires the container is already warm.
- **Workflow resume** — the in-memory barrier is lost on resume, a new one
  is created, hydration re-runs. Idempotent, cheap.

Hydration failure is log-and-continue: a file-using tool that lands after
a failed hydrate will simply find the file missing and surface its own
error, instead of torching the whole run.

An `hydrate_barrier_wait` log event fires (only when the actual wait
exceeds 50 ms) so we can measure how often tools actually block on this.

### 4. Parallelize `hydrateWorkspace` internals (`workspace.ts`)
Two changes inside the hydration function itself:

- **One batched `mkdir -p`**: every directory in the manifest is collected
  into a single shell call up front instead of N per-file calls.
- **Bounded-parallel worker pool** (8 at a time) for the R2 get + writeFile
  pipeline, with per-file error isolation so a single missing R2 object
  can't poison the rest of the batch.

Combined with the barrier change above, file-using tools that *do* wait on
the barrier now wait on seconds instead of tens of seconds.

## Expected Impact

| Contributor | Before | After |
|---|---|---|
| UI blind window before first emit | 1-4 s | ~50 ms (immediate `session_start`) |
| Bootstrap `step.do` overhead | 0.5-1.5 s | 0 ms (inlined) |
| Hydrate-workspace blocking `turn_start` | 2-10 s | 0 ms on critical path (background) |
| Sequential file hydration (when awaited) | 2-5 s | 0.5-1 s (parallel worker pool) |
| `llm-1` `step.do` overhead | 0.5-1 s | unchanged |
| KV lag + WS poll | 0.5-1.5 s | unchanged |

Rough critical-path total: **~5-18 s → ~1-4 s** on a cold run, and **~1-2 s**
once any warm isolate or sandbox is in play. The UI shows activity within
the first poll tick for every run.

## Not Changed (Next Levers)

These are on the table if further reduction is wanted. They weren't done in
this pass because each one was either (a) a large structural change, or
(b) entangled with work the DB migration agents are doing on `db.ts`.

- **LLM token streaming via `emit()`.** Currently `step.do("llm-1")` returns
  only after the full turn completes; users see nothing until then. Biggest
  remaining UX win, but requires reworking `callLLM` to yield chunks and
  plumbing a streaming emit path. Wait for a quiet tree.

- **Pre-warm the `llm` / `tools` module imports at workflow entry.** First
  turn pays a 100-300 ms dynamic-import cost inside `step.do("llm-1")`.
  Kicking off the `memo()` loads at the top of `run()` would hide that cost
  behind hydration.

- **`run_phase_timing` observability event.** Emit a structured log at the
  end of setup capturing setup_ms / hydrate_ms / pre_llm_ms / llm1_ms so
  the production effect of these fixes can actually be measured instead of
  estimated.

- **`deploy/src/runtime/db.ts` `_currentOrgId` cross-tenant concern.** The
  same class of bug that was fixed in `logger.ts`. The DB migration agents
  are already rewriting `db.ts` with `withOrgDb` / `withAdminDb` per-request
  patterns, which eliminates the shared mutable state entirely. Don't
  pre-solve — review after the migration lands.

## Regression Coverage

Locked in by `deploy/test/budget-repair-integration.test.ts` (6 cases) and
`deploy/test/logger-isolation.test.ts` (6 cases). Both were added in commit
`25f1e1e8` and cover the two critical-severity bugs found alongside the
latency work: content-budget tool-pair orphaning and logger cross-tenant
context leakage.
