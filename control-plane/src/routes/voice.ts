/**
 * Voice router — Vapi call listing/detail, platform calls, cross-platform summary.
 * Ported from agentos/api/routers/voice_webhooks.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDb, getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import {
  isVoiceGenericPlatform,
  processTavusWebhook,
  processVapiWebhook,
  verifyWebhookHmac,
  VOICE_GENERIC_PLATFORMS,
} from "../logic/voice-webhook";
import { extractVapiCallIds, resolveVapiVoiceTenant } from "../logic/voice-tenant";
import type { Env } from "../env";

export const voiceRoutes = createOpenAPIRouter();

function nowSec(): string {
  return new Date().toISOString();
}

function parseAgentConfigJson(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

// ── Plan-based model routing (mirrors deploy/src/runtime/db.ts + router.ts) ──

const PLAN_ROUTING: Record<string, Record<string, Record<string, { model: string; provider: string; max_tokens: number }>>> = {
  basic: {
    general: { simple: { model: "@cf/zai-org/glm-4.7-flash", provider: "workers-ai", max_tokens: 2048 }, moderate: { model: "@cf/zai-org/glm-4.7-flash", provider: "workers-ai", max_tokens: 4096 }, complex: { model: "@cf/moonshotai/kimi-k2.5", provider: "workers-ai", max_tokens: 8192 }, tool_call: { model: "@cf/zai-org/glm-4.7-flash", provider: "workers-ai", max_tokens: 2048 } },
    creative: { write: { model: "@cf/moonshotai/kimi-k2.5", provider: "workers-ai", max_tokens: 8192 } },
  },
  standard: {
    general: { simple: { model: "google-ai-studio/gemini-2.5-flash", provider: "google", max_tokens: 4096 }, moderate: { model: "openai/gpt-5-mini", provider: "openai", max_tokens: 8192 }, complex: { model: "openai/gpt-5.4", provider: "openai", max_tokens: 16384 }, tool_call: { model: "google-ai-studio/gemini-2.5-flash", provider: "google", max_tokens: 4096 } },
    creative: { write: { model: "anthropic/claude-sonnet-4-6", provider: "anthropic", max_tokens: 8192 } },
  },
  premium: {
    general: { simple: { model: "openai/gpt-5-nano", provider: "openai", max_tokens: 8192 }, moderate: { model: "openai/gpt-5.4", provider: "openai", max_tokens: 16384 }, complex: { model: "anthropic/claude-opus-4-6", provider: "anthropic", max_tokens: 16384 }, tool_call: { model: "openai/gpt-5.4", provider: "openai", max_tokens: 16384 } },
    creative: { write: { model: "anthropic/claude-opus-4-6", provider: "anthropic", max_tokens: 16384 } },
  },
};

/**
 * Resolve agent plan to routing table. Agent-level overrides win.
 */
function resolvePlanRouting(
  plan: string,
  agentRouting: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (agentRouting && Object.keys(agentRouting).length > 0) return agentRouting;
  const normalized = (plan || "standard").toLowerCase().trim();
  return PLAN_ROUTING[normalized] || PLAN_ROUTING["standard"];
}

/**
 * Select the best model for a voice call from the agent's plan routing.
 * Voice calls are conversational → use general.moderate by default.
 * Falls back to config.model or a sensible default.
 */
function resolveVoiceModel(config: Record<string, unknown>): { model: string; provider: string; max_tokens: number } {
  const plan = String(config.plan || "standard");
  const agentRouting = (config.routing && typeof config.routing === "object" && !Array.isArray(config.routing))
    ? (config.routing as Record<string, any>)
    : undefined;

  const routing = resolvePlanRouting(plan, agentRouting);
  if (routing) {
    // Voice is conversational — general.moderate is the best default
    const generalRoutes = routing["general"];
    if (generalRoutes) {
      const route = generalRoutes["moderate"] || generalRoutes["simple"];
      if (route && route.model) {
        return {
          model: String(route.model),
          provider: String(route.provider || "openai"),
          max_tokens: Number(route.max_tokens) || 4096,
        };
      }
    }
    // Try creative.write as fallback (also conversational)
    const creativeRoutes = routing["creative"];
    if (creativeRoutes?.write?.model) {
      return {
        model: String(creativeRoutes.write.model),
        provider: String(creativeRoutes.write.provider || "openai"),
        max_tokens: Number(creativeRoutes.write.max_tokens) || 4096,
      };
    }
  }

  // Fallback to config.model
  const fallbackModel = String(config.model || "anthropic/claude-sonnet-4-6");
  return {
    model: fallbackModel,
    provider: fallbackModel.includes("claude") ? "anthropic" : fallbackModel.includes("gpt") ? "openai" : "openai",
    max_tokens: 4096,
  };
}

