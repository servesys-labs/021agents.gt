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
// hono-agents removed — gateway doesn't serve DO WebSocket routes directly
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
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
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

// ── DO Name Derivation ────────────────────────────────────────────
// Must match agent-ws.ts buildDoName() and server.ts routing logic.

function buildDoName(orgId: string, agentName: string, userId: string): string {
  const shortOrg = orgId.length > 12 ? orgId.slice(-8) : orgId;
  const shortUser = userId.length > 12 ? userId.slice(-8) : userId;
  const orgPrefix = shortOrg ? `${shortOrg}-` : "";
  let name = shortUser
    ? `${orgPrefix}${agentName}-u-${shortUser}`
    : `${orgPrefix}${agentName}`;
  if (name.length > 63) name = name.slice(0, 63);
  return name;
}

// ── Auth Middleware (KV-cached, JWT + API key) ────────────────────
// Checks KV cache first (<1ms), then tries JWT verification, then API key lookup.

const PUBLIC_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/health/detailed",
  "/api/v1/auth/login",
  "/api/v1/auth/signup",
  "/api/v1/auth/forgot-password",
  "/api/v1/auth/reset-password",
  "/api/v1/auth/verify-email",
  "/api/v1/webhooks/stripe",
  "/api/v1/models",
]);

app.use("/api/v1/*", async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();

  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return c.json({ error: "Authorization required" }, 401);

  // 1. Try KV cache first (<1ms) — works for both JWT and API key tokens
  const cacheKey = `auth:${token.slice(-16)}`;
  const cached = await c.env.CACHE.get(cacheKey, "json") as {
    orgId: string; userId: string; scopes: string[];
  } | null;

  if (cached) {
    c.set("orgId", cached.orgId);
    c.set("userId", cached.userId);
    c.set("scopes", cached.scopes);
    return next();
  }

  // 2. Try JWT verification (for user sessions from login/signup)
  const secret = c.env.JWT_SECRET || "dev-secret-change-me";
  const jwtPayload = await verifyJwt(token, secret);
  if (jwtPayload && jwtPayload.org_id && jwtPayload.user_id) {
    const authData = {
      orgId: jwtPayload.org_id as string,
      userId: jwtPayload.user_id as string,
      scopes: ["*"],
    };
    await c.env.CACHE.put(cacheKey, JSON.stringify(authData), { expirationTtl: 300 });
    c.set("orgId", authData.orgId);
    c.set("userId", authData.userId);
    c.set("scopes", authData.scopes);
    return next();
  }

  // 3. Try API key lookup (for programmatic access)
  try {
    const sql = await getDb(c.env.DB_ADMIN);
    const [key] = await sql`
      SELECT org_id, user_id, scopes FROM api_keys
      WHERE key_hash = encode(digest(${token}, 'sha256'), 'hex')
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `;
    await sql.end();

    if (!key) return c.json({ error: "Invalid token" }, 401);

    const authData = {
      orgId: key.org_id,
      userId: key.user_id || "",
      scopes: Array.isArray(key.scopes) ? key.scopes : [],
    };

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
// Old schema: agents table uses handle (not name), agent_id (not id)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/agents", async (c) => {
  const orgId = c.get("orgId");
  const agents = await kvCached(c.env.CACHE, `agents:${orgId}`, 60, async () => {
    const sql = await getDb(c.env.DB);
    const rows = await sql`
      SELECT agent_id, handle as name, display_name, description, config, is_active, created_at
      FROM agents WHERE org_id = ${orgId} ORDER BY created_at DESC
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
      SELECT * FROM agents WHERE (handle = ${name} OR name = ${name}) AND org_id = ${orgId} LIMIT 1
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
    INSERT INTO agents (handle, name, display_name, description, config, org_id)
    VALUES (${body.name}, ${body.name}, ${body.name}, ${body.description || ""}, ${JSON.stringify(body.config || {})}::jsonb, ${orgId})
    RETURNING *
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `agents:${orgId}`, `agent:${orgId}:${body.name}`);

  try {
    await c.env.AGENT_CORE.fetch(new Request(`http://internal/agents/${body.name}/default`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "configure", config: body.config }),
    }));
  } catch {}

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
      config = COALESCE(${body.config ? JSON.stringify(body.config) : null}::jsonb, config),
      updated_at = now()
    WHERE (handle = ${name} OR name = ${name}) AND org_id = ${orgId}
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
  await sql`UPDATE agents SET is_active = false WHERE (handle = ${name} OR name = ${name}) AND org_id = ${orgId}`;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `agents:${orgId}`, `agent:${orgId}:${name}`);
  return c.json({ deleted: name });
});

// ═══════════════════════════════════════════════════════════════════
// AGENT EXECUTION — No proxy. Clients connect DIRECTLY to Agent Worker.
//
// The SDK pattern: UI → WebSocket → Agent Worker DO (routeAgentRequest)
// URL: wss://agent-harness.servesys.workers.dev/agents/chat-agent/{doName}
//
// The gateway does NOT proxy agent traffic. It only serves control-plane
// (auth, billing, CRUD, marketplace). All real-time agent communication
// goes through the agent worker directly via SDK's AgentClient.
// ═══════════════════════════════════════════════════════════════════

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

// ── Credit packages (public pricing tiers) ──

app.get("/api/v1/credits/packages", async (c) => {
  const packages = await kvCached(c.env.CACHE, "credit_packages", 300, async () => {
    const sql = await getDb(c.env.DB);
    const rows = await sql`
      SELECT id, name, credits_usd, price_usd, stripe_price_id
      FROM credit_packages WHERE is_active = true ORDER BY price_usd ASC
    `;
    await sql.end();
    return rows;
  });
  return c.json(packages);
});

// ── Stripe checkout session ──

app.post("/api/v1/credits/checkout", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ package_id: number; success_url?: string; cancel_url?: string }>();

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Stripe not configured" }, 503);
  }

  // Look up the package
  const sql = await getDb(c.env.DB);
  const [pkg] = await sql`
    SELECT * FROM credit_packages WHERE id = ${body.package_id} AND is_active = true
  `;
  if (!pkg) {
    await sql.end();
    return c.json({ error: "Package not found" }, 404);
  }

  // Get or create Stripe customer for this org
  const [org] = await sql`SELECT org_id, stripe_customer_id, name FROM orgs WHERE org_id = ${orgId}`;
  await sql.end();

  let customerId = org?.stripe_customer_id;
  if (!customerId) {
    // Create Stripe customer
    const customerResp = await fetch("https://api.stripe.com/v1/customers", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${c.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "metadata[org_id]": orgId,
        ...(org?.name ? { name: org.name } : {}),
      }),
    });
    const customer = await customerResp.json() as { id: string };
    customerId = customer.id;

    // Save customer ID
    const sql2 = await getDb(c.env.DB);
    await sql2`UPDATE orgs SET stripe_customer_id = ${customerId} WHERE org_id = ${orgId}`;
    await sql2.end();
  }

  // Create checkout session
  const params = new URLSearchParams({
    "mode": "payment",
    "customer": customerId,
    "line_items[0][quantity]": "1",
    "metadata[org_id]": orgId,
    "metadata[package_id]": String(pkg.id),
    "metadata[credits_usd]": String(pkg.credits_usd),
    ...(body.success_url ? { "success_url": body.success_url } : { "success_url": "https://app.oneshots.co/settings/billing?success=true" }),
    ...(body.cancel_url ? { "cancel_url": body.cancel_url } : { "cancel_url": "https://app.oneshots.co/settings/billing?cancelled=true" }),
  });

  // Use stripe_price_id if available, otherwise create a one-time price
  if (pkg.stripe_price_id) {
    params.set("line_items[0][price]", pkg.stripe_price_id);
  } else {
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][unit_amount]", String(Math.round(Number(pkg.price_usd) * 100)));
    params.set("line_items[0][price_data][product_data][name]", `${pkg.name} Credits`);
  }

  const sessionResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const session = await sessionResp.json() as { id: string; url: string };

  return c.json({ checkout_url: session.url, session_id: session.id });
});

