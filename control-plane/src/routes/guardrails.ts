/**
 * Guardrails Router — scan, redact, policy CRUD, event log, stats, test.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
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

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const guardrailRoutes = new Hono<R>();

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

// ── POST /scan ──────────────────────────────────────────────────

const scanBodySchema = z.object({
  text: z.string().min(1).max(200_000),
  scan_type: z.enum(["input", "output"]),
  agent_name: z.string().optional(),
  system_prompt: z.string().optional(),
});

guardrailRoutes.post("/scan", requireScope("guardrails:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = scanBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { text, scan_type, agent_name, system_prompt } = parsed.data;

  // Load agent-specific policy if agent_name is provided, otherwise use defaults
  let policy = DEFAULT_GUARDRAIL_POLICY;
  if (agent_name) {
    try {
      const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
      const rows = await sql`
        SELECT policy_json FROM guardrail_policies
        WHERE org_id = ${user.org_id}
          AND (agent_name = ${agent_name} OR agent_name IS NULL)
        ORDER BY agent_name DESC NULLS LAST
        LIMIT 1
      `;
      if (rows.length) {
        const row = rows[0] as Record<string, unknown>;
        policy = {
          ...DEFAULT_GUARDRAIL_POLICY,
          ...(typeof row.policy_json === "string"
            ? JSON.parse(row.policy_json)
            : row.policy_json ?? {}),
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
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
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

  return c.json({
    safe: result.action === "allow",
    action: result.action,
    pii_matches: piiMatches,
    injection_result: injectionResult,
    safety_issues: safetyResult?.issues ?? [],
    redacted_text: result.redacted_text,
  });
});

// ── POST /redact ────────────────────────────────────────────────

const redactBodySchema = z.object({
  text: z.string().min(1).max(200_000),
  categories: z.array(z.string()).optional(),
});

guardrailRoutes.post("/redact", requireScope("guardrails:write"), async (c) => {
  const body = await c.req.json();
  const parsed = redactBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { text, categories } = parsed.data;
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

guardrailRoutes.get("/policies", requireScope("guardrails:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT id, name, agent_name, policy_json, created_at, updated_at
    FROM guardrail_policies
    WHERE org_id = ${user.org_id}
    ORDER BY created_at DESC
  `;

  const policies = rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    name: r.name,
    agent_name: r.agent_name,
    ...(typeof r.policy_json === "string"
      ? JSON.parse(r.policy_json as string)
      : r.policy_json ?? {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return c.json({ policies });
});

// ── POST /policies ──────────────────────────────────────────────

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

guardrailRoutes.post("/policies", requireScope("guardrails:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = policyBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { name, agent_name, ...policyFields } = parsed.data;
  const id = genId();
  const now = Date.now();
  const policyJson = JSON.stringify({
    ...policyFields,
    allowed_pii_categories: [],
  });

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    INSERT INTO guardrail_policies (id, org_id, name, agent_name, policy_json, created_at, updated_at)
    VALUES (${id}, ${user.org_id}, ${name}, ${agent_name ?? null}, ${policyJson}, ${now}, ${now})
  `;

  return c.json({ id, name, agent_name, ...policyFields, created_at: now }, 201);
});

// ── PUT /policies/:policy_id ────────────────────────────────────

guardrailRoutes.put("/policies/:policy_id", requireScope("guardrails:write"), async (c) => {
  const user = c.get("user");
  const policyId = c.req.param("policy_id");
  const body = await c.req.json();
  const parsed = policyBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { name, agent_name, ...policyFields } = parsed.data;
  const now = Date.now();
  const policyJson = JSON.stringify({
    ...policyFields,
    allowed_pii_categories: [],
  });

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const result = await sql`
    UPDATE guardrail_policies
    SET name = ${name}, agent_name = ${agent_name ?? null},
        policy_json = ${policyJson}, updated_at = ${now}
    WHERE id = ${policyId} AND org_id = ${user.org_id}
  `;

  if (!result.count) {
    return c.json({ error: "Policy not found" }, 404);
  }

  return c.json({ id: policyId, name, agent_name, ...policyFields, updated_at: now });
});

// ── DELETE /policies/:policy_id ─────────────────────────────────

guardrailRoutes.delete("/policies/:policy_id", requireScope("guardrails:write"), async (c) => {
  const user = c.get("user");
  const policyId = c.req.param("policy_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM guardrail_policies
    WHERE id = ${policyId} AND org_id = ${user.org_id}
  `;

  if (!result.count) {
    return c.json({ error: "Policy not found" }, 404);
  }

  return c.json({ deleted: true });
});

// ── GET /events ─────────────────────────────────────────────────

guardrailRoutes.get("/events", requireScope("guardrails:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name");
  const eventType = c.req.query("event_type");
  const sinceDays = Math.min(365, Math.max(1, Number(c.req.query("since_days") ?? 7)));
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName && eventType) {
    rows = await sql`
      SELECT * FROM guardrail_events
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
        AND event_type = ${eventType} AND created_at >= ${sinceMs}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM guardrail_events
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
        AND created_at >= ${sinceMs}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (eventType) {
    rows = await sql`
      SELECT * FROM guardrail_events
      WHERE org_id = ${user.org_id} AND event_type = ${eventType}
        AND created_at >= ${sinceMs}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM guardrail_events
      WHERE org_id = ${user.org_id} AND created_at >= ${sinceMs}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json({ events: rows });
});

// ── GET /stats ──────────────────────────────────────────────────

guardrailRoutes.get("/stats", requireScope("guardrails:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const totals = await sql`
    SELECT
      COUNT(*)::int AS total_scans,
      COUNT(*) FILTER (WHERE action = 'block')::int AS blocked_count,
      COUNT(*) FILTER (WHERE action = 'warn')::int AS warned_count
    FROM guardrail_events
    WHERE org_id = ${user.org_id}
  `;

  // PII and injection stats from the matches JSON column
  const eventRows = await sql`
    SELECT matches FROM guardrail_events
    WHERE org_id = ${user.org_id}
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

// ── POST /test ──────────────────────────────────────────────────

const testBodySchema = z.object({
  text: z.string().min(1).max(200_000),
  policy_id: z.string(),
});

guardrailRoutes.post("/test", requireScope("guardrails:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = testBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { text, policy_id } = parsed.data;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT policy_json FROM guardrail_policies
    WHERE id = ${policy_id} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (!rows.length) {
    return c.json({ error: "Policy not found" }, 404);
  }

  const row = rows[0] as Record<string, unknown>;
  const policy: GuardrailPolicy = {
    ...DEFAULT_GUARDRAIL_POLICY,
    ...(typeof row.policy_json === "string"
      ? JSON.parse(row.policy_json as string)
      : row.policy_json ?? {}),
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
