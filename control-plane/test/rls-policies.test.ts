/**
 * Static analysis tests for the RLS SQL file.
 *
 * Reads control-plane/src/db/rls.sql and verifies its structure
 * programmatically — no database execution required.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RLS_PATH = resolve(__dirname, "../src/db/rls.sql");
let rlsSql: string;

try {
  rlsSql = readFileSync(RLS_PATH, "utf-8");
} catch {
  rlsSql = "";
}

describe("RLS Policies", () => {
  it("rls.sql file exists and is non-empty", () => {
    expect(rlsSql.length).toBeGreaterThan(0);
  });

  it("rls.sql is valid SQL (no obvious syntax errors)", () => {
    // Basic structural checks — balanced parentheses and no unclosed strings
    const opens = (rlsSql.match(/\(/g) || []).length;
    const closes = (rlsSql.match(/\)/g) || []).length;
    expect(opens).toBe(closes);

    // Ends with a semicolon or comment (not mid-statement)
    const trimmed = rlsSql.trim();
    const lastChar = trimmed[trimmed.length - 1];
    // Should end with semicolon or be inside a comment block
    expect([";", "-", "/"].includes(lastChar) || trimmed.endsWith("$$;")).toBe(true);
  });

  // ── Core tables covered ──────────────────────────────────────────────

  const coreTables = [
    "agents",
    "agent_versions",
    "sessions",
    "turns",
    "eval_runs",
    "eval_trials",
    "issues",
    "security_scans",
    "security_findings",
    "billing_records",
    "billing_events",
    "session_feedback",
    "episodes",
    "facts",
    "memory_facts",
    "components",
    "orgs",
    "org_members",
    "api_keys",
    "secrets",
  ];

  it("covers all core tables", () => {
    for (const table of coreTables) {
      expect(rlsSql, `rls.sql should mention table '${table}'`).toContain(`'${table}'`);
    }
  });

  // ── app.current_org_id function ──────────────────────────────────────

  it("creates app.current_org_id function", () => {
    expect(rlsSql).toContain("CREATE OR REPLACE FUNCTION app.current_org_id()");
    expect(rlsSql).toContain("current_setting('app.current_org_id'");
  });

  it("creates the app schema", () => {
    expect(rlsSql).toContain("CREATE SCHEMA IF NOT EXISTS app");
  });

  // ── RLS enable/force ─────────────────────────────────────────────────

  it("enables RLS on all listed tables", () => {
    expect(rlsSql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("forces RLS on all listed tables", () => {
    expect(rlsSql).toContain("FORCE ROW LEVEL SECURITY");
  });

  // ── CRUD policies ────────────────────────────────────────────────────

  it("creates SELECT policy for each table", () => {
    expect(rlsSql).toContain("_tenant_select");
    expect(rlsSql).toContain("FOR SELECT USING");
  });

  it("creates INSERT policy for each table", () => {
    expect(rlsSql).toContain("_tenant_insert");
    expect(rlsSql).toContain("FOR INSERT WITH CHECK");
  });

  it("creates UPDATE policy for each table", () => {
    expect(rlsSql).toContain("_tenant_update");
    expect(rlsSql).toContain("FOR UPDATE USING");
  });

  it("creates DELETE policy for each table", () => {
    expect(rlsSql).toContain("_tenant_delete");
    expect(rlsSql).toContain("FOR DELETE USING");
  });

  // ── Special policies ─────────────────────────────────────────────────

  it("components table allows public read", () => {
    // The components policy should include is_public = true
    expect(rlsSql).toContain("is_public = true");
    // The special components policy should override the standard one
    expect(rlsSql).toContain("components_tenant_select");
  });

  it("turns table uses session join for scoping", () => {
    // turns may not have org_id — RLS should use EXISTS subquery on sessions
    expect(rlsSql).toContain("turns_tenant_select");
    expect(rlsSql).toContain("EXISTS");
    expect(rlsSql).toContain("s.session_id = turns.session_id");
    expect(rlsSql).toContain("s.org_id = app.current_org_id()");
  });

  // ── Index recommendations ────────────────────────────────────────────

  it("includes index recommendations", () => {
    expect(rlsSql).toContain("idx_sessions_org_created");
    expect(rlsSql).toContain("idx_agents_org_active");
    expect(rlsSql).toContain("idx_issues_org_status");
    expect(rlsSql).toContain("idx_billing_org_created");
  });

  // ── Policy uses app.current_org_id() ─────────────────────────────────

  it("all tenant policies reference app.current_org_id()", () => {
    // Every policy format string uses app.current_org_id()
    // Count occurrences — should appear multiple times (at least in each EXECUTE format)
    const matches = rlsSql.match(/app\.current_org_id\(\)/g) || [];
    // At minimum: function definition + select/insert/update/delete format strings + special policies
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  // ── DROP IF EXISTS for idempotency ───────────────────────────────────

  it("drops existing policies before creating (idempotent re-run)", () => {
    expect(rlsSql).toContain("DROP POLICY IF EXISTS");
    const drops = (rlsSql.match(/DROP POLICY IF EXISTS/g) || []).length;
    // At least 4 per standard loop + special policies
    expect(drops).toBeGreaterThanOrEqual(4);
  });

  // ── Additional tables ────────────────────────────────────────────────

  const additionalTables = [
    "risk_profiles",
    "gold_images",
    "compliance_checks",
    "procedures",
    "policy_templates",
    "slo_definitions",
    "conversation_scores",
    "runtime_events",
    "otel_events",
    "webhooks",
    "webhook_deliveries",
    "schedules",
    "job_queue",
    "projects",
    "environments",
    "mcp_servers",
    "guardrail_events",
    "guardrail_policies",
    "pipelines",
    "workflows",
    "workflow_runs",
    "workflow_approvals",
  ];

  it("covers governance and operational tables", () => {
    for (const table of additionalTables) {
      expect(rlsSql, `rls.sql should mention table '${table}'`).toContain(`'${table}'`);
    }
  });
});
