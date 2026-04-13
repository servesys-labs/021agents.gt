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

---

## Update: Durable Object Facets (Agents Week 2026)

Cloudflare announced **DO Facets** during Agents Week (April 2026). This changes our architecture:

### What Facets Are

Facets allow a single Durable Object to contain **multiple isolated SQLite databases** — one per "facet" plus one for the supervisor. Each facet runs isolated code with its own database, managed by a parent supervisor DO.

```
AgentOSAgent (supervisor DO)
  ├── ctx.facets.get("memory")     → isolated SQLite for memory/RAG
  ├── ctx.facets.get("signals")    → isolated SQLite for signal state
  ├── ctx.facets.get("workspace")  → isolated SQLite for file state
  └── supervisor SQLite            → conversation, config, billing
```

API: `ctx.facets.get(name, callback)` retrieves or initializes a facet. Each facet gets its own `.fetch()` and RPC methods. Data isolation is strict — facet code cannot access other facets' databases.

### Impact on Our Architecture

**What changes:**
- The **Signals Worker** could become a **facet** of the Agent Core DO instead of a separate Worker. Signal clustering and rules would run inside the same DO with their own isolated database. This eliminates the service binding hop and the queue round-trip for signal ingestion.
- The **Memory Worker** operations that are per-agent (fact storage, episodic notes) could be facets. But Vectorize search (cross-agent) still needs a separate Worker or shared binding.
- **Dynamic Workers** (already used for code execution) now support exporting DO classes, meaning the Compute Worker's sandbox isolation can use facets + Dynamic Workers together.

**What stays the same:**
- **Channels Worker** stays separate — it's a different entry point (webhook receiver), not a facet of the agent.
- **Compute Worker** stays separate — containers are resource-intensive and need independent scaling.
- **Service bindings** remain the right pattern for cross-Worker communication.
- The overall composable topology is still correct.

### Revised Topology

```
                    ┌─────────────────────────────────┐
                    │           Gateway Worker          │
                    └──┬──────┬──────┬──────┬─────────┘
                       │      │      │      │
                 ┌─────▼──────▼──────▼──────▼─────────┐
                 │        Agent Core Worker             │
                 │                                      │
                 │  AgentOSAgent (supervisor DO)         │
                 │    ├── memory facet (per-agent RAG)   │
                 │    ├── signals facet (per-agent)      │
                 │    └── workspace facet (files)        │
                 │                                      │
                 │  AgentRunWorkflow (execution)         │
                 └──┬──────────┬───────────────────────┘
                    │          │
              ┌─────▼────┐ ┌──▼──────────┐
              │ Compute   │ │ Channels    │
              │ Worker    │ │ Worker      │
              │ (sandbox) │ │ (webhooks)  │
              └───────────┘ └─────────────┘
```

### Migration Path

1. Current: Service bindings between 4+ Workers (already scaffolded)
2. Next: Evaluate facets for memory + signals (per-agent state)
3. Keep: Compute + Channels as separate Workers (different scaling needs)

Facets are especially powerful for our use case because each agent session already has its own DO instance — facets give each session isolated databases for memory, signals, and workspace without cross-instance coordination.

---

## Update: What Think Eliminates (Post-Model-Agent Analysis)

Migrating from raw `Agent` to `Think` as the base class eliminates ~3,100 lines of hand-rolled code from the monolith. Here's the precise mapping:

### Eliminated by Think + SDK

| Monolith Component | Lines | Replaced By |
|---|---|---|
| Conversation persistence (INSERT/DELETE, hydration from Supabase) | ~300 | Think Session — auto-persists to DO SQLite |
| Streaming + KV polling (Workflow → KV → DO polls → WS push) | ~500 | `streamText().toUIMessageStreamResponse()` — direct WebSocket |
| Custom compaction (shouldCompact, compactMessages, pruneToolResults) | ~200 | `configureSession().compactAfter(threshold)` |
| Workspace persistence (checkpoint chain to R2) | ~400 | `@cloudflare/shell` Workspace (SQLite + R2 hybrid) |
| Memory context building (buildMemoryContext, 864 lines) | ~864 | Think context blocks: `withContext("memory", ...)` |
| Active workflow tracking (active_workflows SQLite, orphaned recovery) | ~200 | `keepAliveWhile()` + Think abort — no orphans |
| Custom WebSocket protocol (auth, reconnect, replay) | ~300 | Think `cf_agent_chat_*` protocol (standard) |
| Custom useAgentChat in mobile (SSE over fetch) | ~85 | `useAgentChat` from agents/react (WebSocket) |
| Circuit breaker SQLite table | ~100 | Think `beforeToolCall`/`afterToolCall` hooks |
| Hand-rolled MCP server | ~170 | `McpAgent` from agents/mcp |

