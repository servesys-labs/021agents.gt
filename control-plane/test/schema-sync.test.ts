/**
 * Schema-sync test — static analysis that validates every INSERT statement
 * in the codebase against the canonical schema in 001_init.sql.
 *
 * This catches column mismatches at build time with zero DB dependency.
 * If an INSERT references a column that doesn't exist in the CREATE TABLE,
 * this test fails with the exact file, line, table, and column.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ── Parse schema ────────────────────────────────────────────────────

const SCHEMA_PATH = join(__dirname, "../src/db/migrations/001_init.sql");
const schema = readFileSync(SCHEMA_PATH, "utf-8");

/** Extract column names from each CREATE TABLE in the schema. */
function parseSchema(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  // Match CREATE TABLE IF NOT EXISTS <name> ( ... );
  const tableRegex = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/g;
  let match;
  while ((match = tableRegex.exec(sql)) !== null) {
    const tableName = match[1];
    const body = match[2];
    const cols = new Set<string>();
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      // Skip constraints, indexes, comments, empty lines
      if (!trimmed || trimmed.startsWith("--") || trimmed.startsWith("CONSTRAINT")
          || trimmed.startsWith("PRIMARY KEY") || trimmed.startsWith("UNIQUE")
          || trimmed.startsWith("CHECK") || trimmed.startsWith("FOREIGN KEY")
          || trimmed.startsWith("REFERENCES") || trimmed.startsWith("ON ")
          || trimmed.startsWith(")")
      ) continue;
      // Column name is the first word
      const colMatch = trimmed.match(/^(\w+)/);
      if (colMatch && !["CREATE", "TABLE", "IF", "NOT", "EXISTS"].includes(colMatch[1].toUpperCase())) {
        cols.add(colMatch[1]);
      }
    }
    // Don't overwrite — first definition wins (CREATE TABLE IF NOT EXISTS)
    if (!tables.has(tableName)) {
      tables.set(tableName, cols);
    }
  }
  return tables;
}

const SCHEMA_TABLES = parseSchema(schema);

// ── Scan source files for INSERT statements ─────────────────────────

interface InsertSite {
  file: string;
  line: number;
  table: string;
  columns: string[];
}

