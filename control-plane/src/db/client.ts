/**
 * Hyperdrive Postgres connection — same pattern as runtime worker.
 *
 * Creates a fresh connection per call. Hyperdrive handles server-side pooling.
 *
 * With Supabase RLS enabled + FORCE ROW LEVEL SECURITY, every query must
 * run inside a transaction that first calls:
 *   set_config('app.current_org_id', orgId, true)
 *
 * Use `getDbForOrg()` for all org-scoped queries (the common case).
 * Use `getDb()` only for system-level queries that don't need org context
 * (health checks, cron jobs, etc.).
 */
import type postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

/**
 * Raw DB connection — no RLS context set.
 * Use only for system-level operations (cron, health, migrations).
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
 * Org-scoped DB query runner with RLS context.
 *
 * Sets `app.current_org_id` in a transaction before executing queries,
 * so Supabase RLS policies filter rows automatically.
 *
 * Usage:
 * ```ts
 * const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
 * const rows = await sql`SELECT * FROM agents WHERE is_active = true`;
 * ```
 *
 * Each call to `sql\`...\`` opens a transaction, sets context, runs the
 * query, and commits. This is safe with Hyperdrive's transaction-mode pooling.
 */
export async function getDbForOrg(
  hyperdrive: Hyperdrive,
  orgId: string,
  opts?: { userId?: string; role?: string },
): Promise<Sql> {
  const pg = (await import("postgres")).default;
  const sql = pg(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 3,
  });

  async function setRlsContext(tx: any): Promise<void> {
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    if (opts?.userId) {
      await tx`SELECT set_config('app.current_user_id', ${opts.userId}, true)`;
    }
    if (opts?.role) {
      await tx`SELECT set_config('app.current_role', ${opts.role}, true)`;
    }
  }

  // Return a proxy that wraps every tagged template call in a transaction
  // with set_config for RLS context.
  return new Proxy(sql, {
    apply(_target, _thisArg, args) {
      // Tagged template call: sql`SELECT ...`
      return sql.begin(async (tx: any) => {
        await setRlsContext(tx);
        return tx(...args);
      });
    },
    get(target, prop, receiver) {
      if (prop === "begin") {
        // Wrap .begin() to auto-set context before user callback
        return async (fn: (tx: any) => Promise<unknown>) => {
          return sql.begin(async (tx: any) => {
            await setRlsContext(tx);
            return fn(tx);
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Sql;
}
