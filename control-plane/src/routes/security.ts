/**
 * Security scanning routes -- OWASP probes, AIVSS, risk profiles.
 * Ported from agentos/api/routers/redteam.py.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
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

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const securityRoutes = new Hono<R>();

// ── GET /probes ──────────────────────────────────────────────────

securityRoutes.get("/probes", requireScope("security:read"), (c) => {
  return c.json({ probes: allProbesDicts() });
});

// ── GET /scans ───────────────────────────────────────────────────

securityRoutes.get("/scans", requireScope("security:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.query("agent_name") ?? "";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (agentName) {
    rows = await sql`
      SELECT * FROM security_scans
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM security_scans
      WHERE org_id = ${user.org_id}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ scans: rows });
});

// ── GET /findings ────────────────────────────────────────────────

securityRoutes.get("/findings", requireScope("security:read"), async (c) => {
  const user = c.get("user");
  const scanId = c.req.query("scan_id") ?? "";
  const agentName = c.req.query("agent_name") ?? "";
  const severity = c.req.query("severity") ?? "";
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100)));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Use separate queries to avoid SQL injection with dynamic WHERE
  let rows;
  if (scanId && agentName && severity) {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id} AND scan_id = ${scanId} AND agent_name = ${agentName} AND severity = ${severity}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  } else if (scanId && agentName) {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id} AND scan_id = ${scanId} AND agent_name = ${agentName}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  } else if (scanId && severity) {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id} AND scan_id = ${scanId} AND severity = ${severity}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  } else if (agentName && severity) {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName} AND severity = ${severity}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  } else if (scanId) {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id} AND scan_id = ${scanId}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  } else if (agentName) {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  } else if (severity) {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id} AND severity = ${severity}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM security_findings
      WHERE org_id = ${user.org_id}
      ORDER BY aivss_score DESC LIMIT ${limit}
    `;
  }

  return c.json({ findings: rows });
});

// ── GET /risk-profiles ───────────────────────────────────────────

securityRoutes.get("/risk-profiles", requireScope("security:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM risk_profiles WHERE org_id = ${user.org_id}
    ORDER BY risk_score DESC
  `;
  return c.json({ profiles: rows });
});

// ── GET /risk-profiles/:agent_name ───────────────────────────────

securityRoutes.get("/risk-profiles/:agent_name", requireScope("security:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM risk_profiles WHERE agent_name = ${agentName} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (!rows.length) {
    return c.json({ agent_name: agentName, risk_score: 0.0, risk_level: "not_scanned" });
  }
  return c.json(rows[0]);
});

// ── POST /scan/:agent_name ───────────────────────────────────────

securityRoutes.post("/scan/:agent_name", requireScope("security:write"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const scanType = c.req.query("scan_type") ?? "config";
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Load agent config from DB (config_json is canonical; same column as agents router)
  const agentRows = await sql`
    SELECT config_json FROM agents
    WHERE name = ${agentName} AND org_id = ${user.org_id}
    LIMIT 1
  `;
  if (!agentRows.length) {
    return c.json({ error: `Agent '${agentName}' not found` }, 404);
  }

  const agentConfig = parseAgentConfigJson(
    (agentRows[0] as Record<string, unknown>).config_json,
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
        INSERT INTO security_findings (
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

    // Upsert risk profile
    await sql`
      INSERT INTO risk_profiles (agent_name, org_id, risk_score, risk_level, last_scan_id, findings_summary, updated_at)
      VALUES (
        ${agentName}, ${user.org_id}, ${result.risk_score}, ${result.risk_level},
        ${result.scan_id}, ${JSON.stringify(result.findings_summary)}, ${Date.now() / 1000}
      )
      ON CONFLICT (agent_name) DO UPDATE SET
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

// ── POST /scan/:agent_name/runtime ───────────────────────────────

securityRoutes.post("/scan/:agent_name/runtime", requireScope("security:write"), (c) => {
  return c.json(
    {
      error: "Runtime scanning is edge-only. Invoke probes against worker runtime and persist findings via control plane.",
    },
    410,
  );
});

// ── GET /scan/:scan_id/report ────────────────────────────────────

securityRoutes.get("/scan/:scan_id/report", requireScope("security:read"), async (c) => {
  const user = c.get("user");
  const scanId = c.req.param("scan_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const scanRows = await sql`
    SELECT * FROM security_scans WHERE scan_id = ${scanId} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (!scanRows.length) {
    return c.json({ error: "Scan not found" }, 404);
  }

  const scan = scanRows[0] as Record<string, unknown>;
  const findingRows = await sql`
    SELECT * FROM security_findings WHERE scan_id = ${scanId} AND org_id = ${user.org_id}
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
    started_at: Number(scan.started_at ?? 0),
    completed_at: Number(scan.completed_at ?? 0),
    findings_summary: {},
  };

  const report = generateReport(mockResult);
  return c.json(report);
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

securityRoutes.post("/aivss/calculate", requireScope("security:write"), async (c) => {
  const body = await c.req.json();
  const parsed = aivssBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid AIVSS vector", details: parsed.error.flatten() }, 400);
  }

  const vector = defaultVector(parsed.data);
  const score = calculateAivss(vector);
  return c.json({
    score,
    risk_level: classifyRisk(score),
    vector: vectorToDict(vector),
  });
});

// ── GET /risk-trends/:agent_name ─────────────────────────────────

securityRoutes.get("/risk-trends/:agent_name", requireScope("security:read"), async (c) => {
  const user = c.get("user");
  const agentName = c.req.param("agent_name");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT scan_id, risk_score, risk_level, passed, failed, started_at as created_at
    FROM security_scans
    WHERE org_id = ${user.org_id} AND agent_name = ${agentName}
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
