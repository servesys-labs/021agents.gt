# Gateway Spec — Lighter Control-Plane (No Feature Cuts)

**Goal**: Rebuild the 60K-line, 595-endpoint control-plane as a lighter CF-native gateway. Same features, less code, faster responses.

**Approach**: Categorize every route group into one of 5 implementation patterns. Each pattern uses a different CF primitive for the hot path, with Postgres as the source of truth.

---

## 5 Implementation Patterns

### Pattern A: KV-Cached Postgres
**For**: Read-heavy, write-rare data. KV serves reads at <1ms. Writes go to Postgres + invalidate KV.
```
Read:  KV.get(key) → hit? return : Postgres → KV.put(key, data, {ttl}) → return
Write: Postgres.update() → KV.delete(key)
```

### Pattern B: DO State + Postgres Ledger
**For**: Atomic counters, real-time state. DO handles atomicity. Postgres stores the audit trail.
```
Read:  DO.getBalance() → return (instant, no Postgres)
Write: DO.deduct() → Queue.send(event) → Postgres.insert(transaction)
```

### Pattern C: Analytics Engine + Postgres Archive
**For**: High-volume append-only data. AE handles writes. Postgres stores archive for complex queries.
```
Write: AnalyticsEngine.writeDataPoint() (instant, no Postgres)
Read:  AE SQL API for recent data, Postgres for historical
```

### Pattern D: Agent DO RPC (via service binding)
**For**: Per-agent state that now lives in Think DO SQLite. Gateway calls DO via RPC.
```
Read:  env.RUNTIME.fetch("/internal/agent/{name}/state") → DO responds from SQLite
Write: env.RUNTIME.fetch("/internal/agent/{name}/configure", body) → DO updates
```

### Pattern E: Postgres Direct (complex relational)
**For**: Multi-table JOINs, admin dashboards, reports. No CF primitive replaces this.
```
Read:  Hyperdrive → Postgres → return
Write: Hyperdrive → Postgres → optional KV invalidation
```

---

## Complete Endpoint Mapping (595 endpoints)

### Auth & Identity (33 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/auth` | 5 | **A** (KV session cache) + **E** (user CRUD) | Login → Postgres verify → KV session token (TTL 7d). Logout → KV.delete. Profile reads → KV cache. User create/update → Postgres. |
| `/api/v1/api-keys` | 4 | **A** (KV key lookup) + **E** (key CRUD) | Key validation → KV `apikey:{hash}` (TTL 5min). Key create/revoke → Postgres + KV.delete. |
| `/api/v1/end-user-tokens` | 4 | **A** (KV token cache) | Same pattern as API keys — KV for validation, Postgres for CRUD. |
| `/api/v1/features` | 11 | **A** (KV only, TTL 30s) | Feature flags rarely change. KV is the primary store, Postgres backup. |
| `/api/v1/secrets` | 4 | **A** (KV encrypted) | `secret:{org}:{name}` → encrypted value in KV. Postgres for audit of who set it. |
| `/api/v1/secrets-rotation` | 2 | **E** | Rotation logic needs transaction safety → Postgres. |
| `/api/v1/security-events` | 3 | **C** (AE writes) + **E** (reads) | Event ingestion → AE. Admin queries → Postgres. |

### Agent Lifecycle (46 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/agents` | 23 | **A** (config cache) + **E** (CRUD) + **D** (live state) | List/get agent → KV `agent:{org}:{name}` (TTL 60s). Create/update → Postgres + KV.delete. Live status → DO RPC via service binding. |
| `/api/v1/skills` | 4 | **A** (KV cache) | Skills are read-heavy. KV `skills:{org}` with TTL. |
| `/api/v1/skills-admin` | 4 | **E** | Admin CRUD → Postgres. |
| `/api/v1/tools` | 13 | **A** (KV cache) | `tools:{org}` → tool registry in KV (TTL 5min). |
| `/api/v1/config` | 3 | **A** (KV) + **D** (push to DO) | Read → KV. Update → Postgres + KV.delete + DO.configure() via RPC. |