function mapVoiceCallRow(r: Record<string, unknown>): Record<string, unknown> {
  const statusRaw = String(r.status ?? "").toLowerCase();
  let status: "completed" | "missed" | "voicemail" = "completed";
  if (statusRaw === "failed" || statusRaw === "busy" || statusRaw === "no-answer") status = "missed";
  else if (statusRaw.includes("voice")) status = "voicemail";

  const started = r.started_at ?? r.created_at;
  let startedAt = new Date().toISOString();
  try {
    if (typeof started === "string" || typeof started === "number") {
      startedAt = new Date(started).toISOString();
    }
  } catch {
    /* keep default */
  }

  return {
    id: String(r.call_id ?? ""),
    caller: String(r.phone_number ?? ""),
    duration_seconds: Number(r.duration_seconds ?? 0),
    status,
    started_at: startedAt,
    summary: String(r.transcript ?? "").slice(0, 500),
  };
}

async function vapiForwardGet(env: { VAPI_API_KEY?: string }, path: string): Promise<Response> {
  const key = String(env.VAPI_API_KEY ?? "").trim();
  if (!key) {
    return new Response(JSON.stringify({ error: "VAPI_API_KEY not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  return fetch(`https://api.vapi.ai${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
}

// ── GET/PUT /config — MVP agent voice prefs + call history (server-side Vapi key) ─

const getVoiceConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Voice"],
  summary: "Voice UI config for an agent (prefs + recent Vapi calls)",
  middleware: [requireScope("agents:read")],
  request: {
    query: z.object({ agent_name: z.string().min(1) }),
  },
  responses: {
    200: { description: "Voice config", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 404),
  },
});
voiceRoutes.openapi(getVoiceConfigRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: `Agent '${agentName}' not found` }, 404);
  }

  const cfg = parseAgentConfigJson((rows[0] as Record<string, unknown>).config_json);
  const voice = (cfg.voice && typeof cfg.voice === "object" && !Array.isArray(cfg.voice)
    ? (cfg.voice as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const vapiAssistantId = String(voice.vapi_assistant_id ?? "");
  let callRows: Record<string, unknown>[] = [];
  try {
    if (vapiAssistantId) {
      callRows = (await sql`
        SELECT * FROM voice_calls
        WHERE org_id = ${user.org_id} AND platform = 'vapi' AND platform_agent_id = ${vapiAssistantId}
        ORDER BY started_at DESC
        LIMIT 50
      `) as Record<string, unknown>[];
    } else {
      callRows = (await sql`
        SELECT * FROM voice_calls
        WHERE org_id = ${user.org_id} AND platform = 'vapi' AND agent_name = ${agentName}
        ORDER BY started_at DESC
        LIMIT 50
      `) as Record<string, unknown>[];
    }
  } catch {
    callRows = [];
  }

  const vapiConfigured = Boolean(String(c.env.VAPI_API_KEY ?? "").trim());

  return c.json({
    voice: String(voice.voice ?? "alloy"),
    greeting: String(voice.greeting ?? ""),
    language: String(voice.language ?? "en"),
    max_duration: Number(voice.max_duration ?? 600),
    vapi_configured: vapiConfigured,
    vapi_assistant_id: vapiAssistantId,
    vapi_phone_number_id: String(voice.vapi_phone_number_id ?? ""),
    calls: callRows.map((r) => mapVoiceCallRow(r)),
  });
});

const putVoiceConfigRoute = createRoute({
  method: "put",
  path: "/config",
  tags: ["Voice"],
  summary: "Update voice UI prefs and Vapi resource IDs on an agent",
  middleware: [requireScope("agents:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1),
            voice: z.string().optional(),
            greeting: z.string().optional(),
            language: z.string().optional(),
            max_duration: z.coerce.number().int().min(60).max(7200).optional(),
            vapi_assistant_id: z.string().optional(),
            vapi_phone_number_id: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 404),
  },
});
voiceRoutes.openapi(putVoiceConfigRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const agentName = body.agent_name;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT config_json FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: `Agent '${agentName}' not found` }, 404);
  }

  const cfg = parseAgentConfigJson((rows[0] as Record<string, unknown>).config_json);
  const prevVoice =
    cfg.voice && typeof cfg.voice === "object" && !Array.isArray(cfg.voice)
      ? (cfg.voice as Record<string, unknown>)
      : {};
  const nextVoice: Record<string, unknown> = { ...prevVoice };
  if (body.voice !== undefined) nextVoice.voice = body.voice;
  if (body.greeting !== undefined) nextVoice.greeting = body.greeting;
  if (body.language !== undefined) nextVoice.language = body.language;
  if (body.max_duration !== undefined) nextVoice.max_duration = body.max_duration;
  if (body.vapi_assistant_id !== undefined) nextVoice.vapi_assistant_id = body.vapi_assistant_id;
  if (body.vapi_phone_number_id !== undefined) nextVoice.vapi_phone_number_id = body.vapi_phone_number_id;
  cfg.voice = nextVoice;

  await sql`
    UPDATE agents SET config_json = ${JSON.stringify(cfg)}, updated_at = now()
    WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;

  // Auto-configure Vapi assistant with Server URL when linking
  let vapiConfigResult: { ok: boolean; error?: string } | null = null;
  const newAssistantId = String(nextVoice.vapi_assistant_id ?? "").trim();
  if (newAssistantId && c.env.VAPI_API_KEY) {
    const serverUrl = `https://api.oneshots.co/api/v1/voice/vapi/server-url`;
    vapiConfigResult = await configureVapiAssistant(c.env as Env, newAssistantId, {
      serverUrl,
      voice: String(nextVoice.voice ?? "") || undefined,
      greeting: String(nextVoice.greeting ?? "") || undefined,
      language: String(nextVoice.language ?? "") || undefined,
      maxDuration: Number(nextVoice.max_duration) || undefined,
    });
  }

  return c.json({
    ok: true,
    agent_name: agentName,
    vapi_configured: vapiConfigResult?.ok ?? false,
    vapi_config_error: vapiConfigResult?.error,
  });
});

