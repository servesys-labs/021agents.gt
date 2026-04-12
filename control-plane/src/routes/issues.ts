/**
 * Issues routes -- CRUD, detection, classification, remediation.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import { classifyIssue } from "../logic/issue-classifier";
import { suggestFix, autoRemediate } from "../logic/issue-remediation";
import { detectFromSession } from "../logic/issue-detector";
import { requireScope } from "../middleware/auth";

export const issueRoutes = createOpenAPIRouter();

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

const issueSummaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Issues"],
  summary: "Get issues summary",
  middleware: [requireScope("issues:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
    }),
  },
  responses: {
    200: { description: "Issue summary", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

issueRoutes.openapi(issueSummaryRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
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
        WHERE agent_name = ${agentName}
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
});

// ── GET / ────────────────────────────────────────────────────────

const listIssuesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Issues"],
  summary: "List issues",
  middleware: [requireScope("issues:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
      status: z.string().default(""),
      category: z.string().default(""),
      severity: z.string().default(""),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: { description: "Issue list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

issueRoutes.openapi(listIssuesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, status, category, severity, limit } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Build query based on filters present
    let rows;
    if (agentName && status && category && severity) {
      rows = await sql`
        SELECT * FROM issues
        WHERE agent_name = ${agentName}
          AND status = ${status} AND category = ${category} AND severity = ${severity}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (agentName && status) {
      rows = await sql`
        SELECT * FROM issues
        WHERE agent_name = ${agentName} AND status = ${status}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (agentName && severity) {
      rows = await sql`
        SELECT * FROM issues
        WHERE agent_name = ${agentName} AND severity = ${severity}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (agentName && category) {
      rows = await sql`
        SELECT * FROM issues
        WHERE agent_name = ${agentName} AND category = ${category}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (status && severity) {
      rows = await sql`
        SELECT * FROM issues
        WHERE status = ${status} AND severity = ${severity}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (agentName) {
      rows = await sql`
        SELECT * FROM issues
        WHERE agent_name = ${agentName}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (status) {
      rows = await sql`
        SELECT * FROM issues
        WHERE status = ${status}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (category) {
      rows = await sql`
        SELECT * FROM issues
        WHERE category = ${category}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else if (severity) {
      rows = await sql`
        SELECT * FROM issues
        WHERE severity = ${severity}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM issues
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }

    return c.json({ issues: rows });
  });
});

// ── POST / ───────────────────────────────────────────────────────

const createIssueRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Issues"],
  summary: "Create an issue",
  middleware: [requireScope("issues:write")],
  request: {
    body: { content: { "application/json": { schema: createIssueSchema } } },
  },
  responses: {
    200: { description: "Issue created", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 500),
  },
});

issueRoutes.openapi(createIssueRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const req = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
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

    const now = new Date().toISOString();
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
});

// ── POST /detect/:session_id ─────────────────────────────────────

const detectIssuesRoute = createRoute({
  method: "post",
  path: "/detect/{session_id}",
  tags: ["Issues"],
  summary: "Detect issues from a session",
  middleware: [requireScope("issues:write")],
  request: {
    params: z.object({ session_id: z.string() }),
  },
  responses: {
    200: { description: "Detected issues", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

issueRoutes.openapi(detectIssuesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { session_id: sessionId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Load session (RLS enforces tenant)
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
    const now = new Date().toISOString();
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
});

// ── GET /:issue_id ───────────────────────────────────────────────

const getIssueRoute = createRoute({
  method: "get",
  path: "/{issue_id}",
  tags: ["Issues"],
  summary: "Get issue detail",
  middleware: [requireScope("issues:read")],
  request: {
    params: z.object({ issue_id: z.string() }),
  },
  responses: {
    200: { description: "Issue detail", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

issueRoutes.openapi(getIssueRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { issue_id: issueId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM issues WHERE issue_id = ${issueId} LIMIT 1
    `;
    if (!rows.length) {
      return c.json({ error: "Issue not found" }, 404);
    }
    return c.json(rows[0]);
  });
});

// ── PUT /:issue_id ───────────────────────────────────────────────

const updateIssueRoute = createRoute({
  method: "put",
  path: "/{issue_id}",
  tags: ["Issues"],
  summary: "Update an issue",
  middleware: [requireScope("issues:write")],
  request: {
    params: z.object({ issue_id: z.string() }),
    body: { content: { "application/json": { schema: updateIssueSchema } } },
  },
  responses: {
    200: { description: "Updated issue", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(400, 401, 500),
  },
});

issueRoutes.openapi(updateIssueRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { issue_id: issueId } = c.req.valid("param");
  const req = c.req.valid("json");

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} LIMIT 1`;
    if (!existing.length) {
      return c.json({ error: "Issue not found" }, 404);
    }

    const now = new Date().toISOString();

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
        WHERE issue_id = ${issueId}
      `;
    } else {
      await sql`
        UPDATE issues SET
          status = COALESCE(${req.status ?? null}, status),
          severity = COALESCE(${req.severity ?? null}, severity),
          category = COALESCE(${req.category ?? null}, category),
          assigned_to = COALESCE(${req.assigned_to ?? null}, assigned_to),
          suggested_fix = COALESCE(${req.suggested_fix ?? null}, suggested_fix)
        WHERE issue_id = ${issueId}
      `;
    }

    const updated = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} LIMIT 1`;
    return c.json(updated[0]);
  });
});

// ── POST /:issue_id/resolve ──────────────────────────────────────

const resolveIssueRoute = createRoute({
  method: "post",
  path: "/{issue_id}/resolve",
  tags: ["Issues"],
  summary: "Resolve an issue",
  middleware: [requireScope("issues:write")],
  request: {
    params: z.object({ issue_id: z.string() }),
  },
  responses: {
    200: { description: "Resolved", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

issueRoutes.openapi(resolveIssueRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { issue_id: issueId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} LIMIT 1`;
    if (!existing.length) {
      return c.json({ error: "Issue not found" }, 404);
    }

    const now = new Date().toISOString();
    await sql`
      UPDATE issues SET
        status = 'resolved',
        resolved_by = ${user.user_id},
        resolved_at = ${now}
      WHERE issue_id = ${issueId}
    `;

    return c.json({ resolved: true, issue_id: issueId });
  });
});

// ── POST /:issue_id/triage ───────────────────────────────────────

const triageIssueRoute = createRoute({
  method: "post",
  path: "/{issue_id}/triage",
  tags: ["Issues"],
  summary: "Triage an issue",
  middleware: [requireScope("issues:write")],
  request: {
    params: z.object({ issue_id: z.string() }),
  },
  responses: {
    200: { description: "Triaged", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

issueRoutes.openapi(triageIssueRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { issue_id: issueId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} LIMIT 1`;
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
      WHERE issue_id = ${issueId}
    `;

    return c.json({
      issue_id: issueId,
      status: "triaged",
      category: classification.category,
      severity: classification.severity,
      suggested_fix: fix,
    });
  });
});

// ── POST /:issue_id/auto-fix ─────────────────────────────────────

const autoFixIssueRoute = createRoute({
  method: "post",
  path: "/{issue_id}/auto-fix",
  tags: ["Issues"],
  summary: "Auto-fix an issue",
  middleware: [requireScope("issues:write")],
  request: {
    params: z.object({ issue_id: z.string() }),
  },
  responses: {
    200: { description: "Auto-fix result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

issueRoutes.openapi(autoFixIssueRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { issue_id: issueId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const existing = await sql`SELECT * FROM issues WHERE issue_id = ${issueId} LIMIT 1`;
    if (!existing.length) {
      return c.json({ error: "Issue not found" }, 404);
    }

    const issue = existing[0] as Record<string, unknown>;
    const agentName = String(issue.agent_name ?? "");
    if (!agentName) {
      return c.json({ error: "Issue has no associated agent" }, 400);
    }

    // Load agent config (RLS filters agents by org)
    const agentRows = await sql`
      SELECT config FROM agents WHERE name = ${agentName} LIMIT 1
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
      WHERE name = ${agentName}
    `;

    // Mark issue as fixing
    await sql`
      UPDATE issues SET status = 'fixing', fix_applied = 1
      WHERE issue_id = ${issueId}
    `;

    // Audit the config change
    try {
      const now = new Date().toISOString();
      await sql`
        INSERT INTO config_audit (
          org_id, agent_name, action, field_changed, new_value, changed_by, created_at
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
});
