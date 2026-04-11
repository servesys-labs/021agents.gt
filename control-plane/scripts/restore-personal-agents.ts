#!/usr/bin/env npx tsx
/**
 * Restore the default "my-assistant" personal agent for a known list of
 * users whose agent row was wiped (e.g. by rls-smoke-test.mjs doing
 * DROP SCHEMA public CASCADE).
 *
 * The personal agent is normally auto-created by /auth/signup and
 * /auth/cf-access-exchange (see control-plane/src/routes/auth.ts:320 and
 * :747). Existing users who weren't signing up won't get it
 * re-created automatically — this script plugs that gap.
 *
 * Uses the canonical buildPersonalAgentPrompt() from the source tree so
 * the prompt always matches whatever the current release ships.
 *
 * The insert is idempotent: if the user already has a 'my-assistant'
 * row we report it and skip. If the user doesn't exist at all, we
 * report and skip.
 *
 * Usage:
 *   cd control-plane && npx tsx scripts/restore-personal-agents.ts
 *
 * Reads DATABASE_URL from ../../.env or environment.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";
import { buildPersonalAgentPrompt } from "../src/prompts/personal-agent";

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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[restore-pa] DATABASE_URL not set in env or .env");
  process.exit(1);
}

// Targeted restore — add more emails here if a future wipe takes out
// more users. Kept explicit rather than "all users" so nothing gets
// created by accident on a shared DB.
const TARGET_EMAILS = [
  "founder@oneshots.co",
  "stella@021agents.ai",
];

// ── Personal agent config factory ────────────────────────────────
// Mirrors the shape built inline in routes/auth.ts around line 324
// (email signup path). If that config shape drifts, update this
// factory to match — or extract both to a shared helper.
function buildPersonalAgentConfig(displayName: string) {
  return {
    name: "my-assistant",
    description: `${displayName}'s personal AI assistant`,
    system_prompt: buildPersonalAgentPrompt(displayName),
    model: "", // Let plan routing handle model selection
    plan: "free",
    tools: [
      "web-search", "browse",
      "python-exec", "bash",
      "read-file", "write-file",
      "memory-save", "memory-recall",
      "create-schedule", "list-schedules", "delete-schedule",
    ],
    max_turns: 50,
    temperature: 0.7,
    tags: ["personal", "assistant"],
    version: "1.0.0",
    governance: { budget_limit_usd: 10 },
    reasoning_strategy: "",
    use_code_mode: true,
    parallel_tool_calls: true,
    is_personal: true,
  };
}

async function main() {
  const sql = postgres(DATABASE_URL!, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });

  const results: Array<{ email: string; status: string; detail: string }> = [];

  try {
    for (const email of TARGET_EMAILS) {
      // 1. Find the user row.
      const userRows = await sql`
        SELECT user_id, email, name
        FROM users
        WHERE email = ${email}
        LIMIT 1
      `;
      if (userRows.length === 0) {
        results.push({ email, status: "skipped", detail: "user row not found" });
        continue;
      }
      const user = userRows[0] as { user_id: string; email: string; name: string | null };

      // 2. Find the org this user belongs to. Prefer owner, then
      // earliest-created membership.
      const memberRows = await sql`
        SELECT org_id, role, created_at
        FROM org_members
        WHERE user_id = ${user.user_id}
        ORDER BY
          CASE WHEN role = 'owner' THEN 0 ELSE 1 END,
          created_at ASC
        LIMIT 1
      `;
      if (memberRows.length === 0) {
        results.push({ email, status: "skipped", detail: "no org membership" });
        continue;
      }
      const orgId = String(memberRows[0].org_id);

      // 3. Does a personal agent already exist for this org?
      const existing = await sql`
        SELECT agent_id, is_active
        FROM agents
        WHERE org_id = ${orgId} AND name = 'my-assistant'
        LIMIT 1
      `;
      if (existing.length > 0) {
        results.push({
          email,
          status: "exists",
          detail: `org ${orgId}, agent_id ${existing[0].agent_id} (active=${existing[0].is_active})`,
        });
        continue;
      }

      // 4. Build the config and insert.
      const displayName = user.name || email.split("@")[0];
      const config = buildPersonalAgentConfig(displayName);
      const agentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const description = `${displayName}'s personal AI assistant`;

      await sql`
        INSERT INTO agents (
          agent_id, name, org_id, description, config, version,
          is_active, created_by, created_at, updated_at
        ) VALUES (
          ${agentId}, 'my-assistant', ${orgId}, ${description},
          ${JSON.stringify(config)}, '1.0.0',
          ${true}, ${user.user_id}, now(), now()
        )
      `;

      results.push({
        email,
        status: "created",
        detail: `org ${orgId}, agent_id ${agentId}, display "${displayName}"`,
      });
    }
  } finally {
    // Let Node GC the socket — see rls-smoke-test.mjs for the Supabase
    // pooler reasons behind not calling sql.end().
  }

  // Report
  console.log("\n[restore-pa] Results:");
  for (const r of results) {
    const mark =
      r.status === "created" ? "✓" :
      r.status === "exists" ? "·" : "⚠";
    console.log(`  ${mark} ${r.email} — ${r.status}: ${r.detail}`);
  }
  const created = results.filter(r => r.status === "created").length;
  const exists = results.filter(r => r.status === "exists").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  console.log(`\n[restore-pa] ${created} created, ${exists} already present, ${skipped} skipped.`);

  if (skipped > 0) {
    // Skipping is not necessarily a hard error (user may not exist yet),
    // but exit non-zero so a scripted runner notices.
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[restore-pa] Fatal error:", err);
  process.exit(1);
});
