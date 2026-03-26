/**
 * PII Detection Engine — regex-based PII scanning with Luhn validation.
 *
 * Detects SSN, credit cards, emails, phone numbers, IP addresses,
 * API keys, AWS keys, and US street addresses.
 */

// ── PII Categories ──────────────────────────────────────────────

export const PII_CATEGORIES = {
  SSN: "ssn",
  CREDIT_CARD: "credit_card",
  EMAIL: "email",
  PHONE: "phone",
  IP_ADDRESS: "ip_address",
  API_KEY: "api_key",
  AWS_KEY: "aws_key",
  ADDRESS: "address",
} as const;

export type PiiCategory = (typeof PII_CATEGORIES)[keyof typeof PII_CATEGORIES];

export interface PiiMatch {
  type: PiiCategory;
  value: string;
  start: number;
  end: number;
  confidence: number;
}

// ── Pattern definitions ─────────────────────────────────────────

interface PiiPattern {
  type: PiiCategory;
  regex: RegExp;
  confidence: number;
  validate?: (match: string) => boolean;
}

/** Luhn checksum — validates credit card numbers. */
function luhnCheck(num: string): boolean {
  const digits = num.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Validate that an IP address has octets in 0-255 range. */
function isValidIp(ip: string): boolean {
  const parts = ip.split(".");
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

const PII_PATTERNS: PiiPattern[] = [
  {
    type: PII_CATEGORIES.SSN,
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.95,
  },
  {
    type: PII_CATEGORIES.CREDIT_CARD,
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    confidence: 0.9,
    validate: luhnCheck,
  },
  {
    type: PII_CATEGORIES.EMAIL,
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,
    confidence: 0.95,
  },
  {
    type: PII_CATEGORIES.PHONE,
    regex: /\b(?:\+?1[-.]?)?\(?[2-9]\d{2}\)?[-.]?\d{3}[-.]?\d{4}\b/g,
    confidence: 0.85,
  },
  {
    type: PII_CATEGORIES.IP_ADDRESS,
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    confidence: 0.8,
    validate: isValidIp,
  },
  {
    type: PII_CATEGORIES.API_KEY,
    regex: /\b(?:sk|pk|ak|token|key|secret|password)[-_]?[A-Za-z0-9]{16,}\b/gi,
    confidence: 0.85,
  },
  {
    type: PII_CATEGORIES.AWS_KEY,
    regex: /\bAKIA[A-Z0-9]{16}\b/g,
    confidence: 0.95,
  },
  {
    type: PII_CATEGORIES.ADDRESS,
    regex: /\b\d{1,5}\s+[A-Za-z0-9.\s]{2,30}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Court|Ct|Way|Place|Pl)\.?\s*,?\s*[A-Za-z\s]{2,25},?\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/gi,
    confidence: 0.75,
  },
];

// ── Public API ──────────────────────────────────────────────────

/**
 * Detect all PII matches in the given text.
 */
export function detectPii(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];

  for (const pattern of PII_PATTERNS) {
    // Reset regex state for global patterns
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      const value = m[0];
      // Run optional validation (e.g. Luhn for credit cards, octet range for IPs)
      if (pattern.validate && !pattern.validate(value)) continue;

      matches.push({
        type: pattern.type,
        value,
        start: m.index,
        end: m.index + value.length,
        confidence: pattern.confidence,
      });
    }
  }

  // Sort by position in text
  matches.sort((a, b) => a.start - b.start);

  // De-duplicate overlapping matches (keep higher confidence)
  const deduped: PiiMatch[] = [];
  for (const match of matches) {
    const last = deduped[deduped.length - 1];
    if (last && match.start < last.end) {
      // Overlapping — keep higher confidence
      if (match.confidence > last.confidence) {
        deduped[deduped.length - 1] = match;
      }
      continue;
    }
    deduped.push(match);
  }

  return deduped;
}

/**
 * Redact PII matches from text, replacing with [REDACTED:{type}].
 */
export function redactPii(text: string, matches: PiiMatch[]): string {
  if (!matches.length) return text;

  // Process from end to preserve indices
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = text;
  for (const match of sorted) {
    const placeholder = `[REDACTED:${match.type}]`;
    result = result.slice(0, match.start) + placeholder + result.slice(match.end);
  }
  return result;
}

/**
 * Convenience: detect and redact in one call.
 */
export function scanAndRedact(text: string): {
  redacted: string;
  matches: PiiMatch[];
  hasMatches: boolean;
} {
  const matches = detectPii(text);
  const redacted = redactPii(text, matches);
  return { redacted, matches, hasMatches: matches.length > 0 };
}
