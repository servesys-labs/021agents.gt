/**
 * AIVSS — AI Vulnerability Scoring System.
 *
 * CVSS-like scoring for AI agent vulnerabilities.
 * Ported from agentos/security/aivss.py.
 *
 * Vector components:
 *   AV (Attack Vector): network/adjacent/local/physical
 *   AC (Attack Complexity): low/high
 *   PR (Privileges Required): none/low/high
 *   S  (Scope): unchanged/changed
 *   CI (Confidentiality Impact): none/low/high
 *   II (Integrity Impact): none/low/high
 *   AI (Availability Impact): none/low/high
 */

// Score weights per component value
const AV_SCORES: Record<string, number> = {
  network: 0.85,
  adjacent: 0.62,
  local: 0.55,
  physical: 0.2,
};

const AC_SCORES: Record<string, number> = {
  low: 0.77,
  high: 0.44,
};

const PR_SCORES: Record<string, number> = {
  none: 0.85,
  low: 0.62,
  high: 0.27,
};

const SCOPE_MULTIPLIER: Record<string, number> = {
  unchanged: 1.0,
  changed: 1.08,
};

const IMPACT_SCORES: Record<string, number> = {
  none: 0.0,
  low: 0.22,
  high: 0.56,
};

/** AIVSS vector representing attack surface and impact. */
export interface AIVSSVector {
  attack_vector: string; // network/adjacent/local/physical
  attack_complexity: string; // low/high
  privileges_required: string; // none/low/high
  scope: string; // unchanged/changed
  confidentiality_impact: string; // none/low/high
  integrity_impact: string; // none/low/high
  availability_impact: string; // none/low/high
}

/** Default AIVSS vector with optional overrides. */
export function defaultVector(overrides: Partial<AIVSSVector> = {}): AIVSSVector {
  return {
    attack_vector: "network",
    attack_complexity: "low",
    privileges_required: "none",
    scope: "unchanged",
    confidentiality_impact: "none",
    integrity_impact: "none",
    availability_impact: "none",
    ...overrides,
  };
}

/** Convert vector to string representation like "AV:N/AC:L/PR:N/S:U/CI:H/II:H/AI:H". */
export function vectorToString(v: AIVSSVector): string {
  const av = v.attack_vector[0]?.toUpperCase() ?? "N";
  const ac = v.attack_complexity[0]?.toUpperCase() ?? "L";
  const pr = v.privileges_required[0]?.toUpperCase() ?? "N";
  const s = v.scope[0]?.toUpperCase() ?? "U";
  const ci = v.confidentiality_impact[0]?.toUpperCase() ?? "N";
  const ii = v.integrity_impact[0]?.toUpperCase() ?? "N";
  const ai = v.availability_impact[0]?.toUpperCase() ?? "N";
  return `AV:${av}/AC:${ac}/PR:${pr}/S:${s}/CI:${ci}/II:${ii}/AI:${ai}`;
}

/** Parse a vector string like "AV:N/AC:L/PR:N/S:U/CI:H/II:H/AI:H". */
export function vectorFromString(vectorString: string): AIVSSVector {
  const abbrevMap: Record<string, Record<string, string>> = {
    AV: { N: "network", A: "adjacent", L: "local", P: "physical" },
    AC: { L: "low", H: "high" },
    PR: { N: "none", L: "low", H: "high" },
    S: { U: "unchanged", C: "changed" },
    CI: { N: "none", L: "low", H: "high" },
    II: { N: "none", L: "low", H: "high" },
    AI: { N: "none", L: "low", H: "high" },
  };

  const fieldMap: Record<string, keyof AIVSSVector> = {
    AV: "attack_vector",
    AC: "attack_complexity",
    PR: "privileges_required",
    S: "scope",
    CI: "confidentiality_impact",
    II: "integrity_impact",
    AI: "availability_impact",
  };

  const result: Partial<AIVSSVector> = {};

  for (const part of vectorString.split("/")) {
    const colonIndex = part.indexOf(":");
    if (colonIndex === -1) continue;

    const key = part.slice(0, colonIndex).trim();
    const abbrev = part.slice(colonIndex + 1).trim();

    if (abbrevMap[key]?.[abbrev]) {
      result[fieldMap[key]] = abbrevMap[key][abbrev];
    }
  }

  return defaultVector(result);
}

/** Convert vector to dictionary with vector string included. */
export function vectorToDict(v: AIVSSVector): Record<string, string> {
  return {
    attack_vector: v.attack_vector,
    attack_complexity: v.attack_complexity,
    privileges_required: v.privileges_required,
    scope: v.scope,
    confidentiality_impact: v.confidentiality_impact,
    integrity_impact: v.integrity_impact,
    availability_impact: v.availability_impact,
    vector_string: vectorToString(v),
  };
}

