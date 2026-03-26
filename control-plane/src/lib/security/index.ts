/**
 * Security module — Red Team security scanning for AI agents.
 *
 * Ported from agentos/security/ (redteam.py, owasp_probes.py, maestro.py, aivss.py).
 *
 * @example
 * ```typescript
 * import { RedTeamRunner } from "./lib/security";
 *
 * const runner = new RedTeamRunner(db);
 * const result = await runner.scanConfig("my-agent", agentConfig, "org-123", "config");
 * console.log(result.risk_score, result.risk_level);
 * ```
 */

// AIVSS — AI Vulnerability Scoring System
export {
  AIVSSCalculator,
  calculator,
  calculateAivss,
  classifyRisk,
  scoreFinding,
  aggregateRisk,
  defaultVector,
  vectorToString,
  vectorFromString,
  vectorToDict,
  type AIVSSVector,
} from "./aivss";

// MAESTRO — 7-layer AI threat model
export {
  MaestroFramework,
  MAESTRO_LAYERS,
  LAYER_DESCRIPTIONS,
  layerAssessmentToDict,
  createLayerSummary,
  type MaestroLayer,
  type LayerAssessment,
  type Finding,
} from "./maestro";

// OWASP Probes — LLM Top 10 security probes
export {
  OwaspProbeLibrary,
  probeToDict,
  probeResultToDict,
  evaluateOutput,
  type Probe,
  type ProbeResult,
} from "./owaspProbes";

// Red Team Runner — Main orchestrator
export {
  RedTeamRunner,
  generateReport,
  type SecurityDb,
  type ScanResult,
} from "./redteam";
