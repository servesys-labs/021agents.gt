/**
 * Gateway — Lighter Control-Plane
 *
 * Hono + hono-agents + CF-native primitives.
 * 5 patterns: KV cache, BillingDO, Analytics Engine, DO RPC, Postgres.
 *
 * This is NOT a rewrite of the 60K-line control-plane.
 * It's a clean rebuild that offers the same features using CF primitives
 * for the hot paths, with Postgres as the relational source of truth.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentsMiddleware } from "hono-agents";
import { DurableObject } from "cloudflare:workers";

// ── Types ──────────────────────────────────────────────────────────

interface Env {
  // Service binding to Agent Core
  AGENT_CORE: Fetcher;
  // KV cache
  CACHE: KVNamespace;
  // Postgres
  DB: Hyperdrive;
  DB_ADMIN: Hyperdrive;
  // Durable Objects
  BILLING: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  // Analytics Engine
  AUDIT_AE: AnalyticsEngineDataset;
  TELEMETRY_AE: AnalyticsEngineDataset;
  // Queue
  BILLING_QUEUE: Queue;
  // Platform
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  STORAGE: R2Bucket;
  // Secrets
  JWT_SECRET?: string;
}

type Variables = {
  orgId: string;
  userId: string;
  scopes: string[];
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Global Middleware ───────────────────────────────────────────────

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
  maxAge: 86400,
}));

// ── KV Cache Utility ───────────────────────────────────────────────
// Pattern A: KV in front of Postgres. <1ms reads, TTL-based invalidation.

async function kvCached<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = await kv.get(key, "json");
  if (cached) return cached as T;
  const fresh = await fetcher();
  if (fresh) await kv.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
  return fresh;
}

async function kvInvalidate(kv: KVNamespace, ...keys: string[]) {
  await Promise.all(keys.map(k => kv.delete(k)));
}

// ── Postgres Helper ────────────────────────────────────────────────

async function getDb(hyperdrive: Hyperdrive) {
  const pg = (await import("postgres")).default;
  return pg(hyperdrive.connectionString, {
    max: 1, fetch_types: false, prepare: false,
    idle_timeout: 5, connect_timeout: 3,
  });
}

// ── Auth Middleware (KV-cached) ────────────────────────────────────
// Pattern A: validate API key from KV first, Postgres on miss.

app.use("/api/v1/*", async (c, next) => {
  const path = c.req.path;

  // Skip auth for public endpoints
  if (path === "/api/v1/health" || path === "/api/v1/auth/login") {
    return next();
  }

  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return c.json({ error: "Authorization required" }, 401);

  // Try KV cache first (<1ms)
  const cacheKey = `auth:${token.slice(-16)}`; // last 16 chars as cache key
  const cached = await c.env.CACHE.get(cacheKey, "json") as {
    orgId: string; userId: string; scopes: string[];
  } | null;

  if (cached) {
    c.set("orgId", cached.orgId);
    c.set("userId", cached.userId);
    c.set("scopes", cached.scopes);
    return next();
  }

  // KV miss → validate against Postgres
  try {
    const sql = await getDb(c.env.DB_ADMIN);
    const [key] = await sql`
      SELECT org_id, user_id, scopes FROM api_keys
      WHERE key_hash = encode(digest(${token}, 'sha256'), 'hex')
        AND revoked_at IS NULL
      LIMIT 1
    `;
    await sql.end();

    if (!key) return c.json({ error: "Invalid API key" }, 401);

    const authData = {
      orgId: key.org_id,
      userId: key.user_id || "",
      scopes: Array.isArray(key.scopes) ? key.scopes : [],
    };

    // Cache for 5 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(authData), { expirationTtl: 300 });

    c.set("orgId", authData.orgId);
    c.set("userId", authData.userId);
    c.set("scopes", authData.scopes);
    return next();
  } catch (err) {
    console.error("[auth] Validation failed:", err);
    return c.json({ error: "Auth service error" }, 500);
  }
});

// Audit logging middleware — writes to Analytics Engine, not Postgres
app.use("/api/v1/*", async (c, next) => {
  const start = Date.now();
  await next();
  try {
    c.env.AUDIT_AE.writeDataPoint({
      blobs: [c.req.method, c.req.path, c.get("orgId") || "", c.get("userId") || ""],
      doubles: [c.res.status, Date.now() - start],
      indexes: [c.get("orgId") || "anonymous"],
    });
  } catch {} // non-blocking
});

// ── Health ──────────────────────────────────────────────────────────

app.get("/api/v1/health", (c) =>
  c.json({ status: "ok", service: "gateway", version: "2.0.0", ts: Date.now() }),
);

app.get("/api/v1/health/detailed", async (c) => {
  const checks: Record<string, { ok: boolean; ms: number }> = {};

  const dbStart = Date.now();
  try {
    const sql = await getDb(c.env.DB_ADMIN);
    await sql`SELECT 1`;
    await sql.end();
    checks.database = { ok: true, ms: Date.now() - dbStart };
  } catch { checks.database = { ok: false, ms: Date.now() - dbStart }; }

  const coreStart = Date.now();
  try {
    const resp = await c.env.AGENT_CORE.fetch(new Request("http://internal/api/health"));
    checks.agent_core = { ok: resp.ok, ms: Date.now() - coreStart };
  } catch { checks.agent_core = { ok: false, ms: Date.now() - coreStart }; }

  const allOk = Object.values(checks).every(ch => ch.ok);
  return c.json({ status: allOk ? "healthy" : "degraded", checks, ts: Date.now() }, allOk ? 200 : 503);
});

// ═══════════════════════════════════════════════════════════════════
// AGENT LIFECYCLE (Pattern A: KV cache + Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/agents", async (c) => {
  const orgId = c.get("orgId");
  const agents = await kvCached(c.env.CACHE, `agents:${orgId}`, 60, async () => {
    const sql = await getDb(c.env.DB);
    const rows = await sql`
      SELECT name, description, config, is_active, created_at FROM agents
      WHERE org_id = ${orgId} ORDER BY created_at DESC
    `;
    await sql.end();
    return rows;
  });
  return c.json(agents);
});

app.get("/api/v1/agents/:name", async (c) => {
  const orgId = c.get("orgId");
  const name = c.req.param("name");
  const agent = await kvCached(c.env.CACHE, `agent:${orgId}:${name}`, 60, async () => {
    const sql = await getDb(c.env.DB);
    const [row] = await sql`
      SELECT * FROM agents WHERE name = ${name} AND org_id = ${orgId} LIMIT 1
    `;
    await sql.end();
    return row || null;
  });
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  return c.json(agent);
});

app.post("/api/v1/agents", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json();
  const sql = await getDb(c.env.DB);
  const [agent] = await sql`
    INSERT INTO agents (name, description, config, org_id)
    VALUES (${body.name}, ${body.description || ""}, ${JSON.stringify(body.config || {})}, ${orgId})
    RETURNING *
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `agents:${orgId}`, `agent:${orgId}:${body.name}`);

  // Push config to Agent Core DO via service binding
  try {
    await c.env.AGENT_CORE.fetch(new Request(`http://internal/agents/${body.name}/default`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "configure", config: body.config }),
    }));
  } catch {} // best-effort

  return c.json(agent, 201);
});

app.put("/api/v1/agents/:name", async (c) => {
  const orgId = c.get("orgId");
  const name = c.req.param("name");
  const body = await c.req.json();
  const sql = await getDb(c.env.DB);
  const [agent] = await sql`
    UPDATE agents SET
      description = COALESCE(${body.description}, description),
      config = COALESCE(${body.config ? JSON.stringify(body.config) : null}, config),
      updated_at = now()
    WHERE name = ${name} AND org_id = ${orgId}
    RETURNING *
  `;
  await sql.end();
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  await kvInvalidate(c.env.CACHE, `agents:${orgId}`, `agent:${orgId}:${name}`);
  return c.json(agent);
});

app.delete("/api/v1/agents/:name", async (c) => {
  const orgId = c.get("orgId");
  const name = c.req.param("name");
  const sql = await getDb(c.env.DB);
  await sql`UPDATE agents SET is_active = false WHERE name = ${name} AND org_id = ${orgId}`;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `agents:${orgId}`, `agent:${orgId}:${name}`);
  return c.json({ deleted: name });
});

// ── Agent live state (Pattern D: DO RPC via service binding) ──

app.get("/api/v1/agents/:name/state", async (c) => {
  const name = c.req.param("name");
  const orgId = c.get("orgId");
  const resp = await c.env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/${orgId}-${name}/default`, {
      headers: { "Content-Type": "application/json" },
    }),
  );
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ── Agent config push (Pattern D: configure via DO RPC) ──

app.post("/api/v1/agents/:name/configure", async (c) => {
  const name = c.req.param("name");
  const orgId = c.get("orgId");
  const body = await c.req.json();
  const resp = await c.env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/${orgId}-${name}/default`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "configure", config: body }),
    }),
  );
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ═══════════════════════════════════════════════════════════════════
// BILLING (Pattern B: BillingDO + Queue + Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/credits/balance", async (c) => {
  const orgId = c.get("orgId");
  const billingDO = c.env.BILLING.get(c.env.BILLING.idFromName(orgId));
  const resp = await billingDO.fetch(new Request("http://internal/balance"));
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

app.post("/api/v1/credits/topup", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ amount: number; description?: string }>();
  const billingDO = c.env.BILLING.get(c.env.BILLING.idFromName(orgId));
  const resp = await billingDO.fetch(new Request("http://internal/topup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

app.get("/api/v1/credits/transactions", async (c) => {
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT * FROM credit_transactions
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC LIMIT 100
  `;
  await sql.end();
  return c.json(rows);
});

// ═══════════════════════════════════════════════════════════════════
// OBSERVABILITY (Pattern C: Analytics Engine + Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/sessions", async (c) => {
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT session_id, agent_name, status, model, cost_total_usd, created_at
    FROM sessions WHERE org_id = ${orgId}
    ORDER BY created_at DESC LIMIT 50
  `;
  await sql.end();
  return c.json(rows);
});

app.get("/api/v1/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);
  const [session] = await sql`
    SELECT * FROM sessions WHERE session_id = ${sessionId} AND org_id = ${orgId}
  `;
  await sql.end();
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

// ── Live sessions (Pattern D: query Agent Core) ──

app.get("/api/v1/sessions/active", async (c) => {
  const resp = await c.env.AGENT_CORE.fetch(
    new Request("http://internal/api/sessions/active"),
  );
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ── Conversations (Pattern D: Think Session in DO SQLite) ──

app.get("/api/v1/conversations/:agentName", async (c) => {
  const orgId = c.get("orgId");
  const name = c.req.param("agentName");
  const resp = await c.env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/${orgId}-${name}/default`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "getHistory" }),
    }),
  );
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ── Dashboard (Pattern C: Analytics Engine aggregations) ──

app.get("/api/v1/dashboard/stats", async (c) => {
  const orgId = c.get("orgId");
  // KV-cached aggregate (30s TTL)
  const stats = await kvCached(c.env.CACHE, `dashboard:${orgId}`, 30, async () => {
    const sql = await getDb(c.env.DB);
    const [row] = await sql`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(cost_total_usd), 0) as total_cost,
        COUNT(DISTINCT agent_name) as active_agents
      FROM sessions
      WHERE org_id = ${orgId} AND created_at > now() - interval '24 hours'
    `;
    await sql.end();
    return row;
  });
  return c.json(stats);
});

// ═══════════════════════════════════════════════════════════════════
// TOOLS & SKILLS (Pattern A: KV cache)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/tools", async (c) => {
  const orgId = c.get("orgId");
  const tools = await kvCached(c.env.CACHE, `tools:${orgId}`, 300, async () => {
    const sql = await getDb(c.env.DB);
    const rows = await sql`
      SELECT name, description, schema FROM tool_registry
      WHERE org_id = ${orgId} OR org_id IS NULL
      ORDER BY name
    `;
    await sql.end();
    return rows;
  });
  return c.json(tools);
});

app.post("/api/v1/tools", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json();
  const sql = await getDb(c.env.DB);
  const [tool] = await sql`
    INSERT INTO tool_registry (name, description, schema, org_id)
    VALUES (${body.name}, ${body.description}, ${JSON.stringify(body.schema || {})}, ${orgId})
    RETURNING *
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `tools:${orgId}`);
  return c.json(tool, 201);
});

// ═══════════════════════════════════════════════════════════════════
// GOVERNANCE (Pattern A: KV cache + Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/guardrails", async (c) => {
  const orgId = c.get("orgId");
  const rules = await kvCached(c.env.CACHE, `guardrails:${orgId}`, 60, async () => {
    const sql = await getDb(c.env.DB);
    const rows = await sql`
      SELECT * FROM guardrail_rules WHERE org_id = ${orgId} AND is_active = true
    `;
    await sql.end();
    return rows;
  });
  return c.json(rules);
});

app.post("/api/v1/guardrails", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json();
  const sql = await getDb(c.env.DB);
  const [rule] = await sql`
    INSERT INTO guardrail_rules (name, type, config, org_id)
    VALUES (${body.name}, ${body.type}, ${JSON.stringify(body.config)}, ${orgId})
    RETURNING *
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `guardrails:${orgId}`);
  return c.json(rule, 201);
});

// ═══════════════════════════════════════════════════════════════════
// AUTH (Pattern A: KV + Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.post("/api/v1/auth/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const sql = await getDb(c.env.DB_ADMIN);
  const [user] = await sql`
    SELECT id, org_id, email, password_hash FROM users
    WHERE email = ${body.email} LIMIT 1
  `;
  await sql.end();
  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  // In production: verify password hash, generate JWT
  // For now: return a simple token
  const token = crypto.randomUUID();
  await c.env.CACHE.put(`session:${token}`, JSON.stringify({
    userId: user.id, orgId: user.org_id,
  }), { expirationTtl: 86400 }); // 24hr

  return c.json({ token, org_id: user.org_id });
});

app.get("/api/v1/api-keys", async (c) => {
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT id, name, prefix, scopes, created_at FROM api_keys
    WHERE org_id = ${orgId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
  await sql.end();
  return c.json(rows);
});

app.post("/api/v1/api-keys", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ name: string; scopes?: string[] }>();
  const key = `ak_${crypto.randomUUID().replace(/-/g, "")}`;
  const sql = await getDb(c.env.DB);
  const [row] = await sql`
    INSERT INTO api_keys (name, key_hash, prefix, scopes, org_id, user_id)
    VALUES (
      ${body.name},
      encode(digest(${key}, 'sha256'), 'hex'),
      ${key.slice(0, 8)},
      ${JSON.stringify(body.scopes || ["agent:read", "agent:write"])},
      ${orgId},
      ${c.get("userId")}
    )
    RETURNING id, name, prefix, scopes, created_at
  `;
  await sql.end();
  return c.json({ ...row, key }, 201); // key returned only once
});

// ═══════════════════════════════════════════════════════════════════
// ORGS (Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/orgs/current", async (c) => {
  const orgId = c.get("orgId");
  const org = await kvCached(c.env.CACHE, `org:${orgId}`, 300, async () => {
    const sql = await getDb(c.env.DB);
    const [row] = await sql`SELECT * FROM orgs WHERE id = ${orgId}`;
    await sql.end();
    return row;
  });
  return c.json(org);
});

// ═══════════════════════════════════════════════════════════════════
// MEMORY & RAG (Pattern D for per-agent, Pattern E for cross-agent)
// ═══════════════════════════════════════════════════════════════════

app.post("/api/v1/memory/search", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ query: string; agent_name?: string }>();

  // Cross-agent semantic search via Vectorize
  const embedding = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [body.query],
  });
  const results = await c.env.VECTORIZE.query(embedding.data[0], {
    topK: 10,
    filter: { org_id: orgId },
  });
  return c.json({ results: results.matches });
});

// ═══════════════════════════════════════════════════════════════════
// EVAL (Pattern E: Postgres — complex relational queries)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/eval/runs", async (c) => {
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT * FROM eval_runs WHERE org_id = ${orgId}
    ORDER BY created_at DESC LIMIT 50
  `;
  await sql.end();
  return c.json(rows);
});

app.post("/api/v1/eval/runs", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json();
  const sql = await getDb(c.env.DB);
  const [run] = await sql`
    INSERT INTO eval_runs (agent_name, dataset_id, config, org_id)
    VALUES (${body.agent_name}, ${body.dataset_id}, ${JSON.stringify(body.config || {})}, ${orgId})
    RETURNING *
  `;
  await sql.end();
  return c.json(run, 201);
});

// ═══════════════════════════════════════════════════════════════════
// FEATURES & CONFIG (Pattern A: KV, near-instant)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/features", async (c) => {
  const orgId = c.get("orgId");
  const features = await kvCached(c.env.CACHE, `features:${orgId}`, 30, async () => {
    const sql = await getDb(c.env.DB);
    const rows = await sql`
      SELECT name, enabled, config FROM feature_flags
      WHERE org_id = ${orgId} OR org_id IS NULL
    `;
    await sql.end();
    return Object.fromEntries(rows.map((r: any) => [r.name, { enabled: r.enabled, config: r.config }]));
  });
  return c.json(features);
});

// ═══════════════════════════════════════════════════════════════════
// BILLING DO (Pattern B: atomic balance at edge)
// ═══════════════════════════════════════════════════════════════════

export class BillingDO extends DurableObject<Env> {
  async initialize() {
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS balance (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          balance_usd REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          amount_usd REAL NOT NULL,
          description TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO balance (id, balance_usd) VALUES (1, 0);
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();
    const url = new URL(request.url);

    if (url.pathname === "/balance") {
      const [row] = this.ctx.storage.sql.exec("SELECT balance_usd FROM balance WHERE id = 1").toArray() as any[];
      return Response.json({ balance_usd: Number(row?.balance_usd || 0) });
    }

    if (url.pathname === "/topup" && request.method === "POST") {
      const { amount, description } = await request.json() as { amount: number; description?: string };
      this.ctx.storage.sql.exec("UPDATE balance SET balance_usd = balance_usd + ? WHERE id = 1", amount);
      this.ctx.storage.sql.exec(
        "INSERT INTO transactions (type, amount_usd, description) VALUES ('topup', ?, ?)",
        amount, description || "Top-up",
      );
      const [row] = this.ctx.storage.sql.exec("SELECT balance_usd FROM balance WHERE id = 1").toArray() as any[];
      return Response.json({ balance_usd: Number(row?.balance_usd || 0) });
    }

    if (url.pathname === "/deduct" && request.method === "POST") {
      const { amount, description } = await request.json() as { amount: number; description?: string };
      const [row] = this.ctx.storage.sql.exec("SELECT balance_usd FROM balance WHERE id = 1").toArray() as any[];
      const current = Number(row?.balance_usd || 0);
      if (current < amount) {
        return Response.json({ error: "Insufficient balance", balance_usd: current }, { status: 402 });
      }
      this.ctx.storage.sql.exec("UPDATE balance SET balance_usd = balance_usd - ? WHERE id = 1", amount);
      this.ctx.storage.sql.exec(
        "INSERT INTO transactions (type, amount_usd, description) VALUES ('burn', ?, ?)",
        -amount, description || "Usage",
      );
      return Response.json({ balance_usd: current - amount });
    }

    if (url.pathname === "/transactions") {
      const rows = this.ctx.storage.sql.exec(
        "SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100",
      ).toArray();
      return Response.json(rows);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

// ── Rate Limiter DO ────────────────────────────────────────────────

export class RateLimiterDO extends DurableObject<Env> {
  private counts = new Map<string, { count: number; resetAt: number }>();

  async fetch(request: Request): Promise<Response> {
    const { key, limit, windowSeconds } = await request.json() as {
      key: string; limit: number; windowSeconds: number;
    };
    const now = Date.now();
    const entry = this.counts.get(key);

    if (!entry || now > entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return Response.json({ allowed: true, remaining: limit - 1 });
    }

    if (entry.count >= limit) {
      return Response.json({ allowed: false, remaining: 0, retryAfter: entry.resetAt - now });
    }

    entry.count++;
    return Response.json({ allowed: true, remaining: limit - entry.count });
  }
}

// ═══════════════════════════════════════════════════════════════════
// QUEUE CONSUMER (billing events → Postgres ledger)
// ═══════════════════════════════════════════════════════════════════

async function handleBillingQueue(batch: MessageBatch, env: Env) {
  const sql = await getDb(env.DB_ADMIN);
  try {
    for (const msg of batch) {
      const evt = msg.body as {
        org_id: string; agent_name: string; amount_usd: number;
        description: string; type: string;
      };
      try {
        await sql`
          INSERT INTO credit_transactions (org_id, agent_name, type, amount_usd, description)
          VALUES (${evt.org_id}, ${evt.agent_name}, ${evt.type}, ${evt.amount_usd}, ${evt.description})
        `;
        msg.ack();
      } catch (err) {
        console.error("[billing-queue] Write failed:", err);
        msg.retry();
      }
    }
  } finally {
    await sql.end();
  }
}

// ═══════════════════════════════════════════════════════════════════
// WORKER ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env) {
    await handleBillingQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