### Execution & Runtime (57 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/runtime-proxy` | 9 | **DELETE** → **D** | Clients connect directly to Agent DO. Admin queries via service binding. **Biggest win: 1,132 lines removed.** |
| `/api/v1/codemode` | 8 | **DELETE** → **D** | Agent DO handles code execution via CodeMode. |
| `/api/v1/sandbox` | 0 (proxy) | **DELETE** → **D** | Agent DO handles sandbox tools. |
| `/api/v1/schedules` | 7 | **DELETE** → **D** | Agent DO `scheduleEvery()` / `getSchedules()` / `cancelSchedule()` via @callable. |
| `/api/v1/mcp` | 5 | **DELETE** → **D** | Agent DO `addMcpServer()` / `removeMcpServer()` via @callable. |
| `/api/v1/workflows` | 9 | **E** + **D** | List workflows → Postgres. Create/status → DO RPC (Workflow binding in Agent Core). |
| `/api/v1/jobs` | 8 | **E** | Queue + Postgres. Job dispatch stays server-side. |
| `/api/v1/autopilot` | 6 | **D** + **E** | Active sessions → DO state. History → Postgres. |
| `/api/v1/gpu` | 2 | **E** | Rare admin endpoint. Postgres direct. |
| `/api/v1/deploy` | 3 | **E** | Deployment management. Postgres direct. |

### Billing & Credits (18 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/credits` | 5 | **B** (BillingDO balance) + **E** (ledger) | Get balance → BillingDO.getBalance() (instant). Deduct → BillingDO.deduct() → Queue → Postgres ledger. Top-up → BillingDO.topUp() + Postgres. |
| `/api/v1/billing` | 5 | **E** | Invoice history, plan details → Postgres. |
| `/api/v1/stripe` | 3 | **E** | Webhook processing → Postgres + BillingDO.topUp(). |
| `/api/v1/plans` | 1 | **A** (KV, write-rare) | Plan catalog in KV. TTL 1hr. |
| `/api/v1/referrals` | 4 | **E** | Referral tracking → Postgres. |

### Observability & Analytics (91 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/observability` | 35 | **C** (AE for metrics) + **E** (Postgres for session details) | Dashboards/aggregations → AE SQL API. Individual session details → Postgres. |
| `/api/v1/ops` | 9 | **C** + **E** | Same split: metrics in AE, details in Postgres. |
| `/api/v1/sessions` | 15 | **D** (live) + **E** (historical) | Active sessions → DO RPC. Completed → Postgres. |
| `/api/v1/session-management` | 5 | **D** | Terminate/pause → DO RPC. List → Postgres. |
| `/api/v1/conversations` | 6 | **D** | Think Session data lives in DO SQLite. Admin reads via service binding. |
| `/api/v1/dashboard` | 12 | **C** (AE) + **A** (KV cached aggregates) | Real-time metrics → AE. Cached summaries → KV (TTL 30s). |
| `/api/v1/audit` | 4 | **C** (AE writes) + **E** (reads) | Write audit → AE.writeDataPoint(). Query → AE SQL API. |
| `/api/v1/alerts` | 6 | **E** + **C** | Alert rules → Postgres. Alert events → AE. |

### Governance & Security (56 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/security` | 7 | **E** | Security scan results → Postgres. |
| `/api/v1/redteam` | 5 | **E** | Red team runs → Postgres. |
| `/api/v1/issues` | 9 | **E** | Issue tracking → Postgres (needs JOINs). |
| `/api/v1/intelligence` | 5 | **E** | Conversation analytics → Postgres. |
| `/api/v1/guardrails` | 8 | **A** (KV enforcement cache) + **E** (CRUD) | Guardrail rules cached in KV for per-turn checks. CRUD in Postgres. |
| `/api/v1/dlp` | 7 | **A** (KV pattern cache) + **E** (CRUD) | DLP patterns cached in KV. CRUD in Postgres. |
| `/api/v1/compliance` | 8 | **E** | Compliance checks → Postgres. |
| `/api/v1/policies` | 4 | **A** (KV cache) + **E** | Policy rules cached in KV (TTL 60s). CRUD in Postgres. |
| `/api/v1/slos` | 7 | **E** + **C** (AE for SLO metrics) | SLO definitions → Postgres. SLO measurements → AE. |