// ── Stripe webhook (payment confirmation → credit topup) ──

app.post("/api/v1/webhooks/stripe", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: "Webhook not configured" }, 503);
  }

  // Verify Stripe signature
  const signature = c.req.header("stripe-signature") || "";
  const rawBody = await c.req.text();

  // Parse signature header
  const sigParts = Object.fromEntries(
    signature.split(",").map(p => p.trim().split("=", 2) as [string, string])
  );
  const timestamp = sigParts["t"];
  const sig = sigParts["v1"];
  if (!timestamp || !sig) return c.json({ error: "Invalid signature" }, 400);

  // Verify HMAC
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(c.env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expectedSig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expectedHex = [...new Uint8Array(expectedSig)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (expectedHex !== sig) return c.json({ error: "Invalid signature" }, 400);

  // Check timestamp freshness (5 min tolerance)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return c.json({ error: "Timestamp too old" }, 400);
  }

  const event = JSON.parse(rawBody) as { id: string; type: string; data: { object: any } };

  // Idempotency check
  const sql = await getDb(c.env.DB_ADMIN);
  const [existing] = await sql`
    SELECT event_id FROM stripe_events_processed WHERE event_id = ${event.id}
  `;
  if (existing) {
    await sql.end();
    return c.json({ received: true, duplicate: true });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orgId = session.metadata?.org_id;
    const creditsUsd = Number(session.metadata?.credits_usd || 0);
    const packageId = session.metadata?.package_id;

    if (orgId && creditsUsd > 0) {
      // Top up via BillingDO (atomic balance update)
      const billingDO = c.env.BILLING.get(c.env.BILLING.idFromName(orgId));
      await billingDO.fetch(new Request("http://internal/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: creditsUsd, description: `Credit purchase (package ${packageId})` }),
      }));

      // Record transaction in Postgres for history
      await sql`
        INSERT INTO credit_transactions (org_id, type, amount_usd, description, stripe_payment_intent_id)
        VALUES (${orgId}, 'purchase', ${creditsUsd}, ${`Package ${packageId}`}, ${session.payment_intent || ""})
      `;
    }
  }

  // Mark event as processed
  await sql`
    INSERT INTO stripe_events_processed (event_id, event_type) VALUES (${event.id}, ${event.type})
  `;
  await sql.end();

  return c.json({ received: true });
});

// ── Usage summary ──

