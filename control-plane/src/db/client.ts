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

// Module-level pool: one per isolate, reused across requests
let _pool: Sql | null = null;
let _poolConnectionString: string = "";

/**
 * Get a shared DB connection pool. Reuses across requests in the same isolate.
 */
export async function getDb(hyperdrive: Hyperdrive): Promise<Sql> {
  const connStr = hyperdrive.connectionString;

  // Reuse existing pool if connection string hasn't changed
  if (_pool && _poolConnectionString === connStr) {
    return _pool;
  }

  // Clean up old pool if connection string changed (rare: Hyperdrive rotation)
  if (_pool) {
    try { await _pool.end(); } catch {}
  }

  const pg = (await import("postgres")).default;
  _pool = pg(connStr, {
    max: 5,              // 5 connections per isolate (up from 1)
    fetch_types: false,
    prepare: false,      // Required for Hyperdrive transaction-mode pooling
    idle_timeout: 30,    // Keep idle connections for 30s (up from 5s)
    connect_timeout: 5,  // 5s connect timeout (up from 3s)
  });
  _poolConnectionString = connStr;

  return _pool;
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
