/**
 * Security response headers middleware.
 * Adds HSTS, anti-clickjacking, XSS protection, and CSP headers to all responses.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

export const securityHeadersMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  await next();

  // HSTS: enforce HTTPS for 1 year, include subdomains
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

  // Prevent MIME sniffing
  c.header("X-Content-Type-Options", "nosniff");

  // Clickjacking protection
  c.header("X-Frame-Options", "DENY");

  // XSS protection (legacy, but still useful)
  c.header("X-XSS-Protection", "1; mode=block");

  // Referrer policy
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions policy (disable unnecessary browser features)
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  // CSP for API responses (restrictive)
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/v1/")) {
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }
});
