/**
 * Global error handler — consistent JSON error responses.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

export const errorHandler = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  try {
    await next();
  } catch (e: any) {
    // JSON parse errors from invalid Content-Type should be 400, not 500
    if (e instanceof SyntaxError || e.message?.includes("Unexpected token") || e.message?.includes("JSON")) {
      return c.json({ error: "Malformed JSON in request body" }, 400);
    }
    const status = e.status ?? e.statusCode ?? 500;
    const message = e.message ?? "Internal server error";
    console.error(`[error] ${c.req.method} ${c.req.path}: ${message}`);
    return c.json({ error: message, detail: e.detail ?? undefined }, status);
  }
});
