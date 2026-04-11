/**
 * Public-route detection: routes that bypass JWT/API-key auth entirely.
 *
 * Each matcher answers a single question so the orchestrator can
 * compose them without re-deriving URL parsing logic. Webhook routes
 * are unauthenticated at the middleware layer because they verify
 * provider-specific signatures in-route.
 */

const PUBLIC_PATHS = new Set([
  "/health",
  "/health/detailed",
  "/api/v1/health",
  "/api/v1/health/detailed",
  "/api/v1/auth/login",
  "/api/v1/auth/signup",
  "/api/v1/auth/providers",
  "/api/v1/config",
  "/v1/health",
  "/v1/openapi.json",
  "/v1/docs",
  "/api/v1/openapi.json",
  "/api/v1/_openapi-raw.json",
  "/api/v1/docs",
  "/widget.js",
]);

/** Plans list + detail are public reads; POST /api/v1/plans requires auth. */
export function isPublicPlansRead(path: string, method: string): boolean {
  if (method === "POST") return false;
  return path === "/api/v1/plans" || path.startsWith("/api/v1/plans/");
}

/** Public marketplace / discovery endpoints. */
export function isPublicDiscovery(path: string, method: string): boolean {
  if (method !== "GET") return false;
  return (
    path === "/api/v1/marketplace/search" ||
    path.startsWith("/api/v1/marketplace/listings/") ||
    path === "/api/v1/feed" ||
    path === "/api/v1/feed/stats" ||
    path === "/.well-known/agent.json" ||
    path === "/.well-known/agents.json"
  );
}

/** Unauthenticated voice provider webhooks (signature verified in-route). */
export function isPublicVoiceWebhook(path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (path === "/api/v1/voice/vapi/webhook") return true;
  if (path === "/api/v1/voice/twilio/incoming") return true;
  const m = path.match(/^\/api\/v1\/voice\/([a-z0-9_-]+)\/webhook$/);
  if (!m) return false;
  return m[1] === "tavus";
}

/** Unauthenticated external webhooks (verified in-route). */
export function isPublicExternalWebhook(path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (path === "/api/v1/chat/telegram/webhook") return true;
  if (path === "/api/v1/stripe/webhook") return true;
  if (path === "/api/v1/github/webhooks/receive") return true;
  return false;
}

/**
 * True if the request should bypass auth entirely.
 * Does NOT cover service-token auth — that's handled separately
 * because it still produces a synthetic user record.
 */
export function isPublicRequest(path: string, method: string): boolean {
  return (
    PUBLIC_PATHS.has(path) ||
    path.startsWith("/api/v1/auth/") ||
    isPublicPlansRead(path, method) ||
    isPublicDiscovery(path, method) ||
    isPublicVoiceWebhook(path, method) ||
    isPublicExternalWebhook(path, method)
  );
}
