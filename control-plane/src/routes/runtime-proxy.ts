/**
 * Runtime proxy router — forward tool calls to RUNTIME service binding.
 *
 * Includes: health checks, graceful degradation, circuit breaker patterns
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import {
  DEFAULT_CREDIT_HOLD_TTL_SECONDS,
  DEFAULT_CREDIT_HOLD_USD,
  releaseCreditHold,
  reserveCreditHold,
  settleCreditHold,
} from "../logic/credits";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import type { CurrentUser } from "../auth/types";
import { failSafe } from "../lib/error-response";

export const runtimeProxyRoutes = createOpenAPIRouter();

// Runtime health state (in-memory, per-worker)
const runtimeHealth = {
  lastCheck: 0,
  healthy: true,
  latencyMs: 0,
  consecutiveFailures: 0,
};

const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const MAX_CONSECUTIVE_FAILURES = 3;
const CIRCUIT_BREAKER_TIMEOUT_MS = 60_000; // 1 minute cooldown

// ── Concurrency Management ─────────────────────────────────────────
// Track in-flight requests to runtime. If too many are pending,
// queue new requests with exponential backoff instead of immediate 503.
const MAX_CONCURRENT_RUNTIME_REQUESTS = 40; // Leave headroom below the 50 limit
const MAX_QUEUE_WAIT_MS = 15_000; // Max time to wait in queue
let inFlightCount = 0;

async function withConcurrencyLimit<T>(operation: () => Promise<T>): Promise<T> {
  if (inFlightCount >= MAX_CONCURRENT_RUNTIME_REQUESTS) {
    // Backoff: wait up to 15s for a slot to open
    const start = Date.now();
    while (inFlightCount >= MAX_CONCURRENT_RUNTIME_REQUESTS) {
      if (Date.now() - start > MAX_QUEUE_WAIT_MS) {
        throw Object.assign(
          new Error("Runtime is at capacity. Please retry in a moment."),
          { status: 503 },
        );
      }
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300)); // 200-500ms jitter
    }
  }

  inFlightCount++;
  try {
    return await operation();
  } finally {
    inFlightCount--;
  }
}

/**
 * Check runtime health with caching to avoid hammering the service
 */
async function checkRuntimeHealth(runtime: Fetcher): Promise<{ healthy: boolean; latencyMs: number }> {
  const now = Date.now();

  // Return cached health if recent
  if (now - runtimeHealth.lastCheck < HEALTH_CHECK_INTERVAL_MS) {
    return { healthy: runtimeHealth.healthy, latencyMs: runtimeHealth.latencyMs };
  }

  runtimeHealth.lastCheck = now;

  try {
    const start = Date.now();
    const resp = await runtime.fetch("https://runtime/health", {
      method: "GET",
      // Short timeout for health check
      cf: { cacheTtl: 0 },
    });
    const latencyMs = Date.now() - start;

    runtimeHealth.latencyMs = latencyMs;
    runtimeHealth.consecutiveFailures = 0;
    runtimeHealth.healthy = resp.status === 200;

    return { healthy: runtimeHealth.healthy, latencyMs };
  } catch (e) {
    runtimeHealth.consecutiveFailures++;
    runtimeHealth.healthy = false;

    // Circuit breaker: if too many failures, stay "unhealthy" for cooldown period
    if (runtimeHealth.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      runtimeHealth.lastCheck = now + CIRCUIT_BREAKER_TIMEOUT_MS;
    }

    return { healthy: false, latencyMs: Infinity };
  }
}

