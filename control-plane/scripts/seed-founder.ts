import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { hashPassword } from "../src/auth/password";
import { bootstrapPersonalOrg } from "../src/logic/personal-org-bootstrap";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedUser {
  email: string;
  password: string;
  name: string;
  userId: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
}

const USERS: SeedUser[] = [
  {
    email: "founder@oneshots.co",
    password: "OneShots2026!",
    name: "Founder",
    userId: "usr_founder_001",
    orgId: "org_oneshots_001",
    orgName: "OneShots",
    orgSlug: "oneshots",
  },
  {
    email: "Stella@021agents.ai",
    password: "021Agents!",
    name: "Stella",
    userId: "usr_stella_001",
    orgId: "org_021agents_001",
    orgName: "021 Agents",
    orgSlug: "021agents",
  },
];

function loadEnv(): void {
  try {
    const envPath = resolve(__dirname, "../../.env");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}

function maskDbUrl(url: string): string {
  return url.replace(/:\/\/[^@]+@/, "://***:***@");
}

loadEnv();

const DATABASE_URL: string = process.env.RAILWAY_URL || process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  console.error("RAILWAY_URL (preferred) or DATABASE_URL not found in env or .env");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

async function seedUser(user: SeedUser): Promise<void> {
  console.log(`\n→ ${user.email}`);
  const nowIso = new Date().toISOString();
  const passwordHash = await hashPassword(user.password);

  await sql.begin(async (tx) => {
    const scopedSql = tx as unknown as ReturnType<typeof postgres>;

    const [existingUser] = await scopedSql`
      SELECT user_id
      FROM users
      WHERE email = ${user.email}
      LIMIT 1
    `;
    const userId = existingUser ? String(existingUser.user_id) : user.userId;

    await scopedSql`
      INSERT INTO users (
        user_id,
        email,
        name,
        password_hash,
        provider,
        is_active,
        email_verified,
        created_at,
        updated_at
      )
      VALUES (${userId}, ${user.email}, ${user.name}, ${passwordHash}, ${"local"}, ${true}, ${true}, ${nowIso}, ${nowIso})
      ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        name = EXCLUDED.name,
        provider = EXCLUDED.provider,
        is_active = EXCLUDED.is_active,
        email_verified = EXCLUDED.email_verified,
        updated_at = EXCLUDED.updated_at
    `;
    console.log(`  ✓ user  ${userId}`);

    const [existingOrg] = await scopedSql`
      SELECT org_id
      FROM orgs
      WHERE slug = ${user.orgSlug}
      LIMIT 1
    `;
    const orgId = existingOrg ? String(existingOrg.org_id) : user.orgId;

    const bootstrap = await bootstrapPersonalOrg(scopedSql as any, {
      orgId,
      userId,
      email: user.email,
      displayName: user.name,
      orgName: user.orgName,
      orgSlug: user.orgSlug,
      nowIso,
      plan: "pro",
      planType: "pro",
      starterCreditsUsd: 100,
      starterCreditDescription: "Founder seed bonus",
      starterCreditReferenceId: `seed:${user.orgSlug}`,
      starterCreditReferenceType: "founder_seed",
    });

    console.log(`  ✓ org   ${orgId} (${user.orgName})`);
    if (bootstrap.seededAgents.length > 0) {
      console.log(`  ✓ agents ${bootstrap.seededAgents.join(", ")}`);
    }
    if (bootstrap.projectId) {
      console.log(`  ✓ project ${bootstrap.projectId}`);
    }
    console.log(`  ✓ credits ${bootstrap.creditsSeeded ? "$100 seeded" : "existing balance kept"}`);
    if (bootstrap.referralCodeCreated) {
      console.log("  ✓ referral link");
    }
  });
}

async function main() {
  console.log(`Seeding ${USERS.length} users against ${maskDbUrl(DATABASE_URL)}\n`);

  try {
    for (const user of USERS) {
      await seedUser(user);
    }
  } catch (err: any) {
    console.error("\nSeed failed:", err?.message || String(err));
    if (err?.detail) console.error("  detail:", err.detail);
    if (err?.hint) console.error("  hint:  ", err.hint);
    await sql.end();
    process.exit(1);
  }

  await sql.end();

  console.log(`
═══ Done ═══

Login credentials:

  1. ${USERS[0].email}
     password: ${USERS[0].password}
     org:      ${USERS[0].orgName}

  2. ${USERS[1].email}
     password: ${USERS[1].password}
     org:      ${USERS[1].orgName}

Re-run any time — the script is idempotent and refreshes password hashes.
`);
}

main().catch((err) => { console.error(err); process.exit(1); });
