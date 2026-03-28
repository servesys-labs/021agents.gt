/**
 * DLP (Data Loss Prevention) Router — data classification, agent DLP policies,
 * exposure reports, and retroactive session scanning.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { detectPii, type PiiMatch } from "../logic/pii-detector";

export const dlpRoutes = createOpenAPIRouter();

// ── Helpers ─────────────────────────────────────────────────────

function genId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DATA_LEVELS = ["public", "internal", "confidential", "restricted"] as const;
type DataLevel = (typeof DATA_LEVELS)[number];

const PII_HANDLING_MODES = ["block", "redact", "allow"] as const;
type PiiHandling = (typeof PII_HANDLING_MODES)[number];

// ── Zod schemas ─────────────────────────────────────────────────

const classificationBodySchema = z.object({
  name: z.string().min(1).max(200),
  level: z.enum(DATA_LEVELS),
  description: z.string().max(2000).default(""),
  patterns: z.array(z.string()).min(1),
});

const agentPolicySchema = z.object({
  allowed_data_levels: z.array(z.enum(DATA_LEVELS)).default(["public", "internal"]),
  required_redactions: z.array(z.string()).default([]),
  pii_handling: z.enum(PII_HANDLING_MODES).default("redact"),
  audit_all_access: z.boolean().default(false),
});

const exposureReportQuerySchema = z.object({
  since_days: z.coerce.number().int().min(1).max(365).default(30),
  agent_name: z.string().optional(),
});

// ── GET /classifications ────────────────────────────────────────

const listClassificationsRoute = createRoute({
  method: "get",
  path: "/classifications",
  tags: ["DLP"],
  summary: "List data classifications",
  middleware: [requireScope("dlp:read")],
  responses: {
    200: { description: "List of classifications", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

dlpRoutes.openapi(listClassificationsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT id, name, level, description, patterns, created_at, updated_at
    FROM dlp_classifications
    WHERE org_id = ${user.org_id}
    ORDER BY created_at DESC
  `;

  const classifications = rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    name: r.name,
    level: r.level,
    description: r.description,
    patterns:
      typeof r.patterns === "string"
        ? JSON.parse(r.patterns as string)
        : r.patterns ?? [],
    org_id: user.org_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return c.json({ classifications });
});

// ── POST /classifications ───────────────────────────────────────

const createClassificationRoute = createRoute({
  method: "post",
  path: "/classifications",
  tags: ["DLP"],
  summary: "Create a data classification",
  middleware: [requireScope("dlp:write")],
  request: { body: { content: { "application/json": { schema: classificationBodySchema } } } },
  responses: {
    201: { description: "Classification created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

dlpRoutes.openapi(createClassificationRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { name, level, description, patterns } = c.req.valid("json");
  const id = genId();
  const now = Date.now();

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await sql`
    INSERT INTO dlp_classifications (id, org_id, name, level, description, patterns, created_at, updated_at)
    VALUES (${id}, ${user.org_id}, ${name}, ${level}, ${description}, ${JSON.stringify(patterns)}, ${now}, ${now})
  `;

  return c.json({ id, name, level, description, patterns, created_at: now }, 201);
});

// ── DELETE /classifications/:id ─────────────────────────────────

const deleteClassificationRoute = createRoute({
  method: "delete",
  path: "/classifications/{id}",
  tags: ["DLP"],
  summary: "Delete a data classification",
  middleware: [requireScope("dlp:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Classification deleted", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

dlpRoutes.openapi(deleteClassificationRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id: classId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM dlp_classifications
    WHERE id = ${classId} AND org_id = ${user.org_id}
  `;

  if (!result.count) {
    return c.json({ error: "Classification not found" }, 404);
  }

  return c.json({ deleted: true });
});

// ── GET /agents/:agent_name/policy ──────────────────────────────

const getAgentPolicyRoute = createRoute({
  method: "get",
  path: "/agents/{agent_name}/policy",
  tags: ["DLP"],
  summary: "Get DLP policy for an agent",
  middleware: [requireScope("dlp:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "Agent DLP policy", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

dlpRoutes.openapi(getAgentPolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT policy_json FROM dlp_agent_policies
    WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
    LIMIT 1
  `;

  if (!rows.length) {
    // Return defaults
    return c.json({
      agent_name: agentName,
      allowed_data_levels: ["public", "internal"],
      required_redactions: [],
      pii_handling: "redact" as PiiHandling,
      audit_all_access: false,
    });
  }

  const row = rows[0] as Record<string, unknown>;
  const policy =
    typeof row.policy_json === "string"
      ? JSON.parse(row.policy_json as string)
      : row.policy_json ?? {};

  return c.json({ agent_name: agentName, ...policy });
});

// ── PUT /agents/:agent_name/policy ──────────────────────────────

const updateAgentPolicyRoute = createRoute({
  method: "put",
  path: "/agents/{agent_name}/policy",
  tags: ["DLP"],
  summary: "Set DLP policy for an agent",
  middleware: [requireScope("dlp:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    body: { content: { "application/json": { schema: agentPolicySchema } } },
  },
  responses: {
    200: { description: "Agent DLP policy updated", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401),
  },
});

dlpRoutes.openapi(updateAgentPolicyRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const data = c.req.valid("json");

  const policyJson = JSON.stringify(data);
  const now = Date.now();
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Upsert
  await sql`
    INSERT INTO dlp_agent_policies (id, org_id, agent_name, policy_json, created_at, updated_at)
    VALUES (${genId()}, ${user.org_id}, ${agentName}, ${policyJson}, ${now}, ${now})
    ON CONFLICT (org_id, agent_name) DO UPDATE SET
      policy_json = EXCLUDED.policy_json,
      updated_at = EXCLUDED.updated_at
  `;

  return c.json({ agent_name: agentName, ...data, updated_at: now });
});

// ── GET /exposure-report ────────────────────────────────────────

const exposureReportRoute = createRoute({
  method: "get",
  path: "/exposure-report",
  tags: ["DLP"],
  summary: "Get data exposure report",
  middleware: [requireScope("dlp:read")],
  request: {
    query: exposureReportQuerySchema,
  },
  responses: {
    200: { description: "Exposure report", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401),
  },
});

dlpRoutes.openapi(exposureReportRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { since_days: sinceDays, agent_name: agentName } = c.req.valid("query");
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Pull guardrail events that had PII matches
  let rows;
  if (agentName) {
    rows = await sql`
      SELECT id, agent_name, event_type, action, matches, created_at
      FROM guardrail_events
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
        AND created_at >= ${sinceMs}
      ORDER BY created_at DESC LIMIT 500
    `;
  } else {
    rows = await sql`
      SELECT id, agent_name, event_type, action, matches, created_at
      FROM guardrail_events
      WHERE org_id = ${user.org_id} AND created_at >= ${sinceMs}
      ORDER BY created_at DESC LIMIT 500
    `;
  }

  let totalExposures = 0;
  const byCategory: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  const recentEvents: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    try {
      const m =
        typeof r.matches === "string"
          ? JSON.parse(r.matches as string)
          : r.matches ?? {};
      const piiCount = Number(m.pii ?? 0);
      if (piiCount > 0) {
        totalExposures += piiCount;
        const agent = String(r.agent_name ?? "unknown");
        byAgent[agent] = (byAgent[agent] ?? 0) + piiCount;

        if (recentEvents.length < 50) {
          recentEvents.push({
            id: r.id,
            agent_name: agent,
            event_type: r.event_type,
            action: r.action,
            pii_count: piiCount,
            created_at: r.created_at,
          });
        }
      }
    } catch {
      // skip malformed
    }
  }

  return c.json({
    total_exposures: totalExposures,
    by_category: byCategory,
    by_agent: byAgent,
    recent_events: recentEvents,
  });
});

// ── POST /scan-session/:session_id ──────────────────────────────

const scanSessionRoute = createRoute({
  method: "post",
  path: "/scan-session/{session_id}",
  tags: ["DLP"],
  summary: "Retroactively scan a session for PII",
  middleware: [requireScope("dlp:write")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Session scan result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 404),
  },
});

dlpRoutes.openapi(scanSessionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load session turns from the sessions/turns table
  const turns = await sql`
    SELECT id, role, content FROM session_turns
    WHERE session_id = ${sessionId}
      AND org_id = ${user.org_id}
    ORDER BY created_at ASC
  `;

  if (!turns.length) {
    return c.json({ error: "Session not found or has no turns" }, 404);
  }

  let totalPii = 0;
  const details: Array<{
    turn_id: string;
    role: string;
    pii_matches: PiiMatch[];
  }> = [];

  for (const turn of turns) {
    const t = turn as Record<string, unknown>;
    const content = String(t.content ?? "");
    if (!content) continue;

    const matches = detectPii(content);
    if (matches.length) {
      totalPii += matches.length;
      details.push({
        turn_id: String(t.id ?? ""),
        role: String(t.role ?? ""),
        pii_matches: matches,
      });
    }
  }

  // Log the retroactive scan as a guardrail event
  try {
    await sql`
      INSERT INTO guardrail_events (
        id, org_id, agent_name, event_type, action,
        text_preview, matches, created_at
      ) VALUES (
        ${genId()}, ${user.org_id}, ${"session_scan"},
        ${"retroactive_scan"}, ${totalPii > 0 ? "warn" : "allow"},
        ${`Retroactive scan of session ${sessionId}: ${turns.length} turns`},
        ${JSON.stringify({ pii: totalPii, session_id: sessionId })},
        ${Date.now()}
      )
    `;
  } catch {
    // Best-effort
  }

  return c.json({
    session_id: sessionId,
    turns_scanned: turns.length,
    pii_found: totalPii,
    details,
  });
});