app.get("/api/v1/usage", async (c) => {
  const orgId = c.get("orgId");
  const days = Number(c.req.query("days")) || 30;
  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT
      agent_name,
      COUNT(*) as session_count,
      COALESCE(SUM(cost_total_usd), 0) as total_cost
    FROM sessions
    WHERE org_id = ${orgId} AND created_at > NOW() - (${days} || ' days')::interval
    GROUP BY agent_name
    ORDER BY total_cost DESC
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

// ── Session turn history (written by Queue from DO telemetry) ──

app.get("/api/v1/sessions/:id/turns", async (c) => {
  const sessionId = c.req.param("id");
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);

  // Verify session belongs to this org
  const [session] = await sql`
    SELECT session_id FROM sessions WHERE session_id = ${sessionId} AND org_id = ${orgId}
  `;
  if (!session) {
    await sql.end();
    return c.json({ error: "Session not found" }, 404);
  }

  // Session metadata is in the sessions table; detailed turn-level data
  // comes from the session's metadata JSONB (populated by Queue consumer).
  // If detailed turn tracking is needed, the Queue consumer writes tool
  // execution events which we can query from the telemetry tables.
  // For now, return what we have from the session + any tool executions.
  const [detail] = await sql`
    SELECT * FROM sessions WHERE session_id = ${sessionId}
  `;
  await sql.end();

  // The session metadata JSONB may contain turns array if the Queue consumer
  // populates it. Return the full session with whatever detail is available.
  return c.json({
    session: detail,
    // Tool execution history would come from Analytics Engine or a
    // dedicated tool_executions table — defer to Tier 3 implementation
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONVERSATIONS (Pattern E: Postgres — relational source of truth)
//
// The Svelte UI expects full conversation CRUD + paginated messages.
// Postgres is the durable store; the Agent Core DO uses these for
// context but the gateway owns the lifecycle.
// ═══════════════════════════════════════════════════════════════════

// List conversations for an agent (cursor-paginated)
app.get("/api/v1/conversations", async (c) => {
  const orgId = c.get("orgId");
  const agentName = c.req.query("agent_name") || "";
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const cursor = c.req.query("cursor"); // ISO timestamp for keyset pagination

  const sql = await getDb(c.env.DB);
  let rows;
  if (cursor) {
    rows = await sql`
      SELECT id, org_id, user_id, agent_name, channel, title,
             message_count, total_cost_usd, created_at, updated_at
      FROM conversations
      WHERE org_id = ${orgId}
        AND agent_name = ${agentName}
        AND status != 'deleted'
        AND created_at < ${cursor}
      ORDER BY created_at DESC
      LIMIT ${limit + 1}
    `;
  } else {
    rows = await sql`
      SELECT id, org_id, user_id, agent_name, channel, title,
             message_count, total_cost_usd, created_at, updated_at
      FROM conversations
      WHERE org_id = ${orgId}
        AND agent_name = ${agentName}
        AND status != 'deleted'
      ORDER BY created_at DESC
      LIMIT ${limit + 1}
    `;
  }
  await sql.end();

  const hasMore = rows.length > limit;
  const conversations = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? conversations[conversations.length - 1].created_at : undefined;

  return c.json({ conversations, has_more: hasMore, cursor: nextCursor });
});

// Get messages for a conversation (keyset-paginated by id)
app.get("/api/v1/conversations/:id/messages", async (c) => {
  const orgId = c.get("orgId");
  const conversationId = c.req.param("id");
  const limit = Math.min(Number(c.req.query("limit")) || 100, 200);
  const afterId = Number(c.req.query("after_id")) || 0;

  const sql = await getDb(c.env.DB);

  // Verify conversation belongs to this org
  const [conv] = await sql`
    SELECT id FROM conversations
    WHERE id = ${conversationId} AND org_id = ${orgId} AND status != 'deleted'
  `;
  if (!conv) {
    await sql.end();
    return c.json({ error: "Conversation not found" }, 404);
  }

  const rows = afterId
    ? await sql`
        SELECT id, conversation_id, role, content, model, token_count,
               cost_usd, session_id, tool_calls, tool_results, metadata, created_at
        FROM conversation_messages
        WHERE conversation_id = ${conversationId} AND id > ${afterId}
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `
    : await sql`
        SELECT id, conversation_id, role, content, model, token_count,
               cost_usd, session_id, tool_calls, tool_results, metadata, created_at
        FROM conversation_messages
        WHERE conversation_id = ${conversationId}
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
  await sql.end();

  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  const nextAfterId = hasMore ? messages[messages.length - 1].id : undefined;

  return c.json({ messages, has_more: hasMore, after_id: nextAfterId });
});

// Create a new conversation
app.post("/api/v1/conversations", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<{ agent_name: string; channel?: string; title?: string }>();

  if (!body.agent_name) return c.json({ error: "agent_name required" }, 400);

  const sql = await getDb(c.env.DB);
  const [conv] = await sql`
    INSERT INTO conversations (org_id, user_id, agent_name, channel, title)
    VALUES (
      ${orgId},
      ${userId},
      ${body.agent_name},
      ${body.channel || "portal"},
      ${body.title || "New conversation"}
    )
    RETURNING id, org_id, user_id, agent_name, channel, title,
              message_count, total_cost_usd, created_at, updated_at
  `;
  await sql.end();
  return c.json(conv, 201);
});

// Update conversation (title)
app.put("/api/v1/conversations/:id", async (c) => {
  const orgId = c.get("orgId");
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ title?: string }>();

  const sql = await getDb(c.env.DB);
  const [conv] = await sql`
    UPDATE conversations
    SET title = COALESCE(${body.title || null}, title),
        updated_at = now()
    WHERE id = ${conversationId} AND org_id = ${orgId} AND status != 'deleted'
    RETURNING id, org_id, user_id, agent_name, channel, title,
              message_count, total_cost_usd, created_at, updated_at
  `;
  await sql.end();
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  return c.json(conv);
});

// Soft-delete a conversation
app.delete("/api/v1/conversations/:id", async (c) => {
  const orgId = c.get("orgId");
  const conversationId = c.req.param("id");

  const sql = await getDb(c.env.DB);
  await sql`
    UPDATE conversations SET status = 'deleted', updated_at = now()
    WHERE id = ${conversationId} AND org_id = ${orgId}
  `;
  await sql.end();
  return c.json({ deleted: conversationId });
});

// Legacy: get conversation history from Agent Core DO (for live session replay)
app.get("/api/v1/conversations/agent/:agentName/live", async (c) => {
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

// ═══════════════════════════════════════════════════════════════════
// CONVERSATION EXPORT (JSON, Markdown, PDF)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/conversations/:id/export", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const conversationId = c.req.param("id");
  const format = c.req.query("format") || "json";

  // Get conversation header from Postgres
  const sql = await getDb(c.env.DB);
  const [conv] = await sql`
    SELECT * FROM conversations
    WHERE id = ${conversationId} AND org_id = ${orgId} AND status != 'deleted'
  `;
  if (!conv) {
    await sql.end();
    return c.json({ error: "Conversation not found" }, 404);
  }
  await sql.end();

  // Fetch messages from Agent Core DO (source of truth for message content)
  const doName = buildDoName(orgId, conv.agent_name, userId);
  const messagesResp = await c.env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/chat-agent/${doName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "getConversationMessages", conversationId }),
    }),
  );

  let messages: any[] = [];
  try {
    const data = await messagesResp.json() as any;
    messages = data.messages || data || [];
  } catch {
    // If DO doesn't support this RPC yet, check if archived in R2
    if (conv.r2_archive_key) {
      const archived = await c.env.STORAGE.get(conv.r2_archive_key);
      if (archived) {
        const data = await archived.json() as any;
        messages = data.messages || [];
      }
    }
  }

  if (format === "json") {
    return c.json({
      conversation: conv,
      messages,
      exported_at: new Date().toISOString(),
    });
  }

  if (format === "markdown") {
    const lines = [
      `# ${conv.title || "Conversation"}`,
      `**Agent:** ${conv.agent_name} | **Date:** ${conv.created_at} | **Cost:** $${Number(conv.total_cost_usd || 0).toFixed(4)}`,
      "",
      "---",
      "",
    ];
    for (const msg of messages) {
      const role = msg.role === "assistant" ? "**Assistant**" : msg.role === "user" ? "**You**" : `**${msg.role}**`;
      lines.push(`### ${role}`);
      lines.push("");
      lines.push(msg.content || "");
      lines.push("");
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${conv.title || conversationId}.md"`,
      },
    });
  }

  // PDF — generate structured HTML, return as downloadable
  // Uses a simple HTML template that browsers/tools can convert to PDF
  if (format === "pdf") {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${conv.title || "Conversation"}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; border-bottom: 2px solid #e5e5e5; padding-bottom: 0.5rem; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 2rem; }
  .message { margin-bottom: 1.5rem; padding: 1rem; border-radius: 8px; }
  .user { background: #f0f4ff; border-left: 3px solid #3b82f6; }
  .assistant { background: #f0fdf4; border-left: 3px solid #22c55e; }
  .system { background: #fefce8; border-left: 3px solid #eab308; font-style: italic; }
  .tool { background: #f5f5f5; border-left: 3px solid #a3a3a3; font-family: monospace; font-size: 0.85rem; }
  .role { font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  pre { white-space: pre-wrap; word-break: break-word; }
</style></head><body>
<h1>${conv.title || "Conversation"}</h1>
<div class="meta">Agent: ${conv.agent_name} · ${conv.created_at} · Cost: $${Number(conv.total_cost_usd || 0).toFixed(4)} · ${messages.length} messages</div>
${messages.map((msg: any) => `
<div class="message ${msg.role}">
  <div class="role">${msg.role}</div>
  <pre>${(msg.content || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
</div>`).join("")}
</body></html>`;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${conv.title || conversationId}.html"`,
      },
    });
  }

  return c.json({ error: "Format must be json, markdown, or pdf" }, 400);
});

// ═══════════════════════════════════════════════════════════════════
// TRACE VIEWER (detailed session debugging)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/sessions/:id/trace", async (c) => {
  const orgId = c.get("orgId");
  const sessionId = c.req.param("id");
  const sql = await getDb(c.env.DB);

  const [session] = await sql`
    SELECT * FROM sessions WHERE session_id = ${sessionId} AND org_id = ${orgId}
  `;
  if (!session) {
    await sql.end();
    return c.json({ error: "Session not found" }, 404);
  }

  // Build timeline from session metadata (written by Queue consumer)
  // The metadata JSONB contains structured events from the agent's lifecycle hooks
  const metadata = session.metadata || {};
  const events = metadata.events || [];

  await sql.end();

  return c.json({
    session: {
      id: session.id,
      agent_name: session.agent_name,
      model: session.model,
      status: session.status,
      turn_count: session.turn_count,
      tool_call_count: session.tool_call_count,
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
      cost_usd: session.cost_usd,
      duration_ms: session.duration_ms,
      error: session.error,
      created_at: session.created_at,
      completed_at: session.completed_at,
    },
    timeline: events,
    // Cost breakdown by step
    cost_breakdown: metadata.cost_breakdown || null,
  });
});

// ═══════════════════════════════════════════════════════════════════
// VOICE CONFIG (Pattern E: Postgres + Agent Core DO)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/agents/:name/voice-config", async (c) => {
  const orgId = c.get("orgId");
  const agentName = c.req.param("name");
  const sql = await getDb(c.env.DB);
  const [agent] = await sql`
    SELECT config FROM agents WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true
  `;
  await sql.end();
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const config = agent.config || {};
  return c.json({
    enabled: config.voice?.enabled || false,
    stt_model: config.voice?.stt_model || "deepgram-nova-3",
    tts_voice: config.voice?.tts_voice || "aura-asteria-en",
    greeting: config.voice?.greeting || "",
    phone_number: config.voice?.phone_number || null,
    language: config.voice?.language || "en",
    interrupt_enabled: config.voice?.interrupt_enabled ?? true,
    silence_timeout_ms: config.voice?.silence_timeout_ms || 2000,
  });
});

