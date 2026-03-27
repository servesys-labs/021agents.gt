/**
 * PII Auto-Redactor — detects and redacts PII from text before storage.
 *
 * Unlike pii-detector.ts (which is used for guardrail scanning/reporting),
 * this module provides a self-contained redaction pipeline designed for
 * automatic redaction in the data path (e.g., before persisting conversation
 * messages). Each PII type maps to a human-readable placeholder token.
 */

// ── Types ───────────────────────────────────────────────────────

export interface Piifinding {
  type: string;
  original: string;
  replacement: string;
  index: number;
}

export interface RedactionResult {
  redacted: string;
  piiFound: Piifinding[];
  hadPii: boolean;
}

// ── Pattern definitions ─────────────────────────────────────────

interface RedactionPattern {
  type: string;
  regex: RegExp;
  replacement: string;
  validate?: (match: string) => boolean;
}

/** Luhn checksum for credit card validation. */
function luhnCheck(num: string): boolean {
  const digits = num.replace(/[\s\-]/g, "");
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

/** Validate IP address octets are 0-255. */
function isValidIp(ip: string): boolean {
  const parts = ip.split(".");
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

const REDACTION_PATTERNS: RedactionPattern[] = [
  // SSN: XXX-XX-XXXX
  {
    type: "ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
  // Credit card: 13-19 digits with optional spaces/dashes
  {
    type: "credit_card",
    regex: /\b(?:\d[ \-]*?){13,19}\b/g,
    replacement: "[CC_REDACTED]",
    validate: luhnCheck,
  },
  // Email addresses
  {
    type: "email",
    regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/gi,
    replacement: "[EMAIL_REDACTED]",
  },
  // Phone numbers: US + international (with optional country code)
  {
    type: "phone",
    regex: /(?:\+\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{4}\b/g,
    replacement: "[PHONE_REDACTED]",
  },
  // IP addresses (v4)
  {
    type: "ip_address",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "[IP_REDACTED]",
    validate: isValidIp,
  },
  // Date of birth patterns: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, Month DD YYYY, etc.
  {
    type: "dob",
    regex:
      /\b(?:(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)\d{2}|(?:19|20)\d{2}[\/\-](?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+(?:19|20)\d{2})\b/gi,
    replacement: "[DOB_REDACTED]",
  },
  // US street addresses: number + street name + suffix + optional city/state/zip
  {
    type: "address",
    regex:
      /\b\d{1,5}\s+[A-Za-z0-9.\s]{2,30}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Court|Ct|Way|Place|Pl|Circle|Cir|Terrace|Ter|Trail|Trl|Parkway|Pkwy)\.?\b/gi,
    replacement: "[ADDRESS_REDACTED]",
  },
];

// ── Public API ──────────────────────────────────────────────────

/**
 * Detect and redact all PII in the given text.
 *
 * Returns the redacted string, a list of findings, and a convenience boolean.
 */
export function redactPii(text: string): RedactionResult {
  if (!text) return { redacted: text, piiFound: [], hadPii: false };

  interface RawMatch {
    type: string;
    original: string;
    replacement: string;
    start: number;
    end: number;
    confidence: number;
  }

  const raw: RawMatch[] = [];

  // Confidence ordering for overlap resolution (higher = preferred)
  const confidenceMap: Record<string, number> = {
    ssn: 0.95,
    credit_card: 0.9,
    email: 0.95,
    phone: 0.85,
    ip_address: 0.8,
    dob: 0.85,
    address: 0.75,
  };

  for (const pattern of REDACTION_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      const original = m[0];
      if (pattern.validate && !pattern.validate(original)) continue;
      raw.push({
        type: pattern.type,
        original,
        replacement: pattern.replacement,
        start: m.index,
        end: m.index + original.length,
        confidence: confidenceMap[pattern.type] ?? 0.5,
      });
    }
  }

  if (raw.length === 0) {
    return { redacted: text, piiFound: [], hadPii: false };
  }

  // Sort by position, then de-duplicate overlaps (keep higher confidence)
  raw.sort((a, b) => a.start - b.start);

  const deduped: RawMatch[] = [];
  for (const match of raw) {
    const last = deduped[deduped.length - 1];
    if (last && match.start < last.end) {
      if (match.confidence > last.confidence) {
        deduped[deduped.length - 1] = match;
      }
      continue;
    }
    deduped.push(match);
  }

  // Build findings list
  const piiFound: Piifinding[] = deduped.map((m) => ({
    type: m.type,
    original: m.original,
    replacement: m.replacement,
    index: m.start,
  }));

  // Replace from end to preserve indices
  const sorted = [...deduped].sort((a, b) => b.start - a.start);
  let redacted = text;
  for (const match of sorted) {
    redacted = redacted.slice(0, match.start) + match.replacement + redacted.slice(match.end);
  }

  return { redacted, piiFound, hadPii: true };
}