### Memory & Knowledge (29 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/memory` | 19 | **D** (per-agent) + **E** (cross-agent) | Per-agent memory → Think context blocks via DO RPC. Cross-agent search → Vectorize + Postgres. Fact extraction → Queue → Postgres. |
| `/api/v1/rag` | 10 | **E** + Vectorize | RAG document upload/search. Postgres for metadata, Vectorize for embeddings. |

### Channels & Integrations (66 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/chat` | 23 | **Channels Worker** | Already extracted to composable Channels Worker. |
| `/api/v1/voice` | 31 | **Voice Worker** | Already extracted to voice-agent/. |
| `/api/v1/connectors` | 7 | **A** (KV token cache) + **E** | Connector tokens in KV. CRUD in Postgres. |
| `/api/v1/webhooks` | 8 | **E** | Webhook config → Postgres. |
| `/api/v1/github/webhooks` | 4 | **E** | GitHub webhook processing → Postgres. |

### Content & Marketplace (26 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/marketplace` | 5 | **E** + Vectorize | Catalog in Postgres, semantic search via Vectorize. |
| `/api/v1/feed` | 2 | **E** | Feed posts → Postgres. |
| `/api/v1/feedback` | 5 | **C** (AE) + **E** | Feedback events → AE for volume. Detailed → Postgres. |
| `/api/v1/workspace` | 5 | **D** | Think Workspace in DO. Admin reads via service binding. |
| `/api/v1/projects` | 7 | **E** | Project management → Postgres (JOINs). |
| `/api/v1/releases` | 11 | **E** | Version history → Postgres. |
| `/api/v1/gold-images` | 12 | **E** | Gold image registry → Postgres. |

### Training & Eval (44 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/eval` | 24 | **E** | Eval runs/trials with complex filters → Postgres. |
| `/api/v1/evolve` | 15 | **E** | Evolution runs → Postgres. |
| `/api/v1/training` | 20 | **E** | Training loop → Postgres. |

### Platform Admin (27 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/api/v1/orgs` | 10 | **E** | Org management → Postgres (multi-table). |
| `/api/v1/domains` | 5 | **E** | Domain management → Postgres + CF API. |
| `/api/v1/retention` | 4 | **E** | Retention policy → Postgres. |
| `/api/v1/pipelines` | 18 | **E** | Data pipeline config → Postgres. |
| `/api/v1/middleware` | 1 | health check | Inline. |
| `/api/v1/compare` | 0 | — | — |
| `/api/v1/edge-ingest` | 0 | — | — |
| `/api/v1/batch-api` | 4 | **D** | Batch execution → Agent DO RPC. |

### Public API (13 endpoints)

| Route Group | Endpoints | Pattern | Implementation |
|---|---|---|---|
| `/v1` (public-api) | 12 | **D** + **A** | Agent runs → DO RPC. Config → KV cache. |
| `/v1` (openapi) | 1 | Static | OpenAPI spec from KV. |

---

## Summary by Pattern

| Pattern | Endpoints | Lines Affected | What Changes |
|---|---|---|---|
| **A: KV Cache** | ~120 | ~4,000 | Add KV.get/put wrapper around Postgres reads. Invalidate on writes. |
| **B: BillingDO** | ~10 | ~800 | BillingDO for atomic balance. Queue for ledger. |
| **C: Analytics Engine** | ~50 | ~3,000 | Move high-volume writes to AE. Dashboard reads from AE SQL API. |
| **D: Agent DO RPC** | ~80 | ~5,500 | Replace Postgres reads with service binding → DO RPC. Delete proxy routes. |
| **E: Postgres Direct** | ~335 | ~29,000 | Stays. This IS the relational data. |
| **DELETE** | ~30 | ~3,700 | Runtime-proxy, codemode, sandbox, schedules, MCP — handled by Agent DO. |

