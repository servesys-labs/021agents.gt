# Composable Architecture Proposal

**Date**: 2026-04-13
**Context**: The `deploy/` worker is 39,500 lines across 75 files, with 24 bindings, 5 DO classes, 1 Workflow, 2 Queue consumers, and webhook handlers for 6 chat platforms — all in one Worker deployment unit.

---

## The Problem

Every change — a Telegram webhook fix, a memory algorithm tweak, a voice relay optimization — redeploys the **entire runtime**. The bundle is growing toward the 10 MiB paid-plan limit. And the blast radius of any bug is everything.

## The Principle: Composable, Not Microservices

Cloudflare's platform is designed for **composable Workers** connected via **Service Bindings** (zero-latency, same-thread RPC). This is fundamentally different from traditional microservices:

- No network hop between Workers (service bindings are in-process)
- No serialization overhead for RPC calls
- No service mesh, no load balancers, no DNS
- Each Worker deploys independently but composes at runtime

The goal: **each building block is a single-concern Worker** that can be developed, tested, and deployed independently, but they compose into a unified agent runtime via service bindings.

---

## Current Monolith: Dependency Map

```
deploy/src/index.ts (8,336 lines)
  ├── AgentOSAgent (DO)      — conversation state, WebSocket, email, voice, 12 @callable methods
  ├── AgentSandbox (DO)      — container lifecycle
  ├── AgentOSMcpServer (DO)  — MCP protocol
  ├── SessionCounterDO       — atomic counters
  ├── SignalCoordinatorDO     — signal clustering
  └── default export         — fetch (webhooks, API), queue consumer, cron, email router

deploy/src/workflow.ts (3,172 lines)
  └── AgentRunWorkflow       — durable agent execution loop

deploy/src/runtime/ (28,000 lines across 73 modules)
  ├── tools.ts (8,369)       — 100+ tool implementations
  ├── db.ts (2,446)          — Supabase/Hyperdrive queries
  ├── memory.ts + rag-*.ts   — episodic memory, RAG, embeddings
  ├── codemode.ts            — V8 isolate code execution
  ├── voice-relay.ts         — Twilio WebSocket relay
  ├── signals.ts             — signal derivation + coordination
  ├── channel-router.ts      — multi-channel dispatch
  └── ... 65 more modules
```

---

## Proposed Composable Architecture

```
                              ┌─────────────────────────┐
                              │     UI / CLI / SDK       │
                              └───────────┬─────────────┘
                                          │
                    ┌─────────────────────────────────────────┐
                    │           Gateway Worker                 │
                    │  (auth, routing, rate-limit, webhooks)   │
                    └──┬──────┬──────┬──────┬──────┬─────────┘
                       │      │      │      │      │
          ┌────────────┤      │      │      │      ├────────────┐
          │            │      │      │      │      │            │
    ┌─────▼─────┐ ┌───▼───┐ ┌▼──────▼┐ ┌──▼───┐ ┌▼────────┐ ┌▼──────────┐
    │  Agent    │ │Memory │ │Compute │ │Voice │ │Channels │ │ Signals   │
    │  Core     │ │Worker │ │Worker  │ │Worker│ │ Worker  │ │ Worker    │
    └─────┬─────┘ └───┬───┘ └───┬────┘ └──┬───┘ └────┬────┘ └─────┬────┘
          │           │         │          │          │            │
    ┌─────▼─────────────────────▼──────────▼──────────▼────────────▼─────┐
    │                    Shared Platform Layer                            │
    │  Hyperdrive (Postgres)  ·  R2  ·  KV  ·  Queues  ·  Vectorize    │
    └────────────────────────────────────────────────────────────────────┘
```

### Block 1: Agent Core (`agent-core`)

**What it owns**: The agent Durable Object, Workflow execution engine, and the `@callable()` RPC surface.

```
Files:
  src/index.ts          — AgentOSAgent DO, AgentRunWorkflow
  src/runtime/db.ts     — conversation persistence
  src/runtime/llm.ts    — LLM call orchestration
  src/runtime/router.ts — model selection
  src/runtime/tools.ts  — tool execution (calls Compute Worker for sandbox)
  src/runtime/mailbox.ts, idempotency.ts, abort.ts, errors.ts, compact.ts

Bindings:
  AGENT_RUN_WORKFLOW    — durable execution
  AGENT_PROGRESS_KV     — real-time progress
  HYPERDRIVE            — conversation state, agent config
  AI                    — LLM inference
  COMPUTE (service)     — delegate sandbox/code execution
  MEMORY (service)      — delegate RAG/embeddings
  SIGNALS (service)     — delegate signal ingestion

DOs: AgentOSAgent, SessionCounterDO
```

**Why this is one block**: The agent DO, the Workflow that runs its turns, and the LLM routing are tightly coupled — they share conversation state, cost tracking, and the turn loop. Splitting them would create a distributed transaction problem for no benefit.

### Block 2: Memory Worker (`agent-memory`)

