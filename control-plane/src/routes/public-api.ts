/**
 * Public Agent API — developer-facing endpoints for SDK & widget consumers.
 *
 * Mounted at /v1 on the control-plane. Accessed via:
 *   - Custom org domains: POST https://acme.agentos.dev/v1/agents/my-bot/run
 *   - Direct with API key: POST https://api.oneshots.co/v1/agents/my-bot/run
 *
 * All routes require API key auth (ak_...). The org is resolved from:
 *   1. Custom domain hostname (via hostnameMiddleware)
 *   2. API key's org_id
 *
 * Endpoints:
 *   POST   /agents/:name/run          — Sync agent execution (JSON response)
 *   POST   /agents/:name/run/stream   — Streaming agent execution (SSE)
 *   POST   /agents/:name/run/upload   — File upload + sync agent execution (multipart/form-data)
 *   POST   /agents/:name/conversations — Create or continue a conversation thread
 *   GET    /agents/:name/conversations — List conversations
 *   GET    /agents/:name/conversations/:id — Get conversation with messages
 *   DELETE /agents/:name/conversations/:id — Delete conversation
 *   GET    /health                     — Org-scoped health check
 */
import { createRoute, z, OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { dispatchRunCompletedWebhooks, type AgentRunEvent } from "../logic/webhook-delivery";
import { redactPii } from "../logic/pii-redactor";
import { hasCredits, deductCredits } from "../logic/credits";
import { failSafe } from "../lib/error-response";

type R = { Bindings: Env; Variables: { user: CurrentUser; custom_domain?: string } };
export const publicAgentRoutes = new OpenAPIHono<R>();

// ── Helpers ──────────────────────────────────────────────────────────────

function resolveOrgId(c: any): string {
  // Prefer hostname-resolved org (custom domain), fallback to API key org
  return c.get("resolved_org_id") || c.get("user")?.org_id || "";
}

function requireAuth(c: any): Response | null {
  const user = c.get("user");
  if (!user?.org_id && !c.get("resolved_org_id")) {
    return c.json({ error: "Authentication required. Provide an API key via Authorization: Bearer ak_..." }, 401);
  }
  return null;
}

async function checkAgentAccess(c: any, agentName: string, orgId: string): Promise<Response | null> {
  const user = c.get("user");

  // Check if API key is scoped to specific agents (resolved in auth middleware)
  if (user?.allowedAgents && user.allowedAgents.length > 0) {
    if (!user.allowedAgents.includes(agentName) && !user.allowedAgents.includes("*")) {
      return c.json({ error: `API key not authorized for agent: ${agentName}` }, 403);
    }
  }

  // Verify agent exists and is active
  let agents: any[] = [];
  try {
    agents = await withOrgDb(c.env, orgId, async (sql) => {
      return await sql`
        SELECT name FROM agents WHERE name = ${agentName} AND is_active = true LIMIT 1
      `;
    });
  } catch (err) {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  if (agents.length === 0) {
    return c.json({ error: `Agent not found: ${agentName}` }, 404);
  }

  return null;
}

// ── GET /health — Org-scoped health ──────────────────────────────────────

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Public API"],
  summary: "Org-scoped health check",
  responses: {
    200: {
      description: "Health status",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string(),
            service: z.string(),
            version: z.string(),
            org_id: z.string().optional(),
            domain: z.string().optional(),
            timestamp: z.number(),
          }),
        },
      },
    },
  },
});

publicAgentRoutes.openapi(healthRoute, async (c): Promise<any> => {
  const orgId = resolveOrgId(c);
  const domain = c.get("custom_domain") || "";
  return c.json({
    status: "ok",
    service: "agentos-public-api",
    version: "1.0.0",
    org_id: orgId || undefined,
    domain: domain || undefined,
    timestamp: Date.now(),
  });
});

// ── POST /agents/:name/run — Synchronous agent execution ─────────────────