/** Recursively find all .ts files (excluding test files, node_modules). */
function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...findTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".typetest.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Extract INSERT sites from a TypeScript file. */
function extractInserts(filePath: string, content: string): InsertSite[] {
  const sites: InsertSite[] = [];
  // Match INSERT INTO <table> (<col1>, <col2>, ...)
  // Handles both regular strings and template literals
  const insertRegex = /INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/gi;
  let match;
  while ((match = insertRegex.exec(content)) !== null) {
    const table = match[1];
    const colStr = match[2];
    // Calculate line number
    const lineNum = content.substring(0, match.index).split("\n").length;
    // Parse column names — handle template literal interpolation
    const columns = colStr
      .replace(/\$\{[^}]*\}/g, "") // Remove template expressions
      .split(",")
      .map(c => c.trim().replace(/['"]/g, ""))
      .filter(c => c.length > 0 && /^\w+$/.test(c));

    if (columns.length > 0) {
      // Skip DO-local SQLite inserts (preceded by `this.sql` or `_circuitBreakerSql`)
      const preceding = content.substring(Math.max(0, match.index - 30), match.index);
      if (preceding.includes("this.sql") || preceding.includes("_circuitBreakerSql")) continue;

      sites.push({
        file: relative(join(__dirname, "../.."), filePath),
        line: lineNum,
        table,
        columns,
      });
    }
  }
  return sites;
}

// ── Tables to skip (not in main schema — DO-local SQLite, etc.) ─────
const SKIP_TABLES = new Set([
  // DO-local SQLite tables (not in Postgres)
  "conversation_messages_local", "active_workflows", "workspace_checkpoints",
  // DO-local SQLite tables (use ? params, not ${} template literals)
  "circuit_breaker_state", "mailbox",
  // Signal coordinator DO-local tables
  "signal_clusters", "signal_state", "signal_cooldowns",
  // Postgres system / extension tables
  "pg_stat_user_tables", "_sql_schema_migrations",
  // Stripe webhook processing (external)
  "stripe_events_processed",
]);

// ── Tests ───────────────────────────────────────────────────────────

describe("Schema sync — INSERT column validation", () => {
  const ROOT = join(__dirname, "../..");
  const dirs = [
    join(ROOT, "control-plane/src"),
    join(ROOT, "deploy/src"),
  ];

  const allFiles = dirs.flatMap(findTsFiles);
  const allInserts: InsertSite[] = [];
  for (const file of allFiles) {
    const content = readFileSync(file, "utf-8");
    allInserts.push(...extractInserts(file, content));
  }

  it("should have parsed the schema with 100+ tables", () => {
    expect(SCHEMA_TABLES.size).toBeGreaterThan(100);
  });

  it("should have found INSERT statements in source files", () => {
    expect(allInserts.length).toBeGreaterThan(30);
  });

  // Group by table for readable output
  const byTable = new Map<string, InsertSite[]>();
  for (const site of allInserts) {
    if (SKIP_TABLES.has(site.table)) continue;
    if (!byTable.has(site.table)) byTable.set(site.table, []);
    byTable.get(site.table)!.push(site);
  }

  for (const [table, sites] of byTable) {
    const schemaCols = SCHEMA_TABLES.get(table);

    it(`INSERT INTO ${table} — table exists in schema`, () => {
      if (!schemaCols) {
        const locations = sites.map(s => `${s.file}:${s.line}`).join(", ");
        expect.fail(
          `Table "${table}" does not exist in 001_init.sql but INSERT found at: ${locations}`
        );
      }
    });

    if (schemaCols) {
      for (const site of sites) {
        const badCols = site.columns.filter(c => !schemaCols.has(c));
        if (badCols.length > 0) {
          it(`INSERT INTO ${table} at ${site.file}:${site.line} — all columns exist`, () => {
            expect.fail(
              `Column(s) [${badCols.join(", ")}] do not exist in table "${table}". ` +
              `Schema has: [${[...schemaCols].join(", ")}]`
            );
          });
        }
      }
    }
  }
});

// ── RLS coverage test ───────────────────────────────────────────────

describe("RLS policy coverage", () => {
  /** Extract tables with FORCE ROW LEVEL SECURITY. */
  function parseForcedRls(sql: string): Set<string> {
    const tables = new Set<string>();
    const regex = /ALTER TABLE\s+(\w+)\s+FORCE ROW LEVEL SECURITY/g;
    let match;
    while ((match = regex.exec(sql)) !== null) {
      tables.add(match[1]);
    }
    return tables;
  }

  /** Extract tables that have at least one CREATE POLICY. */
  function parsePolicies(sql: string): Set<string> {
    const tables = new Set<string>();
    const regex = /CREATE POLICY\s+\w+\s+ON\s+(\w+)/g;
    let match;
    while ((match = regex.exec(sql)) !== null) {
      tables.add(match[1]);
    }
    return tables;
  }

  const forcedTables = parseForcedRls(schema);
  const tablesWithPolicies = parsePolicies(schema);

  it("should have FORCE RLS on 100+ tables", () => {
    expect(forcedTables.size).toBeGreaterThan(100);
  });

  it("every table with FORCE RLS must have at least one CREATE POLICY", () => {
    const missing: string[] = [];
    for (const table of forcedTables) {
      if (!tablesWithPolicies.has(table)) {
        missing.push(table);
      }
    }
    if (missing.length > 0) {
      expect.fail(
        `${missing.length} table(s) have FORCE ROW LEVEL SECURITY but no CREATE POLICY: [${missing.join(", ")}]. ` +
        `Non-superuser connections will be denied ALL access to these tables.`
      );
    }
  });

  it("no orphaned policies (policy exists but RLS not forced)", () => {
    const orphaned: string[] = [];
    for (const table of tablesWithPolicies) {
      if (!forcedTables.has(table)) {
        orphaned.push(table);
      }
    }
    // This is a warning, not necessarily a failure — but worth surfacing
    if (orphaned.length > 0) {
      console.warn(
        `[RLS] ${orphaned.length} table(s) have CREATE POLICY but RLS is not FORCE'd: [${orphaned.join(", ")}]`
      );
    }
  });
});