**Total: ~3,100 lines eliminated.**

### What Stays (Think doesn't replace these)

| Component | Why It Stays |
|---|---|
| **Postgres (Hyperdrive)** | Multi-tenant platform metadata: agent configs, billing, orgs, API keys, tool registry, audit logs, eval data. Think's SQLite is per-DO — no cross-agent queries. |
| **Workflows** | Durable execution for >5 min runs (deep research, batch processing). Think uses keepAliveWhile for chat-length runs. |
| **Queues** | Async guaranteed-delivery: telemetry pipeline, signal fanout, billing records. Think has no queue primitive. |
| **R2** | Org-level file storage shared across agents. Think Workspace uses R2 for per-agent spillover only. |
| **Vectorize** | Cross-agent RAG, shared knowledge bases. Think context blocks are per-conversation only. |
| **KV** | Config cache, feature flags. Thin caching layer. |
| **AI Gateway** | Cross-tenant model routing, caching, rate limiting, cost tracking. Think calls one model per turn. |
| **Cron Triggers** | Platform-wide scheduled tasks (billing reconciliation, data retention). |
| **Containers/Sandboxes** | Full OS for coding agents. Think adds these as tools, doesn't replace them. |

### Data Ownership Shift

```
BEFORE (monolith — everything in Postgres):
  Postgres: conversations + sessions + agent config + billing +
            orgs + API keys + tool registry + audit + eval + memory

AFTER (Think — split by responsibility):
  Think DO SQLite:  conversations, workspace files, session state,
                    context blocks, scheduled tasks, MCP server state
                    (per-agent, per-instance — 100% of chat traffic)

  Postgres:         agent config, billing, orgs, API keys,
                    tool registry, audit logs, eval data
                    (platform metadata — admin/API traffic only)

  Vectorize:        cross-agent RAG, shared knowledge bases
  R2:               org-level file storage, eval datasets
  KV:               config cache, feature flags
```

**Postgres traffic drops ~40%** — all conversation read/write moves to DO SQLite.

---

## Control-Plane: Rethinking for the Think Era

The control-plane (`control-plane/`) is currently a 100+ route Hono API that does everything from auth to billing to observability. In the Think-based architecture, its role changes fundamentally.

### What the Control-Plane Does Today (70 route groups)

```
Platform CRUD (stays):           Agent CRUD, orgs, API keys, secrets, domains
Billing (stays):                 Credits, Stripe, usage metering, plans
Auth (stays):                    JWT, API keys, end-user tokens, MFA, session management
Governance (stays):              Policies, SLOs, compliance, guardrails, DLP, security scanning
Observability (stays):           Sessions, traces, audit logs, alerts, security events
Marketplace (stays):             Publish, discover, rate agents

Runtime Proxy (SHRINKS):         /runtime-proxy/* — streams agent runs via SSE
                                 Think eliminates this: clients connect directly to DO via WebSocket

Conversation Data (MOVES):       /sessions, /conversations — stored in Postgres
                                 Moves to DO SQLite: Think Session handles persistence

Memory/RAG API (SPLITS):         /memory, /rag — fact extraction, episodic recall
                                 Platform-wide search stays in control-plane (Vectorize)
                                 Per-agent memory moves to Think context blocks

Workspace API (MOVES):           /workspace — file CRUD via R2
                                 Moves to Think Workspace (@cloudflare/shell)

Config Push (SIMPLIFIES):        Agent config changes pushed to DO
                                 Think's configure() + getConfig() handle this natively
```

