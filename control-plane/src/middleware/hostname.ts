/**
 * Hostname middleware — resolves org from hostname for custom domain support.
 *
 * For requests arriving on a custom domain (or *.agentos.dev subdomain),
 * looks up the org_id from the `custom_domains` table and injects it into
 * the Hono context so downstream routes scope to that org automatically.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { withAdminDb } from "../db/client";

// ---------------------------------------------------------------------------
// In-memory TTL cache: hostname -> { org_id, allowed_origins }
// ---------------------------------------------------------------------------
const CACHE_TTL = 300_000; // 5 minutes
const CACHE_MAX = 1024;

interface CacheEntry {
  ts: number;
  org_id: string;
  allowed_origins: string[] | null;
}

const hostnameCache = new Map<string, CacheEntry>();

function cacheGet(hostname: string): CacheEntry | null {
  const entry = hostnameCache.get(hostname);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    hostnameCache.delete(hostname);
    return null;
  }
  return entry;
}

function cachePut(hostname: string, org_id: string, allowed_origins: string[] | null): void {
  hostnameCache.set(hostname, { ts: Date.now(), org_id, allowed_origins });
  if (hostnameCache.size > CACHE_MAX) {
    // Evict oldest 25%
    const entries = [...hostnameCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = Math.floor(entries.length / 4);
    for (let i = 0; i < toRemove; i++) hostnameCache.delete(entries[i][0]);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAIN_DOMAIN = "api.oneshots.co";
const PLATFORM_SUFFIX = ".agentos.dev";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export const hostnameMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user: CurrentUser;
    resolved_org_id?: string;
    custom_domain?: string;
  };
}>(async (c, next) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;

  // Skip for the main control-plane domain — no custom domain resolution needed
  if (hostname === MAIN_DOMAIN || hostname === "localhost" || hostname === "127.0.0.1") {
    return next();
  }

  // Determine the lookup key:
  // - For *.agentos.dev subdomains, extract the subdomain portion
  // - For custom domains, use the full hostname
  let lookupHostname: string;

  if (hostname.endsWith(PLATFORM_SUFFIX)) {
    // e.g. "acme.agentos.dev" -> use full hostname for DB lookup
    const subdomain = hostname.slice(0, -PLATFORM_SUFFIX.length);
    if (!subdomain || subdomain.includes(".")) {
      // Bare "agentos.dev" or nested subdomain — pass through
      return next();
    }
    lookupHostname = hostname;
  } else {
    // Custom domain (e.g. "api.acme.com")
    lookupHostname = hostname;
  }

  // Check cache first
  const cached = cacheGet(lookupHostname);
  if (cached) {
    c.set("resolved_org_id", cached.org_id);
    c.set("custom_domain", lookupHostname);
    setCorsHeader(c, cached.allowed_origins);
    return next();
  }

  // Look up from custom_domains table. This runs BEFORE auth middleware,
  // so there is no user or org context yet — we have to use withAdminDb
  // to find out which org the incoming hostname belongs to.
  try {
    const row = await withAdminDb(c.env, async (sql) => {
      const rows = await sql`
        SELECT org_id FROM custom_domains
        WHERE hostname = ${lookupHostname} AND status = 'active'
        LIMIT 1
      `;
      return rows.length > 0 ? rows[0] : null;
    });

    if (!row) {
      // No matching custom domain — pass through (may be handled by auth normally)
      return next();
    }

    const orgId: string = row.org_id;
    const allowedOrigins: string[] | null = null;

    // Populate cache
    cachePut(lookupHostname, orgId, allowedOrigins);

    // Set context for downstream routes
    c.set("resolved_org_id", orgId);
    c.set("custom_domain", lookupHostname);
    setCorsHeader(c, allowedOrigins);
  } catch {
    // DB lookup failed — pass through without custom domain resolution.
    // Downstream auth will still enforce org scoping via the normal path.
  }

  return next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOrigins(raw: unknown): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function setCorsHeader(c: { header: (name: string, value: string) => void; req: { header: (name: string) => string | undefined } }, allowedOrigins: string[] | null): void {
  if (!allowedOrigins || allowedOrigins.length === 0) return;

  const requestOrigin = c.req.header("Origin");
  if (!requestOrigin) return;

  // Check if the request origin is in the allowed list
  if (allowedOrigins.includes("*") || allowedOrigins.includes(requestOrigin)) {
    c.header("Access-Control-Allow-Origin", requestOrigin);
  }
}
