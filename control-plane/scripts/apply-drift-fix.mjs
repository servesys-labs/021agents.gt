#!/usr/bin/env node
/**
 * One-off schema drift repair for production.
 *
 * Applies ALTER/UPDATE statements to align the prod schema with the
 * updated 001_init.sql after the April 2026 live smoke test surfaced
 * five tables whose schema had drifted from the code's expectations:
 *
 *   - conversation_scores (missing ~15 columns)
 *   - voice_calls         (missing platform, platform_agent_id, started_at, call_id PK)
 *   - gold_images         (missing image_id PK, name, description, version, category, config_hash, created_by)
 *   - security_scans      (missing started_at)
 *   - issues              (missing issue_id PK)
 *
 * Safe to re-run — every statement uses IF NOT EXISTS / IF EXISTS guards.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/apply-drift-fix.mjs
 *   (or put DATABASE_URL in the repo-root .env)
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  console.error("DATABASE_URL is not set. Put it in .env or export it.");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

/**
 * Each entry is a chatty label + an array of statements. Statements run
 * in sequence; errors are logged but don't stop the batch so later fixes
 * still apply. Everything uses IF NOT EXISTS guards so re-running is safe.
 */
const batches = [
  {
    label: "conversation_scores: add turn-level quality metric columns",
    statements: [
      `ALTER TABLE conversation_scores ALTER COLUMN conversation_id DROP NOT NULL`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS turn_number INT NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS agent_name TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS sentiment TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC(6,4) NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS sentiment_confidence NUMERIC(6,4) NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS relevance_score NUMERIC(6,4) NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS coherence_score NUMERIC(6,4) NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS helpfulness_score NUMERIC(6,4) NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS safety_score NUMERIC(6,4) NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS quality_overall NUMERIC(6,4) NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS topic TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS has_tool_failure INT NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS has_hallucination_risk INT NOT NULL DEFAULT 0`,
      `ALTER TABLE conversation_scores ADD COLUMN IF NOT EXISTS scorer_model TEXT NOT NULL DEFAULT ''`,
      // Upsert key for (session_id, turn_number) — wrapped in DO so re-run doesn't fail.
      `DO $$ BEGIN
         CREATE UNIQUE INDEX conversation_scores_session_turn_key
           ON conversation_scores (session_id, turn_number);
       EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$`,
    ],
  },
  {
    label: "security_scans: add started_at",
    statements: [
      `ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ],
  },
  {
    label: "voice_calls: add platform columns + rename id → call_id",
    statements: [
      `ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'twilio'`,
      `ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS platform_agent_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS phone_number TEXT NOT NULL DEFAULT ''`,
      // Rename id → call_id. Fails if call_id already exists (already renamed).
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'voice_calls' AND column_name = 'id')
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'voice_calls' AND column_name = 'call_id') THEN
           ALTER TABLE voice_calls RENAME COLUMN id TO call_id;
         END IF;
       END $$`,
    ],
  },
  {
    label: "issues: rename id → issue_id",
    statements: [
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'issues' AND column_name = 'id')
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'issues' AND column_name = 'issue_id') THEN
           ALTER TABLE issues RENAME COLUMN id TO issue_id;
         END IF;
       END $$`,
    ],
  },
  {
    label: "gold_images: add missing columns + rename id → image_id",
    statements: [
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS config_hash TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS approved_by TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
      `ALTER TABLE gold_images ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'gold_images' AND column_name = 'id')
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'gold_images' AND column_name = 'image_id') THEN
           ALTER TABLE gold_images RENAME COLUMN id TO image_id;
         END IF;
       END $$`,
    ],
  },
];

let pass = 0;
let fail = 0;
for (const batch of batches) {
  console.log(`\n▶ ${batch.label}`);
  for (const stmt of batch.statements) {
    try {
      await sql.unsafe(stmt);
      pass++;
      const preview = stmt.replace(/\s+/g, " ").slice(0, 90);
      console.log(`  ✓ ${preview}${preview.length < stmt.length ? "…" : ""}`);
    } catch (err) {
      fail++;
      console.error(`  ✗ ${stmt.slice(0, 120)}`);
      console.error(`     ${err.message}`);
    }
  }
}

await sql.end();
console.log(`\n${pass} statements applied, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