### New Control-Plane Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTROL-PLANE (Hono Worker)                   │
│                                                                   │
│  Role: Platform admin API — multi-tenant metadata, billing,      │
│  governance. Does NOT handle real-time chat or agent execution.  │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Auth & IAM   │  │ Billing &    │  │ Agent Registry         │  │
│  │ (JWT, keys,  │  │ Credits      │  │ (CRUD, config, deploy) │  │
│  │ MFA, tokens) │  │ (Stripe)     │  │                        │  │
│  └──────────────┘  └──────────────┘  └────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Governance   │  │ Observability│  │ Marketplace            │  │
│  │ (policies,   │  │ (traces,     │  │ (publish, discover,    │  │
│  │ guardrails)  │  │ audit, alerts│  │ rate, feature)         │  │
│  └──────────────┘  └──────────────┘  └────────────────────────┘  │
│                                                                   │
│  Bindings: Hyperdrive (Postgres), AI, R2, Vectorize, KV,        │
│            RUNTIME (service binding to Agent Core)                │
│            Queues (jobs, telemetry DLQ replay)                   │
│                                                                   │
│  Does NOT have: SANDBOX, BROWSER, LOADER, DO namespaces          │
│  (those belong to Agent Core / Compute workers)                  │
└────────────────────────┬────────────────────────────────────────┘
                         │ Service Binding: RUNTIME
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              AGENT CORE (Think-based Worker)                     │
│                                                                   │
│  ModelAgent DO (extends Think):                                  │
│  - Session persistence (DO SQLite)                               │
│  - WebSocket streaming (direct to client)                        │
│  - Workspace files (SQLite + R2)                                 │
│  - Context blocks (soul, memory, skills)                         │
│  - Sub-agents (specialists with isolated SQLite)                 │
│  - MCP client + server                                           │
│  - Code execution (CodeMode + Sandbox)                           │
│  - Browser tools                                                 │
│  - Voice (withVoice mixin)                                       │
│                                                                   │
│  Clients connect DIRECTLY to DO via WebSocket                    │
│  (no control-plane proxy needed for real-time)                   │
└─────────────────────────────────────────────────────────────────┘
```

### What Changes in Control-Plane

| Route Group | Current | Think Era | Action |
|---|---|---|---|
| `/runtime-proxy/*` | Proxy SSE streams to runtime worker | Clients connect directly to DO via WebSocket | **Remove** — largest route group, ~1500 lines |
| `/sessions`, `/conversations` | Read/write conversation data from Postgres | Think Session in DO SQLite; CP reads via service binding for admin views | **Simplify** — read-only admin view |
| `/memory`, `/rag` | Full memory API (search, extract, consolidate) | Per-agent memory in Think context blocks; cross-agent RAG stays | **Split** — per-agent → DO, cross-agent → CP |
| `/workspace` | File CRUD via R2 | Think Workspace handles per-agent files | **Remove** — CP doesn't need file API |
| `/agents` (config push) | Push config to DO via service binding + Supabase write | Think `configure()` called from CP via service binding | **Simplify** — one RPC call |
| `/eval` | Eval runs via Workflow | Stays — eval is a platform concern, not per-agent | **Keep** |
| `/billing`, `/credits`, `/stripe` | All billing logic | Stays — multi-tenant billing is platform | **Keep** |
| `/auth`, `/api-keys` | All auth | Stays — platform IAM | **Keep** |
| `/governance/*` | Policies, guardrails, compliance | Stays — platform governance | **Keep** |
| `/observability/*` | Traces, audit, alerts | Stays — cross-agent observability | **Keep** |
| `/marketplace` | Agent discovery | Stays — platform marketplace | **Keep** |

### Control-Plane After Migration

**Removed**: ~2,500 lines (runtime-proxy, workspace API, conversation write paths)
**Simplified**: ~500 lines (sessions → read-only, memory → cross-agent only, config → RPC)
**Kept**: ~5,000 lines (auth, billing, governance, observability, marketplace, eval)

The control-plane becomes a **pure platform administration API** — it never touches real-time chat traffic. All agent interaction goes directly from client → Agent Core DO via WebSocket.

### How Clients Connect (Before vs After)

**Before (SSE via control-plane proxy)**:
```
Browser → control-plane → runtime-proxy → DO → Workflow → KV → DO → WS → Browser
         (auth, billing)   (proxy SSE)    (create)  (poll)  (push)
         7 hops, 200-800ms latency per event
```

**After (WebSocket direct to DO)**:
```
Browser → Agent Core DO (WebSocket)
          Think handles: auth (onBeforeConnect), streaming, persistence
          1 hop, <10ms latency per event

Control-plane called separately for:
  - Auth token issuance (login)
  - Billing metering (async, post-turn)
  - Config changes (admin action)
```

### Billing in the Think Era

Currently the control-plane intercepts SSE streams to meter usage. With direct WebSocket, billing works differently:

```typescript
// In ModelAgent (extends Think)
onChatResponse(result: ChatResponseResult) {
  if (result.status === "completed") {
    // Async billing: enqueue to telemetry pipeline
    this.env.TELEMETRY_QUEUE.send({
      type: "billing",
      payload: {
        org_id: this.getConfig()?.orgId,
        agent_name: this.name,
        tokens_in: result.usage?.promptTokens || 0,
        tokens_out: result.usage?.completionTokens || 0,
        model: this.getConfig()?.modelTier || "fast",
        ts: Date.now(),
      },
    });
  }
}
```

Queue → Control-plane consumer → Postgres. Billing is **async and non-blocking** — never in the critical chat path.

### hono-agents Middleware

The control-plane uses Hono. For routes that need to talk to agents, use `hono-agents` middleware:

```typescript
import { agentsMiddleware } from "hono-agents";

// In control-plane routes that need agent access
app.use("/api/v1/agents/:name/configure", agentsMiddleware());

// The middleware handles WebSocket upgrades + HTTP routing
// to DOs via the RUNTIME service binding
```

This replaces the current hand-rolled runtime-proxy routes with a single middleware line.

### Rethinking Control-Plane with CF-Native Primitives

The current control-plane is a traditional API server (Hono + Postgres via Hyperdrive). But Cloudflare has primitives that can replace most of what Postgres does:

**Replace Postgres with D1 + KV + DO SQLite:**

| Current (Postgres) | CF-Native Replacement | Why Better |
|---|---|---|
| `agents` table (config, status, org_id) | **D1** — CF's serverless SQLite at the edge | No Hyperdrive latency, no connection pooling, no external DB to manage. D1 supports joins, indexes, triggers — everything agents table needs. |
| `api_keys` table (hash, scopes, rate limits) | **D1** for storage + **KV** for fast lookup cache | KV gives <1ms reads for auth hot path. D1 for the source of truth. |
| `credit_transactions`, `org_credit_balance` | **D1** for ledger + **DO** for real-time balance | DO per-org for atomic balance updates (no transaction isolation issues). D1 for audit trail. |
| `sessions`, `runs` (observability data) | **D1** for query + **Analytics Engine** for metrics | Analytics Engine for high-volume writes (tool calls, tokens). D1 for structured queries (list sessions for org). |
| `tool_registry` | **KV** (JSON per tool, fast reads) | Tools are read-heavy, write-rare. KV is perfect. |
| `connector_tokens` (encrypted) | **KV** with encryption | Secrets stored encrypted in KV, decrypted in Worker. |
| `audit_log` | **Analytics Engine** | Append-only, high-volume, queryable via SQL API. |
| `eval_runs`, `eval_trials` | **D1** | Structured query needs (filter by status, model, date). |
| `marketplace_agents` | **D1** + **Vectorize** for search | D1 for catalog, Vectorize for semantic discovery. |

**The result: no external database at all.** Everything runs on CF primitives:

```
CURRENT:
  Control-plane Worker → Hyperdrive → Railway Postgres (external)
  Latency: 50-200ms per query (connection setup + query + network)

PROPOSED:
  Control-plane Worker → D1 (edge SQLite, <5ms)
                       → KV (edge cache, <1ms reads)
                       → DO (per-org atomic state)
                       → Analytics Engine (high-volume events)
  Latency: 1-10ms per operation
```

**D1 handles everything Postgres does** for the control-plane:
- Relational queries with JOIN (agent + org + billing)
- Indexes, triggers, views
- 10GB per database (free tier: 5M reads/day)
- Automatic replication across CF network
- No connection pooling, no Hyperdrive needed, no external dependency

**When you'd still keep Postgres**: If you need cross-region strong consistency, very large datasets (>10GB), or complex stored procedures. For a prototype with <1000 tenants, D1 is more than sufficient.

### CF-Native Control-Plane Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              CONTROL-PLANE (Hono + hono-agents)                  │
│                                                                   │
│  Auth:        D1 (api_keys, users) + KV (session cache)         │
│  Billing:     BillingDO per-org (atomic balance) + D1 (ledger)  │
│  Agents:      D1 (config CRUD) + KV (fast config cache)         │
│  Tools:       KV (tool registry, read-heavy)                     │
│  Eval:        D1 (runs, trials — structured queries)             │
│  Audit:       Analytics Engine (append-only, high-volume)        │
│  Marketplace: D1 (catalog) + Vectorize (semantic search)         │
│  Governance:  D1 (policies, SLOs) + KV (policy cache)           │
│  Observability: Analytics Engine (metrics) + D1 (session list)   │
│                                                                   │
│  NO Postgres. NO Hyperdrive. 100% CF-native.                    │
│                                                                   │
│  Bindings: D1, KV, Analytics Engine, Vectorize, AI,             │
│            RUNTIME (service binding to Agent Core),              │
│            Queue (billing events from Agent Core)                │
└─────────────────────────────────────────────────────────────────┘
```

### BillingDO — Per-Org Atomic Balance

The trickiest part of billing is atomic credit balance updates. Postgres uses transactions. With CF primitives, use a Durable Object per org:

```typescript
export class BillingDO extends DurableObject<Env> {
  async initialize() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS balance (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO balance (id, balance_usd) VALUES (1, 0);
    `);
  }

  async deduct(amount: number, description: string): Promise<{ ok: boolean; balance: number }> {
    const [row] = this.ctx.storage.sql.exec("SELECT balance_usd FROM balance WHERE id = 1").toArray() as any[];
    const current = Number(row?.balance_usd || 0);
    if (current < amount) return { ok: false, balance: current };

    // Atomic: single DO, single thread, no races
    const newBalance = current - amount;
    this.ctx.storage.sql.exec("UPDATE balance SET balance_usd = ? WHERE id = 1", newBalance);
    this.ctx.storage.sql.exec(
      "INSERT INTO transactions (type, amount_usd, description) VALUES ('burn', ?, ?)",
      -amount, description,
    );
    return { ok: true, balance: newBalance };
  }

  async topUp(amount: number, description: string): Promise<{ balance: number }> {
    this.ctx.storage.sql.exec("UPDATE balance SET balance_usd = balance_usd + ? WHERE id = 1", amount);
    this.ctx.storage.sql.exec(
      "INSERT INTO transactions (type, amount_usd, description) VALUES ('topup', ?, ?)",
      amount, description,
    );
    const [row] = this.ctx.storage.sql.exec("SELECT balance_usd FROM balance WHERE id = 1").toArray() as any[];
    return { balance: Number(row?.balance_usd || 0) };
  }

  async getBalance(): Promise<number> {
    const [row] = this.ctx.storage.sql.exec("SELECT balance_usd FROM balance WHERE id = 1").toArray() as any[];
    return Number(row?.balance_usd || 0);
  }
}
```

Agent Core calls this after each turn:
```typescript
// In Think agent's onChatResponse:
const billingDO = this.env.BILLING.get(this.env.BILLING.idFromName(orgId));
await billingDO.deduct(costUsd, `Agent ${this.name} turn`);
```

### Migration: Postgres → D1

D1 supports the same SQL as Postgres for the queries we run. Migration path:
1. Export Postgres tables as SQL
2. Import into D1 via `wrangler d1 execute`
3. Update control-plane queries (minimal changes — both are SQL)
4. Remove Hyperdrive config
5. Remove Railway/Supabase dependency

**For the prototype with no users, this is the right time to do it.**
