/**
 * API access audit log middleware for the public agent API (/v1/*).
 *
 * Logs every API request to the api_access_log table in a fire-and-forget
 * manner using waitUntil so it does not block the response.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { withOrgDb, withAdminDb } from "../db/client";

/**
 * Extract the agent name from a /v1/agents/:name/... path.
 */
function extractAgentName(path: string): string | null {
  const match = path.match(/^\/v1\/agents\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Extract the client IP from request headers.
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
 * Generate a simple request ID (UUID v4 using Web Crypto).
 */
function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * API audit log middleware.
 * Only logs /v1/* paths. Uses fire-and-forget DB insert.
 */
export const apiAuditLogMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: CurrentUser };
}>(async (c, next) => {
  // Only log public API routes
  if (!c.req.path.startsWith("/v1/")) return next();

  const start = Date.now();
  const requestId = c.req.header("X-Request-ID") || generateRequestId();

  // Set request ID header for tracing
  c.header("X-Request-ID", requestId);

  await next();

  const latencyMs = Date.now() - start;
  const user = c.get("user");

  // Build the log entry
  const logEntry = {
    request_id: requestId,
    org_id: user?.org_id || null,
    api_key_id: user?.auth_method === "api_key" ? (user.apiKeyId || user.user_id) : null,
    end_user_id: null as string | null,
    method: c.req.method,
    path: c.req.path,
    agent_name: extractAgentName(c.req.path),
    status_code: c.res.status,
    latency_ms: latencyMs,
    ip_address: getClientIp(c.req),
    user_agent: c.req.header("User-Agent") || null,
    idempotency_key: null as string | null,
  };

  // Try to extract end_user_id and idempotency_key from request body (best-effort).
  // Only attempt for methods that typically have bodies.
  if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
    try {
      // Clone the request body from stored data if available
      const bodyText = await c.req.text().catch(() => "");
      if (bodyText) {
        const body = JSON.parse(bodyText);
        if (body.end_user_id) logEntry.end_user_id = String(body.end_user_id);
        if (body.idempotency_key) logEntry.idempotency_key = String(body.idempotency_key);
      }
    } catch {
      // Body parsing is best-effort
    }
  }

  // Fire-and-forget insert using waitUntil if available. If we have a
  // resolved org use withOrgDb (audit row belongs to that tenant under
  // RLS). If not (unauthenticated 401 path, for example), fall back to
  // withAdminDb so the audit still lands.
  const insertLog = async () => {
    const writer = async (sql: any) => {
      await sql`
        INSERT INTO api_access_log (
          request_id, org_id, api_key_id, end_user_id,
          method, path, agent_name, status_code,
          latency_ms, ip_address, user_agent, idempotency_key
        ) VALUES (
          ${logEntry.request_id},
          ${logEntry.org_id},
          ${logEntry.api_key_id},
          ${logEntry.end_user_id},
          ${logEntry.method},
          ${logEntry.path},
          ${logEntry.agent_name},
          ${logEntry.status_code},
          ${logEntry.latency_ms},
          ${logEntry.ip_address},
          ${logEntry.user_agent},
          ${logEntry.idempotency_key}
        )
      `;
    };
    try {
      if (logEntry.org_id) {
        await withOrgDb(c.env, logEntry.org_id, writer);
      } else {
        await withAdminDb(c.env, writer);
      }
    } catch {
      // Audit logging is fire-and-forget — never fail the request
    }
  };

  // Hono's `c.executionCtx` getter THROWS when no ExecutionContext is
  // available (tests, non-Workers runtimes), so `?.` optional chaining does
  // NOT short-circuit here — we must try/catch. In production Workers
  // runtime, waitUntil keeps the isolate alive until the log lands.
  try {
    c.executionCtx.waitUntil(insertLog());
  } catch {
    insertLog().catch(() => {});
  }
});