const agentRunRoute = createRoute({
  method: "post",
  path: "/agents/{name}/run",
  tags: ["Public API"],
  summary: "Synchronous agent execution",
  request: {
    params: z.object({ name: z.string().openapi({ example: "my-agent" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            input: z.string().min(1).openapi({ example: "Hello, how can you help me?" }),
            conversation_id: z.string().optional(),
            user_id: z.string().optional(),
            metadata: z.record(z.unknown()).optional(),
            system_prompt: z.string().optional(),
            response_format: z.enum(["text", "json_object", "json_schema"]).optional(),
            response_schema: z.record(z.unknown()).optional(),
            model: z.string().optional(),
            idempotency_key: z.string().optional(),
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
    ...errorResponses(400, 401, 403, 404, 500),
  },
});

publicAgentRoutes.openapi(agentRunRoute, async (c): Promise<any> => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const { name: agentName } = c.req.valid("param");
  const orgId = resolveOrgId(c);

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  // Credit gate: verify org has credits before running
  try {
    const hasEnough = await withOrgDb(c.env, orgId, async (creditSql) => {
      return await hasCredits(creditSql, orgId, 1);
    });
    if (!hasEnough) {
      return c.json({
        error: "Insufficient credits. Purchase credits at https://app.021agents.ai/settings?tab=billing",
        code: "insufficient_credits",
        balance_cents: 0,
      }, 402);
    }
  } catch {
    // If credit check fails (e.g. table not yet migrated), allow the run
  }

  const body = c.req.valid("json");

  if (!body.input || typeof body.input !== "string") {
    return c.json({ error: "input is required (string)" }, 400);
  }

  // Check PII redaction setting (cached). idempotency_cache is NOT
  // RLS-enforced, so the explicit `org_id = ${orgId}` filter is kept below.
  let autoRedactPii = false;
  try {
    autoRedactPii = await withOrgDb(c.env, orgId, async (sql) => {
      const settings = await sql`SELECT auto_redact_pii FROM org_settings LIMIT 1`;
      return Boolean(settings[0]?.auto_redact_pii);
    });
  } catch {}

  // Idempotency: check cache before running
  const idempotencyKey = body.idempotency_key;
  if (idempotencyKey) {
    try {
      const cachedResponse = await withOrgDb(c.env, orgId, async (sql) => {
        const cached = await sql`
          SELECT response_body FROM idempotency_cache
          WHERE idempotency_key = ${idempotencyKey} AND org_id = ${orgId} AND expires_at > now()
          LIMIT 1
        `;
        if (cached.length > 0) {
          return typeof cached[0].response_body === "string"
            ? JSON.parse(cached[0].response_body)
            : cached[0].response_body;
        }
        return null;
      });
      if (cachedResponse !== null) {
        return c.json(cachedResponse);
      }
    } catch {}
  }

  // Forward to runtime worker via service binding
  const runtimeBody: Record<string, unknown> = {
    input: body.input,
    agent_name: agentName,
    org_id: orgId,
    project_id: "",
    channel: "public_api",
    channel_user_id: body.user_id || "",
  };
  if (body.system_prompt) runtimeBody.system_prompt = body.system_prompt;
  if (body.response_format) runtimeBody.response_format = body.response_format;
  if (body.response_schema) runtimeBody.response_schema = body.response_schema;
  if (body.model) runtimeBody.model = body.model;

  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify(runtimeBody),
      }),
    );

    const result = await resp.json() as Record<string, unknown>;

    // If conversation_id provided, save to conversation thread
    const conversationId = body.conversation_id;
    if (conversationId) {
      try {
        const storedInput = autoRedactPii ? redactPii(body.input).redacted : body.input;
        const storedOutput = autoRedactPii ? redactPii(String(result.output || "")).redacted : String(result.output || "");
        await withOrgDb(c.env, orgId, async (sql) => {
          // conversation_messages is NOT RLS-enforced; conversation_id is
          // the natural key that scopes to a conversation row whose RLS
          // already filtered by org.
          await sql`
            INSERT INTO conversation_messages (conversation_id, role, content, metadata, cost_usd, model)
            VALUES (${conversationId}, 'user', ${storedInput}, ${JSON.stringify(body.metadata || {})}, 0, '')
          `;
          await sql`
            INSERT INTO conversation_messages (conversation_id, role, content, metadata, cost_usd, model)
            VALUES (${conversationId}, 'assistant', ${storedOutput},
                    ${JSON.stringify({ session_id: result.session_id, turns: result.turns })},
                    ${Number(result.cost_usd || 0)}, ${String(result.model || "")})
          `;
          await sql`
            UPDATE conversations SET message_count = message_count + 2, last_message_at = now()
            WHERE conversation_id = ${conversationId}
          `;
        });
      } catch {}
    }

    const runResponse = {
      output: result.output || "",
      session_id: result.session_id || "",
      success: Boolean(result.success),
      turns: Number(result.turns || 0),
      tool_calls: Number(result.tool_calls || 0),
      cost_usd: Number(result.cost_usd || 0),
      latency_ms: Number(result.latency_ms || 0),
      model: String(result.model || ""),
      conversation_id: body.conversation_id || null,
    };

    // Deduct credits based on actual cost
    try {
      const costUsd = Number(result.cost_usd || 0);
      const deductResult = await withOrgDb(c.env, orgId, async (deductSql) => {
        return await deductCredits(deductSql, orgId, costUsd, `Agent run: ${agentName}`, agentName, String(result.session_id || ""));
      });
      if (!deductResult.success) {
        console.error(`[public-api-billing] FAILED deduction $${costUsd} from org ${orgId} — insufficient credits`);
      }
    } catch (err: any) {
      console.error(`[public-api-billing] Credit deduction error for org ${orgId}: ${err.message}`);
    }

    // Store idempotency cache if key was provided
    if (idempotencyKey) {
      try {
        await withOrgDb(c.env, orgId, async (sql) => {
          await sql`
            INSERT INTO idempotency_cache (idempotency_key, org_id, response_body, expires_at)
            VALUES (${idempotencyKey}, ${orgId}, ${JSON.stringify(runResponse)}, now() + interval '24 hours')
            ON CONFLICT (idempotency_key, org_id) DO NOTHING
          `;
        });
      } catch {}
    }

    // Fire-and-forget webhook delivery for agent.run.completed
    try {
      const webhookEvent: AgentRunEvent = {
        agent_name: agentName,
        session_id: String(result.session_id || ""),
        conversation_id: body.conversation_id || null,
        output: String(result.output || ""),
        success: Boolean(result.success),
        turns: Number(result.turns || 0),
        tool_calls: Number(result.tool_calls || 0),
        cost_usd: Number(result.cost_usd || 0),
        latency_ms: Number(result.latency_ms || 0),
        model: String(result.model || ""),
      };
      // dispatchRunCompletedWebhooks must run inside the transaction, but
      // since it's fire-and-forget the wrapper closes once we await this
      // line. Run it synchronously inside withOrgDb so its queries are
      // RLS-scoped, then return so the wrapper closes.
      await withOrgDb(c.env, orgId, async (sql) => {
        await dispatchRunCompletedWebhooks(sql, orgId, webhookEvent, (c.env as any).JOB_QUEUE).catch(() => {});
      });
    } catch {}

    // Fire-and-forget end-user usage tracking
    try {
      const user = c.get("user");
      const trackUserId = body.user_id || user.user_id || "";
      if (trackUserId) {
        await withOrgDb(c.env, orgId, async (sql) => {
          await sql`
            INSERT INTO end_user_usage (org_id, end_user_id, agent_name, session_id, cost_usd, latency_ms, input_tokens, created_at)
            VALUES (${orgId}, ${trackUserId}, ${agentName}, ${String(result.session_id || "")},
                    ${Number(result.cost_usd || 0)}, ${Number(result.latency_ms || 0)},
                    ${Number(result.total_tokens || 0)}, now())
          `.catch(() => {});
        });
      }
    } catch {}

    return c.json(runResponse);
  } catch (err) {
    return c.json(failSafe(err, "public-api/agents/run", { userMessage: "Agent execution failed. Please try again in a moment." }), 500);
  }
});

