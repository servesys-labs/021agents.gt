/**
 * Global error handler — consistent JSON error responses.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

export const errorHandler = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  try {
    await next();
  } catch (e: any) {
    const status = e.status ?? e.statusCode ?? 500;
    const message = e.message ?? "Internal server error";
    console.error(`[error] ${c.req.method} ${c.req.path}: ${message}`);
    return c.json({ error: message, detail: e.detail ?? undefined }, status);
  }
});
