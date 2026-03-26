/**
 * Hyperdrive Postgres connection — same pattern as runtime worker.
 *
 * Creates a fresh connection per call. Hyperdrive handles server-side pooling.
 *
 * `getDbForOrg()` attempts to set RLS context but falls back gracefully
 * if the app schema or set_config function doesn't exist yet. This allows
 * the worker to function before RLS SQL has been applied to Supabase.
 */
import type postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

/**
 * Raw DB connection — no RLS context set.
 * Used by all routes (RLS context is set per-query when possible).
 */
export async function getDb(hyperdrive: Hyperdrive): Promise<Sql> {
  const pg = (await import("postgres")).default;
  return pg(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false, // Hyperdrive requires prepare:false (transaction-mode pooling)
    idle_timeout: 5,
    connect_timeout: 3,
  });
}

/**
 * Org-scoped DB connection.
 *
 * Returns a plain SQL connection (same as getDb). The RLS context setting
 * is attempted but non-fatal — if the app schema doesn't exist yet,
 * queries still work (they just don't have RLS enforcement at the Postgres level).
 *
 * All routes MUST still include `AND org_id = ${user.org_id}` in their WHERE clauses
 * as application-level tenant isolation (defense in depth).
 *
 * Once RLS SQL is applied to Supabase, `getDbForOrg` will provide double protection:
 * application-level WHERE clause + Postgres RLS policy.
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