**What it owns**: All RAG, embeddings, episodic memory, memory consolidation, and knowledge search.

```
Files:
  src/runtime/memory.ts
  src/runtime/memory-manager.ts
  src/runtime/memory-provider.ts
  src/runtime/memory-consolidation.ts
  src/runtime/memory-digest.ts
  src/runtime/team-memory.ts
  src/runtime/curated-memory.ts
  src/runtime/rag-hybrid.ts
  src/runtime/rag-transforms.ts
  src/runtime/rag-rerank.ts
  src/runtime/rag-eval.ts
  src/runtime/embeddings.ts
  src/runtime/query-profile.ts

Bindings:
  VECTORIZE             — embedding search
  HYPERDRIVE            — fact/episode storage
  AI                    — embedding generation
  R2 (STORAGE)          — document storage

RPC interface (service binding):
  searchFacts(query, orgId, agentName, opts) → Fact[]
  searchEpisodes(query, orgId, agentName, opts) → Episode[]
  buildMemoryContext(orgId, agentName, input, history) → string
  queueFactExtraction(session, messages) → void
  queueSessionEpisodicNote(session, summary) → void
  consolidateMemory(orgId, agentName) → void
```

**Why separate**: Memory is the heaviest subsystem by binding count (Vectorize + AI + Hyperdrive + R2) and the most independently evolvable. New embedding models, reranker algorithms, and consolidation strategies change frequently. Zero coupling to conversation state or WebSocket handling.

### Block 3: Compute Worker (`agent-compute`)

**What it owns**: Sandbox container management, code execution, browser rendering, and the Dynamic Workers (V8 isolate) pool.

```
Files:
  src/index.ts (AgentSandbox class only)
  src/runtime/codemode.ts
  src/runtime/harness-modules.ts

Bindings:
  SANDBOX               — container DO
  LOADER                — Dynamic Workers
  BROWSER               — headless Puppeteer
  STORAGE (R2)          — file read/write for sandbox

DOs: AgentSandbox

RPC interface:
  execInSandbox(sandboxId, command, opts) → { stdout, stderr, exitCode }
  writeFile(sandboxId, path, content) → void
  readFile(sandboxId, path) → string
  execCode(code, scope, typeDefinitions) → CodemodeResult
  renderBrowser(url, opts) → { screenshot?, content? }
```

**Why separate**: Containers are the most resource-intensive binding (1/4 vCPU, 1 GiB RAM each). Container lifecycle (boot, warm pool, eviction) is completely independent of agent logic. Browser rendering sessions have their own pool management. Isolating compute also contains the blast radius of OOM kills and container crashes.

### Block 4: Channels Worker (`agent-channels`)

**What it owns**: All inbound webhook handlers for chat platforms, plus the outbound message formatting per platform.

```
Files:
  Telegram webhook handler    (~500 lines, currently in index.ts)
  WhatsApp webhook handler    (~400 lines)
  Slack webhook handler       (~300 lines)
  Instagram webhook handler   (~200 lines)
  Facebook Messenger handler  (~200 lines)
  src/runtime/channel-router.ts
  src/runtime/channel-prompts.ts
  src/runtime/fast-agent.ts

Bindings:
  TELEGRAM_BOT_TOKEN, SLACK_SIGNING_SECRET, WHATSAPP_*, INSTAGRAM_*, FACEBOOK_*
  AGENT_CORE (service)  — delegate to agent for execution
  SIGNAL_QUEUE          — emit ingest signals

RPC interface:
  (none — this Worker is an HTTP entry point, not called by others)
```

**Why separate**: Platform webhook secrets, verification logic, and message formatting are entirely platform-specific. Each platform has its own rate limits, retry semantics, and API quirks. A WhatsApp API change should never risk breaking the agent runtime. This is also the easiest block to extract — **~2,000 lines that leave the monolith with zero functional loss**.

### Block 5: Signals Worker (`agent-signals`)

**What it owns**: Signal ingestion, clustering, rule evaluation, and the coordinator DO.

```
Files:
  src/runtime/signals.ts
  src/runtime/signal-coordinator-do.ts
  src/runtime/signal-rules-memory.ts
  src/runtime/signal-rule-packs.ts

Bindings:
  SIGNAL_QUEUE (consumer)
  SIGNAL_ANALYTICS       — Analytics Engine writes
  HYPERDRIVE             — signal metadata persistence
  AGENT_RUN_WORKFLOW     — fire remediation workflows

DOs: SignalCoordinatorDO

RPC interface:
  ingestSignal(envelope) → { stored, scheduled }
  getSnapshot(orgId, agentName, feature) → SignalCoordinatorSnapshot
```

**Why separate**: Signals are completely orthogonal to agent execution. They consume from a Queue (async, no latency path), cluster events in their own DO, and fire remediation workflows. Zero coupling to conversation state. **Cleanest seam in the entire codebase.**

### Block 6: Voice Worker (`agent-voice`)

