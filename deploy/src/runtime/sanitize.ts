/**
 * Input sanitization — defends against ASCII smuggling, hidden prompt injection,
 * and Unicode-based attacks.
 *
 * Inspired by Claude Code's multi-layer sanitization approach:
 * - NFKC normalization (canonicalizes visually identical chars)
 * - Strip dangerous Unicode categories (format controls, private use, tags)
 * - Iterative until stable (catches recursively nested attacks)
 */

// ── Dangerous Unicode ranges ────────────────────────────────────────
// These characters can be used for prompt injection via invisible text:
//   - Zero-width chars: hide instructions between visible text
//   - Directional overrides: reverse visible text to mask malicious content
//   - Tag characters (U+E0000–E007F): ASCII smuggling via Unicode tags
//   - Private use: custom glyphs that can encode hidden payloads
//   - Format controls: invisible joiners/non-joiners that alter text flow

const DANGEROUS_RANGES = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]|\uD800[\uDC00-\uDFFF]|\uDB40[\uDC00-\uDC7F]/g;

// Tag characters U+E0001–U+E007F (encoded as surrogate pairs in JS)
// U+E0000 = \uDB40\uDC00, U+E007F = \uDB40\uDC7F
const TAG_CHARS = /[\uDB40][\uDC00-\uDC7F]/g;

// Private Use Area: U+E000–U+F8FF (BMP) + Supplementary (U+F0000–U+FFFFF, U+100000–U+10FFFF)
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

// Format control characters (Cf category subset — the invisible ones)
const FORMAT_CONTROLS = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF0-\uFFF8]/g;

const MAX_ITERATIONS = 10;

/**
 * Sanitize a single string by normalizing and stripping dangerous Unicode.
 * Iterates until stable (max 10 passes) to catch nested attacks.
 */
export function sanitizeUnicode(text: string): string {
  if (!text || typeof text !== "string") return text;

  let current = text;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Step 1: NFKC normalization — canonicalizes visually similar chars
    let next = current.normalize("NFKC");

    // Step 2: Strip dangerous ranges
    next = next.replace(DANGEROUS_RANGES, "");
    next = next.replace(TAG_CHARS, "");
    next = next.replace(PRIVATE_USE, "");
    next = next.replace(FORMAT_CONTROLS, "");

    // Stable — no more changes
    if (next === current) return next;
    current = next;
  }

  return current;
}

/**
 * Recursively sanitize all strings in an object/array.
 * Handles nested structures (e.g., message history with content arrays).
 */
export function sanitizeDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeUnicode(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDeep);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeDeep(v);
    }
    return result;
  }
  return value;
}
