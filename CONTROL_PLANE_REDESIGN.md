# Control-Plane Redesign — CF-Native, Postgres-Backed

**Date**: 2026-04-13
**Context**: The control-plane is 60K+ lines (42K routes, 18K logic/middleware). It's a Hono API where every endpoint hits Postgres via Hyperdrive. Many routes exist because the control-plane does things that should be handled by the Agent Core DO, by KV caching, by the edge, or by DOs themselves.

**Principle**: Postgres is the source of truth for relational platform data. But not every request needs to hit Postgres. CF primitives (KV, DO, Analytics Engine, Queues, Cron) can absorb the read-heavy, write-heavy, and real-time paths — leaving Postgres for what it's good at: complex queries, transactions, and JOINs.

---

## The Problem: Everything Goes Through Postgres

```
Current: EVERY request → Hono middleware → Hyperdrive → Postgres → response
                          (auth)           (50-200ms)   (query)

This means:
- 100 concurrent users = 100 Hyperdrive connections
- Read-heavy endpoints (config, tool registry) hammer Postgres
- Real-time endpoints (sessions, conversations) need Postgres round-trips
- High-volume writes (telemetry, audit) bottleneck on Postgres
- The control-plane is a SPOF between clients and data
```

## The Solution: Tiered Data Architecture

```
                    ┌──────────────────────────────────┐
                    │          Client Request            │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │   KV Cache (< 1ms reads)          │  Tier 0: Edge
                    │   Auth tokens, config, tools,     │
                    │   feature flags, API key lookup    │
                    └──────────────┬───────────────────┘
                                   │ cache miss
                    ┌──────────────▼───────────────────┐
                    │   Durable Objects (< 5ms)          │  Tier 1: Stateful Edge
                    │   BillingDO (atomic balance),      │
                    │   RateLimiterDO (per-org limits),   │
                    │   Agent DO (Think session data)     │
                    └──────────────┬───────────────────┘
                                   │ complex query
                    ┌──────────────▼───────────────────┐
                    │   Postgres via Hyperdrive          │  Tier 2: Source of Truth
                    │   Relational queries, JOINs,       │
                    │   admin dashboards, eval data       │
                    └──────────────────────────────────┘

Writes:
  Hot path (every turn):   Queue → Postgres (async, non-blocking)
  Analytics/audit:         Analytics Engine (never hits Postgres)
  Config changes:          Postgres + KV invalidation
```

---

## Route-by-Route Migration Plan

### Tier 0: Move to KV (cache in front of Postgres)

These routes are read-heavy, rarely change, and are called on every request. Put them in KV with TTL, invalidate on write.

| Route Group | Lines | Current | CF-Native | Savings |
|---|---|---|---|---|
| Auth token validation | ~300 (middleware) | Postgres lookup per request | **KV**: `api-key:{hash}` → scopes, org_id, rate limits. TTL 5min. Postgres on miss. | ~95% of auth queries skip Postgres |
| Agent config reads | ~500 (in agents.ts) | `SELECT * FROM agents WHERE name=? AND org_id=?` per run | **KV**: `agent:{org}:{name}` → full config JSON. TTL 60s. Invalidate on PUT/PATCH. | Config reads skip Postgres |
| Tool registry | 877 (tools.ts) | `SELECT * FROM tool_registry` | **KV**: `tools:{org}` → tool list. TTL 5min. | Tool lookups skip Postgres |
| Feature flags | 83 (features.ts) | Postgres feature_flags table | **KV**: `features:{org}` → flag map. TTL 30s. | Sub-ms flag checks |
| Plans catalog | 231 (plans.ts) | `SELECT * FROM plans` | **KV**: `plans` → plan list. Write-rare. TTL 1hr. | One KV read vs Postgres |
| Connector tokens | ~200 (connectors.ts) | `SELECT access_token FROM connector_tokens` | **KV**: `connector:{org}:{name}` → encrypted token. TTL 5min. | Fast secret lookup |

**Implementation pattern:**
```typescript
// KV-backed config with Postgres fallback
async function getAgentConfig(env: Env, orgId: string, name: string) {
  const cacheKey = `agent:${orgId}:${name}`;
  const cached = await env.CONFIG_KV.get(cacheKey, "json");
  if (cached) return cached;

  // Cache miss → Postgres
  const { withOrgDb } = await import("./db/client");
  const config = await withOrgDb(env, orgId, async (sql) => {
    const [row] = await sql`SELECT * FROM agents WHERE name = ${name} LIMIT 1`;
    return row;
  });

  // Populate cache
  if (config) await env.CONFIG_KV.put(cacheKey, JSON.stringify(config), { expirationTtl: 60 });
  return config;
}

// Invalidate on write
async function updateAgentConfig(env: Env, orgId: string, name: string, update: any) {
  await withOrgDb(env, orgId, async (sql) => {
    await sql`UPDATE agents SET config = ${JSON.stringify(update)} WHERE name = ${name}`;
  });
  // Invalidate cache
  await env.CONFIG_KV.delete(`agent:${orgId}:${name}`);
}
```