**Already exists**: `voice-agent/` is already a separate Worker. The remaining coupling is the voice relay WebSocket handler in `deploy/src/index.ts` and `deploy/src/runtime/voice-relay.ts`.

```
Move to voice-agent/:
  src/runtime/voice-relay.ts (~350 lines)
  Voice relay WebSocket handler from index.ts (~200 lines)

RPC interface:
  (handled via WebSocket upgrade, not service binding)
```

### Block 7: Gateway Worker (`agent-gateway`)

**What it owns**: Auth, routing, rate limiting — the thin entry point that routes to everything else. This is what the current `default export` fetch handler becomes after extracting channels, voice, and signals.

```
Remaining in gateway after extraction:
  Auth verification (JWT, service token, API key)
  Route dispatch to service bindings
  Health/status endpoints
  Cron handler (billing DLQ replay, browser pool prune)
  Email routing (already thin — lookup agent, forward to DO)

Bindings:
  AGENT_CORE (service)
  CHANNELS (service)
  COMPUTE (service)
  MEMORY (service)
  SIGNALS (service)
  VOICE (service)
```

---

## Extraction Order (Least Risk → Most Risk)

Each step is independently deployable. You can stop at any point and have a working system.

```
Phase 1: Channels Worker         ~2,000 lines extracted
         (webhook handlers are stateless, zero coupling)

Phase 2: Signals Worker          ~700 lines extracted
         (queue consumer + coordinator DO, orthogonal)

Phase 3: Voice Relay → voice-agent/  ~550 lines extracted
         (already mostly separate)

Phase 4: Compute Worker          ~1,500 lines extracted
         (sandbox + codemode + browser, resource isolation)

Phase 5: Memory Worker           ~3,000 lines extracted
         (RAG + embeddings, heaviest binding set)

Phase 6: Gateway extraction      ~1,000 lines remains as thin router
         (what's left of the fetch handler after Phase 1-5)
```

**After all phases**: Agent Core is ~8,000 lines (DO + Workflow + tools + LLM) which is the irreducible core. Everything else is behind service bindings.

---

## Service Binding Topology

```jsonc
// agent-gateway/wrangler.jsonc
"services": [
  { "binding": "AGENT_CORE",  "service": "agent-core" },
  { "binding": "CHANNELS",    "service": "agent-channels" },
  { "binding": "COMPUTE",     "service": "agent-compute" },
  { "binding": "MEMORY",      "service": "agent-memory" },
  { "binding": "SIGNALS",     "service": "agent-signals" },
  { "binding": "VOICE",       "service": "agent-voice" }
]

// agent-core/wrangler.jsonc
"services": [
  { "binding": "COMPUTE",  "service": "agent-compute" },
  { "binding": "MEMORY",   "service": "agent-memory" },
  { "binding": "SIGNALS",  "service": "agent-signals" }
]
```

Zero-latency calls. No network hop. Same thread when co-located.

---

## Constraint Awareness

| Constraint | How We Handle It |
|---|---|
| **DO class must be defined in one Worker** | Each DO lives in its owning block (AgentOSAgent in Core, AgentSandbox in Compute, SignalCoordinatorDO in Signals). Other blocks access via `script_name` in bindings. |
| **32 subrequest limit per request** | Gateway → Core → (Compute + Memory) is only 3 hops. Webhook → Channels → Core → Compute is 4. Well within budget. |
| **Single queue consumer** | Each queue has exactly one consumer: Signals Worker consumes SIGNAL_QUEUE, Core consumes TELEMETRY_QUEUE. |
| **10 MiB bundle limit** | After extraction, each block is 1-3 MiB. The monolith's 8+ MiB problem disappears. |
| **Workflow binding locality** | AgentRunWorkflow stays in Core (same Worker as the DO that creates it). |

---

## Is This Right for Future Growth?

**Yes, for these specific reasons:**

1. **Independent deploy cycles**: A Telegram API change deploys Channels only. A new embedding model deploys Memory only. A container config change deploys Compute only. The agent core — the hardest thing to test — changes least often.

2. **Independent scaling**: Voice and Compute are the bottleneck resources (containers, WebRTC). Isolating them means their resource limits don't starve the agent core.

3. **Independent observability**: Each Worker has its own tail logs, error rates, and latency metrics. "Memory is slow" is immediately visible, not buried in a monolith's aggregate metrics.

4. **Team boundaries**: Different people can own different blocks. The Memory team doesn't need to understand webhook verification. The Channels team doesn't need to understand the turn loop.

5. **Reusability**: The Memory Worker can be called by other products. The Compute Worker can serve a standalone code playground. The Signals Worker can process events from any source, not just agents.

**But not for these reasons:**

- Don't split for "microservices purity" — Cloudflare's composable model is opinionated and different from AWS/GCP patterns
- Don't split the Agent Core further — the DO + Workflow + LLM loop is a single transaction boundary, splitting it creates distributed consistency problems
- Don't split prematurely — extract the easy seams (Channels, Signals) first, prove the service binding pattern works, then proceed
