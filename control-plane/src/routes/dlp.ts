/**
 * DLP (Data Loss Prevention) Router — data classification, agent DLP policies,
 * exposure reports, and retroactive session scanning.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { detectPii, type PiiMatch } from "../logic/pii-detector";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const dlpRoutes = new Hono<R>();

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

// ── GET /classifications ────────────────────────────────────────

dlpRoutes.get("/classifications", requireScope("dlp:read"), async (c) => {
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

const classificationBodySchema = z.object({
  name: z.string().min(1).max(200),
  level: z.enum(DATA_LEVELS),
  description: z.string().max(2000).default(""),
  patterns: z.array(z.string()).min(1),
});

dlpRoutes.post("/classifications", requireScope("dlp:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = classificationBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { name, level, description, patterns } = parsed.data;
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

dlpRoutes.delete("/classifications/:id", requireScope("dlp:write"), async (c) => {
  const user = c.get("user");
  const classId = c.req.param("id");
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

dlpRoutes.get("/agents/:agent_name/policy", requireScope("dlp:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
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

const agentPolicySchema = z.object({
  allowed_data_levels: z.array(z.enum(DATA_LEVELS)).default(["public", "internal"]),
  required_redactions: z.array(z.string()).default([]),
  pii_handling: z.enum(PII_HANDLING_MODES).default("redact"),
  audit_all_access: z.boolean().default(false),
});

dlpRoutes.put("/agents/:agent_name/policy", requireScope("dlp:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const body = await c.req.json();
  const parsed = agentPolicySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const policyJson = JSON.stringify(parsed.data);
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

  return c.json({ agent_name: agentName, ...parsed.data, updated_at: now });
});

// ── GET /exposure-report ────────────────────────────────────────

dlpRoutes.get("/exposure-report", requireScope("dlp:read"), async (c) => {
  const user = c.get("user");
  const sinceDays = Math.min(365, Math.max(1, Number(c.req.query("since_days") ?? 30)));
  const agentName = c.req.query("agent_name");
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

dlpRoutes.post("/scan-session/:session_id", requireScope("dlp:write"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
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