### Tier 1: Move to Durable Objects

These need atomicity or per-entity state that Postgres transactions provide. DOs give the same guarantee without connection pool pressure.

| Route Group | Lines | Current | CF-Native | Why |
|---|---|---|---|---|
| Credit balance (deduct/topup) | ~400 (credits.ts + billing.ts) | `BEGIN; SELECT balance; UPDATE balance; INSERT transaction; COMMIT;` | **BillingDO** per-org: single-threaded, atomic, no transaction isolation bugs | Eliminates the transaction deadlock risk that's bitten us twice |
| Rate limiting | ~300 (rate-limit.ts + api-key-rate-limit.ts) | RateLimiterDO already exists | **Keep DO** — already correct | Already CF-native |
| Session counters | ~100 (session-mgmt.ts) | Postgres counter | **SessionCounterDO** (already exists in runtime) | Already CF-native |
| Real-time agent state | ~689 (sessions.ts) | `SELECT * FROM sessions WHERE status='running'` | **Agent DO state** — query via service binding RPC to each running agent | Live state from the source, not a stale Postgres snapshot |

### Tier 2: Move to Analytics Engine

High-volume, append-only writes that don't need relational queries. Analytics Engine handles millions of writes/sec and supports SQL queries via the API.

| Route Group | Lines | Current | CF-Native | Why |
|---|---|---|---|---|
| Audit logs | 249 (audit.ts) | `INSERT INTO audit_log` on every action | **Analytics Engine**: `AUDIT.writeDataPoint()` | Audit is append-only, query-rare. AE handles the volume. |
| Telemetry events | ~500 (observability.ts + ops-observability.ts) | Queue → Postgres INSERT batch | **Analytics Engine**: `TELEMETRY.writeDataPoint()` | Eliminates the telemetry queue → Postgres pipeline entirely |
| Security events | 196 (security-events.ts) | `INSERT INTO security_events` | **Analytics Engine**: `SECURITY.writeDataPoint()` | Same pattern — append-only, high-volume |
| Usage metrics | ~300 (dashboard.ts) | `SELECT SUM(cost_usd) FROM sessions GROUP BY agent` | **Analytics Engine** SQL API for aggregations | AE is purpose-built for this |

**Query pattern (for dashboard/admin views):**
```typescript
// Analytics Engine SQL API (queried from control-plane)
const usage = await env.ANALYTICS.query(`
  SELECT
    blob1 AS agent_name,
    SUM(double1) AS total_tokens,
    COUNT() AS request_count
  FROM model_agent_telemetry
  WHERE timestamp > NOW() - INTERVAL '24' HOUR
    AND index1 = '${orgId}'
  GROUP BY blob1
  ORDER BY total_tokens DESC
  LIMIT 20
`);
```

### Tier 3: Move to Agent Core (via service binding)

These routes proxy to the runtime worker. In the Think architecture, clients connect directly — the control-plane doesn't need to be in the middle.

| Route Group | Lines | Current | CF-Native | Action |
|---|---|---|---|---|
| runtime-proxy (SSE streaming) | 1,132 | Proxy requests to runtime, intercept for billing | **Clients connect directly to DO via WebSocket**. Billing is async (onChatResponse → Queue). | **DELETE** — biggest single route file |
| conversations (read/write) | 265 | Read/write conversation from Postgres | **Think Session in DO SQLite**. Admin reads via service binding: `env.RUNTIME.fetch("/internal/conversations?agent=X")` | **Simplify** — thin admin proxy |
| workspace (file CRUD) | 236 | R2 read/write via control-plane | **Think Workspace in DO**. Admin reads via service binding. | **Simplify** — thin admin proxy |
| memory (search, extract) | 641 | Full memory API | **Per-agent: Think context blocks**. Cross-agent: Keep Vectorize search in CP. | **Split** — per-agent moves to DO |
| schedules | 313 | CRUD on scheduled_runs table | **Agent DO** `scheduleEvery()` / `getSchedules()` / `cancelSchedule()` via @callable RPC | **Replace** with DO RPC |
| MCP control | 289 | MCP server config CRUD | **Agent DO** `addMcpServer()` / `removeMcpServer()` via @callable | **Replace** with DO RPC |
| codemode | 634 | Code execution proxy | **Agent DO** CodeMode tool execution | **Remove** — handled by DO |
| sandbox | 327 | Sandbox exec proxy | **Agent DO** sandbox tools | **Remove** — handled by DO |

### Tier 4: Stays in Postgres (relational, admin, complex queries)

These genuinely need Postgres — relational joins, complex aggregations, admin dashboards.