app.put("/api/v1/agents/:name/voice-config", async (c) => {
  const orgId = c.get("orgId");
  const agentName = c.req.param("name");
  const body = await c.req.json<{
    enabled?: boolean; stt_model?: string; tts_voice?: string;
    greeting?: string; phone_number?: string; language?: string;
    interrupt_enabled?: boolean; silence_timeout_ms?: number;
  }>();

  const sql = await getDb(c.env.DB);
  // Read current config, merge voice section
  const [agent] = await sql`
    SELECT config FROM agents WHERE name = ${agentName} AND org_id = ${orgId} AND is_active = true
  `;
  if (!agent) {
    await sql.end();
    return c.json({ error: "Agent not found" }, 404);
  }

  const config = agent.config || {};
  config.voice = { ...(config.voice || {}), ...body };

  const [updated] = await sql`
    UPDATE agents SET config = ${JSON.stringify(config)}::jsonb, updated_at = NOW()
    WHERE name = ${agentName} AND org_id = ${orgId}
    RETURNING config
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `agent:${orgId}:${agentName}`, `agents:${orgId}`);

  return c.json(updated.config.voice);
});

// ── Agent suggestions (dynamic prompts for empty chat) ──

app.get("/api/v1/agents/:name/suggestions", async (c) => {
  const agentName = c.req.param("name");
  const orgId = c.get("orgId");
  const suggestions = await kvCached(c.env.CACHE, `suggestions:${orgId}:${agentName}`, 300, async () => {
    const sql = await getDb(c.env.DB);
    const [agent] = await sql`
      SELECT config FROM agents WHERE name = ${agentName} AND org_id = ${orgId}
    `;
    await sql.end();
    const config = agent?.config || {};
    // Use configured suggestions or return empty (UI falls back to defaults)
    return config.suggestions || [];
  });
  return c.json({ suggestions });
});

// ── Dashboard (Pattern C: Analytics Engine aggregations) ──

app.get("/api/v1/dashboard/stats", async (c) => {
  const orgId = c.get("orgId");
  try {
    const stats = await kvCached(c.env.CACHE, `dashboard:${orgId}`, 60, async () => {
      const sql = await getDb(c.env.DB);
      // Two simple queries — avoids cross-join subselect issues
      const agentRows = await sql`
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active = true) AS live
        FROM agents WHERE org_id = ${orgId}
      `;
      const sessionRows = await sql`
        SELECT
          COUNT(*) AS total_sessions,
          COUNT(*) FILTER (WHERE status = 'running') AS active_sessions,
          COALESCE(SUM(cost_total_usd), 0) AS total_cost_usd,
          COALESCE(AVG(wall_clock_seconds) * 1000, 0) AS avg_latency_ms,
          CASE WHEN COUNT(*) > 0
            THEN ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / COUNT(*), 2)
            ELSE 0
          END AS error_rate_pct
        FROM sessions
        WHERE org_id = ${orgId} AND created_at > now() - interval '24 hours'
      `;
      await sql.end();
      const a = agentRows[0] || {};
      const s = sessionRows[0] || {};
      return {
        total_agents: Number(a.total ?? 0),
        live_agents: Number(a.live ?? 0),
        total_sessions: Number(s.total_sessions ?? 0),
        active_sessions: Number(s.active_sessions ?? 0),
        total_cost_usd: Number(s.total_cost_usd ?? 0),
        avg_latency_ms: Math.round(Number(s.avg_latency_ms ?? 0)),
        error_rate_pct: Number(s.error_rate_pct ?? 0),
      };
    });
    return c.json(stats);
  } catch (err) {
    console.error("[dashboard/stats]", err);
    return c.json({ error: "Failed to load stats", detail: String(err) }, 500);
  }
});

app.get("/api/v1/dashboard/activity", async (c) => {
  const orgId = c.get("orgId");
  const limit = Math.min(Number(c.req.query("limit")) || 10, 50);
  try {
    const items = await kvCached(c.env.CACHE, `activity:${orgId}:${limit}`, 60, async () => {
      const sql = await getDb(c.env.DB);
      const rows = await sql`
        SELECT
          session_id AS id,
          CASE status WHEN 'failed' THEN 'error' ELSE 'session' END AS type,
          agent_name || CASE status
            WHEN 'completed' THEN ' completed a session'
            WHEN 'failed'    THEN ' session failed'
            WHEN 'running'   THEN ' session started'
            ELSE ' session ' || status
          END AS message,
          agent_name,
          created_at
        FROM sessions
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      await sql.end();
      return rows;
    });
    return c.json({ items });
  } catch (err) {
    console.error("[dashboard/activity]", err);
    return c.json({ items: [], error: String(err) }, 200);
  }
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
    VALUES (${body.name || ''}, ${body.type || 'input'}, ${JSON.stringify(body.config)}::jsonb, ${orgId})
    RETURNING *
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `guardrails:${orgId}`);
  return c.json(rule, 201);
});

app.put("/api/v1/guardrails/:id", async (c) => {
  const orgId = c.get("orgId");
  const ruleId = c.req.param("id");
  const body = await c.req.json<{ name?: string; config?: Record<string, unknown>; is_active?: boolean }>();
  const sql = await getDb(c.env.DB);
  const [rule] = await sql`
    UPDATE guardrail_rules SET
      name = COALESCE(${body.name || null}, name),
      config = COALESCE(${body.config ? JSON.stringify(body.config) : null}::jsonb, config),
      is_active = COALESCE(${body.is_active ?? null}, is_active)
    WHERE id = ${ruleId} AND org_id = ${orgId}
    RETURNING *
  `;
  await sql.end();
  if (!rule) return c.json({ error: "Rule not found" }, 404);
  await kvInvalidate(c.env.CACHE, `guardrails:${orgId}`);
  return c.json(rule);
});

app.delete("/api/v1/guardrails/:id", async (c) => {
  const orgId = c.get("orgId");
  const ruleId = c.req.param("id");
  const sql = await getDb(c.env.DB);
  await sql`DELETE FROM guardrail_rules WHERE id = ${ruleId} AND org_id = ${orgId}`;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `guardrails:${orgId}`);
  return c.json({ deleted: ruleId });
});

// ═══════════════════════════════════════════════════════════════════
// SKILLS (Pattern E: Postgres + KV cache)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/skills", async (c) => {
  const orgId = c.get("orgId");
  const skills = await kvCached(c.env.CACHE, `skills:${orgId}`, 120, async () => {
    const sql = await getDb(c.env.DB);
    const rows = await sql`
      SELECT skill_id, name, description, category, is_active, created_at
      FROM skills
      WHERE (org_id = ${orgId} OR org_id IS NULL) AND is_active = true
      ORDER BY name
    `;
    await sql.end();
    return rows;
  });
  return c.json(skills);
});

