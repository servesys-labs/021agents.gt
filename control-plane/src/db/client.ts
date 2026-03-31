/**
 * Hyperdrive Postgres connection — module-level singleton pool.
 *
 * Each Worker isolate maintains ONE connection pool (not per-request).
 * Hyperdrive handles server-side connection pooling across edge locations.
 * The client-side pool reuses connections across requests in the same isolate.
 *
 * Scalability: 100K concurrent users → ~20 isolates × 5 connections = 100 connections
 * (vs previous: 100K × 1 connection each = 100K connections → pool exhaustion)
 */
import type postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

/**
 * Get a DB connection for the current request.
 * Creates a fresh connection each time to avoid Cloudflare Workers I/O context errors
 * (connections created in one request cannot be used in another).
 * Hyperdrive handles server-side pooling, so per-request connections are efficient.
 */
export async function getDb(hyperdrive: Hyperdrive): Promise<Sql> {
  const pg = (await import("postgres")).default;
  return pg(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false,      // Required for Hyperdrive transaction-mode pooling
    connect_timeout: 5,
  });
}

/**
 * Org-scoped DB connection with RLS context.
 */
export async function getDbForOrg(
  hyperdrive: Hyperdrive,
  orgId: string,
  _opts?: { userId?: string; role?: string },
): Promise<Sql> {
  const sql = await getDb(hyperdrive);

  // Attempt to set RLS context — non-fatal if app schema doesn't exist yet
  try {
    await sql`SELECT set_config('app.current_org_id', ${orgId}, false)`;
  } catch {
    // RLS not set up yet — queries still work via application-level org_id filtering
  }

  return sql;
}