// ── Vapi integration status (no secrets) ─────────────────────────────

const vapiIntegrationStatusRoute = createRoute({
  method: "get",
  path: "/vapi/integration-status",
  tags: ["Voice"],
  summary: "Whether VAPI_API_KEY is configured on the control plane",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: {
      description: "Status",
      content: {
        "application/json": {
          schema: z.object({ configured: z.boolean() }),
        },
      },
    },
  },
});
voiceRoutes.openapi(vapiIntegrationStatusRoute, async (c): Promise<any> => {
  const configured = Boolean(String(c.env.VAPI_API_KEY ?? "").trim());
  return c.json({ configured });
});

// ── Proxy: Vapi phone numbers & assistants (uses server API key) ─────

const vapiPhoneNumbersProxyRoute = createRoute({
  method: "get",
  path: "/vapi/phone-numbers",
  tags: ["Voice"],
  summary: "List phone numbers from Vapi (proxied)",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: { description: "Vapi JSON", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(500),
  },
});
voiceRoutes.openapi(vapiPhoneNumbersProxyRoute, async (c): Promise<any> => {
  const res = await vapiForwardGet(c.env, "/phone-number");
  const text = await res.text();
  if (!res.ok) {
    return c.json(
      { error: `Vapi error ${res.status}`, detail: text.slice(0, 400) },
      res.status === 503 ? 500 : 400,
    );
  }
  try {
    return c.json(JSON.parse(text) as Record<string, unknown>);
  } catch {
    return c.json({ error: "Vapi returned non-JSON" }, 400);
  }
});

const vapiAssistantsProxyRoute = createRoute({
  method: "get",
  path: "/vapi/assistants",
  tags: ["Voice"],
  summary: "List assistants from Vapi (proxied)",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: { description: "Vapi JSON", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(500),
  },
});
voiceRoutes.openapi(vapiAssistantsProxyRoute, async (c): Promise<any> => {
  const res = await vapiForwardGet(c.env, "/assistant");
  const text = await res.text();
  if (!res.ok) {
    return c.json(
      { error: `Vapi error ${res.status}`, detail: text.slice(0, 400) },
      res.status === 503 ? 500 : 400,
    );
  }
  try {
    return c.json(JSON.parse(text) as Record<string, unknown>);
  } catch {
    return c.json({ error: "Vapi returned non-JSON" }, 400);
  }
});

// ── Cross-platform Summary ─────────────────────────────────────────────

const allSummaryRoute = createRoute({
  method: "get",
  path: "/all/summary",
  tags: ["Voice"],
  summary: "Cross-platform voice call summary",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: {
      description: "Summary across all voice platforms",
      content: {
        "application/json": {
          schema: z.object({
            vapi: z.record(z.unknown()),
            platforms: z.record(z.unknown()),
            total_calls: z.number(),
            total_cost_usd: z.number(),
            total_duration_seconds: z.number(),
          }),
        },
      },
    },
  },
});
voiceRoutes.openapi(allSummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let vapiSummary: any = { total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 };
  try {
    const [vapi] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
    `;
    vapiSummary = vapi;
  } catch {
    /* table may be missing in dev */
  }

  let platformSummary: any = { total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 };
  try {
    const [all] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform != 'vapi' AND org_id = ${user.org_id}
    `;
    platformSummary = all;
  } catch {
    /* best-effort */
  }

  return c.json({
    vapi: vapiSummary,
    platforms: platformSummary,
    total_calls: Number(vapiSummary.total_calls) + Number(platformSummary.total_calls),
    total_cost_usd:
      Math.round(
        (Number(vapiSummary.total_cost_usd) + Number(platformSummary.total_cost_usd)) * 10000,
      ) / 10000,
    total_duration_seconds:
      Math.round(
        (Number(vapiSummary.total_duration_seconds) +
          Number(platformSummary.total_duration_seconds)) *
          10,
      ) / 10,
  });
});

