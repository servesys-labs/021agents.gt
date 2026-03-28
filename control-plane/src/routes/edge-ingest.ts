/**
 * Edge ingest router — accept session/turn data from runtime worker.
 * Ported from agentos/api/routers/edge_ingest.py
 *
 * These endpoints are called by the runtime worker to persist telemetry.
 * Auth is via SERVICE_TOKEN, not user JWT.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDb } from "../db/client";

export const edgeIngestRoutes = createOpenAPIRouter();

function requireServiceToken(c: any): boolean {
  const expected = (c.env.SERVICE_TOKEN || "").trim();
  if (!expected) return false;

  const authHeader = c.req.header("Authorization") || "";
  const edgeToken = c.req.header("X-Edge-Token") || "";
  let supplied = edgeToken.trim();
  if (!supplied && authHeader.toLowerCase().startsWith("bearer ")) {
    supplied = authHeader.slice(7).trim();
  }
  return supplied === expected;
}

function ensureIngestAuth(c: any): Response | null {
  const expected = (c.env.SERVICE_TOKEN || "").trim();
  if (!expected) {
    return c.json({ error: "SERVICE_TOKEN not configured for ingest" }, 503);
  }
  if (!requireServiceToken(c)) {
    return c.json({ error: "Invalid ingest token" }, 401);
  }
  return null;
}

// ── POST /sessions — Ingest session data ────────────────────────────

const ingestSessionRoute = createRoute({
  method: "post",
  path: "/sessions",
  tags: ["Edge Ingest"],
  summary: "Ingest session data from runtime worker",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            session_id: z.string().min(1).openapi({ example: "sess-abc123" }),
            org_id: z.string().default("").openapi({ example: "org_abc" }),
            project_id: z.string().default("").openapi({ example: "proj_abc" }),
            agent_name: z.string().default("").openapi({ example: "my-agent" }),
            status: z.string().default("completed"),
            input_text: z.string().default(""),
            output_text: z.string().default(""),
            model: z.string().default(""),
            trace_id: z.string().default(""),
            parent_session_id: z.string().default(""),
            depth: z.coerce.number().default(0),
            step_count: z.coerce.number().default(0),
            action_count: z.coerce.number().default(0),
            wall_clock_seconds: z.coerce.number().default(0),
            cost_total_usd: z.coerce.number().default(0),
            created_at: z.coerce.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session ingested",
      content: { "application/json": { schema: z.object({ ingested: z.boolean(), session_id: z.string() }) } },
    },
    ...errorResponses(400, 401, 500),
  },
});

edgeIngestRoutes.openapi(ingestSessionRoute, async (c): Promise<any> => {
  const authError = ensureIngestAuth(c);
  if (authError) return authError;

  const payload = c.req.valid("json");
  const sessionId = String(payload.session_id || "").trim();
  if (!sessionId) return c.json({ error: "session_id required" }, 400);

  const orgId = String(payload.org_id || "").trim();
  const projectId = String(payload.project_id || "").trim();
  const agentName = String(payload.agent_name || "").trim();
  const status = String(payload.status || "completed").trim() || "completed";
  const inputText = String(payload.input_text || "").slice(0, 5000);
  const outputText = String(payload.output_text || "").slice(0, 10000);
  const model = String(payload.model || "");
  const traceId = String(payload.trace_id || "");
  const parentSessionId = String(payload.parent_session_id || "");
  const depth = Number(payload.depth || 0) || 0;
  const stepCount = Number(payload.step_count || 0) || 0;
  const actionCount = Number(payload.action_count || 0) || 0;
  const wallClockSeconds = Number(payload.wall_clock_seconds || 0) || 0;
  const costTotalUsd = Number(payload.cost_total_usd || 0) || 0;
  const now = payload.created_at ? new Date(Number(payload.created_at) * 1000).toISOString() : new Date().toISOString();
  const endedAt = new Date().toISOString();

  const sql = await getDb(c.env.HYPERDRIVE);

  await sql`
    INSERT INTO sessions (
      session_id, org_id, project_id, agent_name, model, status,
      input_text, output_text, step_count, action_count, wall_clock_seconds,
      cost_total_usd, trace_id, parent_session_id, depth, created_at, ended_at
    ) VALUES (
      ${sessionId}, ${orgId}, ${projectId}, ${agentName}, ${model}, ${status},
      ${inputText}, ${outputText}, ${stepCount}, ${actionCount}, ${wallClockSeconds},
      ${costTotalUsd}, ${traceId}, ${parentSessionId}, ${depth}, ${now}, ${endedAt}
    )
    ON CONFLICT (session_id) DO UPDATE SET
      org_id = EXCLUDED.org_id,
      project_id = EXCLUDED.project_id,
      agent_name = EXCLUDED.agent_name,
      model = EXCLUDED.model,
      status = EXCLUDED.status,
      input_text = EXCLUDED.input_text,
      output_text = EXCLUDED.output_text,
      step_count = EXCLUDED.step_count,
      action_count = EXCLUDED.action_count,
      wall_clock_seconds = EXCLUDED.wall_clock_seconds,
      cost_total_usd = EXCLUDED.cost_total_usd,
      trace_id = EXCLUDED.trace_id,
      parent_session_id = EXCLUDED.parent_session_id,
      depth = EXCLUDED.depth,
      ended_at = EXCLUDED.ended_at
  `;

  return c.json({ ingested: true, session_id: sessionId });
});

// ── POST /turns — Ingest turn data ──────────────────────────────────

const ingestTurnRoute = createRoute({
  method: "post",
  path: "/turns",
  tags: ["Edge Ingest"],
  summary: "Ingest turn data from runtime worker",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            session_id: z.string().min(1).openapi({ example: "sess-abc123" }),
            turn_number: z.coerce.number().int().min(1).openapi({ example: 1 }),
            model_used: z.string().default(""),
            input_tokens: z.coerce.number().default(0),
            output_tokens: z.coerce.number().default(0),
            latency_ms: z.coerce.number().default(0),
            llm_content: z.string().default(""),
            cost_total_usd: z.coerce.number().default(0),
            tool_calls_json: z.string().default("[]"),
            tool_results_json: z.string().default("[]"),
            errors_json: z.string().default("[]"),
            execution_mode: z.string().default("sequential"),
            plan_json: z.string().default("{}"),
            reflection_json: z.string().default("{}"),
            started_at: z.coerce.number().optional(),
            ended_at: z.coerce.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Turn ingested",
      content: { "application/json": { schema: z.object({ ingested: z.boolean(), session_id: z.string(), turn_number: z.number() }) } },
    },
    ...errorResponses(400, 401, 500),
  },
});

edgeIngestRoutes.openapi(ingestTurnRoute, async (c): Promise<any> => {
  const authError = ensureIngestAuth(c);
  if (authError) return authError;

  const payload = c.req.valid("json");
  const sessionId = String(payload.session_id || "").trim();
  const turnNumber = Number(payload.turn_number || 0) || 0;
  if (!sessionId || turnNumber <= 0) {
    return c.json({ error: "session_id and turn_number required" }, 400);
  }

  const sql = await getDb(c.env.HYPERDRIVE);

  // Delete existing turn and insert fresh
  await sql`DELETE FROM turns WHERE session_id = ${sessionId} AND turn_number = ${turnNumber}`;

  const modelUsed = String(payload.model_used || "");
  const inputTokens = Number(payload.input_tokens || 0) || 0;
  const outputTokens = Number(payload.output_tokens || 0) || 0;
  const latencyMs = Number(payload.latency_ms || 0) || 0;
  const llmContent = String(payload.llm_content || "").slice(0, 10000);
  const costTotalUsd = Number(payload.cost_total_usd || 0) || 0;
  const toolCallsJson = String(payload.tool_calls_json || "[]");
  const toolResultsJson = String(payload.tool_results_json || "[]");
  const errorsJson = String(payload.errors_json || "[]");
  const executionMode = String(payload.execution_mode || "sequential");
  const planJson = String(payload.plan_json || "{}");
  const reflectionJson = String(payload.reflection_json || "{}");
  const startedAt = payload.started_at ? new Date(Number(payload.started_at) * 1000).toISOString() : new Date().toISOString();
  const endedAt = payload.ended_at ? new Date(Number(payload.ended_at) * 1000).toISOString() : new Date().toISOString();

  await sql`
    INSERT INTO turns (
      session_id, turn_number, model_used, input_tokens, output_tokens, latency_ms,
      llm_content, cost_total_usd, tool_calls_json, tool_results_json, errors_json,
      execution_mode, plan_json, reflection_json, started_at, ended_at
    ) VALUES (
      ${sessionId}, ${turnNumber}, ${modelUsed}, ${inputTokens}, ${outputTokens}, ${latencyMs},
      ${llmContent}, ${costTotalUsd}, ${toolCallsJson}, ${toolResultsJson}, ${errorsJson},
      ${executionMode}, ${planJson}, ${reflectionJson}, ${startedAt}, ${endedAt}
    )
  `;

  return c.json({ ingested: true, session_id: sessionId, turn_number: turnNumber });
});