app.post("/api/v1/skills", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ name: string; description: string; content: string }>();
  if (!body.name || !body.content) return c.json({ error: "Name and content required" }, 400);
  const sql = await getDb(c.env.DB);
  const [skill] = await sql`
    INSERT INTO skills (org_id, name, description, prompt_template)
    VALUES (${orgId}, ${body.name}, ${body.description || ""}, ${body.content})
    RETURNING skill_id, name, description, is_active, created_at
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `skills:${orgId}`);
  return c.json(skill, 201);
});

app.put("/api/v1/skills/:id", async (c) => {
  const orgId = c.get("orgId");
  const skillId = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string; content?: string; is_active?: boolean }>();
  const sql = await getDb(c.env.DB);
  const [skill] = await sql`
    UPDATE skills SET
      name = COALESCE(${body.name || null}, name),
      description = COALESCE(${body.description || null}, description),
      prompt_template = COALESCE(${body.content || null}, prompt_template),
      is_active = COALESCE(${body.is_active ?? null}, is_active),
      updated_at = NOW()
    WHERE skill_id = ${skillId} AND org_id = ${orgId}
    RETURNING skill_id, name, description, is_active, created_at
  `;
  await sql.end();
  if (!skill) return c.json({ error: "Skill not found" }, 404);
  await kvInvalidate(c.env.CACHE, `skills:${orgId}`);
  return c.json(skill);
});

app.delete("/api/v1/skills/:id", async (c) => {
  const orgId = c.get("orgId");
  const skillId = c.req.param("id");
  const sql = await getDb(c.env.DB);
  await sql`DELETE FROM skills WHERE skill_id = ${skillId} AND org_id = ${orgId}`;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `skills:${orgId}`);
  return c.json({ deleted: skillId });
});

// ═══════════════════════════════════════════════════════════════════
// AUTH (Pattern A: KV + Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

// ── JWT helpers ──

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial, 256,
  );
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial, 256,
  );
  const computed = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
  return computed === hashHex;
}

async function signJwt(payload: Record<string, unknown>, secret: string, expiresInSec = 86400): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=/g, "");
  const now = Math.floor(Date.now() / 1000);
  const body = btoa(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec })).replace(/=/g, "");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${header}.${body}.${sigB64}`;
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── Auth: Login ──

app.post("/api/v1/auth/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  if (!body.email || !body.password) return c.json({ error: "Email and password required" }, 400);

  const sql = await getDb(c.env.DB_ADMIN);
  // Old schema: users has no org_id — join with org_members to get it
  const [user] = await sql`
    SELECT u.user_id, u.email, u.password_hash, u.is_active, m.org_id
    FROM users u
    LEFT JOIN org_members m ON m.user_id = u.user_id
    WHERE u.email = ${body.email.toLowerCase().trim()}
    LIMIT 1
  `;
  await sql.end();

  if (!user || !user.is_active) return c.json({ error: "Invalid credentials" }, 401);
  if (!user.password_hash || !(await verifyPassword(body.password, user.password_hash))) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const secret = c.env.JWT_SECRET || "dev-secret-change-me";
  const token = await signJwt({ user_id: user.user_id, org_id: user.org_id || "", email: user.email }, secret);

  await c.env.CACHE.put(`auth:${token.slice(-16)}`, JSON.stringify({
    orgId: user.org_id || "", userId: user.user_id, scopes: ["*"],
  }), { expirationTtl: 86400 });

  return c.json({ token, user_id: user.user_id, org_id: user.org_id || "", email: user.email });
});

// ── Auth: Signup ──

app.post("/api/v1/auth/signup", async (c) => {
  const body = await c.req.json<{ name: string; email: string; password: string; referral_code?: string }>();
  if (!body.email || !body.password || !body.name) {
    return c.json({ error: "Name, email, and password required" }, 400);
  }
  if (body.password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  const email = body.email.toLowerCase().trim();
  const passwordHash = await hashPassword(body.password);
  const slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-").slice(0, 30) + "-" + crypto.randomUUID().slice(0, 4);

  const sql = await getDb(c.env.DB_ADMIN);
  try {
    // Create org + user in a transaction
    // Old schema: users table has no org_id column.
    // Org membership is in org_members join table.
    const [org] = await sql`
      INSERT INTO orgs (name, slug) VALUES (${body.name}, ${slug}) RETURNING org_id
    `;
    const orgId = org.org_id;
    const [user] = await sql`
      INSERT INTO users (email, name, password_hash)
      VALUES (${email}, ${body.name}, ${passwordHash})
      RETURNING user_id, email
    `;
    const userId = user.user_id;
    await sql`
      INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'owner')
    `;
    await sql`UPDATE orgs SET owner_user_id = ${userId} WHERE org_id = ${orgId}`;
    await sql.end();

    const secret = c.env.JWT_SECRET || "dev-secret-change-me";
    const token = await signJwt({ user_id: userId, org_id: orgId, email: user.email }, secret);

    await c.env.CACHE.put(`auth:${token.slice(-16)}`, JSON.stringify({
      orgId, userId, scopes: ["*"],
    }), { expirationTtl: 86400 });

    return c.json({ token, user_id: userId, org_id: orgId, email: user.email }, 201);
  } catch (err: any) {
    await sql.end();
    if (err.message?.includes("unique") || err.message?.includes("duplicate")) {
      return c.json({ error: "Email already registered" }, 409);
    }
    // Temporary: return error details for debugging signup issues
    return c.json({ error: "Signup failed", detail: err.message?.slice(0, 500) || String(err) }, 500);
  }
});

// ── Auth: Forgot Password ──

app.post("/api/v1/auth/forgot-password", async (c) => {
  const body = await c.req.json<{ email: string }>();
  if (!body.email) return c.json({ error: "Email required" }, 400);

  const sql = await getDb(c.env.DB_ADMIN);
  const [user] = await sql`SELECT user_id FROM users WHERE email = ${body.email.toLowerCase().trim()} AND is_active = true`;
  if (user) {
    const [token] = await sql`
      INSERT INTO password_reset_tokens (user_id) VALUES (${user.user_id}) RETURNING token
    `;
    // TODO: send email via MailChannels or SES with reset link containing token.token
    // For now, log it (in production, NEVER log tokens)
    console.log(`[auth] Password reset token for ${body.email}: ${token.token}`);
  }
  await sql.end();
  // Always return 200 to prevent email enumeration
  return c.json({ message: "If that email exists, a reset link has been sent." });
});

// ── Auth: Reset Password ──

app.post("/api/v1/auth/reset-password", async (c) => {
  const body = await c.req.json<{ token: string; password: string }>();
  if (!body.token || !body.password) return c.json({ error: "Token and password required" }, 400);
  if (body.password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  const sql = await getDb(c.env.DB_ADMIN);
  const [resetToken] = await sql`
    SELECT user_id FROM password_reset_tokens
    WHERE token = ${body.token} AND expires_at > NOW()
  `;
  if (!resetToken) {
    await sql.end();
    return c.json({ error: "Invalid or expired reset token" }, 400);
  }

  const passwordHash = await hashPassword(body.password);
  await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = NOW() WHERE user_id = ${resetToken.user_id}`;
  await sql`DELETE FROM password_reset_tokens WHERE token = ${body.token}`;
  await sql.end();

  return c.json({ message: "Password updated successfully" });
});

// ── Auth: Verify Email ──

app.post("/api/v1/auth/verify-email", async (c) => {
  const body = await c.req.json<{ token: string }>();
  if (!body.token) return c.json({ error: "Token required" }, 400);

  const sql = await getDb(c.env.DB_ADMIN);
  const [verifyToken] = await sql`
    SELECT user_id FROM email_verification_tokens
    WHERE token = ${body.token} AND expires_at > NOW()
  `;
  if (!verifyToken) {
    await sql.end();
    return c.json({ error: "Invalid or expired verification token" }, 400);
  }

  await sql`UPDATE users SET email_verified = true, updated_at = NOW() WHERE user_id = ${verifyToken.user_id}`;
  await sql`DELETE FROM email_verification_tokens WHERE token = ${body.token}`;
  await sql.end();

  return c.json({ message: "Email verified successfully" });
});

// ── Auth: Get current user ──

app.get("/api/v1/auth/me", async (c) => {
  const userId = c.get("userId");
  const orgId = c.get("orgId");
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const sql = await getDb(c.env.DB);
  const [user] = await sql`
    SELECT user_id, email, name, avatar_url, email_verified, created_at
    FROM users WHERE user_id = ${userId}
  `;
  await sql.end();
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({ ...user, org_id: orgId });
});

app.get("/api/v1/api-keys", async (c) => {
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT key_id, name, key_prefix as prefix, scopes, created_at FROM api_keys
    WHERE org_id = ${orgId} AND (revoked = false OR revoked IS NULL) AND is_active = true
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
    INSERT INTO api_keys (name, key_hash, key_prefix, scopes, org_id, user_id)
    VALUES (
      ${body.name},
      encode(digest(${key}, 'sha256'), 'hex'),
      ${key.slice(0, 8)},
      ${JSON.stringify(body.scopes || ["agent:read", "agent:write"])}::jsonb,
      ${orgId},
      ${c.get("userId")}
    )
    RETURNING key_id, name, key_prefix as prefix, scopes, created_at
  `;
  await sql.end();
  return c.json({ ...row, key }, 201); // key returned only once
});

app.delete("/api/v1/api-keys/:id", async (c) => {
  const orgId = c.get("orgId");
  const keyId = c.req.param("id");
  const sql = await getDb(c.env.DB);
  await sql`
    UPDATE api_keys SET revoked = true, updated_at = NOW()
    WHERE key_id = ${keyId} AND org_id = ${orgId} AND (revoked = false OR revoked IS NULL)
  `;
  await sql.end();
  // Invalidate any cached auth entries for this key
  // (Can't easily find the cache key without the raw key, but TTL handles it within 5min)
  return c.json({ revoked: keyId });
});

// ═══════════════════════════════════════════════════════════════════
// ORGS (Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/orgs/current", async (c) => {
  const orgId = c.get("orgId");
  const org = await kvCached(c.env.CACHE, `org:${orgId}`, 300, async () => {
    const sql = await getDb(c.env.DB);
    const [row] = await sql`SELECT * FROM orgs WHERE org_id = ${orgId}`;
    await sql.end();
    return row;
  });
  return c.json(org);
});

