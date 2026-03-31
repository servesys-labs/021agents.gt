/**
 * Shared SSRF protection — validates URLs before any outbound request.
 *
 * Blocks:
 * - Private IP ranges (RFC 1918, RFC 4193, link-local)
 * - Loopback addresses (IPv4 and IPv6, all representations)
 * - Cloud metadata endpoints (AWS, GCP, Azure)
 * - Non-HTTP(S) protocols (file://, data://, javascript://)
 */

// ── Blocked IP patterns ─────────────────────────────────────────────

const BLOCKED_IP_RANGES = [
  // IPv4 private/reserved
  /^127\./,                          // loopback
  /^10\./,                           // private class A
  /^172\.(1[6-9]|2\d|3[01])\./,     // private class B
  /^192\.168\./,                     // private class C
  /^169\.254\./,                     // link-local / AWS metadata
  /^0\./,                            // unspecified
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT (RFC 6598)

  // IPv6 private/reserved (various representations)
  /^::1$/,                           // loopback literal
  /^\[::1\]$/,                       // loopback bracketed
  /^0:0:0:0:0:0:0:1$/,              // loopback expanded
  /^::ffff:127\./i,                  // IPv4-mapped loopback
  /^::ffff:10\./i,                   // IPv4-mapped private A
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,  // IPv4-mapped private B
  /^::ffff:192\.168\./i,             // IPv4-mapped private C
  /^::ffff:169\.254\./i,             // IPv4-mapped link-local
  /^fc00:/i,                         // unique local (RFC 4193)
  /^fd[0-9a-f]{2}:/i,               // unique local
  /^fe80:/i,                         // link-local
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.internal",
  "169.254.169.254",
  "metadata",
  "[::1]",
  "ip6-localhost",
  "ip6-loopback",
]);

// ── Allowed protocols ───────────────────────────────────────────────

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// ── Public API ──────────────────────────────────────────────────────

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a URL for SSRF safety.
 * Returns { valid: true } if the URL is safe to fetch.
 * Returns { valid: false, reason: "..." } if blocked.
 */
export function validateUrl(urlStr: string): UrlValidationResult {
  try {
    const url = new URL(urlStr);

    // Block non-HTTP(S) protocols
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return { valid: false, reason: `Blocked protocol: ${url.protocol}` };
    }

    // Normalize hostname (strip brackets for IPv6)
    const hostname = url.hostname.toLowerCase();

    // Block known dangerous hostnames
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return { valid: false, reason: `Blocked hostname: ${hostname}` };
    }

    // Block private/internal IP ranges
    // Test both raw hostname and de-bracketed version for IPv6
    const testHostname = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(testHostname) || pattern.test(hostname)) {
        return { valid: false, reason: `Blocked IP range: ${hostname}` };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: "Invalid URL" };
  }
}

/**
 * Check if a URL is blocked. Convenience wrapper around validateUrl.
 */
export function isBlockedUrl(urlStr: string): boolean {
  return !validateUrl(urlStr).valid;
}
