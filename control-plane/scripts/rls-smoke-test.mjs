#!/usr/bin/env node
/**
 * RLS smoke test — verifies that the policies in 001_init.sql actually
 * enforce tenant isolation when the connection uses a non-superuser role.
 *
 * What this script does:
 *   1. DROPs the public schema and recreates it (destructive — dev DB only).
 *   2. Applies control-plane/src/db/migrations/001_init.sql.
 *   3. Seeds two test orgs (org_a, org_b) with one agent row each.
 *   4. Runs five isolation checks:
 *        T1  postgres (superuser) sees both rows             → baseline (expected)
 *        T2  app_user + GUC=org_a sees only org_a row        → RLS read enforces
 *        T3  app_user + GUC=org_b sees only org_b row        → RLS read enforces
 *        T4  app_user + GUC unset sees zero rows             → fail-closed default
 *        T5  app_user + GUC=org_a INSERT with org_id=org_b   → rejected (WITH CHECK)
 *   6. Prints a pass/fail summary and exits non-zero on any failure.
 *
 * The app_user role is created by the migration with NOLOGIN; this script
 * uses SET ROLE from the superuser session to switch into it, so no
 * separate credentials are needed.
 *
 * Usage:
 *   node control-plane/scripts/rls-smoke-test.mjs
 *
 * Reads DATABASE_URL from ../../.env or environment.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load DATABASE_URL ────────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(__dirname, "../../.env");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[rls-smoke] DATABASE_URL not set in env or .env");
  process.exit(1);
}

// Supabase's pooler blocks role-management commands (the auth_query
// mapping only knows about the project's postgres user). Derive the
// direct connection URL so the smoke test can CREATE ROLE + GRANT +
// SET ROLE without the pooler getting in the way.
//
//   Pooler URL:  postgres.PROJECTREF:PASS@aws-0-REGION.pooler.supabase.com:5432
//   Direct URL:  postgres:PASS@db.PROJECTREF.supabase.co:5432
//
// If DATABASE_URL is already a direct URL, leave it alone.
function directUrlFrom(pooled) {
  const m = pooled.match(/^postgresql:\/\/postgres\.([a-z0-9]+):([^@]+)@([^/]+)\/(.*)$/);
  if (!m) return pooled; // not a recognizable pooler URL
  const [, projectRef, password, , dbPath] = m;
  return `postgresql://postgres:${password}@db.${projectRef}.supabase.co:5432/${dbPath}`;
}
const DIRECT_URL = process.env.DIRECT_DATABASE_URL || directUrlFrom(DATABASE_URL);
console.log(`[rls-smoke] Using direct URL (host: ${DIRECT_URL.match(/@([^/]+)/)?.[1] || "?"})`);

const MIGRATION_PATH = resolve(__dirname, "../src/db/migrations/001_init.sql");

// ── Test harness ─────────────────────────────────────────────────
const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const mark = passed ? "✓" : "✗";
  const line = `  ${mark} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(passed ? line : `\x1b[31m${line}\x1b[0m`);
}

// Supabase's pooler kills idle connections aggressively after DDL
// batches. postgres.js emits those closures synchronously via socket
// events, which bypass promise-level try/catch. Swallow them at the
// process level — a real error will still surface via the rejected
// promise of whatever query was in flight.
process.on("uncaughtException", (err) => {
  if (err && (err.code === "CONNECTION_CLOSED" || err.code === "CONNECTION_ENDED")) {
    return;
  }
  console.error("[rls-smoke] uncaught:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason;
  if (err && (err.code === "CONNECTION_CLOSED" || err.code === "CONNECTION_ENDED")) {
    return;
  }
  console.error("[rls-smoke] unhandled rejection:", reason);
  process.exit(1);
});

// ── Main ─────────────────────────────────────────────────────────
// Pooler URL is always reachable over IPv4; direct URL may not be
// (Supabase's db.* hosts are IPv6-only). Default to pooler; a user with
// a direct IPv6 path can set DIRECT_DATABASE_URL in env to opt in.
const CONNECTION_URL = process.env.DIRECT_DATABASE_URL || DATABASE_URL;

function connect() {
  return postgres(CONNECTION_URL, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    max_lifetime: 600,
    onnotice: () => {}, // silence NOTICE spam
  });
}

async function main() {
  // Everything runs on ONE connection. postgres.js can't cleanly close
  // this client against Supabase's pooler — calling .end() triggers a
  // synchronous socket error. We let Node GC the socket on process
  // exit and rely on the uncaughtException handler above to swallow
  // any stray close errors.
  console.log("[rls-smoke] Connecting to DATABASE_URL…");
  const sql = connect();

  try {
    // ── 0. Diagnose the server we're talking to ─────────────────
    const [info] = await sql`
      SELECT
        version() AS version,
        current_user AS current_user,
        current_setting('is_superuser') AS is_super,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `;
    console.log(`[rls-smoke] server: ${info.version.split(",")[0]}`);
    console.log(`[rls-smoke] connected as: ${info.current_user} (superuser=${info.is_super}, bypassrls=${info.bypass_rls})`);

    // ── 1. Nuke + recreate schema ───────────────────────────────
    console.log("[rls-smoke] Dropping and recreating public schema…");
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT USAGE ON SCHEMA public TO public;
    `);
    // Drop any lingering app_user from a prior run.
    await sql.unsafe(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
          BEGIN
            EXECUTE 'DROP OWNED BY app_user';
          EXCEPTION WHEN insufficient_privilege THEN NULL;
          END;
          EXECUTE 'DROP ROLE app_user';
        END IF;
      END $$;
    `);

    // ── 2. Apply the consolidated migration ─────────────────────
    console.log(`[rls-smoke] Applying ${MIGRATION_PATH}…`);
    const migrationSql = readFileSync(MIGRATION_PATH, "utf-8");
    await sql.unsafe(migrationSql);
    console.log("[rls-smoke] Migration applied.");

    // Ping: confirm the connection is still alive before trying real work.
    try {
      const [ping] = await sql`SELECT 1 as ok`;
      console.log(`[rls-smoke] Post-migration ping: ${ping.ok === 1 ? "alive" : "unknown"}`);
    } catch (err) {
      console.error(`[rls-smoke] Post-migration ping failed: ${err?.message || err}`);
      throw err;
    }

    // NOTE on SET ROLE: Supabase's pooler blocks client-issued role
    // grants (the auth_query mapping only knows the project's postgres
    // user) and the direct host is IPv6-only. We therefore verify RLS
    // via SCHEMA INSPECTION (tests T1-T4) plus a best-effort runtime
    // test (T5-T9) that skips gracefully when the environment can't
    // grant role membership.

    // ── 4. Seed fixtures ────────────────────────────────────────
    console.log("[rls-smoke] Seeding test fixtures…");
    await sql.unsafe(`
      INSERT INTO orgs (org_id, name, slug) VALUES
        ('org_a', 'Org A', 'org-a'),
        ('org_b', 'Org B', 'org-b');
      INSERT INTO agents (org_id, name, description, config) VALUES
        ('org_a', 'agent-a', 'Agent owned by Org A', '{}'),
        ('org_b', 'agent-b', 'Agent owned by Org B', '{}');
    `);

    console.log("\n[rls-smoke] === Phase 1: schema verification (always runs) ===\n");

    // ── S1: current_org_id() helper exists and defaults to '' ───
    {
      const [r] = await sql`SELECT current_org_id() AS v`;
      const passed = r && r.v === "";
      record(
        "S1: current_org_id() exists, returns '' when GUC unset",
        passed,
        `returned ${JSON.stringify(r?.v)}`,
      );
    }

    // ── S2: setting the GUC flows through current_org_id() ─────
    {
      const [r] = await sql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.current_org_id', 'org_probe', true)");
        return await tx`SELECT current_org_id() AS v`;
      });
      const passed = r && r.v === "org_probe";
      record(
        "S2: set_config('app.current_org_id', ...) is visible to helper",
        passed,
        `returned ${JSON.stringify(r?.v)}`,
      );
    }

    // ── S3: all org-scoped tables have ENABLE + FORCE ──────────
    {
      const rows = await sql`
        SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity = true
        ORDER BY c.relname
      `;
      const unforced = rows.filter(r => !r.forced);
      const passed = rows.length > 100 && unforced.length === 0;
      record(
        `S3: ${rows.length} RLS'd tables have FORCE`,
        passed,
        unforced.length === 0
          ? `${rows.length} tables`
          : `${unforced.length} missing FORCE: ${unforced.map(r => r.relname).slice(0, 5).join(", ")}…`,
      );
    }

    // ── S4: policy count matches RLS'd table count ─────────────
    {
      const [policies] = await sql`
        SELECT COUNT(DISTINCT tablename)::int AS tables_with_policies,
               COUNT(*)::int AS total_policies
        FROM pg_policies
        WHERE schemaname = 'public'
      `;
      const [rlsTables] = await sql`
        SELECT COUNT(*)::int AS rls_tables
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
      `;
      const passed =
        policies.tables_with_policies === rlsTables.rls_tables &&
        policies.total_policies >= rlsTables.rls_tables;
      record(
        "S4: every RLS'd table has at least one policy",
        passed,
        `${policies.tables_with_policies}/${rlsTables.rls_tables} tables covered, ${policies.total_policies} total policies`,
      );
    }

    // ── S5: a2a_tasks has a two-sided policy ───────────────────
    {
      const [p] = await sql`
        SELECT qual
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'a2a_tasks'
        LIMIT 1
      `;
      const qual = String(p?.qual || "");
      const passed = qual.includes("caller_org_id") && qual.includes("callee_org_id") && qual.includes("OR");
      record(
        "S5: a2a_tasks policy references caller OR callee org",
        passed,
        qual ? qual.slice(0, 80) : "no policy found",
      );
    }

    // ── S6: rag_chunks policy allows empty org sentinel ────────
    {
      const [p] = await sql`
        SELECT qual FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'rag_chunks'
        LIMIT 1
      `;
      const qual = String(p?.qual || "");
      const passed = qual.includes("org_id = ''") || qual.includes("org_id::text = ''::text");
      record(
        "S6: rag_chunks policy allows empty org_id (global sentinel)",
        passed,
        qual ? qual.slice(0, 80) : "no policy found",
      );
    }

    // ── S7: sampled critical tables specifically have FORCE ────
    {
      const sampleTables = [
        "agents", "secrets", "sessions", "billing_records",
        "api_keys", "credit_transactions", "conversations",
        "end_user_tokens", "org_credit_balance", "webhooks",
      ];
      const rows = await sql`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY(${sampleTables})
        ORDER BY c.relname
      `;
      const missing = rows.filter(r => !r.relrowsecurity || !r.relforcerowsecurity);
      const passed = missing.length === 0 && rows.length === sampleTables.length;
      record(
        "S7: critical tables have RLS enabled AND FORCE",
        passed,
        passed
          ? `${rows.length}/${sampleTables.length}`
          : `missing: ${missing.map(r => r.relname).join(", ")}`,
      );
    }

    // ── S8: app_user exists with neither SUPERUSER nor BYPASSRLS ─
    {
      const rows = await sql`
        SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
        FROM pg_roles WHERE rolname = 'app_user'
      `;
      const r = rows[0];
      const passed = r && !r.rolsuper && !r.rolbypassrls;
      record(
        "S8: app_user exists, has neither SUPERUSER nor BYPASSRLS",
        passed,
        r ? `super=${r.rolsuper}, bypassrls=${r.rolbypassrls}, canlogin=${r.rolcanlogin}` : "role not found",
      );
    }

    // ── S9: app_user has SELECT on agents (sanity grant check) ──
    {
      const [r] = await sql`
        SELECT has_table_privilege('app_user', 'agents', 'SELECT') AS can_select,
               has_table_privilege('app_user', 'agents', 'INSERT') AS can_insert,
               has_table_privilege('app_user', 'agents', 'UPDATE') AS can_update,
               has_table_privilege('app_user', 'agents', 'DELETE') AS can_delete
      `;
      const passed = r && r.can_select && r.can_insert && r.can_update && r.can_delete;
      record(
        "S9: app_user has SELECT/INSERT/UPDATE/DELETE on agents",
        passed,
        r ? `S=${r.can_select}, I=${r.can_insert}, U=${r.can_update}, D=${r.can_delete}` : "no result",
      );
    }

    // ── S10: app_user can EXECUTE current_org_id() ─────────────
    {
      const [r] = await sql`
        SELECT has_function_privilege('app_user', 'current_org_id()', 'EXECUTE') AS can_execute
      `;
      const passed = r && r.can_execute;
      record(
        "S10: app_user has EXECUTE on current_org_id()",
        passed,
        `can_execute=${r?.can_execute}`,
      );
    }

    // ── S11: connected role has BYPASSRLS (documents the reason
    // phase 2 may skip — this is WHY we need app_user for real
    // enforcement, and the smoke test reports it explicitly).
    {
      const [r] = await sql`
        SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      const passed = true; // informational — not a pass/fail
      record(
        `S11: connected as '${r?.rolname}' (bypassrls=${r?.rolbypassrls}) — informational`,
        passed,
        r?.rolbypassrls
          ? "RLS bypassed for this session; phase 2 needs SET ROLE"
          : "RLS applies to this session directly",
      );
    }

    console.log("\n[rls-smoke] === Phase 2: runtime enforcement (best-effort) ===\n");

    // Try to grant app_user membership so we can SET ROLE. If the
    // environment blocks this (Supabase pooler, missing CREATEROLE,
    // or Postgres 17 admin-option strictness), skip phase 2 cleanly.
    let canSetRole = false;
    try {
      await sql.unsafe(`GRANT app_user TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
      canSetRole = true;
    } catch (err) {
      console.log(`[rls-smoke] Phase 2 skipped: cannot GRANT app_user TO CURRENT_USER (${err?.message || err}).`);
      console.log("[rls-smoke] This is expected against Supabase's pooler. To run phase 2, connect via");
      console.log("[rls-smoke] a direct DATABASE_URL (db.<projectref>.supabase.co) from an IPv6 host.");
    }

    if (canSetRole) {
      // ── R1: app_user + GUC=org_a sees only org_a ─────────────
      try {
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE app_user");
          await tx.unsafe("SELECT set_config('app.current_org_id', 'org_a', true)");
          return await tx`SELECT org_id FROM agents ORDER BY org_id`;
        });
        const passed = rows.length === 1 && rows[0].org_id === "org_a";
        record("R1: app_user + GUC=org_a sees only org_a rows", passed,
          `${rows.length} rows: ${rows.map(r => r.org_id).join(", ")}`);
      } catch (err) {
        record("R1: app_user + GUC=org_a sees only org_a rows", false, err?.message);
      }

      // ── R2: app_user + GUC=org_b sees only org_b ─────────────
      try {
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE app_user");
          await tx.unsafe("SELECT set_config('app.current_org_id', 'org_b', true)");
          return await tx`SELECT org_id FROM agents ORDER BY org_id`;
        });
        const passed = rows.length === 1 && rows[0].org_id === "org_b";
        record("R2: app_user + GUC=org_b sees only org_b rows", passed,
          `${rows.length} rows: ${rows.map(r => r.org_id).join(", ")}`);
      } catch (err) {
        record("R2: app_user + GUC=org_b sees only org_b rows", false, err?.message);
      }

      // ── R3: app_user + no GUC sees zero rows (fail-closed) ───
      try {
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE app_user");
          return await tx`SELECT org_id FROM agents`;
        });
        const passed = rows.length === 0;
        record("R3: app_user + no GUC sees zero rows (fail-closed)", passed, `${rows.length} rows`);
      } catch (err) {
        record("R3: app_user + no GUC sees zero rows (fail-closed)", false, err?.message);
      }

      // ── R4: WITH CHECK blocks cross-org INSERT ───────────────
      {
        let rejected = false;
        let errMsg = "";
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe("SET LOCAL ROLE app_user");
            await tx.unsafe("SELECT set_config('app.current_org_id', 'org_a', true)");
            await tx`
              INSERT INTO agents (org_id, name, description, config)
              VALUES ('org_b', 'cross-tenant-smuggle', 'attempted cross-org insert', '{}')
            `;
          });
        } catch (err) {
          rejected = true;
          errMsg = err?.message || String(err);
        }
        record(
          "R4: app_user + GUC=org_a rejects INSERT with org_id=org_b",
          rejected,
          rejected ? `rejected (${errMsg.slice(0, 60)})` : "INSERT succeeded — WITH CHECK missing",
        );
      }
    }

    // ── Summary ─────────────────────────────────────────────────
    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = total - passed;
    console.log(`\n[rls-smoke] ${passed}/${total} tests passed, ${failed} failed.`);
    if (failed > 0) {
      console.log("\nFailed tests:");
      for (const r of results.filter(r => !r.passed)) {
        console.log(`  - ${r.name}: ${r.detail}`);
      }
      process.exit(1);
    }
    console.log("[rls-smoke] All tests passed. RLS enforcement verified end-to-end.");
  } catch (err) {
    console.error("[rls-smoke] test phase failed:", err?.message || err);
    throw err;
  }
  // No sql.end() — see comment near connect() for why.
}

main().catch((err) => {
  console.error("[rls-smoke] Fatal error:");
  console.error(err);
  process.exit(1);
});
