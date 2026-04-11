/**
 * Security scanning routes -- OWASP probes, AIVSS, risk profiles.
 * Ported from agentos/api/routers/redteam.py.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import {
  allProbesDicts,
  scanConfig,
  generateReport,
} from "../logic/security-scanner";
import {
  calculateAivss,
  classifyRisk,
  defaultVector,
  vectorToDict,
} from "../logic/aivss";
import { parseAgentConfigJson } from "../schemas/common";
import { requireScope } from "../middleware/auth";

export const securityRoutes = createOpenAPIRouter();

// ── GET /probes ──────────────────────────────────────────────────

const listProbesRoute = createRoute({
  method: "get",
  path: "/probes",
  tags: ["Security"],
  summary: "List all security probes",
  middleware: [requireScope("security:read")],
  responses: {
    200: { description: "Probe list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(listProbesRoute, async (c): Promise<any> => {
  return c.json({ probes: allProbesDicts() });
});

// ── GET /scans ───────────────────────────────────────────────────

const listScansRoute = createRoute({
  method: "get",
  path: "/scans",
  tags: ["Security"],
  summary: "List security scans",
  middleware: [requireScope("security:read")],
  request: {
    query: z.object({
      agent_name: z.string().default(""),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: { description: "Scan list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(listScansRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, limit } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (agentName) {
      rows = await sql`
        SELECT * FROM security_scans
        WHERE agent_name = ${agentName}
        ORDER BY started_at DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM security_scans
        ORDER BY started_at DESC LIMIT ${limit}
      `;
    }
    return c.json({ scans: rows });
  });
});

// ── GET /findings ────────────────────────────────────────────────

const listFindingsRoute = createRoute({
  method: "get",
  path: "/findings",
  tags: ["Security"],
  summary: "List security findings",
  middleware: [requireScope("security:read")],
  request: {
    query: z.object({
      scan_id: z.string().default(""),
      agent_name: z.string().default(""),
      severity: z.string().default(""),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  },
  responses: {
    200: { description: "Findings list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(listFindingsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { scan_id: scanId, agent_name: agentName, severity, limit } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Use separate queries to avoid SQL injection with dynamic WHERE
    let rows;
    if (scanId && agentName && severity) {
      rows = await sql`
        SELECT * FROM security_scan_findings
        WHERE scan_id = ${scanId} AND agent_name = ${agentName} AND severity = ${severity}
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    } else if (scanId && agentName) {
      rows = await sql`
        SELECT * FROM security_scan_findings
        WHERE scan_id = ${scanId} AND agent_name = ${agentName}
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    } else if (scanId && severity) {
      rows = await sql`
        SELECT * FROM security_scan_findings
        WHERE scan_id = ${scanId} AND severity = ${severity}
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    } else if (agentName && severity) {
      rows = await sql`
        SELECT * FROM security_scan_findings
        WHERE agent_name = ${agentName} AND severity = ${severity}
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    } else if (scanId) {
      rows = await sql`
        SELECT * FROM security_scan_findings
        WHERE scan_id = ${scanId}
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    } else if (agentName) {
      rows = await sql`
        SELECT * FROM security_scan_findings
        WHERE agent_name = ${agentName}
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    } else if (severity) {
      rows = await sql`
        SELECT * FROM security_scan_findings
        WHERE severity = ${severity}
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM security_scan_findings
        ORDER BY aivss_score DESC LIMIT ${limit}
      `;
    }

    return c.json({ findings: rows });
  });
});

// ── GET /risk-profiles ───────────────────────────────────────────

const listRiskProfilesRoute = createRoute({
  method: "get",
  path: "/risk-profiles",
  tags: ["Security"],
  summary: "List risk profiles",
  middleware: [requireScope("security:read")],
  responses: {
    200: { description: "Risk profiles", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(listRiskProfilesRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM risk_profiles
      ORDER BY risk_score DESC
    `;
    return c.json({ profiles: rows });
  });
});

// ── GET /risk-profiles/:agent_name ───────────────────────────────

const getAgentRiskProfileRoute = createRoute({
  method: "get",
  path: "/risk-profiles/{agent_name}",
  tags: ["Security"],
  summary: "Get agent risk profile",
  middleware: [requireScope("security:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    200: { description: "Risk profile", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(getAgentRiskProfileRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM risk_profiles WHERE agent_name = ${agentName} LIMIT 1
    `;
    if (!rows.length) {
      return c.json({ agent_name: agentName, risk_score: 0.0, risk_level: "not_scanned" });
    }
    return c.json(rows[0]);
  });
});

// ── POST /scan/:agent_name ───────────────────────────────────────

const scanAgentRoute = createRoute({
  method: "post",
  path: "/scan/{agent_name}",
  tags: ["Security"],
  summary: "Run security scan on an agent",
  middleware: [requireScope("security:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      scan_type: z.string().default("config"),
    }),
  },
  responses: {
    200: { description: "Scan result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(scanAgentRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const { scan_type: scanType } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    // Load agent config from DB (config is canonical; same column as agents router)
    const agentRows = await sql`
      SELECT config FROM agents
      WHERE name = ${agentName}
      LIMIT 1
    `;
    if (!agentRows.length) {
      return c.json({ error: `Agent '${agentName}' not found` }, 404);
    }

    const agentConfig = parseAgentConfigJson(
      (agentRows[0] as Record<string, unknown>).config,
    );

    // Generate scan ID
    const scanIdBytes = new Uint8Array(8);
    crypto.getRandomValues(scanIdBytes);
    const scanId = Array.from(scanIdBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Run config scan
    const result = scanConfig(agentName, agentConfig, scanId);

    // Persist scan
    try {
      await sql`
        INSERT INTO security_scans (
          scan_id, org_id, agent_name, scan_type, status,
          total_probes, passed, failed, risk_score, risk_level,
          started_at, completed_at
        ) VALUES (
          ${result.scan_id}, ${user.org_id}, ${agentName}, ${scanType}, ${"completed"},
          ${result.total_probes}, ${result.passed}, ${result.failed},
          ${result.risk_score}, ${result.risk_level},
          ${result.started_at}, ${result.completed_at}
        )
      `;

      // Persist findings
      for (const finding of result.findings) {
        await sql`
          INSERT INTO security_scan_findings (
            scan_id, org_id, agent_name, probe_id, probe_name,
            category, layer, severity, title, description, evidence,
            aivss_vector, aivss_score
          ) VALUES (
            ${result.scan_id}, ${user.org_id}, ${agentName},
            ${String(finding.probe_id ?? "")}, ${String(finding.probe_name ?? "")},
            ${String(finding.category ?? "")}, ${String(finding.layer ?? "")},
            ${String(finding.severity ?? "info")},
            ${`${String(finding.probe_name ?? "")} - ${String(finding.category ?? "unknown")}`},
            ${finding.evidence ? String(finding.evidence).slice(0, 500) : "No description available"},
            ${String(finding.evidence ?? "")},
            ${String(finding.aivss_vector ?? "")}, ${Number(finding.aivss_score ?? 0)}
          )
        `;
      }

      // Upsert risk profile. ON CONFLICT must reference the
      // (org_id, agent_name) scoped unique constraint on risk_profiles
      // — two orgs can legitimately have agents with the same name, so
      // agent_name alone would collide across tenants.
      await sql`
        INSERT INTO risk_profiles (agent_name, org_id, risk_score, risk_level, last_scan_id, findings_summary, updated_at)
        VALUES (
          ${agentName}, ${user.org_id}, ${result.risk_score}, ${result.risk_level},
          ${result.scan_id}, ${JSON.stringify(result.findings_summary)}, ${new Date().toISOString()}
        )
        ON CONFLICT (org_id, agent_name) DO UPDATE SET
          risk_score = EXCLUDED.risk_score,
          risk_level = EXCLUDED.risk_level,
          last_scan_id = EXCLUDED.last_scan_id,
          findings_summary = EXCLUDED.findings_summary,
          updated_at = EXCLUDED.updated_at
      `;
    } catch {
      // Best-effort persistence
    }

    return c.json({
      scan_id: result.scan_id,
      agent_name: agentName,
      risk_score: result.risk_score,
      risk_level: result.risk_level,
      total_probes: result.total_probes,
      passed: result.passed,
      failed: result.failed,
      findings_count: result.findings.length,
    });
  });
});

// ── POST /scan/:agent_name/runtime ───────────────────────────────

const scanAgentRuntimeRoute = createRoute({
  method: "post",
  path: "/scan/{agent_name}/runtime",
  tags: ["Security"],
  summary: "Runtime security scan (edge-only)",
  middleware: [requireScope("security:write")],
  request: {
    params: z.object({ agent_name: z.string() }),
  },
  responses: {
    410: { description: "Gone", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(scanAgentRuntimeRoute, async (c): Promise<any> => {
  return c.json(
    {
      error: "Runtime scanning is edge-only. Invoke probes against worker runtime and persist findings via control plane.",
    },
    410,
  );
});

// ── GET /scan/:scan_id/report ────────────────────────────────────

const getScanReportRoute = createRoute({
  method: "get",
  path: "/scan/{scan_id}/report",
  tags: ["Security"],
  summary: "Get scan report",
  middleware: [requireScope("security:read")],
  request: {
    params: z.object({ scan_id: z.string() }),
  },
  responses: {
    200: { description: "Scan report", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(getScanReportRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { scan_id: scanId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const scanRows = await sql`
      SELECT * FROM security_scans WHERE scan_id = ${scanId} LIMIT 1
    `;
    if (!scanRows.length) {
      return c.json({ error: "Scan not found" }, 404);
    }

    const scan = scanRows[0] as Record<string, unknown>;
    const findingRows = await sql`
      SELECT * FROM security_scan_findings WHERE scan_id = ${scanId}
      ORDER BY aivss_score DESC
    `;

    // Reconstruct a ScanResult-like object for the report generator
    const mockResult = {
    scan_id: String(scan.scan_id),
    agent_name: String(scan.agent_name ?? ""),
    scan_type: String(scan.scan_type ?? ""),
    status: String(scan.status ?? ""),
    total_probes: Number(scan.total_probes ?? 0),
    passed: Number(scan.passed ?? 0),
    failed: Number(scan.failed ?? 0),
    risk_score: Number(scan.risk_score ?? 0),
    risk_level: String(scan.risk_level ?? "unknown"),
    findings: findingRows as unknown as Record<string, unknown>[],
    maestro_layers: [],
    aivss_summary: { overall_score: Number(scan.risk_score ?? 0) },
    probe_results: [],
    started_at: String(scan.started_at ?? new Date().toISOString()),
    completed_at: String(scan.completed_at ?? new Date().toISOString()),
    findings_summary: {},
  };

    const report = generateReport(mockResult);
    return c.json(report);
  });
});

// ── POST /aivss/calculate ────────────────────────────────────────

const aivssBodySchema = z.object({
  attack_vector: z.string().default("network"),
  attack_complexity: z.string().default("low"),
  privileges_required: z.string().default("none"),
  scope: z.string().default("unchanged"),
  confidentiality_impact: z.string().default("none"),
  integrity_impact: z.string().default("none"),
  availability_impact: z.string().default("none"),
});

const calculateAivssRoute = createRoute({
  method: "post",
  path: "/aivss/calculate",
  tags: ["Security"],
  summary: "Calculate AIVSS score",
  middleware: [requireScope("security:write")],
  request: {
    body: { content: { "application/json": { schema: aivssBodySchema } } },
  },
  responses: {
    200: { description: "AIVSS score", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 500),
  },
});

securityRoutes.openapi(calculateAivssRoute, async (c): Promise<any> => {
  const parsed = c.req.valid("json");

  const vector = defaultVector(parsed);
  const score = calculateAivss(vector);
  return c.json({
    score,
    risk_level: classifyRisk(score),
    vector: vectorToDict(vector),
  });
});

// ── GET /risk-trends/:agent_name ─────────────────────────────────

const getRiskTrendsRoute = createRoute({
  method: "get",
  path: "/risk-trends/{agent_name}",
  tags: ["Security"],
  summary: "Get risk trend history for an agent",
  middleware: [requireScope("security:read")],
  request: {
    params: z.object({ agent_name: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
  },
  responses: {
    200: { description: "Risk trends", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

securityRoutes.openapi(getRiskTrendsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT scan_id, risk_score, risk_level, passed, failed, started_at as created_at
      FROM security_scans
      WHERE agent_name = ${agentName}
      ORDER BY started_at DESC LIMIT ${limit}
    `;

    // Reverse to chronological order (oldest first) for trend charts
    const trends = [...rows].reverse().map((s) => ({
      scan_id: s.scan_id,
      risk_score: Number(s.risk_score ?? 0),
      risk_level: String(s.risk_level ?? "unknown"),
      passed: Number(s.passed ?? 0),
      failed: Number(s.failed ?? 0),
      created_at: Number(s.created_at ?? 0),
    }));

    return c.json({ agent_name: agentName, trends });
  });
});