app.put("/api/v1/orgs/current", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ name?: string; settings?: Record<string, unknown> }>();
  const sql = await getDb(c.env.DB);
  const [org] = await sql`
    UPDATE orgs SET
      name = COALESCE(${body.name || null}, name),
      settings = COALESCE(${body.settings ? JSON.stringify(body.settings) : null}::jsonb, settings),
      updated_at = NOW()
    WHERE org_id = ${orgId}
    RETURNING *
  `;
  await sql.end();
  await kvInvalidate(c.env.CACHE, `org:${orgId}`);
  return c.json(org);
});

// ── Org Members (RBAC) ──

app.get("/api/v1/orgs/current/members", async (c) => {
  const orgId = c.get("orgId");
  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.avatar_url, m.role, m.created_at
    FROM org_members m JOIN users u ON m.user_id = u.id
    WHERE m.org_id = ${orgId}
    ORDER BY m.created_at
  `;
  await sql.end();
  return c.json(rows);
});

app.post("/api/v1/orgs/current/members", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{ email: string; role?: string }>();
  if (!body.email) return c.json({ error: "Email required" }, 400);

  const role = body.role || "member";
  if (!["admin", "member", "viewer"].includes(role)) {
    return c.json({ error: "Role must be admin, member, or viewer" }, 400);
  }

  const sql = await getDb(c.env.DB);
  // Find user by email
  const [user] = await sql`SELECT id FROM users WHERE email = ${body.email.toLowerCase().trim()}`;
  if (!user) {
    await sql.end();
    return c.json({ error: "User not found. They must sign up first." }, 404);
  }

  try {
    await sql`
      INSERT INTO org_members (org_id, user_id, role) VALUES (${orgId}, ${user.id}, ${role})
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = ${role}
    `;
    await sql.end();
    return c.json({ user_id: user.id, role }, 201);
  } catch (err: any) {
    await sql.end();
    throw err;
  }
});

app.delete("/api/v1/orgs/current/members/:userId", async (c) => {
  const orgId = c.get("orgId");
  const targetUserId = c.req.param("userId");

  // Prevent removing the org owner
  const sql = await getDb(c.env.DB);
  const [org] = await sql`SELECT owner_user_id FROM orgs WHERE org_id = ${orgId}`;
  if (org?.owner_user_id === targetUserId) {
    await sql.end();
    return c.json({ error: "Cannot remove org owner" }, 403);
  }

  await sql`DELETE FROM org_members WHERE org_id = ${orgId} AND user_id = ${targetUserId}`;
  await sql.end();
  return c.json({ removed: targetUserId });
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
  if (!body.agent_name) return c.json({ error: "agent_name required" }, 400);

  const sql = await getDb(c.env.DB);
  const [run] = await sql`
    INSERT INTO eval_runs (agent_name, config, org_id, status)
    VALUES (${body.agent_name}, ${JSON.stringify(body.config || {})}::jsonb, ${orgId}, 'pending')
    RETURNING *
  `;
  await sql.end();

  // Send to queue for async execution by the agent-harness worker
  try {
    await c.env.BILLING_QUEUE.send({
      type: "eval_run",
      payload: { run_id: run.id, agent_name: body.agent_name, org_id: orgId },
    });
  } catch {
    // Queue send failed — eval stays in pending state, can be retried
  }

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
      SELECT flag_name as name, is_active as enabled, value as config FROM feature_flags
      WHERE org_id = ${orgId}
    `;
    await sql.end();
    return Object.fromEntries(rows.map((r: any) => [r.name, { enabled: r.enabled, config: r.config }]));
  });
  return c.json(features);
});

// ═══════════════════════════════════════════════════════════════════
// MARKETPLACE (Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/marketplace/search", async (c) => {
  const category = c.req.query("category") || "";
  const query = c.req.query("q") || "";
  const sort = c.req.query("sort") || "quality_score";
  const limit = Math.min(Number(c.req.query("limit")) || 20, 50);
  const offset = Number(c.req.query("offset")) || 0;

  const sql = await getDb(c.env.DB);
  const rows = await sql`
    SELECT id, org_id, agent_name, title, description, category,
           quality_score, total_tasks_completed, created_at
    FROM marketplace_listings
    WHERE is_published = true
      AND (${category} = '' OR category = ${category})
      AND (${query} = '' OR title ILIKE ${"%" + query + "%"} OR description ILIKE ${"%" + query + "%"})
    ORDER BY quality_score DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `;
  await sql.end();
  return c.json({ listings: rows, limit, offset });
});

app.get("/api/v1/marketplace/categories", (c) => {
  return c.json([
    "general", "research", "coding", "data-analysis", "customer-support",
    "writing", "marketing", "sales", "legal", "finance", "education",
    "devops", "design", "productivity",
  ]);
});

