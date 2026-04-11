/**
 * Red-team runner — executes security probes against target agents.
 *
 * Orchestrates OWASP probes, MAESTRO assessment, and AIVSS scoring.
 */

import {
  OwaspProbeLibrary,
  ProbeResult,
  evaluateOutput,
  probeResultToDict,
} from "./owaspProbes";
import { MaestroFramework, LayerAssessment } from "./maestro";
import { AIVSSCalculator } from "./aivss";

/** Database interface for persisting scan results. */
export interface SecurityDb {
  insertSecurityScan(params: {
    scan_id: string;
    org_id: string;
    agent_name: string;
    scan_type: string;
    status: string;
    total_probes: number;
    passed: number;
    failed: number;
    risk_score: number;
    risk_level: string;
    started_at: string;
  }): Promise<void>;

  completeSecurityScan(
    scan_id: string,
    params: {
      passed: number;
      failed: number;
      risk_score: number;
      risk_level: string;
    },
  ): Promise<void>;

  insertSecurityFinding(params: {
    scan_id: string;
    org_id: string;
    agent_name: string;
    probe_id: string;
    probe_name: string;
    category: string;
    layer: string;
    severity: string;
    title: string;
    description: string;
    evidence: string;
    aivss_vector: string;
    aivss_score: number;
  }): Promise<void>;

  upsertRiskProfile(params: {
    agent_name: string;
    org_id: string;
    risk_score: number;
    risk_level: string;
    aivss_vector: Record<string, unknown>;
    last_scan_id: string;
    findings_summary: Record<string, unknown>;
  }): Promise<void>;
}

/** Result of a security scan. */
export interface ScanResult {
  scan_id: string;
  agent_name: string;
  scan_type: string;
  status: string;
  total_probes: number;
  passed: number;
  failed: number;
  risk_score: number;
  risk_level: string;
  findings: Record<string, unknown>[];
  maestro_layers: Record<string, unknown>[];
  aivss_summary: Record<string, unknown>;
  probe_results: Record<string, unknown>[];
  started_at: string;
  completed_at: string;
}

/** Active scan for tracking in-progress scans. */
interface ActiveScan {
  scan_id: string;
  agent_name: string;
  scan_type: string;
  status: "running" | "completed" | "cancelled" | "failed";
  started_at: string;
  cancelled?: boolean;
}

/** Runs red-team security scans against agent configurations. */
export class RedTeamRunner {
  private probes: OwaspProbeLibrary;
  private maestro: MaestroFramework;
  private aivss: AIVSSCalculator;
  private db: SecurityDb | null;
  private activeScans: Map<string, ActiveScan> = new Map();

  constructor(db: SecurityDb | null = null) {
    this.probes = new OwaspProbeLibrary();
    this.maestro = new MaestroFramework();
    this.aivss = new AIVSSCalculator();
    this.db = db;
  }

  /**
   * Run config-level security probes (no agent execution needed).
   */
  async scanConfig(
    agentName: string,
    agentConfig: Record<string, unknown>,
    orgId: string = "",
    scanType: string = "config",
  ): Promise<ScanResult> {
    const scanId = this.generateScanId();
    const startedAt = new Date().toISOString();

    // Track active scan
    const activeScan: ActiveScan = {
      scan_id: scanId,
      agent_name: agentName,
      scan_type: scanType,
      status: "running",
      started_at: startedAt,
    };
    this.activeScans.set(scanId, activeScan);

    try {
      // Run config probes
      const results = this.probes.runConfigProbes(agentConfig);

      // Check for cancellation
      if (activeScan.cancelled) {
        return this.createCancelledResult(scanId, agentName, scanType, startedAt);
      }

      return await this.processResults(
        scanId,
        agentName,
        scanType,
        startedAt,
        results,
        orgId,
      );
    } catch (error) {
      activeScan.status = "failed";
      throw error;
    } finally {
      this.activeScans.delete(scanId);
    }
  }