// ── POST /agents/:name/run/stream — SSE streaming agent execution ────────

const agentRunStreamRoute = createRoute({
  method: "post",
  path: "/agents/{name}/run/stream",
  tags: ["Public API"],
  summary: "Streaming agent execution (SSE)",
  request: {
    params: z.object({ name: z.string().openapi({ example: "my-agent" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            input: z.string().min(1).openapi({ example: "Hello" }),
            conversation_id: z.string().optional(),
            user_id: z.string().optional(),
            metadata: z.record(z.unknown()).optional(),
            system_prompt: z.string().optional(),
            response_format: z.enum(["text", "json_object", "json_schema"]).optional(),
            response_schema: z.record(z.unknown()).optional(),
            model: z.string().optional(),
            idempotency_key: z.string().optional(),
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
    ...errorResponses(400, 401, 403, 404, 500),
  },
});

publicAgentRoutes.openapi(agentRunStreamRoute, async (c): Promise<any> => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const { name: agentName } = c.req.valid("param");
  const orgId = resolveOrgId(c);

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  // Credit gate: verify org has credits before streaming
  try {
    const hasEnough = await withOrgDb(c.env, orgId, async (creditSql) => {
      return await hasCredits(creditSql, orgId, 1);
    });
    if (!hasEnough) {
      return c.json({
        error: "Insufficient credits. Purchase credits at https://app.021agents.ai/settings?tab=billing",
        code: "insufficient_credits",
        balance_cents: 0,
      }, 402);
    }
  } catch {
    // If credit check fails, allow the run
  }

  const body = c.req.valid("json");

  if (!body.input || typeof body.input !== "string") {
    return c.json({ error: "input is required (string)" }, 400);
  }

  // Use the runtime's runnable/stream-events endpoint which returns events
  // But for a true SSE experience, we run synchronously and stream chunks
  const runtimeBody: Record<string, unknown> = {
    input: body.input,
    agent_name: agentName,
    org_id: orgId,
    project_id: "",
    channel: "public_api",
    channel_user_id: body.user_id || "",
  };
  if (body.system_prompt) runtimeBody.system_prompt = body.system_prompt;
  if (body.response_format) runtimeBody.response_format = body.response_format;
  if (body.response_schema) runtimeBody.response_schema = body.response_schema;
  if (body.model) runtimeBody.model = body.model;

  // Create a TransformStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendSSE = (event: string, data: unknown) => {
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Run agent in background, stream results
  const runPromise = (async () => {
    try {
      sendSSE("start", { agent: agentName, timestamp: Date.now() });

      const resp = await c.env.RUNTIME.fetch(
        new Request("https://runtime/run", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
          },
          body: JSON.stringify(runtimeBody),
        }),
      );

      const result = await resp.json() as Record<string, unknown>;

      // Stream the output in chunks for a responsive feel
      const output = String(result.output || "");
      const chunkSize = 50;
      for (let i = 0; i < output.length; i += chunkSize) {
        sendSSE("token", { content: output.slice(i, i + chunkSize) });
      }

      // Save to conversation if needed
      const streamConvId = body.conversation_id;
      if (streamConvId) {
        try {
          await withOrgDb(c.env, orgId, async (sql) => {
            await sql`
              INSERT INTO conversation_messages (conversation_id, role, content, cost_usd, model)
              VALUES (${streamConvId}, 'user', ${body.input!}, 0, '')
            `;
            await sql`
              INSERT INTO conversation_messages (conversation_id, role, content, cost_usd, model)
              VALUES (${streamConvId}, 'assistant', ${output},
                      ${Number(result.cost_usd || 0)}, ${String(result.model || "")})
            `;
            await sql`
              UPDATE conversations SET message_count = message_count + 2, last_message_at = now()
              WHERE conversation_id = ${streamConvId}
            `;
          });
        } catch {}
      }

      sendSSE("done", {
        output,
        session_id: result.session_id || "",
        success: Boolean(result.success),
        turns: Number(result.turns || 0),
        tool_calls: Number(result.tool_calls || 0),
        cost_usd: Number(result.cost_usd || 0),
        latency_ms: Number(result.latency_ms || 0),
        model: String(result.model || ""),
        conversation_id: body.conversation_id || null,
      });

      // Fire-and-forget credit deduction
      try {
        const costUsd = Number(result.cost_usd || 0);
        await withOrgDb(c.env, orgId, async (deductSql) => {
          await deductCredits(deductSql, orgId, costUsd, `Agent run: ${agentName}`, agentName, String(result.session_id || ""));
        });
      } catch {}

      // Fire-and-forget end-user usage tracking
      try {
        const user = c.get("user");
        const trackUserId = body.user_id || user.user_id || "";
        if (trackUserId) {
          await withOrgDb(c.env, orgId, async (usageSql) => {
            await usageSql`
              INSERT INTO end_user_usage (org_id, end_user_id, agent_name, session_id, cost_usd, latency_ms, tokens_used, created_at)
              VALUES (${orgId}, ${trackUserId}, ${agentName}, ${String(result.session_id || "")},
                      ${Number(result.cost_usd || 0)}, ${Number(result.latency_ms || 0)},
                      ${Number(result.total_tokens || 0)}, now())
            `.catch(() => {});
          });
        }
      } catch {}
    } catch (err) {
      const ref = crypto.randomUUID().slice(0, 8);
      console.error(`[public-api/agents/run-stream] (ref=${ref})`, err);
      sendSSE("error", { message: `Agent execution failed. Please try again in a moment. (ref: ${ref})`, ref });
    } finally {
      writer.close();
    }
  })();

  // Don't await — let it stream
  c.executionCtx?.waitUntil?.(runPromise) ?? runPromise;

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// ── POST /agents/:name/run/upload — File upload + agent execution ─────────

const agentRunUploadRoute = createRoute({
  method: "post",
  path: "/agents/{name}/run/upload",
  tags: ["Public API"],
  summary: "File upload + sync agent execution (multipart/form-data)",
  request: {
    params: z.object({ name: z.string().openapi({ example: "my-agent" }) }),
  },
  responses: {
    200: {
      description: "Agent run result with file references",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 403, 404, 500),
  },
});

publicAgentRoutes.openapi(agentRunUploadRoute, async (c): Promise<any> => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const { name: agentName } = c.req.valid("param");
  const orgId = resolveOrgId(c);

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  // Credit gate: verify org has credits before upload+run
  try {
    const hasEnough = await withOrgDb(c.env, orgId, async (creditSql) => {
      return await hasCredits(creditSql, orgId, 1);
    });
    if (!hasEnough) {
      return c.json({
        error: "Insufficient credits. Purchase credits at https://app.021agents.ai/settings?tab=billing",
        code: "insufficient_credits",
        balance_cents: 0,
      }, 402);
    }
  } catch {
    // If credit check fails, allow the run
  }

  // Parse multipart form data
  const formData = await c.req.parseBody({ all: true });

  const input = formData["input"];
  if (!input || typeof input !== "string") {
    return c.json({ error: "input is required (text field)" }, 400);
  }

  const conversationId = typeof formData["conversation_id"] === "string" ? formData["conversation_id"] : undefined;
  const userId = typeof formData["user_id"] === "string" ? formData["user_id"] : "";
  const systemPrompt = typeof formData["system_prompt"] === "string" ? formData["system_prompt"] : undefined;
  const responseFormat = typeof formData["response_format"] === "string" ? formData["response_format"] as "text" | "json_object" | "json_schema" : undefined;
  const responseSchema = typeof formData["response_schema"] === "string" ? formData["response_schema"] : undefined;
  const model = typeof formData["model"] === "string" ? formData["model"] : undefined;
  const idempotencyKey = typeof formData["idempotency_key"] === "string" ? formData["idempotency_key"] : undefined;

  // Normalize files: parseBody with { all: true } returns array for multiple, single File for one
  const rawFiles = formData["files"];
  const files: File[] = [];
  if (rawFiles) {
    if (Array.isArray(rawFiles)) {
      for (const f of rawFiles) {
        if (f instanceof File) files.push(f);
      }
    } else if (rawFiles instanceof File) {
      files.push(rawFiles);
    }
  }

  // Validate file constraints
  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  if (files.length > MAX_FILES) {
    return c.json({ error: `Maximum ${MAX_FILES} files allowed, received ${files.length}` }, 400);
  }

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: `File "${file.name}" exceeds 10MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)` }, 400);
    }
  }

  // Idempotency: check cache before running
  if (idempotencyKey) {
    try {
      const cachedResponse = await withOrgDb(c.env, orgId, async (sql) => {
        const cached = await sql`
          SELECT response_body FROM idempotency_cache
          WHERE idempotency_key = ${idempotencyKey} AND org_id = ${orgId} AND expires_at > now()
          LIMIT 1
        `;
        if (cached.length > 0) {
          return typeof cached[0].response_body === "string"
            ? JSON.parse(cached[0].response_body)
            : cached[0].response_body;
        }
        return null;
      });
      if (cachedResponse !== null) {
        return c.json(cachedResponse);
      }
    } catch {}
  }

  // Upload files to R2 and record metadata
  const fileIds: string[] = [];
  const fileUrls: string[] = [];

  try {
    await withOrgDb(c.env, orgId, async (sql) => {
      for (const file of files) {
        const fileId = crypto.randomUUID();
        const r2Key = `uploads/${orgId}/${fileId}/${file.name}`;
        const arrayBuffer = await file.arrayBuffer();

        await c.env.STORAGE.put(r2Key, arrayBuffer, {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
          customMetadata: { org_id: orgId, original_name: file.name },
        });

        await sql`
          INSERT INTO file_uploads (file_id, org_id, agent_name, r2_key, original_name, content_type, size_bytes)
          VALUES (${fileId}, ${orgId}, ${agentName}, ${r2Key}, ${file.name}, ${file.type || "application/octet-stream"}, ${file.size})
        `;

        fileIds.push(fileId);
        fileUrls.push(r2Key);
      }
    });
  } catch (err) {
    return c.json(failSafe(err, "public-api/agents/upload", { userMessage: "File upload failed. Please try again in a moment." }), 500);
  }

  // Build enhanced input with file references
  let enhancedInput = input;
  if (fileUrls.length > 0) {
    enhancedInput = `${input}\n\n[Attached files: ${fileUrls.join(", ")}]`;
  }

  // Forward to runtime worker
  const runtimeBody: Record<string, unknown> = {
    input: enhancedInput,
    agent_name: agentName,
    org_id: orgId,
    project_id: "",
    channel: "public_api",
    channel_user_id: userId,
  };
  if (systemPrompt) runtimeBody.system_prompt = systemPrompt;
  if (responseFormat) runtimeBody.response_format = responseFormat;
  if (responseSchema) {
    try { runtimeBody.response_schema = JSON.parse(responseSchema); } catch {
      return c.json({ error: "response_schema must be a valid JSON string" }, 400);
    }
  }
  if (model) runtimeBody.model = model;

  try {
    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify(runtimeBody),
      }),
    );

    const result = await resp.json() as Record<string, unknown>;

    // Save to conversation if needed
    if (conversationId) {
      try {
        await withOrgDb(c.env, orgId, async (sql) => {
          await sql`
            INSERT INTO conversation_messages (conversation_id, role, content, metadata, cost_usd, model)
            VALUES (${conversationId}, 'user', ${enhancedInput}, ${JSON.stringify({ file_ids: fileIds })}, 0, '')
          `;
          await sql`
            INSERT INTO conversation_messages (conversation_id, role, content, metadata, cost_usd, model)
            VALUES (${conversationId}, 'assistant', ${String(result.output || "")},
                    ${JSON.stringify({ session_id: result.session_id, turns: result.turns })},
                    ${Number(result.cost_usd || 0)}, ${String(result.model || "")})
          `;
          await sql`
            UPDATE conversations SET message_count = message_count + 2, last_message_at = now()
            WHERE conversation_id = ${conversationId}
          `;
        });
      } catch {}
    }

    const runResponse = {
      output: result.output || "",
      session_id: result.session_id || "",
      success: Boolean(result.success),
      turns: Number(result.turns || 0),
      tool_calls: Number(result.tool_calls || 0),
      cost_usd: Number(result.cost_usd || 0),
      latency_ms: Number(result.latency_ms || 0),
      model: String(result.model || ""),
      conversation_id: conversationId || null,
      file_ids: fileIds,
    };

    // Deduct credits based on actual cost
    try {
      const costUsd = Number(result.cost_usd || 0);
      const deductResult = await withOrgDb(c.env, orgId, async (deductSql) => {
        return await deductCredits(deductSql, orgId, costUsd, `Agent run: ${agentName}`, agentName, String(result.session_id || ""));
      });
      if (!deductResult.success) {
        console.error(`[public-api-billing] FAILED deduction $${costUsd} from org ${orgId} — insufficient credits`);
      }
    } catch (err: any) {
      console.error(`[public-api-billing] Credit deduction error for org ${orgId}: ${err.message}`);
    }

    // Store idempotency cache if key was provided
    if (idempotencyKey) {
      try {
        await withOrgDb(c.env, orgId, async (sql) => {
          await sql`
            INSERT INTO idempotency_cache (idempotency_key, org_id, response_body, expires_at)
            VALUES (${idempotencyKey}, ${orgId}, ${JSON.stringify(runResponse)}, now() + interval '24 hours')
            ON CONFLICT (idempotency_key, org_id) DO NOTHING
          `;
        });
      } catch {}
    }

    return c.json(runResponse);
  } catch (err) {
    return c.json(failSafe(err, "public-api/agents/run-upload", { userMessage: "Agent execution failed. Please try again in a moment." }), 500);
  }
});

