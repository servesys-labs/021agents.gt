/**
 * OpenAPI app factory — creates the OpenAPIHono instance used by all routes.
 *
 * Import `createOpenAPIRouter` in each route file instead of `new Hono<R>()`.
 * The main app in index.ts uses `createApp()`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";

export type AppType = {
  Bindings: Env;
  Variables: { user: CurrentUser };
};

/** Create the root OpenAPIHono app (used in index.ts). */
export function createApp() {
  return new OpenAPIHono<AppType>();
}

/** Create a sub-router with OpenAPI support (used in route files). */
export function createOpenAPIRouter() {
  return new OpenAPIHono<AppType>();
}