/**
 * Execute runtime fetch with retry logic and graceful degradation
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; retryDelayMs?: number; fallback?: T }
): Promise<{ result?: T; error?: string; fromFallback: boolean }> {
  const { maxRetries = 2, retryDelayMs = 500, fallback } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      return { result, fromFallback: false };
    } catch (e: any) {
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        if (fallback !== undefined) {
          return { result: fallback, error: e.message, fromFallback: true };
        }
        return { error: e.message, fromFallback: false };
      }

      // Exponential backoff
      await new Promise(r => setTimeout(r, retryDelayMs * Math.pow(2, attempt)));
    }
  }

  return { error: "Max retries exceeded", fromFallback: false };
}

async function reserveRuntimeHold(
  c: any,
  orgId: string,
  sessionId: string,
  agentName: string,
  holdAmountUsd: number,
  ttlSeconds: number = DEFAULT_CREDIT_HOLD_TTL_SECONDS,
): Promise<{ ok: true; holdId: string } | { ok: false; response: Response }> {
  let reserved:
    | { success: true; hold_id: string; hold_amount_usd: number; expires_at: string }
    | { success: false; reason: "insufficient" | "db_error" }
    | { success: false; reason: "debt_pending"; debt_amount_usd: number };
  try {
    reserved = await withOrgDb(c.env, orgId, (sql) =>
      reserveCreditHold(sql, orgId, sessionId, holdAmountUsd, ttlSeconds, { agentName }),
    );
  } catch {
    reserved = { success: false, reason: "db_error" };
  }

  if (!reserved.success) {
    if (reserved.reason === "insufficient" || reserved.reason === "debt_pending") {
      return {
        ok: false,
        response: c.json({
          error: reserved.reason === "debt_pending"
            ? `Outstanding unrecovered cost debt: $${Number(reserved.debt_amount_usd || 0).toFixed(2)}. Please top up before starting new runs.`
            : "Insufficient credits. Purchase credits at https://app.021agents.ai/settings?tab=billing",
          code: reserved.reason === "debt_pending" ? "credit_debt_pending" : "insufficient_credits",
          balance_cents: 0,
        }, 402),
      };
    }
    return {
      ok: false,
      response: c.json({ error: "Credit reservation unavailable. Please try again.", code: "credit_reservation_error" }, 503),
    };
  }

  return { ok: true, holdId: reserved.hold_id };
}

function requireServiceTokenForEdge(
  c: any,
): { ok: true } | { ok: false; status: number; error: string } {
  const authHeader = c.req.header("Authorization") || "";
  const edgeToken = c.req.header("X-Edge-Token") || "";
  const expected = (c.env.SERVICE_TOKEN || "").trim();

  if (!expected) {
    return { ok: false, status: 503, error: "SERVICE_TOKEN not configured" };
  }

  let supplied = edgeToken.trim();
  if (!supplied && authHeader.toLowerCase().startsWith("bearer ")) {
    supplied = authHeader.slice(7).trim();
  }
  if (supplied !== expected) {
    return { ok: false, status: 401, error: "invalid edge token" };
  }
  return { ok: true };
}

function canAccessAgent(user: CurrentUser, agentName: string): boolean {
  const allowed = user.allowedAgents;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(agentName);
}

// ── GET /health — Runtime health status ─────────────────────────────

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Runtime Proxy"],
  summary: "Runtime health status",
  responses: {
    200: {
      description: "Runtime is healthy",
      content: {
        "application/json": {
          schema: z.object({
            runtime: z.string(),
            latency_ms: z.number(),
            cached: z.boolean(),
            consecutive_failures: z.number(),
            timestamp: z.string(),
          }),
        },
      },
    },
    ...errorResponses(500),
  },
});

runtimeProxyRoutes.openapi(healthRoute, async (c): Promise<any> => {
  const health = await checkRuntimeHealth(c.env.RUNTIME);

  return c.json({
    runtime: health.healthy ? "healthy" : "unhealthy",
    latency_ms: health.latencyMs,
    cached: Date.now() - runtimeHealth.lastCheck < HEALTH_CHECK_INTERVAL_MS,
    consecutive_failures: runtimeHealth.consecutiveFailures,
    timestamp: new Date().toISOString(),
  }, health.healthy ? 200 : 503);
});

// ── GET /breakers — Circuit breaker snapshot for the canvas LiveStatsPanel ──
// Proxies to the runtime's /api/v1/runtime/breakers endpoint. Returns
// { db, llm, tools, timestamp }. Uncached on purpose — this is a live
// health signal and we want the UI to see degradations in near real-time.
runtimeProxyRoutes.get("/breakers", async (c): Promise<any> => {
  try {
    const resp = await c.env.RUNTIME.fetch(
      "https://runtime/api/v1/runtime/breakers",
      { method: "GET" },
    );
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    return c.json(
      {
        error: "runtime_unreachable",
        message: err?.message || "Failed to reach runtime",
        // Fail-soft: surface a conservative all-closed snapshot so the UI
        // doesn't flash red on a single network blip. Includes a note so
        // callers can tell the difference between "healthy" and "unknown".
        db: { state: "closed", failures: 0, opened_at: null },
        llm: {
          state: "closed",
          failures: 0,
          opened_at: null,
          last_failure_at: null,
          last_error: null,
          note: "unknown — runtime unreachable",
        },
        tools: {
          state: "closed",
          total_tools_tracked: 0,
          open_count: 0,
          half_open_count: 0,
          worst_tools: [],
        },
        timestamp: Date.now(),
        degraded: true,
      },
      200,
    );
  }
});

// ── POST /agent/run — Agent execution ───────────────────────────────

const agentRunRoute = createRoute({
  method: "post",
  path: "/agent/run",
  tags: ["Runtime Proxy"],
  summary: "Execute an agent run via runtime proxy",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1).openapi({ example: "my-agent" }),
            input: z.string().min(1).openapi({ example: "Hello" }),
            message: z.string().optional(),
            task: z.string().optional(),
            plan: z.enum(["free", "basic", "standard", "premium"]).optional(),
            history: z.array(z.record(z.unknown())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Agent run result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

runtimeProxyRoutes.openapi(agentRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "");
  const input = String(body.input || body.message || body.task || "");

  if (!agentName || !input) {
    return c.json({ error: "agent_name and input are required" }, 400);
  }
  if (!canAccessAgent(user, agentName)) {
    return c.json({ error: `API key is not allowed to access agent '${agentName}'` }, 403);
  }

  const orgId = user.org_id;
  const requestedPlan = String(body.plan || "").toLowerCase();
  const reservationSessionId = crypto.randomUUID();
  let holdId: string | null = null;
  if (requestedPlan !== "free") {
    const holdResult = await reserveRuntimeHold(
      c,
      orgId,
      reservationSessionId,
      agentName,
      DEFAULT_CREDIT_HOLD_USD,
    );
    if (!holdResult.ok) return holdResult.response;
    holdId = holdResult.holdId;
  }

  try {
    const resp = await withConcurrencyLimit(() => c.env.RUNTIME.fetch(
      new Request("https://runtime/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          input,
          agent_name: agentName,
          org_id: orgId,
          project_id: user.project_id || "",
          session_id: reservationSessionId,
          channel: "portal",
          channel_user_id: user.user_id,
          api_key_id: user.apiKeyId ?? "",
          history: body.history,
          ...(requestedPlan ? { plan: requestedPlan } : {}),
        }),
      }),
    ));

    const result = (await resp.json().catch(() => ({ error: "Invalid response from runtime" }))) as Record<string, unknown>;

    if (resp.status < 400 && holdId) {
      try {
        const costUsd = Number(result.cost_usd || 0);
        await withOrgDb(c.env, orgId, (creditSql) =>
          settleCreditHold(
            creditSql,
            orgId,
            holdId!,
            costUsd,
            `Agent run: ${agentName}`,
            agentName,
            String(result.session_id || reservationSessionId),
          ),
        );
      } catch (err: any) {
        console.error(`[billing] Credit settle error for org ${orgId}: ${err.message}`);
      }
    } else if (holdId) {
      await withOrgDb(c.env, orgId, (creditSql) =>
        releaseCreditHold(creditSql, orgId, holdId!, "crash"),
      ).catch(() => {});
    }

    return c.json(result, resp.status as 200 | 400 | 401 | 403 | 404 | 500 | 502 | 503);
  } catch (err) {
    if (holdId) {
      await withOrgDb(c.env, orgId, (creditSql) =>
        releaseCreditHold(creditSql, orgId, holdId!, "crash"),
      ).catch(() => {});
    }
    return c.json(failSafe(err, "runtime-proxy/agent/run", { userMessage: "The runtime is temporarily unavailable. Please try again in a moment." }), 502);
  }
});

// ── POST /batch — Batch agent execution ─────────────────────────────

const batchRoute = createRoute({
  method: "post",
  path: "/batch",
  tags: ["Runtime Proxy"],
  summary: "Batch agent execution with retry logic",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1).openapi({ example: "my-agent" }),
            inputs: z.array(z.string()).min(1).openapi({ example: ["Hello", "World"] }),
            max_concurrency: z.coerce.number().int().min(1).max(20).default(5).openapi({ example: 5 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Batch execution results",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

runtimeProxyRoutes.openapi(batchRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "").trim();
  const inputs = Array.isArray(body.inputs) ? body.inputs.map(String) : [];
  const maxConcurrency = Math.max(1, Math.min(20, Number(body.max_concurrency) || 5));

  if (!agentName) return c.json({ error: "agent_name is required" }, 400);
  if (inputs.length === 0) return c.json({ error: "inputs array is required" }, 400);
  if (!canAccessAgent(user, agentName)) {
    return c.json({ error: `API key is not allowed to access agent '${agentName}'` }, 403);
  }

  const batchOrgId = user.org_id;
  const estimatedBatchCost = inputs.length * 0.01; // conservative $0.01/item estimate

  // Check runtime health before processing
  const health = await checkRuntimeHealth(c.env.RUNTIME);
  if (!health.healthy) {
    return c.json({
      error: "Runtime service temporarily unavailable",
      runtime_health: "unhealthy",
      retry_after_seconds: 30,
      // Return fallback results with errors so client can handle gracefully
      results: inputs.map((input: string) => ({
        error: "Runtime unavailable - request queued for retry",
        input,
        status: "queued",
      })),
    }, 503);
  }

  const batchStart = Date.now();
  const results: Array<Record<string, unknown>> = [];
  let totalCostUsd = 0;
  let fromFallbackCount = 0;

  // Process inputs in batches of max_concurrency
  for (let i = 0; i < inputs.length; i += maxConcurrency) {
    const chunk = inputs.slice(i, i + maxConcurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (input: string) => {
        const itemSessionId = crypto.randomUUID();
        const holdAmountUsd = Math.max(0.1, estimatedBatchCost / Math.max(1, inputs.length));
        const holdResult = await reserveRuntimeHold(
          c,
          batchOrgId,
          itemSessionId,
          agentName,
          holdAmountUsd,
        );
        if (!holdResult.ok) {
          throw new Error("insufficient_credits");
        }

        try {
          const { result, error, fromFallback } = await executeWithRetry(
            async () => {
              const resp = await withConcurrencyLimit(() => c.env.RUNTIME.fetch(
                new Request("https://runtime/api/v1/run", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    agent_name: agentName,
                    task: input,
                    org_id: user.org_id,
                    project_id: user.project_id || "",
                    session_id: itemSessionId,
                    channel: "portal",
                    channel_user_id: user.user_id,
                    api_key_id: user.apiKeyId ?? "",
                  }),
                }),
              ));
              if (resp.status >= 400) {
                const text = await resp.text().catch(() => resp.statusText);
                throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
              }
              return await resp.json() as Record<string, unknown>;
            },
            {
              maxRetries: 2,
              retryDelayMs: 500,
              fallback: {
                error: "Failed after retries",
                input,
                fallback: true
              }
            }
          );

          if (fromFallback) fromFallbackCount++;
          if (error && !result) throw new Error(error);

          const settled = await withOrgDb(c.env, batchOrgId, (creditSql) =>
            settleCreditHold(
              creditSql,
              batchOrgId,
              holdResult.holdId,
              Number(result!.cost_usd || result!.cumulative_cost_usd || 0),
              `Batch run: ${agentName}`,
              agentName,
              String(result!.session_id || itemSessionId),
            ),
          ).catch(() => ({ success: false }));
          if (!settled.success) {
            await withOrgDb(c.env, batchOrgId, (creditSql) =>
              releaseCreditHold(creditSql, batchOrgId, holdResult.holdId, "crash"),
            ).catch(() => {});
          }

          return result!;
        } catch (err) {
          await withOrgDb(c.env, batchOrgId, (creditSql) =>
            releaseCreditHold(creditSql, batchOrgId, holdResult.holdId, "crash"),
          ).catch(() => {});
          throw err;
        }
      }),
    );

    for (const settled of chunkResults) {
      if (settled.status === "fulfilled") {
        const result = settled.value as Record<string, unknown>;
        results.push(result);
        const itemCostUsd = Number(result.cost_usd || result.cumulative_cost_usd || 0);
        totalCostUsd += itemCostUsd;

      } else {
        results.push({
          error: String(settled.reason),
          input: chunk[chunkResults.indexOf(settled)] || "",
          status: "failed",
        });
      }
    }
  }

  const totalLatencyMs = Date.now() - batchStart;
  const failedCount = results.filter(r => r.error || r.status === "failed").length;

  return c.json({
    results,
    total_cost_usd: totalCostUsd,
    total_latency_ms: totalLatencyMs,
    succeeded: results.length - failedCount,
    failed: failedCount,
    from_fallback: fromFallbackCount,
    runtime_healthy: health.healthy,
  });
});

// ── POST /tool/call — Forward tool call to runtime ──────────────────

const toolCallRoute = createRoute({
  method: "post",
  path: "/tool/call",
  tags: ["Runtime Proxy"],
  summary: "Forward a tool call to the runtime",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tool: z.string().optional().openapi({ example: "web_search" }),
            name: z.string().optional().openapi({ example: "web_search" }),
            args: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tool call result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 500),
  },
});

runtimeProxyRoutes.openapi(toolCallRoute, async (c): Promise<any> => {
  const auth = requireServiceTokenForEdge(c);
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status as any);
  }

  const body = c.req.valid("json");
  const toolName = String(body.tool || body.name || "").trim();
  if (!toolName) return c.json({ error: "tool (or name) is required" }, 400);

  // Forward to RUNTIME service binding
  try {
    const resp = await withConcurrencyLimit(() => c.env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/tool/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    if (resp.status >= 400) {
      const text = await resp.text();
      return c.json({ error: text.slice(0, 500) }, resp.status as any);
    }

    return c.json(await resp.json());
  } catch (e: any) {
    return c.json({ error: `Runtime proxy failed: ${e.message}` }, 502);
  }
});

// ── POST /runnable/stream — SSE streaming for agent runs ────────────

const streamRoute = createRoute({
  method: "post",
  path: "/runnable/stream",
  tags: ["Runtime Proxy"],
  summary: "SSE streaming for agent runs",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1).openapi({ example: "my-agent" }),
            input: z.string().optional(),
            task: z.string().optional(),
            plan: z.enum(["free", "basic", "standard", "premium"]).optional(),
            session_id: z.string().optional(),
            conversation_id: z.string().optional(),
            history: z.array(z.object({
              role: z.enum(["user", "assistant", "system"]),
              content: z.string(),
            })).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "SSE event stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    ...errorResponses(400, 500),
  },
});

runtimeProxyRoutes.openapi(streamRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "").trim();

  if (!agentName) {
    return c.json({ error: "agent_name is required" }, 400);
  }
  if (!canAccessAgent(user, agentName)) {
    return c.json({ error: `API key is not allowed to access agent '${agentName}'` }, 403);
  }

  const streamOrgId = user.org_id;
  const streamPlan = String(body.plan || "").toLowerCase();

  // Check runtime health first
  const health = await checkRuntimeHealth(c.env.RUNTIME);
  if (!health.healthy) {
    // Return SSE error stream instead of JSON error
    const encoder = new TextEncoder();
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: "error",
            message: "Runtime service temporarily unavailable. Please try again in 30 seconds.",
            code: "RUNTIME_UNAVAILABLE",
            retry_after: 30
          })}\n\n`
        ));
        controller.close();
      },
    });

    return new Response(errorStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      status: 503,
    });
  }

  const streamSessionId = String(body.session_id || crypto.randomUUID());
  let streamHoldId: string | null = null;
  if (streamPlan !== "free") {
    const holdResult = await reserveRuntimeHold(
      c,
      streamOrgId,
      streamSessionId,
      agentName,
      DEFAULT_CREDIT_HOLD_USD,
    );
    if (!holdResult.ok) return holdResult.response;
    streamHoldId = holdResult.holdId;
  }

  // Forward user auth context to runtime — channel_user_id ensures per-user DO isolation
  const forwardBody = {
    ...body,
    session_id: streamSessionId,
    org_id: user.org_id,
    project_id: user.project_id,
    channel_user_id: user.user_id,
    channel: "portal",
    ...(streamPlan ? { plan: streamPlan } : {}),
  };

  try {
    // Forward to RUNTIME service binding with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s connection timeout

    const resp = await withConcurrencyLimit(() => c.env.RUNTIME.fetch(
      "https://runtime/api/v1/runtime-proxy/runnable/stream",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify(forwardBody),
        // @ts-ignore - Cloudflare fetch supports signal
        signal: controller.signal,
      },
    ));
    clearTimeout(timeoutId);

    if (resp.status >= 400) {
      if (streamHoldId) {
        await withOrgDb(c.env, streamOrgId, (creditSql) =>
          releaseCreditHold(creditSql, streamOrgId, streamHoldId!, "crash"),
        ).catch(() => {});
      }
      const text = await resp.text();
      // Return as SSE error event
      const encoder = new TextEncoder();
      const errorStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              type: "error",
              message: text.slice(0, 500),
              code: "RUNTIME_ERROR"
            })}\n\n`
          ));
          controller.close();
        },
      });

      return new Response(errorStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        status: resp.status,
      });
    }

    // Wrap the SSE stream to intercept the "done" event and deduct credits
    const orgIdForBilling = streamOrgId;
    const agentNameForBilling = agentName;
    const sseStream = resp.body;
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    c.executionCtx.waitUntil((async () => {
      const reader = sseStream!.getReader();
      let buffer = "";
      let billedDone = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          await writer.write(encoder.encode(chunk));
          buffer += chunk;

          // Parse complete SSE frames robustly instead of regex-matching JSON blobs.
          while (true) {
            const sepMatch = buffer.match(/\r?\n\r?\n/);
            if (!sepMatch || sepMatch.index === undefined) break;

            const frame = buffer.slice(0, sepMatch.index);
            buffer = buffer.slice(sepMatch.index + sepMatch[0].length);
            if (!frame.trim()) continue;

            const dataLines = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());
            if (dataLines.length === 0) continue;

            const payloadText = dataLines.join("\n").trim();
            if (!payloadText.startsWith("{")) continue;

            try {
              const parsed = JSON.parse(payloadText) as Record<string, unknown>;
              if (String(parsed.type || "") === "done" && !billedDone) {
                if (streamHoldId) {
                  const costUsd = Number(parsed.cost_usd || 0);
                  const settled = await withOrgDb(c.env, orgIdForBilling, (creditSql) =>
                    settleCreditHold(
                      creditSql,
                      orgIdForBilling,
                      streamHoldId!,
                      costUsd,
                      `Agent run: ${agentNameForBilling}`,
                      agentNameForBilling,
                      String(parsed.session_id || streamSessionId),
                    ),
                  );
                  if (!settled.success) {
                    console.error(`[sse-billing] FAILED settle for org ${orgIdForBilling} hold ${streamHoldId}`);
                    await withOrgDb(c.env, orgIdForBilling, (creditSql) =>
                      releaseCreditHold(creditSql, orgIdForBilling, streamHoldId!, "crash"),
                    ).catch(() => {});
                  } else {
                    billedDone = true;
                  }
                } else {
                  billedDone = true;
                }
              }
            } catch (err: any) {
              console.error(`[sse-billing] Credit settle error: ${err.message}`);
            }
          }
        }
      } catch {} finally {
        if (!billedDone && streamHoldId) {
          await withOrgDb(c.env, orgIdForBilling, (creditSql) =>
            releaseCreditHold(creditSql, orgIdForBilling, streamHoldId!, "crash"),
          ).catch(() => {});
        }
        try { await writer.close(); } catch {}
      }
    })());

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Runtime-Latency-Ms": String(health.latencyMs),
        "X-Runtime-Healthy": "true",
      },
    });
  } catch (e: any) {
    // Return SSE error for connection failures
    runtimeHealth.consecutiveFailures++;
    runtimeHealth.healthy = false;
    if (streamHoldId) {
      await withOrgDb(c.env, streamOrgId, (creditSql) =>
        releaseCreditHold(creditSql, streamOrgId, streamHoldId!, "crash"),
      ).catch(() => {});
    }

    const encoder = new TextEncoder();
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: "error",
            message: `Runtime connection failed: ${e.message}`,
            code: "CONNECTION_FAILED",
            retry_after: 30
          })}\n\n`
        ));
        controller.close();
      },
    });

    return new Response(errorStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      status: 502,
    });
  }
});

// ── POST /runnable/reset — Reset agent conversation history ─────────

const resetRoute = createRoute({
  method: "post",
  path: "/runnable/reset",
  tags: ["RuntimeProxy"],
  summary: "Reset agent conversation history (start new session)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ agent_name: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Reset complete", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(500),
  },
});
runtimeProxyRoutes.openapi(resetRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = body.agent_name;
  if (!canAccessAgent(user, agentName)) {
    return c.json({ error: `API key is not allowed to access agent '${agentName}'` }, 403);
  }
  const orgId = user.org_id || "";
  const userId = user.user_id || "";
  const orgPrefix = orgId ? `${orgId}-` : "";
  const doName = userId ? `${orgPrefix}${agentName}-u-${userId}` : `${orgPrefix}${agentName}`;

  try {
    const resp = await withConcurrencyLimit(() => c.env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/runnable/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
      },
      // Send a special __reset command through the same path as normal runs
      // The DO handles POST /reset directly
      body: JSON.stringify({ __reset: true, agent_name: agentName, org_id: orgId, channel_user_id: userId }),
    }));
    // Alternative: forward directly to the DO reset endpoint
  } catch {}

  return c.json({ ok: true, reset: true, agent_name: agentName });
});

// ══════════════════════════════════════════════════════════════════════
// Phase 7.7: Request Queuing with Backpressure
// ══════════════════════════════════════════════════════════════════════

// In-memory queue per org (bounded)
const requestQueues = new Map<string, Array<{
  body: Record<string, unknown>;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  enqueuedAt: number;
}>>();
const MAX_QUEUE_SIZE = 100;
const QUEUE_TIMEOUT_MS = 30_000;
const DRAIN_INTERVAL_MS = 1_000;

/** Drain queued requests — called per-request since setInterval doesn't survive CF Worker request boundaries. */
async function drainQueue(runtime: Fetcher) {
  const health = await checkRuntimeHealth(runtime);
  if (!health.healthy) return;

  for (const [orgId, queue] of requestQueues.entries()) {
    if (queue.length === 0) continue;

    // Drain sequentially to avoid stampeding the runtime.
    while (queue.length > 0) {
      const item = queue.shift()!;

      // Drop timed-out items.
      if (Date.now() - item.enqueuedAt > QUEUE_TIMEOUT_MS) {
        item.resolve({ error: "Queue timeout" });
        continue;
      }

      try {
        const resp = await withConcurrencyLimit(() => runtime.fetch("https://runtime/api/v1/runtime-proxy/agent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...item.body, org_id: orgId }),
        }));
        const data = await resp.json().catch(() => ({ error: "Invalid response from runtime" }));
        item.resolve(data);
      } catch (err: any) {
        item.resolve({ error: err?.message || String(err) });
        // Stop draining this org on first failure; remaining items retry on next request.
        break;
      }
    }

    if (queue.length === 0) requestQueues.delete(orgId);
    else requestQueues.set(orgId, queue);
  }
}

