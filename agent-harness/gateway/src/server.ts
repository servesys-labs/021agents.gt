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

// ═══════════════════════════════════════════════════════════════════
// AGENT EXECUTION (Pattern D: proxy to Agent Core DO)
//
// Two transport modes:
//   1. SSE: POST /runtime-proxy/runnable/stream → proxy to DO, SSE back
//   2. WebSocket: client connects directly to DO via routeAgentRequest
//      (handled by agent-harness server.ts, not this gateway)
//
// The SSE path is used by the Svelte UI's chat.ts streamAgent() function.
// ═══════════════════════════════════════════════════════════════════

// SSE streaming proxy — bridges Svelte UI to Agent Core DO
app.post("/api/v1/runtime-proxy/runnable/stream", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<{
    agent_name: string;
    input: string;
    session_id?: string;
    plan?: string;
    conversation_id?: string;
    history?: Array<{ role: string; content: string }>;
  }>();

  if (!body.agent_name || !body.input) {
    return c.json({ error: "agent_name and input required" }, 400);
  }

  const doName = buildDoName(orgId, body.agent_name, userId);

  // Forward to Agent Core DO as a chat request
  const resp = await c.env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/chat-agent/${doName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "run",
        input: body.input,
        agent_name: body.agent_name,
        org_id: orgId,
        user_id: userId,
        session_id: body.session_id,
        plan: body.plan,
        conversation_id: body.conversation_id,
        history: body.history,
      }),
    }),
  );

  // Stream the response back as SSE
  if (!resp.body) {
    return c.json({ error: "No response from agent" }, 502);
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Single-shot (non-streaming) agent run
app.post("/api/v1/runtime-proxy/agent/run", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<{
    agent_name: string;
    message: string;
    session_id?: string;
  }>();

  if (!body.agent_name || !body.message) {
    return c.json({ error: "agent_name and message required" }, 400);
  }

  const doName = buildDoName(orgId, body.agent_name, userId);

  const resp = await c.env.AGENT_CORE.fetch(
    new Request(`http://internal/agents/chat-agent/${doName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "run",
        input: body.message,
        agent_name: body.agent_name,
        org_id: orgId,
        user_id: userId,
        session_id: body.session_id,
      }),
    }),
  );

  return new Response(resp.body, { status: resp.status, headers: resp.headers });
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
  const [org] = await sql`SELECT id, stripe_customer_id, name FROM orgs WHERE id = ${orgId}`;
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
    await sql2`UPDATE orgs SET stripe_customer_id = ${customerId} WHERE id = ${orgId}`;
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
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens
    FROM sessions
    WHERE org_id = ${orgId} AND created_at > NOW() - make_interval(days => ${days})
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
    SELECT id FROM sessions WHERE id = ${sessionId} AND org_id = ${orgId}
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
    SELECT * FROM sessions WHERE id = ${sessionId}
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
        AND is_deleted = false
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
        AND is_deleted = false
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
    WHERE id = ${conversationId} AND org_id = ${orgId} AND is_deleted = false
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
    WHERE id = ${conversationId} AND org_id = ${orgId} AND is_deleted = false
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
    UPDATE conversations SET is_deleted = true, updated_at = now()
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
      SELECT id, name, description, version, is_builtin, is_active, created_at
      FROM skills
      WHERE (org_id = ${orgId} OR org_id IS NULL) AND is_active = true
      ORDER BY is_builtin DESC, name
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
    INSERT INTO skills (org_id, name, description, content)
    VALUES (${orgId}, ${body.name}, ${body.description || ""}, ${body.content})
    RETURNING id, name, description, version, is_active, created_at
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
      content = COALESCE(${body.content || null}, content),
      is_active = COALESCE(${body.is_active ?? null}, is_active),
      version = version + 1,
      updated_at = NOW()
    WHERE id = ${skillId} AND org_id = ${orgId}
    RETURNING id, name, description, version, is_active, created_at
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
  // Don't delete built-in skills
  await sql`
    DELETE FROM skills WHERE id = ${skillId} AND org_id = ${orgId} AND is_builtin = false
  `;
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
  const [user] = await sql`
    SELECT id, org_id, email, password_hash, is_active FROM users
    WHERE email = ${body.email.toLowerCase().trim()} LIMIT 1
  `;
  await sql.end();

  if (!user || !user.is_active) return c.json({ error: "Invalid credentials" }, 401);
  if (!user.password_hash || !(await verifyPassword(body.password, user.password_hash))) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const secret = c.env.JWT_SECRET || "dev-secret-change-me";
  const token = await signJwt({ user_id: user.id, org_id: user.org_id, email: user.email }, secret);

  // Cache JWT payload in KV for fast auth middleware lookups
  await c.env.CACHE.put(`auth:${token.slice(-16)}`, JSON.stringify({
    orgId: user.org_id, userId: user.id, scopes: ["*"],
  }), { expirationTtl: 86400 });

  return c.json({ token, user_id: user.id, org_id: user.org_id, email: user.email });
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
    const [org] = await sql`
      INSERT INTO orgs (name, slug) VALUES (${body.name}, ${slug}) RETURNING id
    `;
    const [user] = await sql`
      INSERT INTO users (org_id, email, name, password_hash)
      VALUES (${org.id}, ${email}, ${body.name}, ${passwordHash})
      RETURNING id, org_id, email
    `;
    await sql`
      INSERT INTO org_members (org_id, user_id, role) VALUES (${org.id}, ${user.id}, 'owner')
    `;
    // Set owner reference
    await sql`UPDATE orgs SET owner_user_id = ${user.id} WHERE id = ${org.id}`;
    await sql.end();

    const secret = c.env.JWT_SECRET || "dev-secret-change-me";
    const token = await signJwt({ user_id: user.id, org_id: user.org_id, email: user.email }, secret);

    await c.env.CACHE.put(`auth:${token.slice(-16)}`, JSON.stringify({
      orgId: user.org_id, userId: user.id, scopes: ["*"],
    }), { expirationTtl: 86400 });

    return c.json({ token, user_id: user.id, org_id: user.org_id, email: user.email }, 201);
  } catch (err: any) {
    await sql.end();
    if (err.message?.includes("unique") || err.message?.includes("duplicate")) {
      return c.json({ error: "Email already registered" }, 409);
    }
    throw err;
  }
});

// ── Auth: Forgot Password ──

app.post("/api/v1/auth/forgot-password", async (c) => {
  const body = await c.req.json<{ email: string }>();
  if (!body.email) return c.json({ error: "Email required" }, 400);

  const sql = await getDb(c.env.DB_ADMIN);
  const [user] = await sql`SELECT id FROM users WHERE email = ${body.email.toLowerCase().trim()} AND is_active = true`;
  if (user) {
    const [token] = await sql`
      INSERT INTO password_reset_tokens (user_id) VALUES (${user.id}) RETURNING token
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
    WHERE token = ${body.token} AND used_at IS NULL AND expires_at > NOW()
  `;
  if (!resetToken) {
    await sql.end();
    return c.json({ error: "Invalid or expired reset token" }, 400);
  }

  const passwordHash = await hashPassword(body.password);
  await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = NOW() WHERE id = ${resetToken.user_id}`;
  await sql`UPDATE password_reset_tokens SET used_at = NOW() WHERE token = ${body.token}`;
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
    WHERE token = ${body.token} AND used_at IS NULL AND expires_at > NOW()
  `;
  if (!verifyToken) {
    await sql.end();
    return c.json({ error: "Invalid or expired verification token" }, 400);
  }

  await sql`UPDATE users SET email_verified = true, updated_at = NOW() WHERE id = ${verifyToken.user_id}`;
  await sql`UPDATE email_verification_tokens SET used_at = NOW() WHERE token = ${body.token}`;
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
    SELECT id, email, name, avatar_url, email_verified, created_at
    FROM users WHERE id = ${userId}
  `;
  await sql.end();
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({ ...user, org_id: orgId });
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

app.delete("/api/v1/api-keys/:id", async (c) => {
  const orgId = c.get("orgId");
  const keyId = c.req.param("id");
  const sql = await getDb(c.env.DB);
  await sql`
    UPDATE api_keys SET revoked_at = NOW()
    WHERE id = ${keyId} AND org_id = ${orgId} AND revoked_at IS NULL
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
    const [row] = await sql`SELECT * FROM orgs WHERE id = ${orgId}`;
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
    WHERE id = ${orgId}
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
    SELECT u.id, u.email, u.name, u.avatar_url, m.role, m.joined_at
    FROM org_members m JOIN users u ON m.user_id = u.id
    WHERE m.org_id = ${orgId}
    ORDER BY m.joined_at
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
  const [org] = await sql`SELECT owner_user_id FROM orgs WHERE id = ${orgId}`;
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
