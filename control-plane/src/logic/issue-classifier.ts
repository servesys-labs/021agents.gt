/**
 * Issue classifier -- categorizes issues by type and severity.
 */

const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  security: [
    /governance.*violation/i, /blocked.*tool/i, /unsafe/i,
    /permission.*denied/i, /unauthorized/i,
  ],
  tool_failure: [
    /tool.*fail/i, /tool.*error/i, /timeout/i, /execution.*error/i,
    /command.*failed/i,
  ],
  hallucination: [
    /hallucin/i, /fabricat/i, /not\s+sure/i, /uncertain/i,
    /made\s+up/i, /incorrect.*fact/i,
  ],
  knowledge_gap: [
    /low.*quality/i, /irrelevant/i, /unable.*to.*answer/i,
    /don't.*know/i, /no.*information/i,
  ],
  performance: [
    /budget/i, /cost.*exceed/i, /slow/i, /latency/i, /timeout/i,
    /too.*many.*turns/i,
  ],
  config_drift: [
    /drift/i, /compliance/i, /gold.*image/i, /config.*mismatch/i,
  ],
};

const SEVERITY_WEIGHTS: Record<string, string> = {
  security: "critical",
  tool_failure: "high",
  hallucination: "medium",
  config_drift: "medium",
  knowledge_gap: "low",
  performance: "low",
};

function detectCategory(text: string): string {
  const scores: Record<string, number> = {};
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) score++;
    }
    if (score > 0) scores[category] = score;
  }

  if (Object.keys(scores).length === 0) return "unknown";

  let best = "";
  let bestScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

export interface Classification {
  category: string;
  severity: string;
}

/**
 * Classify an issue based on title and description.
 * If existing valid values are provided, they take precedence.
 */
export function classifyIssue(
  title: string = "",
  description: string = "",
  existingCategory: string = "",
  existingSeverity: string = "",
): Classification {
  const category =
    existingCategory && existingCategory !== "unknown"
      ? existingCategory
      : detectCategory(`${title} ${description}`);

  const severity =
    existingSeverity && existingSeverity !== "" && existingSeverity !== "unknown"
      ? existingSeverity
      : SEVERITY_WEIGHTS[category] ?? "low";

  return { category, severity };
}
