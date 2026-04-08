#!/usr/bin/env npx tsx
/**
 * Push the personal agent system prompt to the database.
 *
 * Usage:
 *   cd control-plane && npx tsx scripts/push-prompt.ts
 *   cd control-plane && npx tsx scripts/push-prompt.ts --org org_xxx --agent my-assistant --user "Ish"
 *
 * This ensures the DB always has the latest prompt from the source code.
 * Run this after modifying control-plane/src/prompts/personal-agent.ts.
 */

import { buildPersonalAgentPrompt } from "../src/prompts/personal-agent";
import postgres from "postgres";

async function main() {
  const orgId = process.argv.find(a => a.startsWith("--org"))?.split("=")[1]
    || process.env.ORG_ID
    || "org_1a8e9338d8ec4cf7";
  const agentName = process.argv.find(a => a.startsWith("--agent"))?.split("=")[1]
    || process.env.AGENT_NAME
    || "my-assistant";
  const userName = process.argv.find(a => a.startsWith("--user"))?.split("=")[1]
    || process.env.USER_NAME
    || "there";

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not set. Run from control-plane/ with .env loaded.");
    process.exit(1);
  }

  const prompt = buildPersonalAgentPrompt(userName);
  console.log(`Prompt: ${prompt.length} chars`);
  console.log(`Contains swarm: ${prompt.includes("swarm")}`);
  console.log(`Contains execute-code: ${prompt.includes("execute-code")}`);

  const sql = postgres(dbUrl);

  const rows = await sql`
    SELECT config FROM agents
    WHERE org_id = ${orgId} AND name = ${agentName}
  `;

  if (rows.length === 0) {
    console.error(`Agent ${agentName} not found in org ${orgId}`);
    await sql.end();
    process.exit(1);
  }

  const cfg = typeof rows[0].config === "string"
    ? JSON.parse(rows[0].config)
    : rows[0].config;

  // Update system prompt
  cfg.system_prompt = prompt;

  // Also sync the tools list from personal-assistant.json
  cfg.tools = [
    "web-search", "browse", "python-exec", "bash",
    "read-file", "write-file", "edit-file",
    "memory-save", "memory-recall",
    "execute-code", "swarm",
  ];

  await sql`
    UPDATE agents
    SET config = ${JSON.stringify(cfg)}
    WHERE org_id = ${orgId} AND name = ${agentName}
  `;

  console.log(`✓ Pushed prompt + tools to ${agentName} in ${orgId}`);
  await sql.end();
}

main().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
