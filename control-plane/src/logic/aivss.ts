/**
 * AIVSS -- AI Vulnerability Scoring System.
 *
 * CVSS-like scoring for AI agent vulnerabilities.
 */

// Score weights per component value
const AV_SCORES: Record<string, number> = { network: 0.85, adjacent: 0.62, local: 0.55, physical: 0.20 };
const AC_SCORES: Record<string, number> = { low: 0.77, high: 0.44 };
const PR_SCORES: Record<string, number> = { none: 0.85, low: 0.62, high: 0.27 };
const SCOPE_MULTIPLIER: Record<string, number> = { unchanged: 1.0, changed: 1.08 };
const IMPACT_SCORES: Record<string, number> = { none: 0.0, low: 0.22, high: 0.56 };

export interface AIVSSVector {
  attack_vector: string;
  attack_complexity: string;
  privileges_required: string;
  scope: string;
  confidentiality_impact: string;
  integrity_impact: string;
  availability_impact: string;
}

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

export function vectorToString(v: AIVSSVector): string {
  return (
    `AV:${v.attack_vector[0].toUpperCase()}` +
    `/AC:${v.attack_complexity[0].toUpperCase()}` +
    `/PR:${v.privileges_required[0].toUpperCase()}` +
    `/S:${v.scope[0].toUpperCase()}` +
    `/CI:${v.confidentiality_impact[0].toUpperCase()}` +
    `/II:${v.integrity_impact[0].toUpperCase()}` +
    `/AI:${v.availability_impact[0].toUpperCase()}`
  );
}

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

/** Calculate AIVSS score from vector components (0.0-10.0 scale). */
export function calculateAivss(vector: AIVSSVector): number {
  const av = AV_SCORES[vector.attack_vector] ?? 0.5;
  const ac = AC_SCORES[vector.attack_complexity] ?? 0.5;
  const pr = PR_SCORES[vector.privileges_required] ?? 0.5;

  const exploitability = 8.22 * av * ac * pr;

  const ci = IMPACT_SCORES[vector.confidentiality_impact] ?? 0.0;
  const ii = IMPACT_SCORES[vector.integrity_impact] ?? 0.0;
  const ai = IMPACT_SCORES[vector.availability_impact] ?? 0.0;

  const impactBase = 1 - (1 - ci) * (1 - ii) * (1 - ai);
  const scopeMult = SCOPE_MULTIPLIER[vector.scope] ?? 1.0;
  const impact = 6.42 * impactBase * scopeMult;

  if (impact <= 0) return 0.0;

  const score = Math.min(10.0, (exploitability + impact) / 2);
  return Math.round(score * 10) / 10;
}

/** Classify risk level from AIVSS score. */
export function classifyRisk(score: number): string {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0.0) return "low";
  return "none";
}

/** Derive AIVSS vector from a security finding. */
export function vectorFromFinding(finding: Record<string, unknown>): AIVSSVector {
  const severity = (finding.severity as string) ?? "info";
  const category = (finding.category as string) ?? "";

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
export function scoreFinding(finding: Record<string, unknown>): Record<string, unknown> {
  const vector = vectorFromFinding(finding);
  const score = calculateAivss(vector);
  const risk = classifyRisk(score);
  return {
    ...finding,
    aivss_vector: vectorToString(vector),
    aivss_score: score,
    aivss_risk_level: risk,
    aivss_components: vectorToDict(vector),
  };
}

/** Aggregate multiple AIVSS scores into an overall risk profile. */
export function aggregateRisk(scores: number[]): Record<string, unknown> {
  if (!scores.length) {
    return { overall_score: 0.0, risk_level: "none", max_score: 0.0, avg_score: 0.0 };
  }
  const maxScore = Math.max(...scores);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    overall_score: Math.round(maxScore * 10) / 10,
    risk_level: classifyRisk(maxScore),
    max_score: Math.round(maxScore * 10) / 10,
    avg_score: Math.round(avgScore * 10) / 10,
    total_findings: scores.length,
  };
}
