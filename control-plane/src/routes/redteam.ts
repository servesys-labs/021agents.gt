/**
 * Red Team security routes — scans, findings, AIVSS risk profiles.
 *
 * Routes:
 *   POST /redteam/scan        - Start security scan
 *   GET  /redteam/scans/:id   - Get scan results
 *   GET  /redteam/scans       - List scans
 *   POST /redteam/scans/:id/cancel - Cancel scan
 *
 * Ported from agentos/api/routers/redteam.py.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { CurrentUser } from "../auth/types";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { RedTeamRunner, ScanResult } from "../lib/security";
import { parseAgentConfigJson } from "../schemas/common";
import { requireScope } from "../middleware/auth";

export const redteamRoutes = createOpenAPIRouter();

// In-memory store for scan results (until persisted to DB)
const scanResultsCache = new Map<string, ScanResult>();
const activeRunners = new Map<string, RedTeamRunner>();

// ── Request/Response schemas ───────────────────────────────────────

const scanRequestSchema = z.object({
  agent_name: z.string().optional(),
  scan_type: z.enum(["config", "runtime", "full"]).default("config"),
  agent_config: z.record(z.unknown()).optional(),
});

// ── POST /redteam/scan ─────────────────────────────────────────────

const startScanRoute = createRoute({
  method: "post",
  path: "/scan",
  tags: ["RedTeam"],
  summary: "Start a red team security scan",
  middleware: [requireScope("security:write")],
  request: {
    query: z.object({
      agent_name: z.string().optional(),
    }),
    body: { content: { "application/json": { schema: scanRequestSchema } } },
  },
  responses: {
    201: { description: "Scan started", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(400, 401, 404, 500),
  },
});

redteamRoutes.openapi(startScanRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const parsed = c.req.valid("json");
  const { scan_type, agent_config } = parsed;

  // Get agent name from body, query param, or return error
  const queryParams = c.req.valid("query");
  const agentName = parsed.agent_name ?? queryParams.agent_name ?? "";

  if (!agentName) {
    return c.json({ error: "agent_name is required" }, 400);
  }

  // Load agent config if not provided
  let agentConfig = agent_config;
  if (!agentConfig) {
    const agentRows = await sql`
      SELECT config_json FROM agents
      WHERE name = ${agentName} AND org_id = ${user.org_id}
      LIMIT 1
    `;
    if (!agentRows.length) {
      return c.json({ error: `Agent '${agentName}' not found` }, 404);
    }
    agentConfig = parseAgentConfigJson(
      (agentRows[0] as Record<string, unknown>).config_json,
    );
  }

  // Create runner and store reference
  const runner = new RedTeamRunner(null);
  const scanId = generateScanId();

  // Run the appropriate scan type
  let result: ScanResult;

  try {
    switch (scan_type) {
      case "runtime":
        result = await runner.scanRuntime(
          agentName,
          agentConfig,
          null,
          user.org_id,
          30.0,
        );
        break;

      case "full":
        result = await runner.scanFull(
          agentName,
          agentConfig,
          null,
          user.org_id,
          30.0,
        );
        break;

      case "config":
      default:
        result = await runner.scanConfig(
          agentName,
          agentConfig,
          user.org_id,
          scan_type,
        );
        break;
    }

    // Persist to database using existing schema
    try {
      await sql`
        INSERT INTO security_scans (
          scan_id, org_id, agent_name, scan_type, status,
          total_probes, passed, failed, risk_score, risk_level,
          started_at, completed_at
        ) VALUES (
          ${result.scan_id}, ${user.org_id}, ${agentName}, ${scan_type}, ${result.status},
          ${result.total_probes}, ${result.passed}, ${result.failed},
          ${result.risk_score}, ${result.risk_level},
          ${result.started_at}, ${result.completed_at}
        )
      `;

      // Persist findings
      for (const finding of result.findings) {
        await sql`
          INSERT INTO security_findings (
            scan_id, org_id, agent_name, probe_id, probe_name,
            category, layer, severity, title, description, evidence,
            aivss_vector, aivss_score
          ) VALUES (
            ${result.scan_id}, ${user.org_id}, ${agentName},
            ${String(finding.probe_id ?? "")}, ${String(finding.probe_name ?? "")},
            ${String(finding.category ?? "")}, ${String(finding.layer ?? "")},
            ${String(finding.severity ?? "info")},
            ${String(finding.probe_name ?? "")},
            ${String(finding.evidence ?? "").slice(0, 500)},
            ${String(finding.evidence ?? "")},
            ${String(finding.aivss_vector ?? "")}, ${Number(finding.aivss_score ?? 0)}
          )
        `;
      }

      // Update risk profile
      await sql`
        INSERT INTO risk_profiles (agent_name, org_id, risk_score, risk_level, last_scan_id, findings_summary, updated_at)
        VALUES (
          ${agentName}, ${user.org_id}, ${result.risk_score}, ${result.risk_level},
          ${result.scan_id}, ${JSON.stringify({
            total: result.findings.length,
            by_severity: countBy(result.findings, "severity"),
            by_category: countBy(result.findings, "category"),
          })}, ${new Date().toISOString()}
        )
        ON CONFLICT (agent_name) DO UPDATE SET
          risk_score = EXCLUDED.risk_score,
          risk_level = EXCLUDED.risk_level,
          last_scan_id = EXCLUDED.last_scan_id,
          findings_summary = EXCLUDED.findings_summary,
          updated_at = EXCLUDED.updated_at
      `;
    } catch (dbError) {
      console.error("Failed to persist scan results:", dbError);
      // Continue - return result even if persistence fails
    }

    // Cache result for quick retrieval
    scanResultsCache.set(result.scan_id, result);
    activeRunners.set(result.scan_id, runner);

    return c.json(
      {
        scan_id: result.scan_id,
        agent_name: agentName,
        scan_type: scan_type,
        status: result.status,
        risk_score: result.risk_score,
        risk_level: result.risk_level,
        total_probes: result.total_probes,
        passed: result.passed,
        failed: result.failed,
        findings_count: result.findings.length,
        started_at: result.started_at,
        completed_at: result.completed_at,
      },
      201,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return c.json({ error: "Scan failed", message: errorMessage }, 500);
  }
});

// ── GET /redteam/scans ─────────────────────────────────────────────

const listScansRoute = createRoute({
  method: "get",
  path: "/scans",
  tags: ["RedTeam"],
  summary: "List red team scans",
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

redteamRoutes.openapi(listScansRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { agent_name: agentName, limit } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT
        scan_id, agent_name, scan_type, status,
        total_probes, passed, failed, risk_score, risk_level,
        started_at, completed_at
      FROM security_scans
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT
        scan_id, agent_name, scan_type, status,
        total_probes, passed, failed, risk_score, risk_level,
        started_at, completed_at
      FROM security_scans
      WHERE org_id = ${user.org_id}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }

  return c.json({
    scans: rows,
    total: rows.length,
  });
});

// ── GET /redteam/scans/:id ─────────────────────────────────────────

const getScanRoute = createRoute({
  method: "get",
  path: "/scans/{id}",
  tags: ["RedTeam"],
  summary: "Get scan results",
  middleware: [requireScope("security:read")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Scan result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

redteamRoutes.openapi(getScanRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { id: scanId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // First check cache for active/running scans with full details
  const cachedResult = scanResultsCache.get(scanId);
  if (cachedResult) {
    return c.json(cachedResult);
  }

  // Get scan from database
  const scanRows = await sql`
    SELECT * FROM security_scans
    WHERE scan_id = ${scanId} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (!scanRows.length) {
    return c.json({ error: "Scan not found" }, 404);
  }

  const scan = scanRows[0] as Record<string, unknown>;

  // Get findings for this scan
  const findingRows = await sql`
    SELECT * FROM security_findings
    WHERE scan_id = ${scanId} AND org_id = ${user.org_id}
    ORDER BY aivss_score DESC
  `;

  // Get MAESTRO layers (stored in scan metadata if available)
  let maestroLayers: Record<string, unknown>[] = [];
  try {
    const metadata = scan.metadata
      ? JSON.parse(String(scan.metadata))
      : null;
    maestroLayers = metadata?.maestro_layers ?? [];
  } catch {
    // Ignore parse errors
  }

  const result: ScanResult = {
    scan_id: String(scan.scan_id),
    agent_name: String(scan.agent_name ?? ""),
    scan_type: String(scan.scan_type ?? ""),
    status: String(scan.status ?? ""),
    total_probes: Number(scan.total_probes ?? 0),
    passed: Number(scan.passed ?? 0),
    failed: Number(scan.failed ?? 0),
    risk_score: Number(scan.risk_score ?? 0),
    risk_level: String(scan.risk_level ?? "unknown"),
    findings: findingRows as Record<string, unknown>[],
    maestro_layers: maestroLayers,
    aivss_summary: {
      overall_score: Number(scan.risk_score ?? 0),
      risk_level: String(scan.risk_level ?? "unknown"),
    },
    probe_results: [],
    started_at: String(scan.started_at ?? new Date().toISOString()),
    completed_at: String(scan.completed_at ?? new Date().toISOString()),
  };

  return c.json(result);
});

// ── POST /redteam/scans/:id/cancel ─────────────────────────────────

const cancelScanRoute = createRoute({
  method: "post",
  path: "/scans/{id}/cancel",
  tags: ["RedTeam"],
  summary: "Cancel a running scan",
  middleware: [requireScope("security:write")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Cancellation result", content: { "application/json": { schema: z.record(z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
    ...errorResponses(401, 500),
  },
});

redteamRoutes.openapi(cancelScanRoute, async (c): Promise<any> => {
  const { id: scanId } = c.req.valid("param");

  // Get the runner for this scan
  const runner = activeRunners.get(scanId);

  if (!runner) {
    return c.json(
      {
        error: "Scan not found or already completed",
        scan_id: scanId,
      },
      404,
    );
  }

  const cancelled = runner.cancelScan(scanId);

  if (cancelled) {
    return c.json({
      success: true,
      message: "Scan cancellation requested",
      scan_id: scanId,
    });
  } else {
    return c.json(
      {
        error: "Scan cannot be cancelled",
        scan_id: scanId,
      },
      409,
    );
  }
});

// ── GET /redteam/probes ────────────────────────────────────────────

const listProbesRoute = createRoute({
  method: "get",
  path: "/probes",
  tags: ["RedTeam"],
  summary: "List available OWASP probes",
  middleware: [requireScope("security:read")],
  responses: {
    200: { description: "Probe list", content: { "application/json": { schema: z.record(z.unknown()) } } },
    ...errorResponses(401, 500),
  },
});

redteamRoutes.openapi(listProbesRoute, async (c): Promise<any> => {
  const { OwaspProbeLibrary, probeToDict } = require("../lib/security");
  const lib = new OwaspProbeLibrary();
  return c.json({ probes: lib.getAll().map(probeToDict) });
});

// ── Helper functions ───────────────────────────────────────────────

function generateScanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function countBy(
  items: Record<string, unknown>[],
  key: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const val = String(item[key] ?? "unknown");
    counts[val] = (counts[val] ?? 0) + 1;
  }
  return counts;
}