  /**
   * Run output-level probes against a live agent.
   */
  async scanRuntime(
    agentName: string,
    agentConfig: Record<string, unknown>,
    runFn: ((input: string) => Promise<string>) | null = null,
    orgId: string = "",
    probeTimeout: number = 30.0,
  ): Promise<ScanResult> {
    const scanId = this.generateScanId();
    const startedAt = new Date().toISOString();

    if (!runFn) {
      return {
        scan_id: scanId,
        agent_name: agentName,
        scan_type: "runtime",
        status: "failed",
        total_probes: 0,
        passed: 0,
        failed: 0,
        risk_score: 0,
        risk_level: "unknown",
        findings: [],
        maestro_layers: [],
        aivss_summary: { overall_score: 0, risk_level: "none" },
        probe_results: [
          {
            error:
              "No agent run function provided — use scanConfig for config-only scans",
          },
        ],
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
    }

    // Track active scan
    const activeScan: ActiveScan = {
      scan_id: scanId,
      agent_name: agentName,
      scan_type: "runtime",
      status: "running",
      started_at: startedAt,
    };
    this.activeScans.set(scanId, activeScan);

    try {
      const outputProbes = this.probes.getOutputProbes();
      const results: ProbeResult[] = [];

      for (const probe of outputProbes) {
        // Check for cancellation
        if (activeScan.cancelled) {
          break;
        }

        try {
          const output = await this.runWithTimeout(
            () => runFn(probe.test_input),
            probeTimeout * 1000,
          );
          const outputText = output ?? "";

          // Evaluate output against expected behavior
          const passed = evaluateOutput(probe, outputText);
          results.push({
            probe,
            passed,
            evidence: passed
              ? "Agent handled probe correctly"
              : outputText.slice(0, 500),
            details: {},
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          results.push({
            probe,
            passed: false,
            evidence: `Probe execution error: ${errorMessage.slice(0, 200)}`,
            details: {},
          });
        }
      }

      // Also run config probes
      if (!activeScan.cancelled) {
        const configResults = this.probes.runConfigProbes(agentConfig);
        results.push(...configResults);
      }

      if (activeScan.cancelled) {
        return this.createCancelledResult(
          scanId,
          agentName,
          "runtime",
          startedAt,
        );
      }

      return await this.processResults(
        scanId,
        agentName,
        "runtime",
        startedAt,
        results,
        orgId,
      );
    } catch (error) {
      activeScan.status = "failed";
      throw error;
    } finally {
      this.activeScans.delete(scanId);
    }
  }

  /**
   * Run a full security scan (config + runtime).
   */
  async scanFull(
    agentName: string,
    agentConfig: Record<string, unknown>,
    runFn: ((input: string) => Promise<string>) | null = null,
    orgId: string = "",
    probeTimeout: number = 30.0,
  ): Promise<ScanResult> {
    // Run config scan first
    const configResult = await this.scanConfig(
      agentName,
      agentConfig,
      orgId,
      "full",
    );

    // If runtime function provided, run runtime scan
    if (runFn) {
      const runtimeResult = await this.scanRuntime(
        agentName,
        agentConfig,
        runFn,
        orgId,
        probeTimeout,
      );

      // Merge results
      return this.mergeResults(configResult, runtimeResult);
    }

    return configResult;
  }

  /**
   * Cancel an active scan.
   */
  cancelScan(scanId: string): boolean {
    const scan = this.activeScans.get(scanId);
    if (scan && scan.status === "running") {
      scan.cancelled = true;
      scan.status = "cancelled";
      return true;
    }
    return false;
  }

  /**
   * Get active scan status.
   */
  getScanStatus(scanId: string): ActiveScan | null {
    return this.activeScans.get(scanId) ?? null;
  }

  /**
   * List all active scans.
   */
  listActiveScans(): ActiveScan[] {
    return Array.from(this.activeScans.values());
  }

  private async processResults(
    scanId: string,
    agentName: string,
    scanType: string,
    startedAt: string,
    results: ProbeResult[],
    orgId: string,
  ): Promise<ScanResult> {
    // Convert to dicts for MAESTRO + AIVSS
    const resultDicts = results.map(probeResultToDict);

    // Score each finding with AIVSS
    const scoredFindings: Record<string, unknown>[] = [];
    for (const r of results) {
      if (!r.passed) {
        const scored = this.aivss.scoreFinding(probeResultToDict(r));
        scoredFindings.push(scored);
      }
    }

    // MAESTRO layer assessment
    const layerAssessments = this.maestro.assess(resultDicts);
    const overallRisk = this.maestro.overallRisk(layerAssessments);

    // Aggregate AIVSS
    const aivssScores = scoredFindings
      .map((f) => Number(f.aivss_score ?? 0))
      .filter((s) => s > 0);
    const aivssAggregate = this.aivss.aggregateRisk(aivssScores);

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    const scanResult: ScanResult = {
      scan_id: scanId,
      agent_name: agentName,
      scan_type: scanType,
      status: "completed",
      total_probes: results.length,
      passed,
      failed,
      risk_score: Number(aivssAggregate.overall_score ?? 0),
      risk_level: overallRisk,
      findings: scoredFindings,
      maestro_layers: layerAssessments.map((a) => ({
        layer: a.layer,
        description: a.description,
        total_probes: a.total_probes,
        passed: a.passed,
        failed: a.failed,
        risk_level: a.risk_level,
        findings: a.findings,
      })),
      aivss_summary: aivssAggregate,
      probe_results: resultDicts,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };

    // Persist to database
    if (this.db) {
      await this.persistResults(scanResult, scoredFindings, orgId);
    }

    return scanResult;
  }

  private async persistResults(
    scanResult: ScanResult,
    scoredFindings: Record<string, unknown>[],
    orgId: string,
  ): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.insertSecurityScan({
        scan_id: scanResult.scan_id,
        org_id: orgId,
        agent_name: scanResult.agent_name,
        scan_type: scanResult.scan_type,
        status: scanResult.status,
        total_probes: scanResult.total_probes,
        passed: scanResult.passed,
        failed: scanResult.failed,
        risk_score: scanResult.risk_score,
        risk_level: scanResult.risk_level,
        started_at: scanResult.started_at,
      });

      await this.db.completeSecurityScan(scanResult.scan_id, {
        passed: scanResult.passed,
        failed: scanResult.failed,
        risk_score: scanResult.risk_score,
        risk_level: scanResult.risk_level,
      });

      // Persist findings
      for (const finding of scoredFindings) {
        await this.db.insertSecurityFinding({
          scan_id: scanResult.scan_id,
          org_id: orgId,
          agent_name: scanResult.agent_name,
          probe_id: String(finding.probe_id ?? ""),
          probe_name: String(finding.probe_name ?? ""),
          category: String(finding.category ?? ""),
          layer: String(finding.layer ?? ""),
          severity: String(finding.severity ?? "info"),
          title: String(finding.probe_name ?? ""),
          description: String(finding.evidence ?? ""),
          evidence: String(finding.evidence ?? ""),
          aivss_vector: String(finding.aivss_vector ?? ""),
          aivss_score: Number(finding.aivss_score ?? 0),
        });
      }

      // Update risk profile
      await this.db.upsertRiskProfile({
        agent_name: scanResult.agent_name,
        org_id: orgId,
        risk_score: scanResult.risk_score,
        risk_level: scanResult.risk_level,
        aivss_vector: scanResult.aivss_summary,
        last_scan_id: scanResult.scan_id,
        findings_summary: {
          total: scoredFindings.length,
          by_severity: countBy(scoredFindings, "severity"),
          by_category: countBy(scoredFindings, "category"),
        },
      });
    } catch (error) {
      // Best-effort persistence - log but don't fail
      console.error("Failed to persist scan results:", error);
    }
  }

  private createCancelledResult(
    scanId: string,
    agentName: string,
    scanType: string,
    startedAt: string,
  ): ScanResult {
    return {
      scan_id: scanId,
      agent_name: agentName,
      scan_type: scanType,
      status: "cancelled",
      total_probes: 0,
      passed: 0,
      failed: 0,
      risk_score: 0,
      risk_level: "unknown",
      findings: [],
      maestro_layers: [],
      aivss_summary: { overall_score: 0, risk_level: "none" },
      probe_results: [],
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };
  }

  private mergeResults(
    configResult: ScanResult,
    runtimeResult: ScanResult,
  ): ScanResult {
    const allFindings = [...configResult.findings, ...runtimeResult.findings];
    const allProbeResults = [
      ...configResult.probe_results,
      ...runtimeResult.probe_results,
    ];
    const allLayers = [
      ...configResult.maestro_layers,
      ...runtimeResult.maestro_layers,
    ];

    // Merge layer assessments
    const layerMap = new Map<string, Record<string, unknown>>();
    for (const layer of allLayers) {
      const layerName = String(layer.layer);
      if (layerMap.has(layerName)) {
        const existing = layerMap.get(layerName)!;
        existing.total_probes =
          Number(existing.total_probes ?? 0) + Number(layer.total_probes ?? 0);
        existing.passed =
          Number(existing.passed ?? 0) + Number(layer.passed ?? 0);
        existing.failed =
          Number(existing.failed ?? 0) + Number(layer.failed ?? 0);
        existing.findings = [
          ...((existing.findings as unknown[]) ?? []),
          ...((layer.findings as unknown[]) ?? []),
        ];
      } else {
        layerMap.set(layerName, { ...layer });
      }
    }

    const mergedLayers = Array.from(layerMap.values());

    // Recalculate overall risk
    const overallRisk = this.maestro.overallRisk(
      mergedLayers.map((l) => ({
        layer: String(l.layer),
        description: String(l.description ?? ""),
        total_probes: Number(l.total_probes ?? 0),
        passed: Number(l.passed ?? 0),
        failed: Number(l.failed ?? 0),
        risk_level: String(l.risk_level ?? "unknown"),
        findings: (l.findings as Record<string, unknown>[]) ?? [],
      })),
    );

    // Recalculate AIVSS aggregate
    const aivssScores = allFindings
      .map((f) => Number(f.aivss_score ?? 0))
      .filter((s) => s > 0);
    const aivssAggregate = this.aivss.aggregateRisk(aivssScores);

    return {
      scan_id: configResult.scan_id,
      agent_name: configResult.agent_name,
      scan_type: "full",
      status: runtimeResult.status === "completed" ? "completed" : "partial",
      total_probes: configResult.total_probes + runtimeResult.total_probes,
      passed: configResult.passed + runtimeResult.passed,
      failed: configResult.failed + runtimeResult.failed,
      risk_score: Number(aivssAggregate.overall_score ?? 0),
      risk_level: overallRisk,
      findings: allFindings,
      maestro_layers: mergedLayers,
      aivss_summary: aivssAggregate,
      probe_results: allProbeResults,
      started_at: configResult.started_at,
      completed_at: new Date().toISOString(),
    };
  }

  private generateScanId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  }

