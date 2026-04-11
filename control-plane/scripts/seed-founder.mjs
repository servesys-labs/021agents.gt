#!/usr/bin/env node
/**
 * Seed the prototype database with two user accounts.
 *
 * This script assumes `001_init.sql` has already been applied to a
 * fresh schema — it does NOT run migrations. On a prototype DB the
 * canonical reset flow is:
 *
 *   psql $DATABASE_URL -f control-plane/src/db/migrations/001_init.sql
 *   node control-plane/scripts/seed-founder.mjs
 *
 * Creates:
 *   1. founder@oneshots.co / OneShots2026!  (OneShots org, $100 credits)
 *   2. Stella@021agents.ai / 021Agents!     (021 Agents org, $100 credits)
 *
 * Each user gets a `my-assistant` personal agent — the default the
 * signup route auto-creates — so the smoke test and any JWT-backed
 * write endpoints have a real agent to target.
 *
 * Idempotent: re-running updates the password hash and leaves
 * credits / org unchanged. Safe to re-run any time.
 *
 * Reads DATABASE_URL from the repo-root .env (or env var).
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
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not found in env or .env");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

// ── PBKDF2 hash (matches control-plane/src/auth/password.ts) ─────
async function hashPassword(password) {
  const saltRaw = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...saltRaw].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(saltHex), iterations: 100_000 },
    key,
    32 * 8,
  );
  const hashHex = [...new Uint8Array(derived)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${saltHex}:${hashHex}`;
}

// ── Users to seed ────────────────────────────────────────────────
const USERS = [
  {
    email: "founder@oneshots.co",
    password: "OneShots2026!",
    name: "Founder",
    org_name: "OneShots",
    org_slug: "oneshots",
  },
  {
    email: "Stella@021agents.ai",
    password: "021Agents!",
    name: "Stella",
    org_name: "021 Agents",
    org_slug: "021agents",
  },
];

function genId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function personalAgentConfig() {
  return {
    name: "my-assistant",
    description: "Personal AI assistant",
    system_prompt:
      "You are the user's personal AI assistant on OneShots. Help with research, coding, " +
      "scheduling, memory, and general daily tasks. Keep responses concise and actionable.",
    model: "",
    plan: "pro",
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

async function seedUser(user) {
  console.log(`\n→ ${user.email}`);
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(user.password);

  // Resolve existing user_id if the account already exists.
  const existingUser = await sql`
    SELECT user_id FROM users WHERE email = ${user.email} LIMIT 1
  `;
  const userId = existingUser.length > 0 ? String(existingUser[0].user_id) : genId("user");

  // Upsert user. Password hash is refreshed on every run so the
  // script is the single source of truth for prototype credentials.
  await sql`
    INSERT INTO users (user_id, email, name, password_hash, provider, is_active, email_verified, created_at, updated_at)
    VALUES (${userId}, ${user.email}, ${user.name}, ${passwordHash}, 'email', true, true, ${now}, ${now})
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      name          = EXCLUDED.name,
      is_active     = true,
      updated_at    = ${now}
  `;
  console.log(`  ✓ user  ${userId}`);

  // Resolve the existing org by slug (the stable identifier a re-run
  // is most likely to match against), falling back to a new org_id.
  // Slug lookup is correct even when the existing owner_user_id
  // differs from the seed's freshly-generated user id.
  const existingOrg = await sql`
    SELECT org_id FROM orgs WHERE slug = ${user.org_slug} LIMIT 1
  `;
  let orgId;
  if (existingOrg.length > 0) {
    orgId = String(existingOrg[0].org_id);
    await sql`
      UPDATE orgs SET
        name          = ${user.org_name},
        owner_user_id = ${userId},
        plan          = 'pro',
        updated_at    = ${now}
      WHERE org_id = ${orgId}
    `;
  } else {
    orgId = genId("org");
    await sql`
      INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at, updated_at)
      VALUES (${orgId}, ${user.org_name}, ${user.org_slug}, ${userId}, 'pro', ${now}, ${now})
    `;
  }
  console.log(`  ✓ org   ${orgId} (${user.org_name})`);

  // Org membership as owner.
  await sql`
    INSERT INTO org_members (org_id, user_id, role, created_at)
    VALUES (${orgId}, ${userId}, 'owner', ${now})
    ON CONFLICT DO NOTHING
  `;

  // $100 starter credits (only on first seed — re-runs leave the
  // balance alone so it's safe to re-seed after smoke tests spend
  // a few cents).
  await sql`
    INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, lifetime_consumed_usd, updated_at)
    VALUES (${orgId}, 100, 100, 0, ${now})
    ON CONFLICT (org_id) DO NOTHING
  `;
  console.log("  ✓ credits $100 (or existing balance)");

  // Personal "my-assistant" agent.
  const configJson = JSON.stringify(personalAgentConfig());
  await sql`
    INSERT INTO agents (agent_id, org_id, name, description, version, config, is_active, agent_role, created_by, created_at, updated_at)
    VALUES (
      ${genId("agt")}, ${orgId}, 'my-assistant', 'Personal AI assistant',
      '1.0.0', ${configJson}, true, 'personal_assistant', ${userId}, ${now}, ${now}
    )
    ON CONFLICT (name, org_id) DO UPDATE SET
      config     = EXCLUDED.config,
      is_active  = true,
      updated_at = ${now}
  `;
  console.log("  ✓ agent my-assistant");
}

// ── Run ──────────────────────────────────────────────────────────
console.log(`Seeding ${USERS.length} users against ${DATABASE_URL.replace(/:\/\/[^@]+@/, "://***:***@")}\n`);

try {
  for (const user of USERS) {
    await seedUser(user);
  }
} catch (err) {
  console.error("\nSeed failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  if (err.hint) console.error("  hint:  ", err.hint);
  await sql.end();
  process.exit(1);
}

await sql.end();

console.log(`
═══ Done ═══

Login credentials:

  1. ${USERS[0].email}
     password: ${USERS[0].password}
     org:      ${USERS[0].org_name}

  2. ${USERS[1].email}
     password: ${USERS[1].password}
     org:      ${USERS[1].org_name}

Re-run any time — the script is idempotent and refreshes password hashes.
`);
