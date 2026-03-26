/**
 * Issues routes -- CRUD, detection, classification, remediation.
 * Ported from agentos/api/routers/issues.py.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { classifyIssue } from "../logic/issue-classifier";
import { suggestFix, autoRemediate } from "../logic/issue-remediation";
import { detectFromSession } from "../logic/issue-detector";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const issueRoutes = new Hono<R>();

// ── Zod schemas ──────────────────────────────────────────────────

const createIssueSchema = z.object({
  agent_name: z.string().default(""),
  title: z.string().min(1).max(500),
  description: z.string().default(""),
  category: z.string().default("unknown"),
  severity: z.string().default("low"),
  source_session_id: z.string().default(""),
});

const updateIssueSchema = z.object({
  status: z.string().optional(),
  severity: z.string().optional(),
  category: z.string().optional(),
  assigned_to: z.string().optional(),
  suggested_fix: z.string().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── GET /summary ─────────────────────────────────────────────────

issueRoutes.get("/summary", requireScope("issues:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") ?? "";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'open') as open,
        COUNT(*) FILTER (WHERE status = 'triaged') as triaged,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
        COUNT(*) FILTER (WHERE status = 'fixing') as fixing,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical,
        COUNT(*) FILTER (WHERE severity = 'high') as high,
        COUNT(*) FILTER (WHERE severity = 'medium') as medium,
        COUNT(*) FILTER (WHERE severity = 'low') as low_sev
      FROM issues
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
    `;
  } else {
    rows = await sql`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'open') as open,
        COUNT(*) FILTER (WHERE status = 'triaged') as triaged,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
        COUNT(*) FILTER (WHERE status = 'fixing') as fixing,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical,
        COUNT(*) FILTER (WHERE severity = 'high') as high,
        COUNT(*) FILTER (WHERE severity = 'medium') as medium,
        COUNT(*) FILTER (WHERE severity = 'low') as low_sev
      FROM issues
      WHERE org_id = ${user.org_id}
    `;
  }

  const r = rows[0] ?? {};
  return c.json({
    total: Number(r.total ?? 0),
    by_status: {
      open: Number(r.open ?? 0),
      triaged: Number(r.triaged ?? 0),
      resolved: Number(r.resolved ?? 0),
      fixing: Number(r.fixing ?? 0),
    },
    by_severity: {
      critical: Number(r.critical ?? 0),
      high: Number(r.high ?? 0),
      medium: Number(r.medium ?? 0),
      low: Number(r.low_sev ?? 0),
    },
  });
});

// ── GET / ────────────────────────────────────────────────────────

issueRoutes.get("/", requireScope("issues:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") ?? "";
  const status = c.req.query("status") ?? "";
  const category = c.req.query("category") ?? "";
  const severity = c.req.query("severity") ?? "";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Build query based on filters present
  let rows;
  if (agentName && status && category && severity) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
        AND status = ${status} AND category = ${category} AND severity = ${severity}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName && status) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName && severity) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND severity = ${severity}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName && category) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND category = ${category}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (status && severity) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND status = ${status} AND severity = ${severity}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (status) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND status = ${status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (category) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND category = ${category}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (severity) {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id} AND severity = ${severity}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM issues
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  return c.json({ issues: rows });
});

// ── POST / ───────────────────────────────────────────────────────

issueRoutes.post("/", requireScope("issues:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = createIssueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const req = parsed.data;
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const issueId = randomId();

  // Auto-classify
  const classification = classifyIssue(
    req.title,
    req.description,
    req.category,
    req.severity,
  );

  // Generate fix suggestion
  const suggestedFix = suggestFix({
    category: classification.category,
    title: req.title,
    description: req.description,
  });

  const now = Date.now() / 1000;
  await sql`
    INSERT INTO issues (
      issue_id, org_id, agent_name, title, description,
      category, severity, status, source, source_session_id,
      suggested_fix, created_at
    ) VALUES (
      ${issueId}, ${user.org_id}, ${req.agent_name},
      ${req.title}, ${req.description},
      ${classification.category}, ${classification.severity},
      ${"open"}, ${"manual"}, ${req.source_session_id},
      ${suggestedFix}, ${now}
    )
  `;

  return c.json({
    issue_id: issueId,
    category: classification.category,
    severity: classification.severity,
    suggested_fix: suggestedFix,
  });
});

// ── POST /detect/:session_id ─────────────────────────────────────

issueRoutes.post("/detect/:session_id", requireScope("issues:write"), async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("session_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load session
  const sessionRows = await sql`
    SELECT * FROM sessions WHERE session_id = ${sessionId} LIMIT 1
  `;
  if (!sessionRows.length) {
    return c.json({ error: "Session not found" }, 404);
  }
  const sessionData = sessionRows[0] as Record<string, unknown>;
  const agentName = String(sessionData.agent_name ?? "");

  // Load conversation scores
  const scoreRows = await sql`
    SELECT * FROM conversation_scores WHERE session_id = ${sessionId}
    ORDER BY turn_number ASC
  `;

  // Detect issues
  const issues = detectFromSession(
    sessionId,
    agentName,
    user.org_id,
    sessionData,
    scoreRows as unknown as Record<string, unknown>[],
  );

  // Persist detected issues and generate fixes
  const now = Date.now() / 1000;
  for (const issue of issues) {
    const fix = suggestFix(issue as unknown as Record<string, unknown>);
    (issue as any).suggested_fix = fix;

    try {
      await sql`
        INSERT INTO issues (
          issue_id, org_id, agent_name, title, description,
          category, severity, status, source, source_session_id,
          suggested_fix, created_at
        ) VALUES (
          ${issue.issue_id}, ${user.org_id}, ${issue.agent_name},
          ${issue.title}, ${issue.description},
          ${issue.category}, ${issue.severity},
          ${"open"}, ${"auto"}, ${issue.source_session_id},
          ${fix}, ${now}
        )
      `;
    } catch {
      // Best-effort persistence
    }
  }

  return c.json({
    session_id: sessionId,
    issues_created: issues.length,
    issues,
  });
});

// ── GET /:issue_id ───────────────────────────────────────────────

issueRoutes.get("/:issue_id", requireScope("issues:read"), async (c) => {
  const user = c.get("user");
  const issueId = c.req.param("issue_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM issues WHERE issue_id = ${issueId} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (!rows.length) {
    return c.json({ error: "Issue not found" }, 404);
  }
  return c.json(rows[0]);
});

// ── PUT /:issue_id ───────────────────────────────────────────────

issueRoutes.put("/:issue_id", requireScope("issues:write"), async (c) => {
  const user = c.get("user");
  const issueId = c.req.param("issue_id");
  const body = await c.req.json();
  const parsed = updateIssueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} AND org_id = ${user.org_id} LIMIT 1`;
  if (!existing.length) {
    return c.json({ error: "Issue not found" }, 404);
  }

  const req = parsed.data;
  const now = Date.now() / 1000;

  // Build update -- apply each field if provided
  if (req.status !== undefined && req.status === "resolved") {
    await sql`
      UPDATE issues SET
        status = ${req.status},
        resolved_by = ${user.user_id},
        resolved_at = ${now},
        severity = COALESCE(${req.severity ?? null}, severity),
        category = COALESCE(${req.category ?? null}, category),
        assigned_to = COALESCE(${req.assigned_to ?? null}, assigned_to),
        suggested_fix = COALESCE(${req.suggested_fix ?? null}, suggested_fix)
      WHERE issue_id = ${issueId} AND org_id = ${user.org_id}
    `;
  } else {
    await sql`
      UPDATE issues SET
        status = COALESCE(${req.status ?? null}, status),
        severity = COALESCE(${req.severity ?? null}, severity),
        category = COALESCE(${req.category ?? null}, category),
        assigned_to = COALESCE(${req.assigned_to ?? null}, assigned_to),
        suggested_fix = COALESCE(${req.suggested_fix ?? null}, suggested_fix)
      WHERE issue_id = ${issueId} AND org_id = ${user.org_id}
    `;
  }

  const updated = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} AND org_id = ${user.org_id} LIMIT 1`;
  return c.json(updated[0]);
});

// ── POST /:issue_id/resolve ──────────────────────────────────────

issueRoutes.post("/:issue_id/resolve", requireScope("issues:write"), async (c) => {
  const user = c.get("user");
  const issueId = c.req.param("issue_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} AND org_id = ${user.org_id} LIMIT 1`;
  if (!existing.length) {
    return c.json({ error: "Issue not found" }, 404);
  }

  const now = Date.now() / 1000;
  await sql`
    UPDATE issues SET
      status = 'resolved',
      resolved_by = ${user.user_id},
      resolved_at = ${now}
    WHERE issue_id = ${issueId} AND org_id = ${user.org_id}
  `;

  return c.json({ resolved: true, issue_id: issueId });
});

// ── POST /:issue_id/triage ───────────────────────────────────────

issueRoutes.post("/:issue_id/triage", requireScope("issues:write"), async (c) => {
  const user = c.get("user");
  const issueId = c.req.param("issue_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} AND org_id = ${user.org_id} LIMIT 1`;
  if (!existing.length) {
    return c.json({ error: "Issue not found" }, 404);
  }

  const issue = existing[0] as Record<string, unknown>;

  // Classify
  const classification = classifyIssue(
    String(issue.title ?? ""),
    String(issue.description ?? ""),
  );

  // Generate fix
  const fix = suggestFix({ ...issue, ...classification });

  await sql`
    UPDATE issues SET
      status = 'triaged',
      category = ${classification.category},
      severity = ${classification.severity},
      suggested_fix = ${fix}
    WHERE issue_id = ${issueId} AND org_id = ${user.org_id}
  `;

  return c.json({
    issue_id: issueId,
    status: "triaged",
    category: classification.category,
    severity: classification.severity,
    suggested_fix: fix,
  });
});

// ── POST /:issue_id/auto-fix ─────────────────────────────────────

issueRoutes.post("/:issue_id/auto-fix", requireScope("issues:write"), async (c) => {
  const user = c.get("user");
  const issueId = c.req.param("issue_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} AND org_id = ${user.org_id} LIMIT 1`;
  if (!existing.length) {
    return c.json({ error: "Issue not found" }, 404);
  }

  const issue = existing[0] as Record<string, unknown>;
  const agentName = String(issue.agent_name ?? "");
  if (!agentName) {
    return c.json({ error: "Issue has no associated agent" }, 400);
  }

  // Load agent config
  const agentRows = await sql`
    SELECT config FROM agents WHERE name = ${agentName} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (!agentRows.length) {
    return c.json({ error: `Agent config not found: ${agentName}` }, 404);
  }

  const rawConfig = agentRows[0].config;
  const agentConfig: Record<string, unknown> =
    typeof rawConfig === "string" ? JSON.parse(rawConfig) : (rawConfig ?? {});

  const changes = autoRemediate(issue, agentConfig);
  if (!changes) {
    return c.json({ applied: false, message: "No auto-fix available for this issue type" });
  }

  // Apply changes to agent config
  const applied: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (key === "system_prompt_append") {
      agentConfig.system_prompt = String(agentConfig.system_prompt ?? "") + String(value);
      applied.push("system_prompt (appended)");
    } else if (key.includes(".")) {
      const parts = key.split(".", 2);
      const sub = (agentConfig[parts[0]] ?? {}) as Record<string, unknown>;
      agentConfig[parts[0]] = sub;
      sub[parts[1]] = value;
      applied.push(key);
    } else {
      agentConfig[key] = value;
      applied.push(key);
    }
  }

  // Write back to DB
  await sql`
    UPDATE agents SET config = ${JSON.stringify(agentConfig)}
    WHERE name = ${agentName} AND org_id = ${user.org_id}
  `;

  // Mark issue as fixing
  await sql`
    UPDATE issues SET status = 'fixing', fix_applied = 1
    WHERE issue_id = ${issueId} AND org_id = ${user.org_id}
  `;

  // Audit the config change
  try {
    const now = Date.now() / 1000;
    await sql`
      INSERT INTO config_audit (
        org_id, agent_name, action, field_changed, change_reason, changed_by, created_at
      ) VALUES (
        ${user.org_id}, ${agentName}, ${"issue.auto_fix"},
        ${applied.join(",")},
        ${`Auto-fix for issue ${issueId}: ${String(issue.title ?? "")}`},
        ${user.user_id}, ${now}
      )
    `;
  } catch {
    // Best-effort audit
  }

  return c.json({
    applied: true,
    issue_id: issueId,
    agent_name: agentName,
    changes_applied: applied,
    changes,
  });
});