// ── Vapi webhook (public — signature optional) ─────────────────────────

const vapiWebhookRoute = createRoute({
  method: "post",
  path: "/vapi/webhook",
  tags: ["Voice"],
  summary: "Receive Vapi webhook events",
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401),
  },
});
voiceRoutes.openapi(vapiWebhookRoute, async (c): Promise<any> => {
  const body = await c.req.arrayBuffer();
  const secret = c.env.VAPI_WEBHOOK_SECRET ?? "";
  const sig = c.req.header("x-vapi-signature") ?? "";
  if (!(await verifyWebhookHmac(secret, body, sig))) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const sql = await getDb(c.env.HYPERDRIVE);
  const { assistantId, phoneNumberId } = extractVapiCallIds(payload);
  const resolved = await resolveVapiVoiceTenant(sql, assistantId, phoneNumberId);
  const tenant = {
    org_id: resolved?.org_id ?? "",
    agent_name: resolved?.agent_name ?? "",
  };
  const out = await processVapiWebhook(payload, sql, tenant);
  return c.json(out);
});

// ── Vapi Server URL — agent LLM integration ────────────────────────────
// This is the endpoint Vapi calls on each conversation turn when an assistant
// has a serverUrl configured. It routes the call to the AgentOS agent's brain.

const vapiServerUrlRoute = createRoute({
  method: "post",
  path: "/vapi/server-url",
  tags: ["Voice"],
  summary: "Vapi Server URL endpoint — connects voice calls to AgentOS agents",
  responses: {
    200: {
      description: "Server URL response",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401),
  },
});
voiceRoutes.openapi(vapiServerUrlRoute, async (c): Promise<any> => {
  // Verify webhook signature
  const body = await c.req.arrayBuffer();
  const secret = c.env.VAPI_WEBHOOK_SECRET ?? "";
  const sig = c.req.header("x-vapi-signature") ?? "";
  if (!(await verifyWebhookHmac(secret, body, sig))) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const message = (payload.message ?? payload) as Record<string, unknown>;
  const eventType = String(message.type ?? payload.type ?? "");

  // Resolve which agent this call belongs to
  const { assistantId, phoneNumberId } = extractVapiCallIds(payload);
  const sql = await getDb(c.env.HYPERDRIVE);
  const tenant = await resolveVapiVoiceTenant(sql, assistantId, phoneNumberId);

  if (!tenant) {
    // Can't resolve agent — return minimal assistant config
    return c.json({
      messageResponse: {
        assistant: {
          firstMessage: "Hello, I'm sorry but I couldn't connect to the agent. Please try again later.",
          model: { provider: "openai", model: "gpt-4o-mini", messages: [] },
        },
      },
    });
  }

  // Load agent config
  const agentRows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${tenant.agent_name} AND org_id = ${tenant.org_id} LIMIT 1
  `;
  if (agentRows.length === 0) {
    return c.json({
      messageResponse: {
        assistant: {
          firstMessage: "Hello, the agent is currently unavailable.",
          model: { provider: "openai", model: "gpt-4o-mini", messages: [] },
        },
      },
    });
  }

  const config = parseAgentConfigJson((agentRows[0] as Record<string, unknown>).config_json);
  const voiceConfig = (config.voice && typeof config.voice === "object" && !Array.isArray(config.voice))
    ? (config.voice as Record<string, unknown>)
    : {};

  // ── assistant-request: Return full assistant configuration ──
  if (eventType === "assistant-request") {
    const systemPrompt = String(config.system_prompt || config.persona || "You are a helpful assistant.");
    const greeting = String(voiceConfig.greeting || "Hello! How can I help you today?");
    const voiceName = String(voiceConfig.voice || "alloy");
    const language = String(voiceConfig.language || "en");
    const maxDuration = Number(voiceConfig.max_duration) || 600;

    // Resolve model from agent's LLM plan routing (basic/standard/premium)
    const resolved = resolveVoiceModel(config);
    const { provider: vapiProvider, model: vapiModel } = mapModelToVapi(resolved.model);

    // Build tool definitions for Vapi (subset safe for voice)
    const agentTools = Array.isArray(config.tools) ? config.tools as string[] : [];
    const vapiTools = buildVapiToolDefs(agentTools);

    return c.json({
      messageResponse: {
        assistant: {
          firstMessage: greeting,
          model: {
            provider: vapiProvider,
            model: vapiModel,
            messages: [
              {
                role: "system",
                content: systemPrompt + "\n\nYou are speaking on a voice call. Keep responses concise and conversational. Avoid markdown, code blocks, or long lists.",
              },
            ],
            ...(vapiTools.length > 0 ? { tools: vapiTools, toolIds: [] } : {}),
          },
          voice: {
            provider: "openai",
            voiceId: voiceName,
          },
          transcriber: {
            provider: "deepgram",
            language,
          },
          maxDurationSeconds: maxDuration,
          silenceTimeoutSeconds: 30,
          endCallFunctionEnabled: true,
        },
      },
    });
  }

  // ── function-call: Execute agent tool via runtime ──
  if (eventType === "function-call") {
    const fnCall = (message.functionCall ?? {}) as Record<string, unknown>;
    const toolName = String(fnCall.name ?? "");
    const toolParams = (fnCall.parameters ?? {}) as Record<string, unknown>;

    if (!toolName) {
      return c.json({ results: [{ result: "No function name provided" }] });
    }

    try {
      // Call the runtime to execute the tool
      const runtimeResp = await c.env.RUNTIME.fetch(
        new Request("https://runtime/run", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            input: `Execute the tool "${toolName}" with parameters: ${JSON.stringify(toolParams)}`,
            agent_name: tenant.agent_name,
            org_id: tenant.org_id,
            channel: "voice",
            channel_user_id: "voice-caller",
          }),
        }),
      );

      const runtimeResult = (await runtimeResp.json().catch(() => ({}))) as Record<string, unknown>;
      const output = String(runtimeResult.output || "Tool execution completed.");

      return c.json({
        results: [{ toolCallId: String(fnCall.id ?? ""), result: output }],
      });
    } catch (err: any) {
      return c.json({
        results: [{ toolCallId: String(fnCall.id ?? ""), result: `Error: ${err.message || "Tool execution failed"}` }],
      });
    }
  }

  // ── end-of-call-report + other events: process normally ──
  const tenantCtx = { org_id: tenant.org_id, agent_name: tenant.agent_name };
  const out = await processVapiWebhook(payload, sql, tenantCtx);
  return c.json(out);
});

/**
 * Map AgentOS model identifiers to Vapi-compatible provider/model pairs.
 */
function mapModelToVapi(agentModel: string): { provider: string; model: string } {
  const lower = agentModel.toLowerCase();

  if (lower.includes("claude")) {
    return { provider: "anthropic", model: lower.replace("anthropic/", "") };
  }
  if (lower.includes("gpt-4o")) {
    return { provider: "openai", model: lower.replace("openai/", "") };
  }
  if (lower.includes("gpt-4")) {
    return { provider: "openai", model: "gpt-4o" };
  }
  if (lower.includes("gemini")) {
    return { provider: "google", model: lower.replace("google/", "") };
  }

  // Default for unknown models
  return { provider: "openai", model: "gpt-4o" };
}

/**
 * Build Vapi-compatible tool definitions from AgentOS tool names.
 * Only includes tools that make sense in a voice context.
 */
function buildVapiToolDefs(
  agentTools: string[],
): Array<Record<string, unknown>> {
  // Tools that are useful and safe in voice calls
  const VOICE_SAFE_TOOLS: Record<string, {
    description: string;
    parameters: Record<string, unknown>;
  }> = {
    "web-search": {
      description: "Search the web for information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
    "knowledge-search": {
      description: "Search the agent's knowledge base for relevant information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
    "http-request": {
      description: "Make an API request to fetch data",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "API URL" },
          method: { type: "string", description: "HTTP method (GET, POST)" },
        },
        required: ["url"],
      },
    },
    "db-query": {
      description: "Query the database for information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query" },
        },
        required: ["query"],
      },
    },
    "send-email": {
      description: "Send an email notification",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body" },
        },
        required: ["to", "subject", "body"],
      },
    },
    "create-schedule": {
      description: "Schedule a follow-up or reminder",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What to schedule" },
          when: { type: "string", description: "When (e.g., 'tomorrow at 2pm')" },
        },
        required: ["description", "when"],
      },
    },
  };

  const tools: Array<Record<string, unknown>> = [];
  for (const name of agentTools) {
    const def = VOICE_SAFE_TOOLS[name];
    if (def) {
      tools.push({
        type: "function",
        function: {
          name,
          description: def.description,
          parameters: def.parameters,
        },
      });
    }
  }
  return tools;
}

/**
 * Update a Vapi assistant's serverUrl and voice settings.
 * Called when linking an agent to a Vapi assistant.
 */
async function configureVapiAssistant(
  env: Env,
  assistantId: string,
  opts: {
    serverUrl: string;
    voice?: string;
    greeting?: string;
    language?: string;
    maxDuration?: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = String(env.VAPI_API_KEY ?? "").trim();
  if (!apiKey || !assistantId) {
    return { ok: false, error: "VAPI_API_KEY or assistant ID missing" };
  }

  const patchBody: Record<string, unknown> = {
    serverUrl: opts.serverUrl,
  };

  if (opts.voice) {
    patchBody.voice = {
      provider: "openai",
      voiceId: opts.voice,
    };
  }

  if (opts.greeting) {
    patchBody.firstMessage = opts.greeting;
  }

  if (opts.language) {
    patchBody.transcriber = {
      provider: "deepgram",
      language: opts.language,
    };
  }

  if (opts.maxDuration && opts.maxDuration > 0) {
    patchBody.maxDurationSeconds = opts.maxDuration;
  }

  try {
    const resp = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patchBody),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Vapi API ${resp.status}: ${text.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || "Failed to update Vapi assistant" };
  }
}

// ── Vapi Calls ─────────────────────────────────────────────────────────

const vapiCallsListRoute = createRoute({
  method: "get",
  path: "/vapi/calls",
  tags: ["Voice"],
  summary: "List Vapi calls",
  middleware: [requireScope("integrations:read")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: "Call list",
      content: { "application/json": { schema: z.object({ calls: z.array(z.record(z.unknown())) }) } },
    },
  },
});
voiceRoutes.openapi(vapiCallsListRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, status, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName && status) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
        AND agent_name = ${agentName} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
        AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (status) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
        AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ calls: rows });
});

// ── Vapi Calls Summary ─────────────────────────────────────────────────

const vapiCallsSummaryRoute = createRoute({
  method: "get",
  path: "/vapi/calls/summary",
  tags: ["Voice"],
  summary: "Get Vapi calls summary",
  middleware: [requireScope("integrations:read")],
  responses: {
    200: {
      description: "Vapi call summary",
      content: {
        "application/json": {
          schema: z.object({
            total_calls: z.number(),
            total_cost_usd: z.number(),
            total_duration_seconds: z.number(),
          }),
        },
      },
    },
  },
});
voiceRoutes.openapi(vapiCallsSummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    const [summary] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform = 'vapi' AND org_id = ${user.org_id}
    `;
    return c.json(summary);
  } catch {
    return c.json({ total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 });
  }
});