| Route Group | Lines | Why Postgres | Notes |
|---|---|---|---|
| agents CRUD | 1,958 | Multi-org queries, JOIN with orgs/plans, admin listing with filters/sort/pagination | KV cache in front for reads |
| eval (runs, trials) | 693 | Complex queries: filter by model, status, date range, JOIN with sessions | |
| evolve | 1,322 | Multi-step evolution with state machines, references between runs | |
| billing ledger | ~400 | Transaction history, Stripe webhook processing, refunds | BillingDO for balance, Postgres for history |
| orgs | 601 | Multi-table: org settings, members, invites, plans | |
| auth (users, API keys) | 982 | User management, key rotation, MFA state | KV cache for hot-path validation |
| governance (policies, guardrails) | ~1,200 | Policy rules, SLO definitions, compliance checks | KV cache for enforcement |
| marketplace | ~400 | Catalog with search, ratings, installs, featured agents | Vectorize for semantic search |
| training | 1,788 | Training runs, datasets, model versions | |
| releases | 847 | Version history, rollback, gold images | |
| issues | 654 | Issue tracking with status, assignee, linked sessions | |

---

## Summary: 42K Lines → What Moves Where

```
Route Lines by Tier:

  Tier 0 — KV cache:          ~2,200 lines  (reads skip Postgres)
  Tier 1 — Durable Objects:   ~1,500 lines  (atomic state at edge)
  Tier 2 — Analytics Engine:  ~1,250 lines  (high-volume writes)
  Tier 3 — Agent Core (DELETE/SIMPLIFY):  ~3,700 lines  (removed or thinned)
  Tier 4 — Stays in Postgres: ~33,500 lines (relational, admin)
                               ──────
                               42,150 lines
```

**Net effect:**
- **~3,700 lines DELETED** (runtime-proxy, codemode, sandbox, schedules, MCP control — all handled by Agent DO now)
- **~2,200 lines get KV cache in front** (auth, config, tools, features, plans — Postgres traffic drops ~60%)
- **~1,250 lines move to Analytics Engine** (audit, telemetry, security events — Postgres stops receiving high-volume writes)
- **~1,500 lines move to DOs** (billing balance, rate limits, live session state — Postgres stops doing atomic counter updates)
- **~33,500 lines STAY** (genuine relational admin logic — agents CRUD, eval, training, governance, marketplace, orgs, billing history)

**Postgres benefits:** With the read cache (KV) and write offload (AE + DOs), Postgres handles ~40% less traffic, all of it the complex queries it's designed for. No more: token validation queries, config reads on every request, counter updates, append-only audit writes.

---

## Implementation Order

```
Sprint 1: KV Cache Layer
  - Add CONFIG_KV binding to control-plane wrangler.jsonc
  - Wrap agent config, tool registry, API key validation with KV
  - Invalidate on writes
  - Measure: Hyperdrive connection count should drop 50%+

Sprint 2: Delete Runtime Proxy
  - Remove /runtime-proxy/* routes (1,132 lines)
  - Clients connect directly to Agent DO via WebSocket
  - Add thin admin proxy for /api/v1/sessions (read-only, via service binding)

Sprint 3: Analytics Engine for Writes
  - Add AUDIT, TELEMETRY, SECURITY Analytics Engine datasets
  - Move audit_log, telemetry, security_events writes to AE
  - Update dashboard queries to use AE SQL API

Sprint 4: BillingDO for Balance
  - BillingDO already exists as pattern in COMPOSABLE_ARCHITECTURE.md
  - Move credit deduct/topup to DO
  - Keep transaction ledger in Postgres

Sprint 5: Agent DO RPC
  - Remove /schedules routes → use Agent DO @callable
  - Remove /mcp-control routes → use Agent DO @callable
  - Remove /codemode proxy → handled by Agent DO CodeMode
  - Remove /sandbox proxy → handled by Agent DO sandbox tools

Sprint 6: Thin Admin Proxies
  - /conversations → service binding to Agent DO (read-only admin view)
  - /workspace → service binding to Agent DO (read-only admin view)
  - /memory → split: per-agent via DO, cross-agent via Vectorize in CP
```

---

## Binding Changes

```jsonc
// control-plane/wrangler.jsonc — additions
{
  // KV for edge caching (new)
  "kv_namespaces": [
    { "binding": "CONFIG_KV", "id": "..." },
    { "binding": "AGENT_PROGRESS_KV", "id": "30da23c287ee4f4c93d1a1f08cdd48a0" }
  ],

  // Analytics Engine for high-volume writes (new)
  "analytics_engine_datasets": [
    { "binding": "AUDIT_AE", "dataset": "agentos_audit" },
    { "binding": "TELEMETRY_AE", "dataset": "agentos_telemetry" },
    { "binding": "SECURITY_AE", "dataset": "agentos_security" }
  ],

  // Existing — stays
  "hyperdrive": [...],
  "services": [{ "binding": "RUNTIME", "service": "agentos" }],
  "durable_objects": { "bindings": [{ "name": "RATE_LIMITER", "class_name": "RateLimiterDO" }] },
  "queues": { ... }
}
```
