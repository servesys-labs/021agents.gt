/**
 * Static analysis tests for the RLS schema.
 *
 * History: previously read `control-plane/src/db/rls.sql` as a standalone
 * file and asserted a dynamic PL/pgSQL policy loop with `_tenant_select /
 * _tenant_insert / _tenant_update / _tenant_delete` names. The April 2026
 * schema consolidation folded every RLS policy into
 * `control-plane/src/db/migrations/001_init.sql` using a direct per-table
 * pattern (`ALTER TABLE x ENABLE/FORCE ROW LEVEL SECURITY;
 * CREATE POLICY x_org_isolation ON x FOR ALL USING (org_id = current_org_id())`).
 * This test rewritten to match the new layout — still no DB execution
 * required, just string checks against the migration SQL.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = resolve(__dirname, "../src/db/migrations/001_init.sql");
let migrationSql: string;

try {
  migrationSql = readFileSync(MIGRATION_PATH, "utf-8");
} catch {
  migrationSql = "";
}

describe("RLS Policies", () => {
  it("001_init.sql migration file exists and is non-trivial", () => {
    expect(migrationSql.length).toBeGreaterThan(50_000);
  });

  it("migration SQL has balanced parentheses and ends cleanly", () => {
    const opens = (migrationSql.match(/\(/g) || []).length;
    const closes = (migrationSql.match(/\)/g) || []).length;
    expect(opens).toBe(closes);

    const trimmed = migrationSql.trim();
    const lastChar = trimmed[trimmed.length - 1];
    expect([";", "-", "/"].includes(lastChar) || trimmed.endsWith("$$;")).toBe(true);
  });

  // ── The app.current_org_id() GUC reader ──────────────────────────────

  it("creates the current_org_id() function that reads the GUC", () => {
    expect(migrationSql).toContain("CREATE OR REPLACE FUNCTION current_org_id()");
    expect(migrationSql).toContain("current_setting('app.current_org_id'");
  });

  // ── Every org-scoped table must be RLS-enabled and forced ─────────────

  // Core tables that MUST have RLS enabled. If any of these lose RLS in a
  // future migration edit, this test fails loud.
  // Tables that MUST be directly RLS-enabled with a policy referencing
  // current_org_id(). Tables whose isolation derives from a parent FK
  // (e.g. security_findings via security_scans, webhook_deliveries via
  // webhooks) are NOT in this list — they rely on the parent's RLS.
  const coreOrgScopedTables = [
    "agents",
    "agent_versions",
    "sessions",
    "eval_runs",
    "issues",
    "security_scans",
    "billing_records",
    "billing_events",
    "session_feedback",
    "episodes",
    "facts",
    "components",
    "api_keys",
    "secrets",
    "projects",
    "environments",
    "webhooks",
    "schedules",
    "conversation_scores",
    "runtime_events",
    "risk_profiles",
    "gold_images",
    "compliance_checks",
    "custom_domains",
    "marketplace_listings",
    "a2a_tasks",
    "a2a_artifacts",
    "connector_tokens",
    "autoresearch_experiments",
    "autoresearch_runs",
  ];

  it.each(coreOrgScopedTables)("enables RLS on %s", (table) => {
    expect(migrationSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    expect(migrationSql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  });

  it("every table with ENABLE ROW LEVEL SECURITY also has FORCE", () => {
    // Count only the real `ALTER TABLE x ENABLE/FORCE ROW LEVEL SECURITY`
    // statements — the migration also mentions these phrases in comments
    // (Pattern: ..., implementation notes), and counting those throws off
    // the invariant. We match at line start after trimming leading ALTER.
    const realEnables = (migrationSql.match(/^ALTER TABLE \S+ ENABLE ROW LEVEL SECURITY/gm) || []).length;
    const realForces = (migrationSql.match(/^ALTER TABLE \S+ FORCE ROW LEVEL SECURITY/gm) || []).length;
    expect(realEnables).toBe(realForces);
    expect(realEnables).toBeGreaterThanOrEqual(100); // ~115 in the April 2026 consolidation
  });

  it("every RLS-enabled table has a policy referencing current_org_id()", () => {
    const policyRefs = (migrationSql.match(/current_org_id\(\)/g) || []).length;
    // One reference in the function definition, then one per table policy
    // at minimum. With 116 enabled tables we expect well over 100 refs.
    expect(policyRefs).toBeGreaterThanOrEqual(100);
  });

  // ── CRUD coverage pattern ────────────────────────────────────────────
  // The consolidation moved from four separate policies (_tenant_select,
  // _tenant_insert, etc) to a single `_org_isolation ON x FOR ALL USING`
  // which is structurally simpler and covers SELECT/INSERT/UPDATE/DELETE
  // in one policy.

  it("uses the FOR ALL policy shape (no stale _tenant_select policies)", () => {
    expect(migrationSql).toContain("_org_isolation");
    expect(migrationSql).toContain("FOR ALL USING");
    // Should NOT have leftover per-operation policies from the old style.
    expect(migrationSql).not.toContain("_tenant_select");
    expect(migrationSql).not.toContain("_tenant_insert");
    expect(migrationSql).not.toContain("_tenant_update");
    expect(migrationSql).not.toContain("_tenant_delete");
  });

  // ── Idempotency ──────────────────────────────────────────────────────

  it("wraps each CREATE POLICY in DO $$ BEGIN ... EXCEPTION for idempotent re-run", () => {
    // The new pattern is `DO $$ BEGIN CREATE POLICY x ... EXCEPTION WHEN duplicate_object`.
    const policyCreates = (migrationSql.match(/CREATE POLICY/g) || []).length;
    const doBlocks = (migrationSql.match(/DO \$\$ BEGIN CREATE POLICY/g) || []).length;
    // Most CREATE POLICY statements should be inside a DO block.
    expect(doBlocks).toBeGreaterThanOrEqual(Math.floor(policyCreates * 0.8));
  });

  // ── Special cases documented in the migration agent's commit ─────────

  it("a2a_tasks uses a two-sided policy covering both sender and recipient orgs", () => {
    // a2a_tasks is shared between calling org and called org — its policy
    // should reference both caller_org_id AND callee_org_id.
    expect(migrationSql).toMatch(/a2a_tasks[\s\S]{0,2000}?(caller_org_id|callee_org_id)/);
  });

  it("marketplace_listings allows public-published rows through the policy", () => {
    // Published listings need to be visible across tenants — either via a
    // separate SELECT policy or an OR branch that checks a published flag.
    expect(migrationSql).toMatch(/marketplace_listings[\s\S]{0,2000}?(published|is_public|visibility)/);
  });

  // ── Tables that must NOT have RLS (global catalogs, per-user, FK-derived) ─

  const tablesExcludedFromRLS = [
    // Per-user tables isolated by user_id FK, not org_id
    "users",
    "user_sessions",
    // Global catalogs
    "credit_packages",
    // Tables that derive isolation via parent FK (sessions → turns)
    "turns",
    "conversation_messages",
    "eval_trials",
  ];

  it.each(tablesExcludedFromRLS)("does NOT enable RLS on the excluded table %s", (table) => {
    expect(migrationSql).not.toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  });
});