**Total: 595 endpoints. Same features. 3,700 lines deleted. ~12,500 lines get CF-native hot paths. ~29,000 lines stay Postgres.**

---

## New Bindings Required

```jsonc
// gateway/wrangler.jsonc
{
  "name": "agentos-gateway",
  "main": "src/server.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],

  // KV for edge caching (Pattern A)
  "kv_namespaces": [
    { "binding": "CACHE", "id": "..." }
  ],

  // Analytics Engine (Pattern C)
  "analytics_engine_datasets": [
    { "binding": "AUDIT_AE", "dataset": "agentos_audit" },
    { "binding": "TELEMETRY_AE", "dataset": "agentos_telemetry" }
  ],

  // BillingDO (Pattern B)
  "durable_objects": {
    "bindings": [
      { "name": "BILLING", "class_name": "BillingDO" },
      { "name": "RATE_LIMITER", "class_name": "RateLimiterDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["BillingDO"] },
    { "tag": "v2", "new_classes": ["RateLimiterDO"] }
  ],

  // Postgres (Pattern E — stays)
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "..." },
    { "binding": "HYPERDRIVE_ADMIN", "id": "..." }
  ],

  // Service binding to Agent Core (Pattern D)
  "services": [
    { "binding": "AGENT_CORE", "service": "model-agent" }
  ],

  // AI for guardrail/DLP checks
  "ai": { "binding": "AI" },

  // Vectorize for marketplace + RAG search
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": "agentos-knowledge-v2" }
  ],

  // R2 for file storage
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "agentos-storage" }
  ],

  // Queues
  "queues": {
    "producers": [
      { "binding": "BILLING_QUEUE", "queue": "agentos-billing" },
      { "binding": "JOB_QUEUE", "queue": "agentos-jobs" }
    ],
    "consumers": [
      { "queue": "agentos-billing", "max_batch_size": 20, "max_retries": 3 }
    ]
  }
}
```

---

## Implementation Order (6 sprints)

### Sprint 1: Scaffold + Auth (Pattern A)
- Create gateway/ directory with Hono + hono-agents
- Implement auth middleware with KV-cached API key validation
- Port auth, api-keys, end-user-tokens routes
- Add KV cache wrapper utility

### Sprint 2: Agent Lifecycle + Config (Pattern A + D)
- Port agents CRUD with KV cache
- Wire service binding to Agent Core for live state/configure
- Port tools, skills, config, features routes with KV
- Delete runtime-proxy, codemode, sandbox, schedules, MCP routes

### Sprint 3: Billing (Pattern B)
- Implement BillingDO (atomic balance)
- Port credits, billing, stripe, plans routes
- Wire Queue for billing ledger to Postgres

### Sprint 4: Observability (Pattern C)
- Add Analytics Engine bindings
- Port audit, telemetry, security-events to AE writes
- Port dashboard, observability with AE SQL API reads
- Port sessions with DO RPC for live + Postgres for historical

### Sprint 5: Governance + Memory (Pattern A + D + E)
- Port guardrails, dlp, policies with KV cache
- Port memory with DO RPC (per-agent) + Vectorize (cross-agent)
- Port security, redteam, compliance, issues (Postgres direct)

### Sprint 6: Everything Else (Pattern E)
- Port remaining Postgres-direct routes: eval, evolve, training,
  orgs, marketplace, releases, projects, connectors, webhooks,
  domains, retention, pipelines, referrals, feed
- Port public API, batch API
- Wire channels and voice as service bindings
