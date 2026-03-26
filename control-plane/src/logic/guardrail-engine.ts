/**
 * Guardrail Rule Engine — central evaluation combining PII detection,
 * prompt injection detection, and output safety scanning.
 *
 * Configurable per agent/org via GuardrailPolicy.
 */

import { detectPii, redactPii, type PiiMatch, type PiiCategory } from "./pii-detector";
import { detectInjection } from "./prompt-injection";
import { scanOutput } from "./output-safety";

// ── Policy types ────────────────────────────────────────────────

export interface GuardrailPolicy {
  /** Enable PII detection on inputs/outputs. */
  pii_detection: boolean;
  /** Auto-redact detected PII instead of blocking. */
  pii_redaction: boolean;
  /** Enable prompt injection checking on inputs. */
  injection_check: boolean;
  /** Enable output safety scanning. */
  output_safety: boolean;
  /** Maximum input length in characters (0 = unlimited). */
  max_input_length: number;
  /** PII categories allowed to pass through without action. */
  allowed_pii_categories: PiiCategory[];
  /** Topic keywords to block. */
  blocked_topics: string[];
}

export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  pii_detection: true,
  pii_redaction: true,
  injection_check: true,
  output_safety: true,
  max_input_length: 50_000,
  allowed_pii_categories: [],
  blocked_topics: [],
};

// ── Result types ────────────────────────────────────────────────

export interface GuardrailResult {
  action: "allow" | "warn" | "block";
  reasons: string[];
  pii_matches: PiiMatch[];
  injection_score: number;
  redacted_text?: string;
}

// ── Helpers ─────────────────────────────────────────────────────

function filterPiiByPolicy(
  matches: PiiMatch[],
  allowed: PiiCategory[],
): PiiMatch[] {
  if (!allowed.length) return matches;
  return matches.filter((m) => !allowed.includes(m.type));
}

function checkBlockedTopics(text: string, topics: string[]): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const topic of topics) {
    if (lower.includes(topic.toLowerCase())) {
      matched.push(topic);
    }
  }
  return matched;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Evaluate input text against a guardrail policy.
 * Checks: input length, blocked topics, PII detection, prompt injection.
 */
export function evaluateInput(
  text: string,
  policy: GuardrailPolicy,
): GuardrailResult {
  const reasons: string[] = [];
  let action: "allow" | "warn" | "block" = "allow";
  let piiMatches: PiiMatch[] = [];
  let injectionScore = 0;
  let redactedText: string | undefined;

  // Length check
  if (policy.max_input_length > 0 && text.length > policy.max_input_length) {
    reasons.push(
      `Input exceeds max length: ${text.length} > ${policy.max_input_length}`,
    );
    action = "block";
  }

  // Blocked topics
  if (policy.blocked_topics.length) {
    const matched = checkBlockedTopics(text, policy.blocked_topics);
    if (matched.length) {
      reasons.push(`Blocked topic(s) detected: ${matched.join(", ")}`);
      action = "block";
    }
  }

  // PII detection
  if (policy.pii_detection) {
    const allMatches = detectPii(text);
    piiMatches = filterPiiByPolicy(allMatches, policy.allowed_pii_categories);

    if (piiMatches.length) {
      if (policy.pii_redaction) {
        redactedText = redactPii(text, piiMatches);
        reasons.push(
          `PII detected and redacted: ${piiMatches.length} match(es)`,
        );
        if (action === "allow") action = "warn";
      } else {
        reasons.push(
          `PII detected: ${piiMatches.length} match(es) — blocking`,
        );
        action = "block";
      }
    }
  }

  // Prompt injection
  if (policy.injection_check) {
    const injection = detectInjection(text);
    injectionScore = injection.score;

    if (injection.detected) {
      reasons.push(
        `Injection detected (score: ${injection.score.toFixed(2)}): ${injection.patterns.join(", ")}`,
      );
      if (injection.recommendation === "block") {
        action = "block";
      } else if (injection.recommendation === "warn" && action !== "block") {
        action = "warn";
      }
    }
  }

  return {
    action,
    reasons,
    pii_matches: piiMatches,
    injection_score: injectionScore,
    redacted_text: redactedText,
  };
}

/**
 * Evaluate output text against a guardrail policy.
 * Checks: PII detection, output safety (prompt leaks, secrets, harmful, toxic).
 */
export function evaluateOutput(
  text: string,
  policy: GuardrailPolicy,
  systemPrompt?: string,
): GuardrailResult {
  const reasons: string[] = [];
  let action: "allow" | "warn" | "block" = "allow";
  let piiMatches: PiiMatch[] = [];
  let redactedText: string | undefined;

  // PII detection on output
  if (policy.pii_detection) {
    const allMatches = detectPii(text);
    piiMatches = filterPiiByPolicy(allMatches, policy.allowed_pii_categories);

    if (piiMatches.length) {
      if (policy.pii_redaction) {
        redactedText = redactPii(text, piiMatches);
        reasons.push(
          `PII detected in output and redacted: ${piiMatches.length} match(es)`,
        );
        if (action === "allow") action = "warn";
      } else {
        reasons.push(
          `PII detected in output: ${piiMatches.length} match(es) — blocking`,
        );
        action = "block";
      }
    }
  }

  // Output safety scanning
  if (policy.output_safety) {
    const safety = scanOutput(redactedText ?? text, systemPrompt);

    if (!safety.safe) {
      const criticalIssues = safety.issues.filter(
        (i) => i.severity === "critical",
      );
      const highIssues = safety.issues.filter((i) => i.severity === "high");

      for (const issue of safety.issues) {
        reasons.push(
          `Output safety: ${issue.type} (${issue.severity}) — ${issue.evidence}`,
        );
      }

      if (criticalIssues.length) {
        action = "block";
      } else if (highIssues.length && action !== "block") {
        action = "block";
      } else if (action !== "block") {
        action = "warn";
      }

      // Apply output safety redactions on top of PII redactions
      redactedText = safety.redacted;
    }
  }

  return {
    action,
    reasons,
    pii_matches: piiMatches,
    injection_score: 0, // Not applicable for output evaluation
    redacted_text: redactedText,
  };
}