app.get("/api/v1/marketplace/:id", async (c) => {
  const listingId = c.req.param("id");
  const sql = await getDb(c.env.DB);
  const [listing] = await sql`
    SELECT l.*, COALESCE(AVG(r.score), 0) as avg_rating, COUNT(r.id) as rating_count
    FROM marketplace_listings l
    LEFT JOIN marketplace_ratings r ON r.listing_id = l.id
    WHERE l.id = ${listingId} AND l.status = 'published'
    GROUP BY l.id
  `;
  await sql.end();
  if (!listing) return c.json({ error: "Listing not found" }, 404);
  return c.json(listing);
});

app.post("/api/v1/marketplace/publish", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{
    agent_name: string; title: string; description?: string;
    category?: string; price_usd?: number;
  }>();
  if (!body.agent_name || !body.title) return c.json({ error: "agent_name and title required" }, 400);

  const sql = await getDb(c.env.DB);
  // Verify agent exists and belongs to this org
  const [agent] = await sql`
    SELECT name, config FROM agents WHERE name = ${body.agent_name} AND org_id = ${orgId} AND is_active = true
  `;
  if (!agent) {
    await sql.end();
    return c.json({ error: "Agent not found" }, 404);
  }

  const [listing] = await sql`
    INSERT INTO marketplace_listings (org_id, agent_name, title, description, category, is_published)
    VALUES (${orgId}, ${body.agent_name}, ${body.title}, ${body.description || ""}, ${body.category || "general"}, true)
    RETURNING *
  `;
  await sql.end();
  return c.json(listing, 201);
});