  private async runWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs),
      ),
    ]);
  }
}

/** Count items by a key. */
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

/** Generate a security report from a scan result. */
export function generateReport(scanResult: ScanResult): Record<string, unknown> {
  const findings = scanResult.findings;
  const bySeverity: Record<string, Record<string, unknown>[]> = {};

  for (const f of findings) {
    const sev = String(f.severity ?? "info");
    if (!bySeverity[sev]) {
      bySeverity[sev] = [];
    }
    bySeverity[sev].push(f);
  }

  const sorted = [...findings].sort(
    (a, b) => Number(b.aivss_score ?? 0) - Number(a.aivss_score ?? 0),
  );

  const recommendations: Record<string, string> = {
    LLM01: "Implement input sanitization and prompt injection detection",
    LLM02: "Sanitize all agent outputs before rendering",
    LLM04: "Set strict budget and turn limits",
    LLM05: "Audit and vet all tool plugins",
    LLM06: "Restrict domain access and add output filtering",
    LLM07: "Validate all tool inputs before execution",
    LLM08: "Reduce tool permissions and require confirmation for destructive actions",
    LLM09: "Add uncertainty markers and fact-checking",
    LLM10: "Remove model identifiers from public-facing configs",
  };

  const remediations = sorted.map((f, i) => ({
    priority: i + 1,
    probe: f.probe_name ?? "",
    category: f.category ?? "",
    severity: f.severity ?? "",
    aivss_score: f.aivss_score ?? 0,
    recommendation:
      recommendations[String(f.category ?? "")] ??
      "Review and remediate the identified vulnerability",
  }));

  return {
    scan_id: scanResult.scan_id,
    agent_name: scanResult.agent_name,
    scan_type: scanResult.scan_type,
    risk_score: scanResult.aivss_summary.overall_score ?? 0,
    risk_level: scanResult.risk_level,
    summary: {
      total_probes: scanResult.total_probes,
      passed: scanResult.passed,
      failed: scanResult.failed,
      critical_findings: (bySeverity.critical ?? []).length,
      high_findings: (bySeverity.high ?? []).length,
      medium_findings: (bySeverity.medium ?? []).length,
      low_findings: (bySeverity.low ?? []).length,
    },
    maestro_layers: scanResult.maestro_layers,
    findings_by_severity: Object.fromEntries(
      Object.entries(bySeverity).map(([k, v]) => [k, v.length]),
    ),
    remediations: remediations.slice(0, 10),
  };
}
