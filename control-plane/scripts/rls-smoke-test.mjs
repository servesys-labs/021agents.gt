#!/usr/bin/env node
/**
 * RLS smoke test — verifies that the policies in 001_init.sql actually
 * enforce tenant isolation end-to-end.
 *
 * Two-phase design so we can run both the setup (requires superuser/
 * schema-owner privs) and the runtime enforcement checks (requires a
 * non-BYPASSRLS role) in a single pass:
 *
 *   Phase 1 — admin connection (DATABASE_URL, typically the Supabase
 *     `postgres` role):
 *       1a. DROP public schema, recreate, apply 001_init.sql.
 *           This is destructive — only run against a dev/prototype DB.
 *       1b. Seed two orgs + one agent each.
 *       1c. Schema inspection tests (S1-S11): helper function exists,
 *           GUC plumbing works, all RLS'd tables have FORCE, every
 *           table has a policy, critical tables spot-checked, a2a_tasks
 *           two-sided policy present, rag_chunks global sentinel OK,
 *           app_user role + grants in place.
 *
 *   Phase 2 — app_user connection (APP_USER_DATABASE_URL, optional):
 *       2a. Runtime enforcement tests (R1-R4) via a connection that
 *           actually logs in as app_user. No SET ROLE dance needed —
 *           the session starts as app_user so RLS applies directly.
 *       2b. If APP_USER_DATABASE_URL is unset, Phase 2 skips cleanly.
 *
 * IMPORTANT: this script does NOT drop or recreate the app_user role.
 * The migration's `CREATE ROLE app_user NOLOGIN` is wrapped in an
 * EXCEPTION block so it's idempotent — if the role already exists with
 * a production LOGIN + password (set via `ALTER ROLE app_user LOGIN
 * PASSWORD ...` during the Hyperdrive swap), re-running this script
 * preserves that state. Only the schema contents get nuked.
 *
 * Usage:
 *   # Phase 1 only (schema verification) — requires --allow-wipe if the
 *   # target DB already has any real user rows. This is a destructive
 *   # test; the guard is there to prevent accidental runs against a
 *   # live dev session.
 *   node control-plane/scripts/rls-smoke-test.mjs --allow-wipe
 *
 *   # Phase 1 + Phase 2 (runtime enforcement)
 *   APP_USER_DATABASE_URL='postgresql://app_user.<ref>:<pwd>@<pooler>/postgres' \
 *     node control-plane/scripts/rls-smoke-test.mjs --allow-wipe
 *
 * Reads DATABASE_URL and APP_USER_DATABASE_URL from ../../.env or env.
 *
 * Env toggles:
 *   ALLOW_WIPE=1   — equivalent to --allow-wipe flag
 *
 * The script will refuse to run if `users` has rows or `orgs` has any
 * rows other than the smoke test's own seed (org_a / org_b / org_c),
 * unless --allow-wipe is passed.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env ────────────────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(__dirname, "../../.env");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {}
}
loadEnv();

const ADMIN_URL = process.env.DATABASE_URL;
const APP_USER_URL = process.env.APP_USER_DATABASE_URL;

if (!ADMIN_URL) {
  console.error("[rls-smoke] DATABASE_URL not set in env or .env");
  process.exit(1);
}

const MIGRATION_PATH = resolve(__dirname, "../src/db/migrations/001_init.sql");

// ── Test harness ─────────────────────────────────────────────────
const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const mark = passed ? "✓" : "✗";
  const line = `  ${mark} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(passed ? line : `\x1b[31m${line}\x1b[0m`);
}

// Supabase's pooler kills idle connections aggressively after large DDL
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

function connect(url) {
  return postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    max_lifetime: 600,
    onnotice: () => {},
  });
}

// ── Phase 1: admin setup + schema verification ──────────────────
async function phase1Admin() {
  console.log("[rls-smoke] === Phase 1: admin setup + schema verification ===");
  console.log("[rls-smoke] Connecting as admin (DATABASE_URL)…");
  const sql = connect(ADMIN_URL);

  // Diagnose the server
  const [info] = await sql`
    SELECT
      version() AS version,
      current_user AS current_user,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
  `;
  console.log(`[rls-smoke] server: ${info.version.split(",")[0]}`);
  console.log(`[rls-smoke] connected as: ${info.current_user} (bypassrls=${info.bypass_rls})`);
  if (!info.bypass_rls) {
    console.warn(
      "[rls-smoke] WARNING: admin role is not BYPASSRLS. If the schema drop fails, " +
      "you may need a connection with schema-owner privileges.",
    );
  }

  // ── Safety guard: refuse to wipe a DB with real user data ──
  // This test DROPs the entire public schema — fine for a dev/prototype
  // DB, catastrophic if run against anything with real rows. The earlier
  // run of this script nuked a live dev session's founder account + a
  // real referral chain because it was queued as a background task
  // without the caller realising what it would destroy. The guard below
  // makes that impossible without an explicit opt-in flag.
  //
  // Pass --allow-wipe (or ALLOW_WIPE=1) to acknowledge that the wipe
  // is intentional. The seed org_ids the smoke test itself creates
  // (org_a/org_b/org_c) are allowed to remain from a prior run.
  const allowWipe =
    process.argv.includes("--allow-wipe") || process.env.ALLOW_WIPE === "1";
  const SEED_ORG_IDS = new Set(["org_a", "org_b", "org_c"]);
  const [{ user_count }] = await sql`
    SELECT COUNT(*)::int AS user_count FROM users
  `.catch(() => [{ user_count: 0 }]);
  const nonSeedOrgs = await sql`
    SELECT org_id, slug FROM orgs
  `.catch(() => []);
  const realOrgs = nonSeedOrgs.filter((o) => !SEED_ORG_IDS.has(String(o.org_id)));
  if (!allowWipe && (user_count > 0 || realOrgs.length > 0)) {
    console.error("");
    console.error("[rls-smoke] ❌ Refusing to wipe a DB with real data.");
    console.error(`[rls-smoke]    users: ${user_count}`);
    console.error(`[rls-smoke]    non-seed orgs: ${realOrgs.length}${realOrgs.length > 0 ? " (" + realOrgs.map((o) => o.slug).join(", ") + ")" : ""}`);
    console.error("");
    console.error("[rls-smoke] This script DROPs the entire public schema, which would");
    console.error("[rls-smoke] destroy every row. If you're SURE you want to wipe (e.g.");
    console.error("[rls-smoke] you just reset a prototype dev DB), re-run with:");
    console.error("[rls-smoke]");
    console.error("[rls-smoke]   node control-plane/scripts/rls-smoke-test.mjs --allow-wipe");
    console.error("[rls-smoke]");
    console.error("[rls-smoke] Or set ALLOW_WIPE=1 in the environment.");
    process.exit(2);
  }

  // ── 1a. Nuke + recreate schema ──────────────────────────────
  console.log("[rls-smoke] Dropping and recreating public schema…");
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO postgres;
    GRANT USAGE ON SCHEMA public TO public;
  `);

  // NOTE: we deliberately do NOT drop the app_user role here, even if
  // it exists from a prior run. The migration's CREATE ROLE is
  // idempotent (EXCEPTION WHEN duplicate_object), so re-running the
  // migration preserves any production password/LOGIN state set via
  // `ALTER ROLE app_user LOGIN PASSWORD ...` during the Hyperdrive
  // swap. Default privileges and table grants are schema-scoped and
  // were cleaned up by the DROP SCHEMA above; the migration will
  // re-apply them to the fresh tables.

  // ── 1b. Apply the consolidated migration ─────────────────────
  console.log(`[rls-smoke] Applying ${MIGRATION_PATH}…`);
  const migrationSql = readFileSync(MIGRATION_PATH, "utf-8");
  await sql.unsafe(migrationSql);
  console.log("[rls-smoke] Migration applied.");

  // Post-migration ping to confirm connection is still alive.
  try {
    const [ping] = await sql`SELECT 1 AS ok`;
    console.log(`[rls-smoke] Post-migration ping: ${ping.ok === 1 ? "alive" : "unknown"}`);
  } catch (err) {
    console.error(`[rls-smoke] Post-migration ping failed: ${err?.message || err}`);
    throw err;
  }

  // ── 1c. Seed fixtures ───────────────────────────────────────
  console.log("[rls-smoke] Seeding test fixtures…");
  // Use ON CONFLICT DO NOTHING so re-runs are idempotent.
  await sql.unsafe(`
    INSERT INTO orgs (org_id, name, slug) VALUES
      ('org_a', 'Org A', 'org-a'),
      ('org_b', 'Org B', 'org-b'),
      ('org_c', 'Org C', 'org-c')
    ON CONFLICT (org_id) DO NOTHING;
    INSERT INTO agents (org_id, name, description, config) VALUES
      ('org_a', 'agent-a', 'Agent owned by Org A', '{}'),
      ('org_b', 'agent-b', 'Agent owned by Org B', '{}')
    ON CONFLICT DO NOTHING;
    INSERT INTO a2a_agents (org_id, agent_name, a2a_card) VALUES
      ('org_a', 'agent-a', '{}'::jsonb),
      ('org_b', 'agent-b', '{}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO a2a_tasks (
      task_id, caller_org_id, caller_agent_name,
      callee_org_id, callee_agent_name, status, input_text
    ) VALUES (
      'task-1', 'org_a', 'agent-a', 'org_b', 'agent-b', 'pending', 'smoke-test'
    ) ON CONFLICT DO NOTHING;
  `);

  console.log("\n[rls-smoke] --- Schema verification tests ---\n");

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

  // ── S2: set_config flows through current_org_id() ──────────
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

  // ── S3: all RLS'd tables have FORCE ─────────────────────────
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

  // ── S4: every RLS'd table has at least one policy ──────────
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

  // ── S6: rag_chunks allows empty org_id sentinel ────────────
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

  // ── S7: critical tables spot-checked ───────────────────────
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

  // ── S8: app_user exists, neither SUPERUSER nor BYPASSRLS ───
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

  // ── S9: app_user has DML on agents (sanity grant check) ────
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

  // ── S11: informational — admin connection bypass status ────
  {
    const [r] = await sql`
      SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    record(
      `S11: admin session connected as '${r?.rolname}' (bypassrls=${r?.rolbypassrls}) — informational`,
      true,
      r?.rolbypassrls
        ? "RLS bypassed for admin session; phase 2 must run as app_user"
        : "RLS applies to admin session directly",
    );
  }

  // No sql.end() — let Node GC the socket (Supabase pooler + postgres.js
  // .end() causes a synchronous socket error that bypasses try/catch).
}

// ── Phase 2: runtime enforcement via direct app_user connection ─
async function phase2AppUser() {
  console.log("\n[rls-smoke] === Phase 2: runtime enforcement (as app_user) ===");
  if (!APP_USER_URL) {
    console.log("[rls-smoke] Phase 2 skipped: APP_USER_DATABASE_URL not set.");
    console.log("[rls-smoke] To run runtime enforcement tests, set APP_USER_DATABASE_URL to");
    console.log("[rls-smoke] a Supabase pooler connection string that authenticates as app_user,");
    console.log("[rls-smoke] e.g. 'postgresql://app_user.<projectref>:<password>@<pooler-host>:5432/postgres'");
    return;
  }

  console.log("[rls-smoke] Connecting as app_user (APP_USER_DATABASE_URL)…");
  const sql = connect(APP_USER_URL);

  // Confirm we are actually app_user and not accidentally logged in as
  // something else (avoids false-green if the URL is misconfigured).
  const [info] = await sql`
    SELECT
      current_user AS current_user,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
  `;
  console.log(`[rls-smoke] connected as: ${info.current_user} (bypassrls=${info.bypass_rls})`);
  if (info.bypass_rls) {
    record(
      "R0: app_user session does NOT have BYPASSRLS",
      false,
      `connected role is '${info.current_user}' with bypassrls=true — RLS won't enforce`,
    );
    return; // no point running the rest
  }
  record(
    "R0: app_user session does NOT have BYPASSRLS",
    true,
    `role=${info.current_user}`,
  );

  // ── R1: GUC=org_a sees only org_a ──────────────────────────
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.current_org_id', 'org_a', true)");
      return await tx`SELECT org_id, name FROM agents ORDER BY org_id`;
    });
    const passed = rows.length === 1 && rows[0].org_id === "org_a";
    record(
      "R1: GUC=org_a sees only org_a rows",
      passed,
      `${rows.length} rows: ${rows.map(r => r.org_id).join(", ")}`,
    );
  } catch (err) {
    record("R1: GUC=org_a sees only org_a rows", false, err?.message || String(err));
  }

  // ── R2: GUC=org_b sees only org_b ──────────────────────────
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.current_org_id', 'org_b', true)");
      return await tx`SELECT org_id, name FROM agents ORDER BY org_id`;
    });
    const passed = rows.length === 1 && rows[0].org_id === "org_b";
    record(
      "R2: GUC=org_b sees only org_b rows",
      passed,
      `${rows.length} rows: ${rows.map(r => r.org_id).join(", ")}`,
    );
  } catch (err) {
    record("R2: GUC=org_b sees only org_b rows", false, err?.message || String(err));
  }

  // ── R3: no GUC → zero rows (fail-closed) ───────────────────
  try {
    // set_config to empty string explicitly inside the tx so we don't
    // inherit leakage from any previous statement on the connection.
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.current_org_id', '', true)");
      return await tx`SELECT org_id FROM agents`;
    });
    const passed = rows.length === 0;
    record("R3: GUC='' sees zero rows (fail-closed)", passed, `${rows.length} rows`);
  } catch (err) {
    record("R3: GUC='' sees zero rows (fail-closed)", false, err?.message || String(err));
  }

  // ── R4: cross-org INSERT rejected by WITH CHECK ────────────
  {
    let rejected = false;
    let errMsg = "";
    try {
      await sql.begin(async (tx) => {
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
      "R4: GUC=org_a rejects INSERT with org_id=org_b",
      rejected,
      rejected ? `rejected (${errMsg.slice(0, 60)})` : "INSERT succeeded — WITH CHECK missing",
    );
  }

  // ── R5: verify the smuggled row did NOT persist ────────────
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.current_org_id', 'org_b', true)");
      return await tx`SELECT org_id, name FROM agents WHERE name = 'cross-tenant-smuggle'`;
    });
    const passed = rows.length === 0;
    record(
      "R5: no smuggled row persisted after R4 rollback",
      passed,
      `${rows.length} rows as org_b`,
    );
  } catch (err) {
    record("R5: no smuggled row persisted after R4 rollback", false, err?.message || String(err));
  }

  // ── R6: a2a_tasks two-sided policy — caller and callee see,
  //       stranger does not ────────────────────────────────────
  try {
    const asCaller = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.current_org_id', 'org_a', true)");
      return await tx`SELECT task_id FROM a2a_tasks`;
    });
    const asCallee = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.current_org_id', 'org_b', true)");
      return await tx`SELECT task_id FROM a2a_tasks`;
    });
    const asStranger = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.current_org_id', 'org_c', true)");
      return await tx`SELECT task_id FROM a2a_tasks`;
    });
    const passed =
      asCaller.length === 1 && asCallee.length === 1 && asStranger.length === 0;
    record(
      "R6: a2a_tasks two-sided policy (caller+callee see, stranger blocked)",
      passed,
      `caller=${asCaller.length}, callee=${asCallee.length}, stranger=${asStranger.length}`,
    );
  } catch (err) {
    record("R6: a2a_tasks two-sided policy", false, err?.message || String(err));
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  await phase1Admin();
  await phase2AppUser();

  // ── Summary ────────────────────────────────────────────────
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
  if (!APP_USER_URL) {
    console.log("[rls-smoke] Schema verified. Set APP_USER_DATABASE_URL to also run runtime enforcement.");
  } else {
    console.log("[rls-smoke] All tests passed. RLS enforcement verified end-to-end.");
  }

  // ── Browser-side state reminder ───────────────────────────────
  // The smoke test wipes Postgres, but meta-chat history and some UI
  // state live in browser localStorage, not Postgres. A true fresh
  // dev environment also needs a client-side reset. Print the snippet
  // so it's one paste-and-run away from a devtools console on the
  // portal.
  console.log("");
  console.log("[rls-smoke] NOTE: meta-chat history is stored in browser localStorage, not Postgres.");
  console.log("[rls-smoke] To fully reset a dev session, run this in the portal devtools console:");
  console.log("[rls-smoke]   Object.keys(localStorage)");
  console.log("[rls-smoke]     .filter(k => k.startsWith('oneshots_meta_agent_'))");
  console.log("[rls-smoke]     .forEach(k => localStorage.removeItem(k));");
  console.log("[rls-smoke] (Or just open an incognito window for the same effect.)");
}

main().catch((err) => {
  console.error("[rls-smoke] Fatal error:");
  console.error(err);
  process.exit(1);
});
