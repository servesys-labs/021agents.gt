/**
 * IP allowlist middleware for the public agent API (/v1/*).
 *
 * Enforces the ip_allowlist column from the api_keys table.
 * Only applies to API key authenticated requests. If the allowlist
 * is empty or not configured, all IPs are allowed.
 *
 * Supports exact IP matching and CIDR range matching (e.g. 10.0.0.0/8).
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";

/**
 * Parse an IPv4 address into a 32-bit number.
 * Returns null for invalid or non-IPv4 addresses.
 */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  // Convert to unsigned 32-bit
  return result >>> 0;
}

/**
 * Check if an IP address falls within a CIDR range.
 * Example: isIpInCidr("10.0.1.5", "10.0.0.0/8") => true
 */
function isIpInCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipNum = parseIpv4(ip);
  const rangeNum = parseIpv4(rangeIp);
  if (ipNum === null || rangeNum === null) return false;

  if (prefix === 0) return true; // /0 matches everything

  // Create mask: e.g. prefix=24 => 0xFFFFFF00
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

/**
 * Check if an IP matches an allowlist entry (exact or CIDR).
 */
function ipMatchesEntry(ip: string, entry: string): boolean {
  if (entry.includes("/")) {
    return isIpInCidr(ip, entry);
  }
  return ip === entry;
}

/**
 * Extract the client IP from request headers.
 * Priority: CF-Connecting-IP > X-Forwarded-For (first) > X-Real-IP
 */
function getClientIp(req: { header: (name: string) => string | undefined; raw: Request }): string | null {
  const cfIp = req.header("CF-Connecting-IP");
  if (cfIp) return cfIp.trim();

  const xff = req.header("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = req.raw.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return null;
}

/**
 * IP allowlist middleware.
 * Only applies to /v1/* paths with API key authentication.
 */
export const ipAllowlistMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: CurrentUser };
}>(async (c, next) => {
  // Only enforce on public API routes
  if (!c.req.path.startsWith("/v1/")) return next();

  const user = c.get("user");

  // Enforce for API key auth and end-user tokens (inherit parent key restrictions)
  if (!user || (user.auth_method !== "api_key" && user.auth_method !== "end_user_token")) return next();

  // If no allowlist configured, allow all
  const allowlist = user.ipAllowlist;
  if (!allowlist || allowlist.length === 0) return next();

  const clientIp = getClientIp(c.req);
  if (!clientIp) {
    return c.json(
      { error: "Unable to determine client IP address. Request denied by IP allowlist policy." },
      403,
    );
  }

  const allowed = allowlist.some((entry) => ipMatchesEntry(clientIp, entry));
  if (!allowed) {
    return c.json(
      {
        error: "IP address not allowed",
        detail: `Your IP ${clientIp} is not in the allowlist for this API key. Contact your organization admin to update the IP allowlist.`,
      },
      403,
    );
  }

  return next();
});
