/**
 * Runtime proxy router — forward tool calls to RUNTIME service binding.
 * Ported from agentos/api/routers/runtime_proxy.py
 *
 * Includes: health checks, graceful degradation, circuit breaker patterns
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";

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

  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          input,
          agent_name: agentName,
          org_id: user.org_id,
          project_id: user.project_id || "",
          channel: "portal",
          channel_user_id: user.user_id,
          history: body.history,
        }),
      }),
    );

    const result = await resp.json() as Record<string, unknown>;
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: `Runtime execution failed: ${err.message || err}` }, 502);
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
        const { result, error, fromFallback } = await executeWithRetry(
          async () => {
            const resp = await c.env.RUNTIME.fetch(
              new Request("https://runtime/api/v1/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  agent_name: agentName,
                  task: input,
                  org_id: user.org_id,
                }),
              }),
            );
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
        return result!;
      }),
    );

    for (const settled of chunkResults) {
      if (settled.status === "fulfilled") {
        const result = settled.value as Record<string, unknown>;
        results.push(result);
        totalCostUsd += Number(result.cost_usd || result.cumulative_cost_usd || 0);
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
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/runtime-proxy/tool/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

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

  // Forward user auth context to runtime
  const forwardBody = {
    ...body,
    org_id: user.org_id,
    project_id: user.project_id,
  };

  try {
    // Forward to RUNTIME service binding with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s connection timeout

    const resp = await c.env.RUNTIME.fetch(
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
    );
    clearTimeout(timeoutId);

    if (resp.status >= 400) {
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

    // Pass through the SSE stream from runtime with headers
    return new Response(resp.body, {
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