/** Calculates AIVSS scores (0.0-10.0 scale like CVSS). */
export class AIVSSCalculator {
  /** Calculate AIVSS score from vector components. */
  calculate(vector: AIVSSVector): number {
    // Exploitability sub-score
    const av = AV_SCORES[vector.attack_vector] ?? 0.5;
    const ac = AC_SCORES[vector.attack_complexity] ?? 0.5;
    const pr = PR_SCORES[vector.privileges_required] ?? 0.5;

    const exploitability = 8.22 * av * ac * pr;

    // Impact sub-score
    const ci = IMPACT_SCORES[vector.confidentiality_impact] ?? 0.0;
    const ii = IMPACT_SCORES[vector.integrity_impact] ?? 0.0;
    const ai = IMPACT_SCORES[vector.availability_impact] ?? 0.0;

    const impactBase = 1 - (1 - ci) * (1 - ii) * (1 - ai);
    const scopeMult = SCOPE_MULTIPLIER[vector.scope] ?? 1.0;
    const impact = 6.42 * impactBase * scopeMult;

    if (impact <= 0) {
      return 0.0;
    }

    // Combined score
    const score = Math.min(10.0, (exploitability + impact) / 2);
    return Math.round(score * 10) / 10;
  }

  /** Classify risk level from AIVSS score. */
  classifyRisk(score: number): string {
    if (score >= 9.0) return "critical";
    if (score >= 7.0) return "high";
    if (score >= 4.0) return "medium";
    if (score > 0.0) return "low";
    return "none";
  }

  /** Derive AIVSS vector from a security finding. */
  vectorFromFinding(finding: Record<string, unknown>): AIVSSVector {
    const severity = String(finding.severity ?? "info");
    const category = String(finding.category ?? "");

    // Default vector based on severity
    if (severity === "critical") {
      return defaultVector({
        attack_vector: "network",
        attack_complexity: "low",
        privileges_required: "none",
        scope: "changed",
        confidentiality_impact: "high",
        integrity_impact: "high",
        availability_impact: "high",
      });
    }

    if (severity === "high") {
      return defaultVector({
        attack_vector: "network",
        attack_complexity: "low",
        privileges_required: "low",
        scope: "unchanged",
        confidentiality_impact: category.includes("LLM06") ? "high" : "low",
        integrity_impact: category.includes("LLM01") ? "high" : "low",
        availability_impact: category.includes("LLM04") ? "high" : "none",
      });
    }

    if (severity === "medium") {
      return defaultVector({
        attack_vector: "network",
        attack_complexity: "high",
        privileges_required: "low",
        scope: "unchanged",
        confidentiality_impact: "low",
        integrity_impact: "low",
        availability_impact: category.includes("LLM04") ? "low" : "none",
      });
    }

    // Low / info
    return defaultVector({
      attack_vector: "local",
      attack_complexity: "high",
      privileges_required: "high",
      scope: "unchanged",
      confidentiality_impact: "none",
      integrity_impact: severity === "low" ? "low" : "none",
      availability_impact: "none",
    });
  }

  /** Score a single finding and return enriched data. */
  scoreFinding(finding: Record<string, unknown>): Record<string, unknown> {
    const vector = this.vectorFromFinding(finding);
    const score = this.calculate(vector);
    const risk = this.classifyRisk(score);
    return {
      ...finding,
      aivss_vector: vectorToString(vector),
      aivss_score: score,
      aivss_risk_level: risk,
      aivss_components: vectorToDict(vector),
    };
  }

  /** Aggregate multiple AIVSS scores into an overall risk profile. */
  aggregateRisk(scores: number[]): Record<string, unknown> {
    if (!scores.length) {
      return {
        overall_score: 0.0,
        risk_level: "none",
        max_score: 0.0,
        avg_score: 0.0,
        total_findings: 0,
      };
    }

    const maxScore = Math.max(...scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    // Overall uses max (worst case) like CVSS
    const overall = maxScore;

    return {
      overall_score: Math.round(overall * 10) / 10,
      risk_level: this.classifyRisk(overall),
      max_score: Math.round(maxScore * 10) / 10,
      avg_score: Math.round(avgScore * 10) / 10,
      total_findings: scores.length,
    };
  }
}

// Export standalone functions for convenience
export const calculator = new AIVSSCalculator();

export function calculateAivss(vector: AIVSSVector): number {
  return calculator.calculate(vector);
}

export function classifyRisk(score: number): string {
  return calculator.classifyRisk(score);
}

export function scoreFinding(finding: Record<string, unknown>): Record<string, unknown> {
  return calculator.scoreFinding(finding);
}

export function aggregateRisk(scores: number[]): Record<string, unknown> {
  return calculator.aggregateRisk(scores);
}