// ── POST /agents/:name/conversations — Create a new conversation ─────────

const createConversationRoute = createRoute({
  method: "post",
  path: "/agents/{name}/conversations",
  tags: ["Public API"],
  summary: "Create a new conversation thread",
  request: {
    params: z.object({ name: z.string().openapi({ example: "my-agent" }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().optional(),
            user_id: z.string().optional(),
            metadata: z.record(z.unknown()).optional(),
            input: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Conversation created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 403, 404, 500),
  },
});

publicAgentRoutes.openapi(createConversationRoute, async (c): Promise<any> => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const { name: agentName } = c.req.valid("param");
  const orgId = resolveOrgId(c);

  const accessErr = await checkAgentAccess(c, agentName, orgId);
  if (accessErr) return accessErr;

  const body = c.req.valid("json");
  const convId = crypto.randomUUID();

  return await withOrgDb(c.env, orgId, async (sql) => {
    await sql`
      INSERT INTO conversations (conversation_id, org_id, agent_name, external_user_id, title, metadata)
      VALUES (${convId}, ${orgId}, ${agentName}, ${body.user_id || ""}, ${body.title || ""}, ${JSON.stringify(body.metadata || {})})
    `;

    const now = new Date().toISOString();
    const result: Record<string, unknown> = {
      conversation_id: convId,
      agent_name: agentName,
      user_id: body.user_id || "",
      title: body.title || "",
      status: "active",
      metadata: body.metadata || {},
      message_count: 0,
      last_message_at: null,
      created_at: now,
      updated_at: now,
    };

    // If initial input provided, run the agent immediately
    if (body.input) {
      try {
        const resp = await c.env.RUNTIME.fetch(
          new Request("https://runtime/run", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              input: body.input,
              agent_name: agentName,
              org_id: orgId,
              project_id: "",
              channel: "public_api",
              channel_user_id: body.user_id || "",
            }),
          }),
        );

        const runResult = await resp.json() as Record<string, unknown>;

        // Save messages
        await sql`
          INSERT INTO conversation_messages (conversation_id, role, content, cost_usd, model)
          VALUES (${convId}, 'user', ${body.input}, 0, '')
        `;
        await sql`
          INSERT INTO conversation_messages (conversation_id, role, content, cost_usd, model)
          VALUES (${convId}, 'assistant', ${String(runResult.output || "")},
                  ${Number(runResult.cost_usd || 0)}, ${String(runResult.model || "")})
        `;
        await sql`
          UPDATE conversations SET message_count = 2, last_message_at = now()
          WHERE conversation_id = ${convId}
        `;

        result.messages = [
          { role: "user", content: body.input },
          { role: "assistant", content: runResult.output || "" },
        ];
        result.output = runResult.output;
        result.session_id = runResult.session_id;
      } catch {}
    }

    return c.json(result, 201);
  });
});