/**
 * POST /agent/run/queued — Run with automatic queuing when circuit is open
 * Instead of returning 503 immediately, queues the request and drains
 * when the runtime recovers.
 */
runtimeProxyRoutes.post("/agent/run/queued", requireScope("agents:write"), async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const orgId = user.org_id;
  const queuedAgentName = String(body.agent_name || "").trim();
  if (!queuedAgentName) {
    return c.json({ error: "agent_name is required" }, 400);
  }
  if (!canAccessAgent(user, queuedAgentName)) {
    return c.json({ error: `API key is not allowed to access agent '${queuedAgentName}'` }, 403);
  }

  // Drain any pending queued requests before processing new ones
  drainQueue(c.env.RUNTIME).catch(() => {});

  // Check circuit breaker state
  const health = await checkRuntimeHealth(c.env.RUNTIME);

  if (health.healthy) {
    // Runtime healthy — execute directly (same as /agent/run)
    try {
      const resp = await withConcurrencyLimit(() => c.env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/agent/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({ ...body, org_id: orgId }),
      }));
      const data = await resp.json();
      return c.json(data, resp.status as any);
    } catch (err) {
      return c.json(failSafe(err, "runtime-proxy/agent/run:direct", { userMessage: "The runtime is temporarily unavailable. Please try again in a moment." }), 503);
    }
  }

  // Runtime unhealthy — queue the request
  const queue = requestQueues.get(orgId) || [];
  if (queue.length >= MAX_QUEUE_SIZE) {
    return c.json({
      error: "Request queue full",
      queue_size: queue.length,
      retry_after: Math.ceil(CIRCUIT_BREAKER_TIMEOUT_MS / 1000),
    }, 503);
  }

  // Queue and wait
  const position = queue.length + 1;
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      queue.push({ body, resolve, reject, enqueuedAt: Date.now() });
      requestQueues.set(orgId, queue);
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Queue timeout")), QUEUE_TIMEOUT_MS)
    ),
  ]).catch((err: any) => {
    console.error(`[runtime-proxy/queue] queued request failed at position ${position}:`, err);
    // Queue timeout is the only expected error here; everything else is
    // a runtime problem users can't act on. Return a user-friendly message.
    const isTimeout = err instanceof Error && /timeout/i.test(err.message);
    return {
      error: isTimeout
        ? "The runtime is overloaded and your request couldn't be served within the queue window. Please try again in a moment."
        : "The runtime is temporarily unavailable. Please try again in a moment.",
      queued_position: position,
    };
  });

  return c.json(result as any);
});
