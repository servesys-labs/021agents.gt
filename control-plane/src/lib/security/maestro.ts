/**
 * MAESTRO framework — 7-layer AI threat model.
 *
 * Layers:
 *   1. Foundation Model — model-level risks (hallucination, bias)
 *   2. Access Control — authentication, budget, rate limiting
 *   3. System Prompt — prompt injection, prompt leaking
 *   4. Tool Use — tool permissions, input validation
 *   5. RAG Pipeline — data poisoning, retrieval injection
 *   6. Agent Orchestration — multi-agent trust, delegation
 *   7. Deployment — infrastructure, API security
 */

export const MAESTRO_LAYERS = [
  "foundation_model",
  "access_control",
  "system_prompt",
  "tool_use",
  "rag_pipeline",
  "agent_orchestration",
  "deployment",
] as const;

export type MaestroLayer = (typeof MAESTRO_LAYERS)[number];

export const LAYER_DESCRIPTIONS: Record<MaestroLayer, string> = {
  foundation_model: "Model-level risks: hallucination, bias, overreliance",
  access_control: "Authentication, budget limits, rate limiting, RBAC",
  system_prompt: "Prompt injection, prompt leaking, jailbreaking",
  tool_use: "Tool permissions, input validation, dangerous operations",
  rag_pipeline: "Data poisoning, retrieval injection, context manipulation",
  agent_orchestration: "Multi-agent trust, delegation chains, sub-agent risks",
  deployment: "Infrastructure security, API exposure, model theft",
};

/** Assessment of a single MAESTRO layer. */
export interface LayerAssessment {
  layer: MaestroLayer;
  description: string;
  total_probes: number;
  passed: number;
  failed: number;
  risk_level: string; // low, medium, high, critical, not_assessed
  findings: Record<string, unknown>[];
}

/** Finding from a security probe. */
export interface Finding {
  probe_id: string;
  probe_name: string;
  severity: string;
  evidence: string;
}

/** Evaluates an agent across all 7 MAESTRO layers. */
export class MaestroFramework {
  /** Aggregate probe results into MAESTRO layer assessments. */
  assess(probeResults: Record<string, unknown>[]): LayerAssessment[] {
    const layerMap: Record<MaestroLayer, LayerAssessment> = {} as Record<
      MaestroLayer,
      LayerAssessment
    >;

    // Initialize all layers
    for (const layer of MAESTRO_LAYERS) {
      layerMap[layer] = {
        layer,
        description: LAYER_DESCRIPTIONS[layer],
        total_probes: 0,
        passed: 0,
        failed: 0,
        risk_level: "not_assessed",
        findings: [],
      };
    }

    // Aggregate results by layer
    for (const result of probeResults) {
      const layer = result.layer as MaestroLayer;
      if (!layer || !layerMap[layer]) {
        continue;
      }

      const assessment = layerMap[layer];
      assessment.total_probes += 1;

      if (result.passed) {
        assessment.passed += 1;
      } else {
        assessment.failed += 1;
        assessment.findings.push({
          probe_id: String(result.probe_id ?? ""),
          probe_name: String(result.probe_name ?? ""),
          severity: String(result.severity ?? "info"),
          evidence: String(result.evidence ?? ""),
        });
      }
    }

    // Compute risk levels
    for (const assessment of Object.values(layerMap)) {
      if (assessment.total_probes === 0) {
        assessment.risk_level = "not_assessed";
      } else if (assessment.failed === 0) {
        assessment.risk_level = "low";
      } else {
        const hasCritical = assessment.findings.some(
          (f) => f.severity === "critical",
        );
        const hasHigh = assessment.findings.some(
          (f) => f.severity === "high",
        );

        if (hasCritical) {
          assessment.risk_level = "critical";
        } else if (hasHigh) {
          assessment.risk_level = "high";
        } else if (assessment.failed > assessment.passed) {
          assessment.risk_level = "high";
        } else {
          assessment.risk_level = "medium";
        }
      }
    }

    return Object.values(layerMap);
  }

  /** Compute overall risk level from layer assessments. */
  overallRisk(
    assessments: Array<{
      layer: string;
      risk_level: string;
      total_probes?: number;
    }>,
  ): string {
    const levels = assessments
      .filter((a) => a.risk_level !== "not_assessed")
      .map((a) => a.risk_level);

    if (levels.length === 0) {
      return "unknown";
    }
    if (levels.includes("critical")) {
      return "critical";
    }
    if (levels.includes("high")) {
      return "high";
    }
    if (levels.includes("medium")) {
      return "medium";
    }
    return "low";
  }

  /** Get layers with highest risk for prioritization. */
  getRiskiestLayers(
    assessments: LayerAssessment[],
    minRiskLevel: string = "medium",
  ): LayerAssessment[] {
    const riskOrder = ["low", "medium", "high", "critical"];
    const minIndex = riskOrder.indexOf(minRiskLevel);

    return assessments
      .filter((a) => {
        const riskIndex = riskOrder.indexOf(a.risk_level);
        return riskIndex >= minIndex && a.risk_level !== "not_assessed";
      })
      .sort((a, b) => {
        const riskDiff =
          riskOrder.indexOf(b.risk_level) - riskOrder.indexOf(a.risk_level);
        if (riskDiff !== 0) return riskDiff;
        return b.failed - a.failed;
      });
  }
}

/** Convert LayerAssessment to plain object. */
export function layerAssessmentToDict(
  assessment: LayerAssessment,
): Record<string, unknown> {
  return {
    layer: assessment.layer,
    description: assessment.description,
    total_probes: assessment.total_probes,
    passed: assessment.passed,
    failed: assessment.failed,
    risk_level: assessment.risk_level,
    findings: assessment.findings,
  };
}

/** Create a summary report of MAESTRO layer assessments. */
export function createLayerSummary(
  assessments: LayerAssessment[],
): Record<string, unknown> {
  const totalProbes = assessments.reduce(
    (sum, a) => sum + a.total_probes,
    0,
  );
  const totalPassed = assessments.reduce((sum, a) => sum + a.passed, 0);
  const totalFailed = assessments.reduce((sum, a) => sum + a.failed, 0);

  const riskDistribution: Record<string, number> = {};
  for (const assessment of assessments) {
    riskDistribution[assessment.risk_level] =
      (riskDistribution[assessment.risk_level] ?? 0) + 1;
  }

  return {
    total_layers: MAESTRO_LAYERS.length,
    assessed_layers: assessments.filter((a) => a.total_probes > 0).length,
    total_probes: totalProbes,
    total_passed: totalPassed,
    total_failed: totalFailed,
    pass_rate: totalProbes > 0 ? (totalPassed / totalProbes) * 100 : 0,
    risk_distribution: riskDistribution,
    layers: assessments.map(layerAssessmentToDict),
  };
}
