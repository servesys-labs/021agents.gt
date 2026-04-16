#!/usr/bin/env node
/**
 * Reset the Railway prototype DB and optionally reseed founder accounts.
 *
 * Default flow:
 *   1. Load RAILWAY_URL from repo-root .env (or env)
 *   2. Truncate all public tables with RESTART IDENTITY CASCADE
 *   3. Run control-plane/scripts/seed-founder.mjs
 *
 * Usage:
 *   node control-plane/scripts/reset-railway-db.mjs
 *   node control-plane/scripts/reset-railway-db.mjs --yes
 *   node control-plane/scripts/reset-railway-db.mjs --skip-seed
 *   node control-plane/scripts/reset-railway-db.mjs --seed-script ./scripts/seed-founder.mjs
 *   node control-plane/scripts/reset-railway-db.mjs --help
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import { stdin, stdout, argv, exit } from "process";
import { fileURLToPath } from "url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEED_SCRIPT = resolve(__dirname, "./seed-founder.mjs");
const HELP_TEXT = `
Usage:
  node control-plane/scripts/reset-railway-db.mjs [options]

Options:
  --yes, -y              Skip confirmation prompt
  --skip-seed            Do not run the founder seed script after reset
  --seed-script <path>   Seed script to run after reset
  --force                Allow non-Railway DATABASE_URL targets
  --help, -h             Show this help
`.trim();

function loadEnv() {
  try {
    const envPath = resolve(__dirname, "../../.env");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}

function parseArgs(rawArgs) {
  const out = {
    yes: false,
    skipSeed: false,
    force: false,
    help: false,
    seedScript: DEFAULT_SEED_SCRIPT,
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--skip-seed") out.skipSeed = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--seed-script") {
      const next = rawArgs[i + 1];
      if (!next) {
        console.error("--seed-script requires a path");
        exit(1);
      }
      out.seedScript = resolve(process.cwd(), next);
      i += 1;
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error(HELP_TEXT);
      exit(1);
    }
  }

  return out;
}

function maskDbUrl(url) {
  return String(url || "").replace(/:\/\/[^@]+@/, "://***:***@");
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

async function confirmReset(url, tableCount) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      `About to TRUNCATE ${tableCount} public tables on ${maskDbUrl(url)}.\nType "reset railway" to continue: `,
    );
    return answer.trim().toLowerCase() === "reset railway";
  } finally {
    rl.close();
  }
}

loadEnv();
const args = parseArgs(argv.slice(2));

if (args.help) {
  console.log(HELP_TEXT);
  exit(0);
}

const databaseUrl = process.env.RAILWAY_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("RAILWAY_URL (preferred) or DATABASE_URL is required");
  exit(1);
}

if (!args.force && !/railway/i.test(databaseUrl)) {
  console.error(`Refusing to reset a non-Railway target: ${maskDbUrl(databaseUrl)}`);
  console.error("Pass --force only if you intentionally want a different database.");
  exit(1);
}

const sql = postgres(databaseUrl, { max: 1, prepare: false });

try {
  const tables = await sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename ASC
  `;

  if (tables.length === 0) {
    console.error("No public tables found. Aborting.");
    await sql.end();
    exit(1);
  }

  const stats = await sql`
    SELECT relname AS tablename, n_live_tup::bigint AS estimated_rows
    FROM pg_stat_user_tables
    WHERE schemaname = 'public' AND n_live_tup > 0
    ORDER BY n_live_tup DESC, relname ASC
    LIMIT 15
  `;

  console.log(`Target: ${maskDbUrl(databaseUrl)}`);
  console.log(`Public tables to truncate: ${tables.length}`);
  if (stats.length > 0) {
    console.log("Top non-empty tables:");
    for (const row of stats) {
      console.log(`  - ${row.tablename}: ~${row.estimated_rows} rows`);
    }
  } else {
    console.log("No non-empty public tables detected.");
  }

  if (!args.yes) {
    const approved = await confirmReset(databaseUrl, tables.length);
    if (!approved) {
      console.log("Reset cancelled.");
      await sql.end();
      exit(0);
    }
  }

  const truncateSql = `TRUNCATE TABLE ${tables.map((row) => quoteIdent(row.tablename)).join(", ")} RESTART IDENTITY CASCADE`;
  console.log("\nResetting Railway database...");
  await sql.unsafe(truncateSql);
  console.log("  ✓ All public tables truncated");

  const postResetRows = await sql`
    SELECT COUNT(*)::int AS non_empty_tables
    FROM pg_stat_user_tables
    WHERE schemaname = 'public' AND n_live_tup > 0
  `;
  console.log(`  ✓ Non-empty tables after truncate: ${postResetRows[0]?.non_empty_tables ?? 0}`);
} catch (err) {
  console.error("\nDatabase reset failed:", err.message || String(err));
  await sql.end();
  exit(1);
}

await sql.end();

if (args.skipSeed) {
  console.log("\nSkipping reseed (--skip-seed).");
  exit(0);
}

console.log(`\nRunning seed script: ${args.seedScript}`);
const result = spawnSync(process.execPath, [args.seedScript], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    RAILWAY_URL: process.env.RAILWAY_URL || databaseUrl,
  },
});

if (result.status !== 0) {
  console.error(`\nSeed script failed with exit code ${result.status ?? 1}.`);
  exit(result.status ?? 1);
}

console.log("\nRailway reset + reseed complete.");
