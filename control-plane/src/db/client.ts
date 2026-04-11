/**
 * Hyperdrive Postgres client — org-scoped and admin-scoped entrypoints.
 *
 * Two public functions, branded types, nothing else exported:
 *
 *   withOrgDb(env, orgId, async (sql) => { ... })
 *     — opens a transaction, sets app.current_org_id = orgId, then runs
 *       the callback. RLS policies enforce isolation. The OrgSql type
 *       brand means you cannot accidentally pass an admin connection to
 *       an org-scoped helper or vice versa.
 *
 *   withAdminDb(env, async (sql) => { ... })
 *     — connects via HYPERDRIVE_ADMIN (a role granted BYPASSRLS) for
 *       cross-org queries: admin dashboards, marketplace discovery,
 *       background workers iterating across tenants, webhook dispatch,
 *       and auth bootstrap (signup/login). Grep-ping for withAdminDb
 *       produces a complete audit of cross-org code paths.
 *
 * The module-level `postgres` import and any raw connection factories
 * are PRIVATE. Callers MUST go through withOrgDb or withAdminDb.
 */
import type { Env } from "../env";
import type postgres from "postgres";

// Raw postgres.js Sql type — kept private to this module. Helpers in
// src/logic/* that accept `sql` as a parameter should type it as OrgSql
// or AdminSql to make the caller's scoping intent part of the signature.
// If a helper is genuinely scope-agnostic (e.g. it only reads global
// tables or takes an already-scoped connection from either side), it can
// import the `Sql` alias below — structurally a supertype of both brands.
type RawSql = ReturnType<typeof postgres>;

/**
 * Scope-agnostic connection type. Accepts both OrgSql and AdminSql.
 * Use sparingly — helpers that can run under either scope lose the
 * TypeScript audit signal that `withAdminDb` grepping provides.
 */
export type Sql = RawSql;

// Branded types. The unique symbol brands are never constructed at runtime;
// they exist only in the type system so OrgSql and AdminSql are
// structurally distinct and callers cannot mix them by mistake.
declare const orgBrand: unique symbol;
declare const adminBrand: unique symbol;

export type OrgSql = RawSql & { readonly [orgBrand]: true };
export type AdminSql = RawSql & { readonly [adminBrand]: true };

/** Connection for an org-scoped query path (RLS enforced). */
async function openConnection(hyperdrive: Hyperdrive): Promise<RawSql> {
  const pg = (await import("postgres")).default;
  return pg(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false, // Hyperdrive transaction-mode pooling requires this
    connect_timeout: 5,
  });
}

/**
 * Run a callback inside an org-scoped transaction.
 *
 * The transaction sets `app.current_org_id = orgId` via `set_config(..., true)`
 * so every query inside the callback passes RLS `current_org_id()` checks.
 * The transaction commits on callback return, rolls back on throw.
 *
 * Throws TypeError if orgId is empty — fail closed rather than silently
 * running queries against `org_id = ''`.
 */
export async function withOrgDb<T>(
  env: Pick<Env, "HYPERDRIVE">,
  orgId: string,
  fn: (sql: OrgSql) => Promise<T>,
): Promise<T> {
  if (!orgId || typeof orgId !== "string") {
    throw new TypeError("withOrgDb: orgId is required and must be a non-empty string");
  }
  const sql = await openConnection(env.HYPERDRIVE);
  return (await sql.begin(async (tx) => {
    // postgres.js's TransactionSql interface uses Omit on the parent Sql
    // interface, which TypeScript strips of its tagged-template call
    // signatures. Cast back to RawSql to regain them — tx IS a tagged
    // template at runtime, the cast is only a type-system fix.
    const txSql = tx as unknown as RawSql;
    // Transaction-local GUC. Cleared automatically on COMMIT/ROLLBACK,
    // which is safe under Hyperdrive's transaction-mode pooling.
    await txSql`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return await fn(txSql as OrgSql);
  })) as T;
}

/**
 * Run a callback against an admin connection that bypasses RLS.
 *
 * Use only for:
 *   - Admin dashboards that aggregate across orgs
 *   - Marketplace discovery / public feed queries
 *   - Webhook dispatch before the org context is known
 *   - Auth bootstrap (signup creates the first org, login resolves to orgs)
 *   - Background workers that iterate across tenants — follow with
 *     withOrgDb() once per tenant to do the actual per-org work
 *
 * HYPERDRIVE_ADMIN is a separate binding in wrangler. In prototype mode it
 * may point to the same connection string as HYPERDRIVE (a superuser role
 * that bypasses RLS by default). In production it should point to a role
 * granted BYPASSRLS explicitly, so admin access is auditable at the
 * database level rather than only at the TypeScript brand level.
 */
export async function withAdminDb<T>(
  env: Pick<Env, "HYPERDRIVE_ADMIN">,
  fn: (sql: AdminSql) => Promise<T>,
): Promise<T> {
  const sql = await openConnection(env.HYPERDRIVE_ADMIN);
  return (await sql.begin(async (tx) => {
    const txSql = tx as unknown as RawSql;
    return await fn(txSql as AdminSql);
  })) as T;
}