// ── POST Vapi Calls (initiate outbound) ────────────────────────────────

const vapiCallsCreateRoute = createRoute({
  method: "post",
  path: "/vapi/calls",
  tags: ["Voice"],
  summary: "Initiate outbound Vapi call (uses server VAPI_API_KEY)",
  middleware: [requireScope("integrations:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            /** Vapi phone-number resource id */
            phone_number_id: z.string().optional(),
            /** Destination E.164, e.g. +15551234567 */
            customer_phone: z.string().optional(),
            assistant_id: z.string().optional(),
            agent_name: z.string().default(""),
            first_message: z.string().optional(),
            /** @deprecated use phone_number_id; was previously misused as phoneNumberId only */
            phone_number: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Call initiated",
      content: {
        "application/json": {
          schema: z.object({
            call_id: z.string(),
            status: z.string(),
            vapi_response: z.record(z.unknown()),
          }),
        },
      },
    },
    ...errorResponses(400),
  },
});
voiceRoutes.openapi(vapiCallsCreateRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const apiKey = c.env.VAPI_API_KEY ?? "";
  if (!apiKey) {
    return c.json({ error: "VAPI_API_KEY not configured" }, 400);
  }
  const body = c.req.valid("json");
  const phoneNumberId = String(body.phone_number_id || body.phone_number || "").trim();
  const customerPhone = String(body.customer_phone || "").trim();
  const assistant_id = String(body.assistant_id || "").trim();
  const agent_name = body.agent_name;
  const first_message = body.first_message;

  if (!phoneNumberId || !customerPhone || !assistant_id) {
    return c.json(
      { error: "phone_number_id, customer_phone, and assistant_id are required" },
      400,
    );
  }

  const vapiBody: Record<string, unknown> = {
    assistantId: assistant_id,
    phoneNumberId,
    customer: { number: customerPhone },
  };
  if (first_message && first_message.trim()) {
    vapiBody.assistantOverrides = { firstMessage: first_message.trim() };
  }

  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(vapiBody),
  });
  const text = await res.text();
  if (!res.ok) {
    return c.json(
      { error: `Vapi API error: ${res.status} ${text.slice(0, 300)}` },
      400,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Vapi API returned non-JSON" }, 400);
  }
  const call_id = String(data.id ?? "");
  if (!call_id) {
    return c.json({ error: "Vapi API response missing call id" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await sql`
      INSERT INTO voice_calls (
        call_id, platform, org_id, agent_name, phone_number, direction, status,
        platform_agent_id, started_at
      ) VALUES (
        ${call_id}, 'vapi', ${user.org_id}, ${agent_name}, ${customerPhone},
        'outbound', 'pending', ${assistant_id}, ${nowSec()}
      )
      ON CONFLICT (call_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        agent_name = EXCLUDED.agent_name,
        phone_number = EXCLUDED.phone_number,
        status = EXCLUDED.status,
        platform_agent_id = EXCLUDED.platform_agent_id
    `;
  } catch {
    /* best-effort */
  }

  return c.json({ call_id, status: "initiated", vapi_response: data });
});

// ── DELETE Vapi Call ────────────────────────────────────────────────────

const vapiCallDeleteRoute = createRoute({
  method: "delete",
  path: "/vapi/calls/{call_id}",
  tags: ["Voice"],
  summary: "End a Vapi call",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call ended",
      content: { "application/json": { schema: z.object({ ended: z.boolean(), call_id: z.string() }) } },
    },
    ...errorResponses(400),
  },
});
voiceRoutes.openapi(vapiCallDeleteRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { call_id: callId } = c.req.valid("param");
  const apiKey = c.env.VAPI_API_KEY ?? "";
  if (!apiKey) {
    return c.json({ error: "VAPI_API_KEY not configured" }, 400);
  }
  const res = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (![200, 204].includes(res.status)) {
    return c.json({ error: `Vapi API error: ${res.status}` }, 400);
  }
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await sql`
      UPDATE voice_calls SET status = 'ended', ended_at = ${nowSec()}
      WHERE call_id = ${callId} AND platform = 'vapi'
    `;
  } catch {
    /* best-effort */
  }
  return c.json({ ended: true, call_id: callId });
});

