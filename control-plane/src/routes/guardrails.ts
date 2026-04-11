/**
 * Guardrails Router — scan, redact, policy CRUD, event log, stats, test.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { requireScope } from "../middleware/auth";
import { detectPii, redactPii, scanAndRedact, PII_CATEGORIES } from "../logic/pii-detector";
import { detectInjection } from "../logic/prompt-injection";
import { scanOutput } from "../logic/output-safety";
import {
  evaluateInput,
  evaluateOutput,
  DEFAULT_GUARDRAIL_POLICY,
  type GuardrailPolicy,
} from "../logic/guardrail-engine";
import { logSecurityEvent } from "../logic/security-events";

export const guardrailRoutes = createOpenAPIRouter();

// ── Helpers ─────────────────────────────────────────────────────

function genId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function textPreview(text: string, maxLen = 100): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

// ── Zod schemas ─────────────────────────────────────────────────

const scanBodySchema = z.object({
  text: z.string().min(1).max(200_000),
  scan_type: z.enum(["input", "output"]),
  agent_name: z.string().optional(),
  system_prompt: z.string().optional(),
});

const redactBodySchema = z.object({
  text: z.string().min(1).max(200_000),
  categories: z.array(z.string()).optional(),
});

const policyBodySchema = z.object({
  name: z.string().min(1).max(200),
  agent_name: z.string().optional(),
  pii_detection: z.boolean().default(true),
  pii_redaction: z.boolean().default(true),
  injection_check: z.boolean().default(true),
  output_safety: z.boolean().default(true),
  max_input_length: z.number().int().min(0).default(50_000),
  blocked_topics: z.array(z.string()).default([]),
});

const testBodySchema = z.object({
  text: z.string().min(1).max(200_000),
  policy_id: z.string(),
});

const eventsQuerySchema = z.object({
  agent_name: z.string().optional(),
  event_type: z.string().optional(),
  since_days: z.coerce.number().int().min(1).max(365).default(7),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ── POST /scan ──────────────────────────────────────────────────

const scanRoute = createRoute({
  method: "post",
  path: "/scan",
  tags: ["Guardrails"],
  summary: "Scan text for policy violations",
  middleware: [requireScope("guardrails:write")],
  request: { body: { content: { "application/json": { schema: scanBodySchema } } } },
  responses: {
    200: { description: "Scan result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

guardrailRoutes.openapi(scanRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { text, scan_type, agent_name, system_prompt } = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Load agent-specific policy if agent_name is provided, otherwise use defaults
    let policy = DEFAULT_GUARDRAIL_POLICY;
    if (agent_name) {
      try {
        const rows = await sql`
          SELECT policy FROM guardrail_policies
          WHERE (agent_name = ${agent_name} OR agent_name IS NULL)
          ORDER BY agent_name DESC NULLS LAST
          LIMIT 1
        `;
        if (rows.length) {
          const row = rows[0] as Record<string, unknown>;
          policy = {
            ...DEFAULT_GUARDRAIL_POLICY,
            ...(typeof row.policy === "string"
              ? JSON.parse(row.policy)
              : row.policy ?? {}),
          };
        }
      } catch {
        // Fall back to defaults
      }
    }

    const piiMatches = detectPii(text);
    const injectionResult = detectInjection(text);
    const safetyResult = scan_type === "output" ? scanOutput(text, system_prompt) : null;

    const result =
      scan_type === "input"
        ? evaluateInput(text, policy)
        : evaluateOutput(text, policy, system_prompt);

    // Log event asynchronously (best-effort)
    try {
      await sql`
        INSERT INTO guardrail_events (
          id, org_id, agent_name, event_type, action,
          text_preview, matches, created_at
        ) VALUES (
          ${genId()}, ${user.org_id}, ${agent_name ?? "unknown"},
          ${scan_type}, ${result.action},
          ${textPreview(text)}, ${JSON.stringify({
            pii: piiMatches.length,
            injection_score: injectionResult.score,
            safety_issues: safetyResult?.issues.length ?? 0,
          })},
          ${Date.now()}
        )
      `;
    } catch {
      // Best-effort logging
    }

    // Security event: guardrail triggered or blocked
    if (result.action === "block" || result.action === "warn") {
      try {
        logSecurityEvent(sql, {
          org_id: user.org_id,
          event_type: result.action === "block" ? "guardrail.blocked" : "guardrail.triggered",
          actor_id: user.user_id,
          actor_type: "user",
          severity: "high",
          details: {
            scan_type,
            action: result.action,
            agent_name: agent_name ?? "unknown",
            pii_count: piiMatches.length,
            injection_score: injectionResult.score,
            reasons: result.reasons,
          },
        });
      } catch {
        // Best-effort
      }
    }

    return c.json({
      safe: result.action === "allow",
      action: result.action,
      pii_matches: piiMatches,
      injection_result: injectionResult,
      safety_issues: safetyResult?.issues ?? [],
      redacted_text: result.redacted_text,
    });
  });
});

// ── POST /redact ────────────────────────────────────────────────

const redactRoute = createRoute({
  method: "post",
  path: "/redact",
  tags: ["Guardrails"],
  summary: "Redact PII from text",
  middleware: [requireScope("guardrails:write")],
  request: { body: { content: { "application/json": { schema: redactBodySchema } } } },
  responses: {
    200: { description: "Redacted text", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

guardrailRoutes.openapi(redactRoute, async (c): Promise<any> => {
  const { text, categories } = c.req.valid("json");
  let matches = detectPii(text);

  // Filter by categories if provided
  if (categories?.length) {
    const catSet = new Set(categories);
    matches = matches.filter((m) => catSet.has(m.type));
  }

  const redacted = redactPii(text, matches);

  return c.json({
    original_length: text.length,
    redacted_text: redacted,
    redacted_count: matches.length,
    matches,
  });
});

// ── GET /policies ───────────────────────────────────────────────

const listPoliciesRoute = createRoute({
  method: "get",
  path: "/policies",
  tags: ["Guardrails"],
  summary: "List guardrail policies",
  middleware: [requireScope("guardrails:read")],
  responses: {
    200: { description: "List of policies", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

guardrailRoutes.openapi(listPoliciesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT id, name, agent_name, policy, created_at, updated_at
      FROM guardrail_policies
      ORDER BY created_at DESC
    `;

    const policies = rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      agent_name: r.agent_name,
      ...(typeof r.policy === "string"
        ? JSON.parse(r.policy as string)
        : r.policy ?? {}),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    return c.json({ policies });
  });
});

// ── POST /policies ──────────────────────────────────────────────

const createPolicyRoute = createRoute({
  method: "post",
  path: "/policies",
  tags: ["Guardrails"],
  summary: "Create a guardrail policy",
  middleware: [requireScope("guardrails:write")],
  request: { body: { content: { "application/json": { schema: policyBodySchema } } } },
  responses: {
    201: { description: "Policy created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

guardrailRoutes.openapi(createPolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name, agent_name, ...policyFields } = c.req.valid("json");
  const id = genId();
  const now = Date.now();
  const policyJson = JSON.stringify({
    ...policyFields,
    allowed_pii_categories: [],
  });

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO guardrail_policies (id, org_id, name, agent_name, policy, created_at, updated_at)
      VALUES (${id}, ${user.org_id}, ${name}, ${agent_name ?? null}, ${policyJson}, ${now}, ${now})
    `;

    return c.json({ id, name, agent_name, ...policyFields, created_at: now }, 201);
  });
});

// ── PUT /policies/:policy_id ────────────────────────────────────

const updatePolicyRoute = createRoute({
  method: "put",
  path: "/policies/{policy_id}",
  tags: ["Guardrails"],
  summary: "Update a guardrail policy",
  middleware: [requireScope("guardrails:write")],
  request: {
    params: z.object({ policy_id: z.string() }),
    body: { content: { "application/json": { schema: policyBodySchema } } },
  },
  responses: {
    200: { description: "Policy updated", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 404),
  },
});

guardrailRoutes.openapi(updatePolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { policy_id: policyId } = c.req.valid("param");
  const { name, agent_name, ...policyFields } = c.req.valid("json");
  const now = Date.now();
  const policyJson = JSON.stringify({
    ...policyFields,
    allowed_pii_categories: [],
  });

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await sql`
      UPDATE guardrail_policies
      SET name = ${name}, agent_name = ${agent_name ?? null},
          policy = ${policyJson}, updated_at = ${now}
      WHERE id = ${policyId}
    `;

    if (!result.count) {
      return c.json({ error: "Policy not found" }, 404);
    }

    return c.json({ id: policyId, name, agent_name, ...policyFields, updated_at: now });
  });
});

// ── DELETE /policies/:policy_id ─────────────────────────────────

const deletePolicyRoute = createRoute({
  method: "delete",
  path: "/policies/{policy_id}",
  tags: ["Guardrails"],
  summary: "Delete a guardrail policy",
  middleware: [requireScope("guardrails:write")],
  request: {
    params: z.object({ policy_id: z.string() }),
  },
  responses: {
    200: { description: "Policy deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

guardrailRoutes.openapi(deletePolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { policy_id: policyId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await sql`
      DELETE FROM guardrail_policies
      WHERE id = ${policyId}
    `;

    if (!result.count) {
      return c.json({ error: "Policy not found" }, 404);
    }

    return c.json({ deleted: true });
  });
});

// ── GET /events ─────────────────────────────────────────────────

const listEventsRoute = createRoute({
  method: "get",
  path: "/events",
  tags: ["Guardrails"],
  summary: "List guardrail events",
  middleware: [requireScope("guardrails:read")],
  request: {
    query: eventsQuerySchema,
  },
  responses: {
    200: { description: "List of events", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

guardrailRoutes.openapi(listEventsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, event_type: eventType, since_days: sinceDays, limit } = c.req.valid("query");
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (agentName && eventType) {
      rows = await sql`
        SELECT * FROM guardrail_events
        WHERE agent_name = ${agentName}
          AND event_type = ${eventType} AND created_at >= ${sinceMs}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (agentName) {
      rows = await sql`
        SELECT * FROM guardrail_events
        WHERE agent_name = ${agentName}
          AND created_at >= ${sinceMs}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (eventType) {
      rows = await sql`
        SELECT * FROM guardrail_events
        WHERE event_type = ${eventType}
          AND created_at >= ${sinceMs}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM guardrail_events
        WHERE created_at >= ${sinceMs}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }

    return c.json({ events: rows });
  });
});

// ── GET /stats ──────────────────────────────────────────────────

const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Guardrails"],
  summary: "Get guardrail statistics",
  middleware: [requireScope("guardrails:read")],
  responses: {
    200: { description: "Guardrail stats", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

guardrailRoutes.openapi(statsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const totals = await sql`
      SELECT
        COUNT(*)::int AS total_scans,
        COUNT(*) FILTER (WHERE action = 'block')::int AS blocked_count,
        COUNT(*) FILTER (WHERE action = 'warn')::int AS warned_count
      FROM guardrail_events
    `;

    // PII and injection stats from the matches JSON column
    const eventRows = await sql`
      SELECT matches FROM guardrail_events
      ORDER BY created_at DESC LIMIT 1000
    `;

    let piiDetected = 0;
    let injectionsDetected = 0;
    const byCategory: Record<string, number> = {};

    for (const row of eventRows) {
      const r = row as Record<string, unknown>;
      try {
        const m =
          typeof r.matches === "string"
            ? JSON.parse(r.matches as string)
            : r.matches ?? {};
        if (m.pii && m.pii > 0) piiDetected += m.pii as number;
        if (m.injection_score && (m.injection_score as number) > 0.25) injectionsDetected++;
      } catch {
        // skip malformed
      }
    }

    const t = (totals[0] ?? {}) as Record<string, number>;

    return c.json({
      total_scans: t.total_scans ?? 0,
      blocked_count: t.blocked_count ?? 0,
      warned_count: t.warned_count ?? 0,
      pii_detected: piiDetected,
      injections_detected: injectionsDetected,
      by_category: byCategory,
    });
  });
});

// ── POST /test ──────────────────────────────────────────────────

const testRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Guardrails"],
  summary: "Test text against a specific guardrail policy",
  middleware: [requireScope("guardrails:write")],
  request: { body: { content: { "application/json": { schema: testBodySchema } } } },
  responses: {
    200: { description: "Test result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 404),
  },
});

guardrailRoutes.openapi(testRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { text, policy_id } = c.req.valid("json");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT policy FROM guardrail_policies
      WHERE id = ${policy_id}
      LIMIT 1
    `;

    if (!rows.length) {
      return c.json({ error: "Policy not found" }, 404);
    }

    const row = rows[0] as Record<string, unknown>;
    const policy: GuardrailPolicy = {
      ...DEFAULT_GUARDRAIL_POLICY,
      ...(typeof row.policy === "string"
        ? JSON.parse(row.policy as string)
        : row.policy ?? {}),
    };

    // Run both input and output evaluation and return the stricter result
    const inputResult = evaluateInput(text, policy);
    const outputResult = evaluateOutput(text, policy);

    // Merge: take the stricter action
    const actionOrder = { allow: 0, warn: 1, block: 2 } as const;
    const finalAction =
      actionOrder[outputResult.action] > actionOrder[inputResult.action]
        ? outputResult.action
        : inputResult.action;

    return c.json({
      result: {
        action: finalAction,
        reasons: [...inputResult.reasons, ...outputResult.reasons],
        pii_matches: inputResult.pii_matches,
        injection_score: inputResult.injection_score,
        redacted_text: inputResult.redacted_text ?? outputResult.redacted_text,
      },
    });
  });
});