app.post("/api/v1/marketplace/:id/rate", async (c) => {
  const userId = c.get("userId");
  const listingId = c.req.param("id");
  const body = await c.req.json<{ score: number; review?: string }>();
  if (!body.score || body.score < 1 || body.score > 5) {
    return c.json({ error: "Score must be 1-5" }, 400);
  }

  const sql = await getDb(c.env.DB);
  const [rating] = await sql`
    INSERT INTO marketplace_ratings (listing_id, rater_org_id, rating, review_text)
    VALUES (${listingId}, ${c.get("orgId")}, ${body.score}, ${body.review || ""})
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  // Update quality_score (rolling average)
  await sql`
    UPDATE marketplace_listings SET
      avg_rating = COALESCE((SELECT AVG(rating) FROM marketplace_ratings WHERE listing_id = ${listingId}), 0),
      total_ratings = (SELECT COUNT(*) FROM marketplace_ratings WHERE listing_id = ${listingId})
    WHERE id = ${listingId}
  `;
  await sql.end();
  return c.json(rating);
});

// Install/clone an agent from the marketplace into the user's org
app.post("/api/v1/marketplace/:id/install", async (c) => {
  const orgId = c.get("orgId");
  const listingId = c.req.param("id");
  const body = await c.req.json<{ name?: string }>();

  const sql = await getDb(c.env.DB);
  const [listing] = await sql`
    SELECT * FROM marketplace_listings WHERE id = ${listingId} AND is_published = true
  `;
  if (!listing) {
    await sql.end();
    return c.json({ error: "Listing not found" }, 404);
  }

  // Clone agent with optional rename
  const agentName = body.name || `${listing.agent_name}-clone`;
  const [agent] = await sql`
    INSERT INTO agents (name, description, config, org_id)
    VALUES (${agentName}, ${listing.description || ""}, ${JSON.stringify(listing.config || {})}::jsonb, ${orgId})
    RETURNING *
  `;

  // Increment install count
  await sql`UPDATE marketplace_listings SET total_tasks_completed = total_tasks_completed + 1 WHERE id = ${listingId}`;
  await sql.end();

  await kvInvalidate(c.env.CACHE, `agents:${orgId}`);

  return c.json({ agent, listing_id: listingId }, 201);
});

// ═══════════════════════════════════════════════════════════════════
// RAG DOCUMENTS (Pattern E: Postgres metadata + R2 storage)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/rag/:agent/documents", async (c) => {
  const orgId = c.get("orgId");
  const agentName = c.req.param("agent");
  // RAG document metadata stored alongside agent config.
  // Full documents live in R2 at: rag/{orgId}/{agentName}/{docId}
  const prefix = `rag/${orgId}/${agentName}/`;
  const listed = await c.env.STORAGE.list({ prefix, limit: 100 });
  const docs = listed.objects.map(obj => ({
    key: obj.key.replace(prefix, ""),
    size: obj.size,
    uploaded: obj.uploaded,
  }));
  return c.json({ documents: docs, agent_name: agentName });
});

app.post("/api/v1/rag/:agent/documents", async (c) => {
  const orgId = c.get("orgId");
  const agentName = c.req.param("agent");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file field required" }, 400);

  const docId = crypto.randomUUID().slice(0, 8);
  const r2Key = `rag/${orgId}/${agentName}/${docId}-${file.name}`;

  // Upload to R2
  await c.env.STORAGE.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { orgId, agentName, originalName: file.name },
  });

  // Queue chunking + Vectorize embedding job (processed by agent-harness worker)
  try {
    await c.env.BILLING_QUEUE.send({
      type: "rag_embed",
      payload: { r2_key: r2Key, org_id: orgId, agent_name: agentName },
    });
  } catch {} // non-blocking — document is stored regardless

  return c.json({ key: r2Key, name: file.name, size: file.size, embedding_queued: true }, 201);
});

app.delete("/api/v1/rag/:agent/documents/:key", async (c) => {
  const orgId = c.get("orgId");
  const agentName = c.req.param("agent");
  const key = c.req.param("key");
  const r2Key = `rag/${orgId}/${agentName}/${key}`;
  await c.env.STORAGE.delete(r2Key);
  // TODO: Remove corresponding Vectorize embeddings
  return c.json({ deleted: key });
});

// ═══════════════════════════════════════════════════════════════════
// EVAL (complete lifecycle — Pattern E: Postgres)
// ═══════════════════════════════════════════════════════════════════

app.get("/api/v1/eval/test-cases", async (c) => {
  const orgId = c.get("orgId");
  const agentName = c.req.query("agent_name") || "";
  const sql = await getDb(c.env.DB);
  const rows = agentName
    ? await sql`
        SELECT * FROM eval_test_cases WHERE org_id = ${orgId} AND agent_name = ${agentName}
        ORDER BY created_at DESC
      `
    : await sql`
        SELECT * FROM eval_test_cases WHERE org_id = ${orgId}
        ORDER BY created_at DESC LIMIT 100
      `;
  await sql.end();
  return c.json(rows);
});

app.post("/api/v1/eval/test-cases", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<{
    agent_name: string; name?: string; input: string; expected?: string;
    rubric?: Record<string, unknown>; tags?: string[];
  }>();
  if (!body.agent_name || !body.input) return c.json({ error: "agent_name and input required" }, 400);

  const sql = await getDb(c.env.DB);
  const [tc] = await sql`
    INSERT INTO eval_test_cases (org_id, agent_name, name, input, expected, rubric, tags)
    VALUES (${orgId}, ${body.agent_name}, ${body.name || ""}, ${body.input},
            ${body.expected || null}, ${JSON.stringify(body.rubric || {})}, ${JSON.stringify(body.tags || [])})
    RETURNING *
  `;
  await sql.end();
  return c.json(tc, 201);
});

app.get("/api/v1/eval/runs/:id/results", async (c) => {
  const orgId = c.get("orgId");
  const runId = c.req.param("id");
  const sql = await getDb(c.env.DB);

  const [run] = await sql`SELECT * FROM eval_runs WHERE eval_run_id = ${runId} AND org_id = ${orgId}`;
  if (!run) {
    await sql.end();
    return c.json({ error: "Run not found" }, 404);
  }

  const trials = await sql`
    SELECT * FROM eval_trials WHERE eval_run_id = ${runId} ORDER BY id
  `;
  await sql.end();

  return c.json({
    run,
    trials,
    summary: {
      total: trials.length,
      passed: trials.filter((t: any) => t.passed).length,
      failed: trials.filter((t: any) => t.passed === false).length,
      avg_score: trials.length > 0
        ? trials.reduce((sum: number, t: any) => sum + (Number(t.score) || 0), 0) / trials.length
        : 0,
      total_cost: trials.reduce((sum: number, t: any) => sum + (Number(t.cost_usd) || 0), 0),
    },
  });
});

// ═══════════════════════════════════════════════════════════════════
// MCP SERVER MANAGEMENT (Pattern D: proxy @callable to Agent Core DO)
//
// The Svelte UI manages MCP servers via these REST endpoints.
// Each call proxies to the ChatAgent DO's @callable methods:
//   addServer, removeServer, listServers, storeConnectorToken
// ═══════════════════════════════════════════════════════════════════

// Helper: call a @callable method on the agent DO via service binding
async function callAgentMethod(env: Env, orgId: string, agentName: string, userId: string, method: string, args: unknown[]) {
  const doName = buildDoName(orgId, agentName, userId);
  const resp = await env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/chat-agent/${doName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "rpc", method, args }),
    }),
  );
  return resp;
}

// List connected MCP servers for an agent
app.get("/api/v1/agents/:name/mcp/servers", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "listServers", []);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Connect a new MCP server
app.post("/api/v1/agents/:name/mcp/servers", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const body = await c.req.json<{ name: string; url: string }>();
  if (!body.name || !body.url) return c.json({ error: "name and url required" }, 400);
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "addServer", [body.name, body.url]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Disconnect an MCP server
app.delete("/api/v1/agents/:name/mcp/servers/:serverId", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const serverId = c.req.param("serverId");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "removeServer", [serverId]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Store OAuth token for a connector
app.post("/api/v1/agents/:name/mcp/tokens", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const body = await c.req.json<{ connector_id: string; token: string; refresh_token?: string; expires_in?: number }>();
  if (!body.connector_id || !body.token) return c.json({ error: "connector_id and token required" }, 400);
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "storeConnectorToken", [
    body.connector_id, body.token, body.refresh_token, body.expires_in,
  ]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Get skill overlays for an agent (proxy to DO)
app.get("/api/v1/agents/:name/skills/:skillName/overlays", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const skillName = c.req.param("skillName");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "getSkillOverlays", [skillName]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Append a skill overlay rule (proxy to DO)
app.post("/api/v1/agents/:name/skills/:skillName/overlays", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const skillName = c.req.param("skillName");
  const body = await c.req.json<{ rule: string; reason?: string }>();
  if (!body.rule) return c.json({ error: "rule required" }, 400);
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "appendSkillRule", [
    skillName, body.rule, "human", body.reason || "",
  ]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Get skill audit trail (proxy to DO)
app.get("/api/v1/agents/:name/skills/:skillName/audit", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const skillName = c.req.param("skillName");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "getSkillAudit", [skillName]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ── Agent Secrets (proxy to DO @callable) ──

// List secrets (keys only, not values — values never leave the DO)
app.get("/api/v1/agents/:name/secrets", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "listSecrets", []);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Store a secret (value goes to DO SQLite, encrypted, never returns to client)
app.post("/api/v1/agents/:name/secrets", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const body = await c.req.json<{ key: string; value: string; category?: string; description?: string; expires_in?: number }>();
  if (!body.key || !body.value) return c.json({ error: "key and value required" }, 400);
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "storeSecret", [
    body.key, body.value, body.category || "api_key", body.description || "", body.expires_in,
  ]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Delete a secret
app.delete("/api/v1/agents/:name/secrets/:key", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const key = c.req.param("key");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "deleteSecret", [key]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// Get learned procedures (proxy to DO)
app.get("/api/v1/agents/:name/procedures", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "getLearnedProcedures", []);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ── Model Selection ──

// Get available models (static catalog — no DO call needed)
app.get("/api/v1/models", (c) => {
  // Import from agent worker would require service binding RPC.
  // Instead, return the catalog directly (it's static config).
  return c.json([
    { id: "@cf/moonshotai/kimi-k2.5", name: "Kimi K2.5", provider: "Workers AI", tier: "free", costPer1kTokens: 0 },
    { id: "@cf/google/gemma-3-27b-it", name: "Gemma 3 27B", provider: "Workers AI", tier: "free", costPer1kTokens: 0 },
    { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", provider: "Workers AI", tier: "free", costPer1kTokens: 0 },
    { id: "deepseek/deepseek-chat-v3.2", name: "DeepSeek V3.2", provider: "OpenRouter", tier: "budget", costPer1kTokens: 0.0003 },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "OpenRouter", tier: "budget", costPer1kTokens: 0.0001 },
    { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "OpenRouter", tier: "budget", costPer1kTokens: 0.0008 },
    { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "OpenRouter", tier: "standard", costPer1kTokens: 0.003 },
    { id: "openai/gpt-5-mini", name: "GPT-5 Mini", provider: "OpenRouter", tier: "standard", costPer1kTokens: 0.002 },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "OpenRouter", tier: "standard", costPer1kTokens: 0.003 },
    { id: "minimax/minimax-m2.7", name: "MiniMax M2.7", provider: "OpenRouter", tier: "standard", costPer1kTokens: 0.002 },
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "OpenRouter", tier: "premium", costPer1kTokens: 0.015 },
    { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "OpenRouter", tier: "premium", costPer1kTokens: 0.01 },
    { id: "x-ai/grok-4", name: "Grok 4", provider: "OpenRouter", tier: "premium", costPer1kTokens: 0.005 },
    { id: "groq/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout (Groq)", provider: "OpenRouter", tier: "speed", costPer1kTokens: 0.0002 },
  ]);
});

// Get/set model for a specific agent (proxy to DO)
app.get("/api/v1/agents/:name/model", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "getCurrentModel", []);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

app.put("/api/v1/agents/:name/model", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const agentName = c.req.param("name");
  const body = await c.req.json<{ model: string }>();
  if (!body.model) return c.json({ error: "model required" }, 400);
  const resp = await callAgentMethod(c.env, orgId, agentName, userId, "setModel", [body.model]);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ═══════════════════════════════════════════════════════════════════
// META-AGENT (Pattern D: proxy to Agent Core DO)
// ═══════════════════════════════════════════════════════════════════

app.post("/api/v1/agents/create-from-description", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<{ description: string; plan?: string }>();
  if (!body.description) return c.json({ error: "description required" }, 400);

  // Route to the meta-agent DO instance for this org
  const doName = buildDoName(orgId, "meta", userId);
  const resp = await c.env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/chat-agent/${doName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "run",
        input: `Create an agent from this description: ${body.description}${body.plan ? `\n\nPlan: ${body.plan}` : ""}`,
        agent_name: "meta",
        org_id: orgId,
        user_id: userId,
      }),
    }),
  );

  // Stream the meta-agent's response back
  return new Response(resp.body, {
    status: resp.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
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
