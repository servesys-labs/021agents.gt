#!/usr/bin/env node
/**
 * Migrate legacy evolution proposals/ledger JSON files into Postgres.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-evolve-from-filesystem.mjs \
 *     --root ../data/evolution \
 *     --agent my-agent \
 *     --org-id org_123
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import postgres from "postgres";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = value;
  }
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonArray(filePath) {
  if (!(await exists(filePath))) return [];
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function tableColumns(sql, tableName) {
  const rows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = ${tableName}
    ORDER BY ordinal_position
  `;
  return rows.map((r) => String(r.column_name));
}

function normalizeRecord(record, defaults) {
  const out = { ...record };
  for (const [k, v] of Object.entries(defaults)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
  }
  return out;
}

async function insertRecords(sql, table, columns, records, dryRun) {
  if (records.length === 0) return 0;
  let inserted = 0;
  for (const record of records) {
    const filtered = {};
    for (const c of columns) {
      if (record[c] !== undefined) filtered[c] = record[c];
    }
    if (Object.keys(filtered).length === 0) continue;

    if (!dryRun) {
      await sql`
        INSERT INTO ${sql(table)} ${sql(filtered)}
      `;
    }
    inserted += 1;
  }
  return inserted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL || "";
  const root = path.resolve(process.cwd(), String(args.root || "../data/evolution"));
  const agent = String(args.agent || "").trim();
  const orgId = String(args["org-id"] || "").trim();
  const dryRun = String(args["dry-run"] || "false").toLowerCase() === "true";

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!agent) throw new Error("--agent is required");
  if (!orgId) throw new Error("--org-id is required");

  const agentDir = path.join(root, agent);
  const proposals = await readJsonArray(path.join(agentDir, "proposals.json"));
  const ledger = await readJsonArray(path.join(agentDir, "ledger.json"));

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const proposalCols = await tableColumns(sql, "evolution_proposals");
    const ledgerCols = await tableColumns(sql, "evolution_ledger");
    if (proposalCols.length === 0) throw new Error("Table evolution_proposals not found");
    if (ledgerCols.length === 0) throw new Error("Table evolution_ledger not found");

    const now = Date.now() / 1000;
    const proposalRecords = proposals.map((p, idx) =>
      normalizeRecord(
        {
          ...p,
          proposal_id: p?.proposal_id || p?.id || `migrated-${agent}-${idx + 1}`,
          agent_name: agent,
          org_id: orgId,
          created_at: Number(p?.created_at || now),
          status: String(p?.status || "pending"),
        },
        {},
      ),
    );
    const ledgerRecords = ledger.map((l) =>
      normalizeRecord(
        {
          ...l,
          agent_name: agent,
          org_id: orgId,
          created_at: Number(l?.created_at || now),
          action: String(l?.action || "migrated"),
        },
        {},
      ),
    );

    const insertedProposals = await insertRecords(
      sql,
      "evolution_proposals",
      proposalCols,
      proposalRecords,
      dryRun,
    );
    const insertedLedger = await insertRecords(sql, "evolution_ledger", ledgerCols, ledgerRecords, dryRun);

    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: dryRun,
          root,
          agent,
          org_id: orgId,
          proposals_found: proposals.length,
          ledger_found: ledger.length,
          proposals_inserted: insertedProposals,
          ledger_inserted: insertedLedger,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
