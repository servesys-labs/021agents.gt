/**
 * Domains router — custom domain management per org.
 * Supports auto-provisioned subdomains ({slug}.agentos.dev) and custom CNAME domains.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

export const domainRoutes = createOpenAPIRouter();

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const DomainSummary = z.object({
  id: z.string(),
  hostname: z.string(),
  type: z.string(),
  status: z.string(),
  ssl_status: z.string(),
  verified_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
});

// ── GET / — list all custom domains for the org ─────────────────────────

const listDomainsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Domains"],
  summary: "List all custom domains for the org",
  middleware: [requireScope("domains:read")],
  responses: {
    200: {
      description: "Domain list",
      content: { "application/json": { schema: z.object({ domains: z.array(DomainSummary) }) } },
    },
    ...errorResponses(401, 500),
  },
});
domainRoutes.openapi(listDomainsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT id, hostname, type, status, ssl_status, verified_at, created_at, updated_at
    FROM custom_domains
    WHERE org_id = ${user.org_id}
    ORDER BY created_at DESC
  `;

  return c.json({ domains: rows });
});

// ── POST / — add a custom domain ────────────────────────────────────────

const addDomainRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Domains"],
  summary: "Add a custom domain or auto-provision a subdomain",
  middleware: [requireScope("domains:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            type: z.enum(["subdomain", "custom"]).default("subdomain"),
            hostname: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Domain created",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            hostname: z.string(),
            type: z.string(),
            status: z.string(),
            ssl_status: z.string(),
            created_at: z.string(),
          }),
        },
      },
    },
    ...errorResponses(400, 401, 404, 409, 500),
  },
});
domainRoutes.openapi(addDomainRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const type = String(body.type || "subdomain");

  if (!["subdomain", "custom"].includes(type)) {
    return c.json({ error: "type must be 'subdomain' or 'custom'" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  let hostname: string;

  if (type === "subdomain") {
    // Auto-generate from org slug
    const orgRows = await sql`
      SELECT slug, subdomain FROM orgs WHERE org_id = ${user.org_id} LIMIT 1
    `;
    if (orgRows.length === 0) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // If org already has a subdomain assigned, reuse it
    if (orgRows[0].subdomain) {
      return c.json({ error: "Organization already has a subdomain assigned", existing: orgRows[0].subdomain }, 409);
    }

    const slug = String(orgRows[0].slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!slug) {
      return c.json({ error: "Organization slug is missing or invalid" }, 400);
    }

    hostname = `${slug}.agentos.dev`;
  } else {
    // Custom CNAME — require and validate hostname
    hostname = String(body.hostname || "").trim().toLowerCase();
    if (!hostname) {
      return c.json({ error: "hostname is required for custom domains" }, 400);
    }
    if (!DOMAIN_RE.test(hostname)) {
      return c.json({ error: "Invalid hostname format" }, 400);
    }
  }

  // Check for duplicate hostname
  const existing = await sql`
    SELECT id FROM custom_domains WHERE hostname = ${hostname} LIMIT 1
  `;
  if (existing.length > 0) {
    return c.json({ error: "Hostname already in use" }, 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO custom_domains (id, org_id, hostname, type, status, ssl_status, created_at, updated_at)
    VALUES (${id}, ${user.org_id}, ${hostname}, ${type}, 'pending', 'pending', ${now}, ${now})
  `;

  // For subdomains, also store on the orgs row
  if (type === "subdomain") {
    await sql`
      UPDATE orgs SET subdomain = ${hostname}, updated_at = ${now} WHERE org_id = ${user.org_id}
    `;
  }

  return c.json({
    id,
    hostname,
    type,
    status: "pending",
    ssl_status: "pending",
    created_at: now,
  }, 201);
});

// ── GET /:domain_id — get domain details ────────────────────────────────

const getDomainRoute = createRoute({
  method: "get",
  path: "/{domain_id}",
  tags: ["Domains"],
  summary: "Get domain details",
  middleware: [requireScope("domains:read")],
  request: {
    params: z.object({ domain_id: z.string() }),
  },
  responses: {
    200: {
      description: "Domain details",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(401, 404, 500),
  },
});
domainRoutes.openapi(getDomainRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { domain_id: domainId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT id, org_id, hostname, type, status, ssl_status,
           cf_custom_hostname_id, verified_at, created_at, updated_at
    FROM custom_domains
    WHERE id = ${domainId} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: "Domain not found" }, 404);
  }

  return c.json(rows[0]);
});

// ── DELETE /:domain_id — remove a custom domain ─────────────────────────

const deleteDomainRoute = createRoute({
  method: "delete",
  path: "/{domain_id}",
  tags: ["Domains"],
  summary: "Remove a custom domain",
  middleware: [requireScope("domains:write")],
  request: {
    params: z.object({ domain_id: z.string() }),
  },
  responses: {
    200: {
      description: "Domain deleted",
      content: { "application/json": { schema: z.object({ deleted: z.string() }) } },
    },
    ...errorResponses(401, 404, 500),
  },
});
domainRoutes.openapi(deleteDomainRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { domain_id: domainId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT id, hostname, type FROM custom_domains
    WHERE id = ${domainId} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: "Domain not found" }, 404);
  }

  const now = new Date().toISOString();

  await sql`
    UPDATE custom_domains
    SET status = 'removed', updated_at = ${now}
    WHERE id = ${domainId} AND org_id = ${user.org_id}
  `;

  // Clear subdomain on org if this was the subdomain entry
  if (rows[0].type === "subdomain") {
    await sql`
      UPDATE orgs SET subdomain = NULL, updated_at = ${now}
      WHERE org_id = ${user.org_id} AND subdomain = ${rows[0].hostname}
    `;
  }

  return c.json({ deleted: domainId });
});

// ── POST /:domain_id/verify — check DNS/SSL status ─────────────────────

const verifyDomainRoute = createRoute({
  method: "post",
  path: "/{domain_id}/verify",
  tags: ["Domains"],
  summary: "Verify domain DNS and SSL status",
  middleware: [requireScope("domains:write")],
  request: {
    params: z.object({ domain_id: z.string() }),
  },
  responses: {
    200: {
      description: "Verification result",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            hostname: z.string(),
            status: z.string(),
            ssl_status: z.string(),
            dns_valid: z.boolean().optional(),
            verified_at: z.string().nullable().optional(),
            cname_target: z.string().optional(),
          }),
        },
      },
    },
    ...errorResponses(401, 404, 500),
  },
});
domainRoutes.openapi(verifyDomainRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { domain_id: domainId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT id, hostname, type, status, ssl_status, cf_custom_hostname_id
    FROM custom_domains
    WHERE id = ${domainId} AND org_id = ${user.org_id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: "Domain not found" }, 404);
  }

  const domain = rows[0];
  const now = new Date().toISOString();

  // For subdomains under *.agentos.dev — auto-verify since we control the zone
  if (domain.type === "subdomain") {
    await sql`
      UPDATE custom_domains
      SET status = 'active', ssl_status = 'active', verified_at = ${now}, updated_at = ${now}
      WHERE id = ${domainId}
    `;
    return c.json({
      id: domainId,
      hostname: domain.hostname,
      status: "active",
      ssl_status: "active",
      verified_at: now,
    });
  }

  // For custom domains — perform DNS lookup to check CNAME target
  let dnsValid = false;
  try {
    const resp = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(String(domain.hostname))}&type=CNAME`,
      { headers: { Accept: "application/dns-json" } },
    );
    if (resp.ok) {
      const data: any = await resp.json();
      const answers: any[] = data.Answer || [];
      dnsValid = answers.some(
        (a: any) => a.type === 5 && String(a.data).replace(/\.$/, "").endsWith(".agentos.dev"),
      );
    }
  } catch {
    // DNS lookup failed — leave dnsValid false
  }

  const newStatus = dnsValid ? "active" : "pending";
  const newSslStatus = dnsValid ? "active" : "pending";
  const verifiedAt = dnsValid ? now : null;

  await sql`
    UPDATE custom_domains
    SET status = ${newStatus}, ssl_status = ${newSslStatus},
        verified_at = ${verifiedAt}, updated_at = ${now}
    WHERE id = ${domainId}
  `;

  return c.json({
    id: domainId,
    hostname: domain.hostname,
    status: newStatus,
    ssl_status: newSslStatus,
    dns_valid: dnsValid,
    verified_at: verifiedAt,
    cname_target: "proxy.agentos.dev",
  });
});