// ── GET /agents/:name/conversations — List conversations ──────────────────

const listConversationsRoute = createRoute({
  method: "get",
  path: "/agents/{name}/conversations",
  tags: ["Public API"],
  summary: "List conversations for an agent",
  request: {
    params: z.object({ name: z.string().openapi({ example: "my-agent" }) }),
    query: z.object({
      user_id: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
    }),
  },
  responses: {
    200: {
      description: "Conversation list",
      content: { "application/json": { schema: z.object({ conversations: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(401, 500),
  },
});

publicAgentRoutes.openapi(listConversationsRoute, async (c): Promise<any> => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const { name: agentName } = c.req.valid("param");
  const orgId = resolveOrgId(c);
  const { user_id: userId, limit, offset } = c.req.valid("query");

  return await withOrgDb(c.env, orgId, async (sql) => {
    let rows;
    if (userId) {
      rows = await sql`
        SELECT conversation_id, agent_name, external_user_id, title, status, metadata, message_count, last_message_at, created_at, updated_at
        FROM conversations
        WHERE agent_name = ${agentName} AND external_user_id = ${userId} AND status != 'deleted'
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT conversation_id, agent_name, external_user_id, title, status, metadata, message_count, last_message_at, created_at, updated_at
        FROM conversations
        WHERE agent_name = ${agentName} AND status != 'deleted'
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    return c.json({
      conversations: rows.map((r: any) => ({
        conversation_id: r.conversation_id,
        agent_name: r.agent_name,
        user_id: r.external_user_id || "",
        title: r.title || "",
        status: r.status,
        metadata: (() => { try { return typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata || {}; } catch { return {}; } })(),
        message_count: Number(r.message_count || 0),
        last_message_at: r.last_message_at || null,
        created_at: r.created_at,
        updated_at: r.updated_at || r.created_at,
      })),
    });
  });
});

// ── GET /agents/:name/conversations/:id — Get conversation with messages ──

const getConversationRoute = createRoute({
  method: "get",
  path: "/agents/{name}/conversations/{id}",
  tags: ["Public API"],
  summary: "Get conversation with messages",
  request: {
    params: z.object({
      name: z.string().openapi({ example: "my-agent" }),
      id: z.string().openapi({ example: "uuid-abc123" }),
    }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50).openapi({ example: 50 }),
      before: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Conversation with messages",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 404, 500),
  },
});

publicAgentRoutes.openapi(getConversationRoute, async (c): Promise<any> => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const orgId = resolveOrgId(c);
  const { id: convId } = c.req.valid("param");
  const { limit, before } = c.req.valid("query");

  return await withOrgDb(c.env, orgId, async (sql) => {
    const convRows = await sql`
      SELECT conversation_id, agent_name, external_user_id, title, status, message_count, metadata, created_at
      FROM conversations
      WHERE conversation_id = ${convId} AND status != 'deleted'
      LIMIT 1
    `;

    if (convRows.length === 0) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const conv = convRows[0];

    let messages;
    if (before) {
      // Paginate backwards: get newest messages before cursor, then reverse for ASC order
      const raw = await sql`
        SELECT id, role, content, cost_usd, model, created_at
        FROM conversation_messages
        WHERE conversation_id = ${convId} AND created_at < ${before}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      messages = raw.reverse();
    } else {
      messages = await sql`
        SELECT id, role, content, cost_usd, model, created_at
        FROM conversation_messages
        WHERE conversation_id = ${convId}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `;
    }

    return c.json({
      conversation_id: conv.conversation_id,
      agent_name: conv.agent_name,
      user_id: conv.external_user_id || "",
      title: conv.title || "",
      status: conv.status,
      metadata: (() => { try { return typeof conv.metadata === "string" ? JSON.parse(conv.metadata) : conv.metadata || {}; } catch { return {}; } })(),
      message_count: Number(conv.message_count || 0),
      created_at: conv.created_at,
      messages: messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        cost_usd: Number(m.cost_usd || 0),
        model: m.model || "",
        created_at: m.created_at,
      })),
    });
  });
});

// ── DELETE /agents/:name/conversations/:id — Delete conversation ──────────

const deleteConversationRoute = createRoute({
  method: "delete",
  path: "/agents/{name}/conversations/{id}",
  tags: ["Public API"],
  summary: "Delete a conversation",
  request: {
    params: z.object({
      name: z.string().openapi({ example: "my-agent" }),
      id: z.string().openapi({ example: "uuid-abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Conversation deleted",
      content: { "application/json": { schema: z.object({ deleted: z.string() }) } },
    },
    ...errorResponses(401, 404, 500),
  },
});

publicAgentRoutes.openapi(deleteConversationRoute, async (c): Promise<any> => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  const orgId = resolveOrgId(c);
  const { id: convId } = c.req.valid("param");

  return await withOrgDb(c.env, orgId, async (sql) => {
    const result = await sql`
      UPDATE conversations SET status = 'deleted', updated_at = now()
      WHERE conversation_id = ${convId}
      RETURNING conversation_id
    `;

    if (result.length === 0) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json({ deleted: convId });
  });
});