// ── GET Vapi Call Detail ───────────────────────────────────────────────

const vapiCallDetailRoute = createRoute({
  method: "get",
  path: "/vapi/calls/{call_id}",
  tags: ["Voice"],
  summary: "Get Vapi call detail",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(vapiCallDetailRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { call_id: callId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM voice_calls
    WHERE call_id = ${callId} AND platform = 'vapi' AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Call not found" }, 404);
  return c.json(rows[0]);
});

// ── GET Vapi Call Events ───────────────────────────────────────────────

const vapiCallEventsRoute = createRoute({
  method: "get",
  path: "/vapi/calls/{call_id}/events",
  tags: ["Voice"],
  summary: "Get Vapi call events",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call events",
      content: { "application/json": { schema: z.object({ events: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(vapiCallEventsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { call_id: callId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const own = await sql`
    SELECT 1 FROM voice_calls
    WHERE call_id = ${callId} AND platform = 'vapi' AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (own.length === 0) return c.json({ error: "Call not found" }, 404);
  const rows = await sql`
    SELECT e.* FROM voice_call_events e
    INNER JOIN voice_calls vc ON vc.call_id = e.call_id
    WHERE e.call_id = ${callId} AND vc.org_id = ${user.org_id} AND vc.platform = 'vapi'
    ORDER BY e.created_at
  `;
  return c.json({ events: rows });
});

// ── Generic platform webhook (e.g. Tavus) ──────────────────────────────

const platformWebhookRoute = createRoute({
  method: "post",
  path: "/{platform}/webhook",
  tags: ["Voice"],
  summary: "Receive webhook events for a voice platform",
  request: {
    params: z.object({ platform: z.string() }),
  },
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 401, 404),
  },
});
voiceRoutes.openapi(platformWebhookRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const cfg = VOICE_GENERIC_PLATFORMS[platform];
  const body = await c.req.arrayBuffer();
  const secret =
    platform === "tavus" ? (c.env.TAVUS_WEBHOOK_SECRET ?? "") : "";
  const sigHeader = c.req.header(cfg.signatureHeader) ?? "";
  if (!(await verifyWebhookHmac(secret, body, sigHeader))) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const sql = await getDb(c.env.HYPERDRIVE);
  if (platform === "tavus") {
    const out = await processTavusWebhook(payload, sql, "");
    return c.json(out);
  }
  return c.json({ error: "Unsupported platform" }, 400);
});

// ── Generic Platform Calls Summary ─────────────────────────────────────

const platformCallsSummaryRoute = createRoute({
  method: "get",
  path: "/{platform}/calls/summary",
  tags: ["Voice"],
  summary: "Get call summary for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string() }),
  },
  responses: {
    200: {
      description: "Call summary",
      content: {
        "application/json": {
          schema: z.object({
            total_calls: z.number(),
            total_cost_usd: z.number(),
            total_duration_seconds: z.number(),
          }),
        },
      },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallsSummaryRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    const [summary] = await sql`
      SELECT COUNT(*) as total_calls,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd,
             COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
      FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
    `;
    return c.json(summary);
  } catch {
    return c.json({ total_calls: 0, total_cost_usd: 0, total_duration_seconds: 0 });
  }
});

// ── Generic Platform Calls List ────────────────────────────────────────

const platformCallsListRoute = createRoute({
  method: "get",
  path: "/{platform}/calls",
  tags: ["Voice"],
  summary: "List calls for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string() }),
    query: z.object({
      agent_name: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: "Call list",
      content: { "application/json": { schema: z.object({ calls: z.array(z.record(z.unknown())), platform: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallsListRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const { agent_name: agentName, status, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName && status) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
        AND agent_name = ${agentName} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
        AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM voice_calls WHERE platform = ${platform} AND org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ calls: rows, platform });
});

// ── Generic Platform Create Call ───────────────────────────────────────

const platformCallCreateRoute = createRoute({
  method: "post",
  path: "/{platform}/calls",
  tags: ["Voice"],
  summary: "Initiate a call on a voice platform",
  middleware: [requireScope("integrations:write")],
  request: {
    params: z.object({ platform: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            persona_id: z.string().default(""),
            context: z.string().default(""),
            agent_name: z.string().default(""),
            properties: z.record(z.unknown()).default({}),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Call initiated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404),
  },
});
voiceRoutes.openapi(platformCallCreateRoute, async (c): Promise<any> => {
  const { platform } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  if (platform !== "tavus") {
    return c.json({ error: `Create not supported for ${platform}` }, 400);
  }

  const user = c.get("user");
  const apiKey = c.env.TAVUS_API_KEY ?? "";
  if (!apiKey) {
    return c.json({ error: "TAVUS_API_KEY not configured" }, 400);
  }

  const body = c.req.valid("json");
  const persona_id = body.persona_id;
  const context = body.context;
  const agent_name = body.agent_name;
  const properties = body.properties;

  const reqBody: Record<string, unknown> = { persona_id };
  if (context) reqBody.conversational_context = context;
  if (properties && Object.keys(properties).length > 0) reqBody.properties = properties;

  const res = await fetch("https://api.tavus.io/v2/conversations", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });
  const text = await res.text();
  if (![200, 201].includes(res.status)) {
    return c.json(
      { error: `Tavus API error: ${res.status} ${text.slice(0, 300)}` },
      400,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Tavus API returned non-JSON" }, 400);
  }
  const conversation_id = String(
    data.conversation_id ?? data.id ?? "",
  );
  if (!conversation_id) {
    return c.json({ error: "Tavus API response missing conversation id" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  try {
    await sql`
      INSERT INTO voice_calls (
        call_id, platform, org_id, agent_name, phone_number, direction, status,
        platform_agent_id, started_at
      ) VALUES (
        ${conversation_id}, 'tavus', ${user.org_id}, ${agent_name}, '',
        'outbound', 'pending', ${persona_id}, ${nowSec()}
      )
      ON CONFLICT (call_id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        agent_name = EXCLUDED.agent_name,
        status = EXCLUDED.status,
        platform_agent_id = EXCLUDED.platform_agent_id
    `;
  } catch {
    /* best-effort */
  }

  return c.json({
    conversation_id,
    status: "initiated",
    tavus_response: data,
  });
});

// ── Generic Platform Call Detail ───────────────────────────────────────

const platformCallDetailRoute = createRoute({
  method: "get",
  path: "/{platform}/calls/{call_id}",
  tags: ["Voice"],
  summary: "Get call detail for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string(), call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call detail",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallDetailRoute, async (c): Promise<any> => {
  const { platform, call_id: callId } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM voice_calls
    WHERE call_id = ${callId} AND platform = ${platform} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "Call not found" }, 404);
  return c.json(rows[0]);
});

// ── Generic Platform Call Events ───────────────────────────────────────

const platformCallEventsRoute = createRoute({
  method: "get",
  path: "/{platform}/calls/{call_id}/events",
  tags: ["Voice"],
  summary: "Get call events for a voice platform",
  middleware: [requireScope("integrations:read")],
  request: {
    params: z.object({ platform: z.string(), call_id: z.string() }),
  },
  responses: {
    200: {
      description: "Call events",
      content: { "application/json": { schema: z.object({ events: z.array(z.record(z.unknown())), platform: z.string() }) } },
    },
    ...errorResponses(404),
  },
});
voiceRoutes.openapi(platformCallEventsRoute, async (c): Promise<any> => {
  const { platform, call_id: callId } = c.req.valid("param");
  if (!isVoiceGenericPlatform(platform)) {
    return c.json({ error: `Unknown platform: ${platform}` }, 404);
  }
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const own = await sql`
    SELECT 1 FROM voice_calls
    WHERE call_id = ${callId} AND platform = ${platform} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (own.length === 0) return c.json({ error: "Call not found" }, 404);
  const rows = await sql`
    SELECT e.* FROM voice_call_events e
    INNER JOIN voice_calls vc ON vc.call_id = e.call_id
    WHERE e.call_id = ${callId} AND vc.org_id = ${user.org_id} AND vc.platform = ${platform}
    ORDER BY e.created_at
  `;
  return c.json({ events: rows, platform });
});
