/**
 * Widget serving endpoint — serves the compiled chat widget JS bundle.
 *
 * GET /widget.js — returns the self-contained IIFE widget script
 * with aggressive caching headers for CDN/browser.
 *
 * The widget script is loaded from R2 storage (bucket: agentos-storage,
 * key: "widget/widget.js"). Falls back to a minimal stub if not found.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { ErrorSchema, errorResponses } from "../schemas/openapi";

type WidgetEnv = { Bindings: Env; Variables: { user: CurrentUser } };
export const widgetServeRoutes = new OpenAPIHono<WidgetEnv>();

// In-memory cache to avoid R2 reads on every request
let cachedWidget: { script: string; etag: string; ts: number } | null = null;
const CACHE_TTL = 300_000; // 5 min

// Fallback script when the real widget bundle isn't in R2 yet.
// The old version told end-user browsers to "Run: npx wrangler r2 object put ..."
// which leaked the internal bucket name and CLI instructions to anyone with the
// widget embedded on their site. Operators see the missing-bundle state via the
// worker's own error log, not via their customers' browser consoles.
const STUB_SCRIPT = `(function(){console.error("[OneShots Widget] Widget is temporarily unavailable. Please contact support if this persists.");})();`;

function widgetHeaders(etag: string, maxAge = 3600): Record<string, string> {
  return {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=86400`,
    "ETag": etag,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  };
}

// ── GET /widget.js — Serve widget JS bundle ─────────────────────────

const widgetJsRoute = createRoute({
  method: "get",
  path: "/widget.js",
  tags: ["Widget"],
  summary: "Serve the compiled chat widget JS bundle",
  responses: {
    200: {
      description: "Widget JavaScript bundle",
      content: { "application/javascript": { schema: z.string() } },
    },
    304: {
      description: "Not modified (ETag match)",
    },
    ...errorResponses(500),
  },
});

widgetServeRoutes.openapi(widgetJsRoute, async (c): Promise<any> => {
  const now = Date.now();

  // Check in-memory cache
  if (cachedWidget && (now - cachedWidget.ts) < CACHE_TTL) {
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === cachedWidget.etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(cachedWidget.script, {
      headers: widgetHeaders(cachedWidget.etag),
    });
  }

  // Load from R2
  try {
    const obj = await c.env.STORAGE.get("widget/widget.js");
    if (obj) {
      const script = await obj.text();
      const etag = `"w-${obj.uploaded?.getTime() || now}"`;
      cachedWidget = { script, etag, ts: now };

      const ifNoneMatch = c.req.header("If-None-Match");
      if (ifNoneMatch === etag) {
        return new Response(null, { status: 304 });
      }
      return new Response(script, {
        headers: widgetHeaders(etag),
      });
    }
  } catch {}

  // Fallback: serve stub. Log server-side so operators notice the missing
  // bundle — end users never see wrangler/bucket names in their console.
  console.error("[widget-serve] widget/widget.js missing from R2 STORAGE — serving fallback stub");
  return new Response(STUB_SCRIPT, {
    headers: widgetHeaders('"stub"', 60),
  });
});
