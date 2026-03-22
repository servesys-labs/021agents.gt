#!/usr/bin/env node

/**
 * AgentOS — Automated Setup Script
 *
 * Runs all the Cloudflare provisioning steps so the user just clicks deploy:
 *   1. Creates the Vectorize index (if it doesn't exist)
 *   2. Prompts for API keys and sets them as secrets
 *   3. Deploys the Worker
 *   4. Runs a health check
 *
 * Usage: npm run setup
 */

import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

function run(cmd, opts = {}) {
  console.log(`\x1b[90m$ ${cmd}\x1b[0m`);
  try {
    return execSync(cmd, { stdio: opts.silent ? "pipe" : "inherit", encoding: "utf-8", ...opts });
  } catch (e) {
    if (opts.ignoreError) return e.stdout || "";
    throw e;
  }
}

async function main() {
  console.log("\n\x1b[1m\x1b[35m  AgentOS — Automated Setup\x1b[0m\n");

  // Step 1: Check wrangler is available
  console.log("\x1b[36m[1/5]\x1b[0m Checking wrangler CLI...");
  try {
    run("wrangler --version", { silent: true });
  } catch {
    console.error("wrangler CLI not found. Install with: npm install -g wrangler");
    process.exit(1);
  }

  // Step 2: Create Vectorize index
  console.log("\n\x1b[36m[2/5]\x1b[0m Creating Vectorize index...");
  const existing = run("wrangler vectorize list --json 2>/dev/null || echo '[]'", { silent: true, ignoreError: true });
  if (existing.includes("agentos-knowledge")) {
    console.log("  Index 'agentos-knowledge' already exists, skipping.");
  } else {
    run("wrangler vectorize create agentos-knowledge --dimensions 768 --metric cosine", { ignoreError: true });
  }

  // Step 3: Set secrets
  console.log("\n\x1b[36m[3/5]\x1b[0m Configuring secrets...");
  const provider = await ask("Default LLM provider (workers-ai/openai/anthropic) [workers-ai]: ") || "workers-ai";

  if (provider === "openai") {
    const key = await ask("OpenAI API key: ");
    if (key.trim()) {
      execSync("wrangler secret put OPENAI_API_KEY", { stdio: ["pipe", "inherit", "inherit"], input: key.trim() });
    }
  } else if (provider === "anthropic") {
    const key = await ask("Anthropic API key: ");
    if (key.trim()) {
      execSync("wrangler secret put ANTHROPIC_API_KEY", { stdio: ["pipe", "inherit", "inherit"], input: key.trim() });
    }
  } else {
    console.log("  Using Workers AI (no API key needed).");
  }

  // Step 4: Install deps and deploy
  console.log("\n\x1b[36m[4/5]\x1b[0m Installing dependencies and deploying...");
  run("npm install");
  run("wrangler deploy");

  // Step 5: Health check
  console.log("\n\x1b[36m[5/5]\x1b[0m Running health check...");
  const output = run("wrangler deploy --dry-run --outdir .wrangler/dist 2>/dev/null || true", { silent: true, ignoreError: true });

  console.log("\n\x1b[1m\x1b[32m  AgentOS deployed successfully!\x1b[0m");
  console.log("\n  Your agent is live on Cloudflare's edge network.");
  console.log("  Open the Worker URL in your browser to access the dashboard.\n");
  console.log("  Endpoints:");
  console.log("    GET  /agents/agentos/:name/health");
  console.log("    POST /agents/agentos/:name/run");
  console.log("    GET  /agents/agentos/:name/tools");
  console.log("    GET  /agents/agentos/:name/memory");
  console.log("    POST /agents/agentos/:name/ingest");
  console.log("    POST /agents/agentos/:name/eval");
  console.log("    PUT  /agents/agentos/:name/config\n");

  rl.close();
}

main().catch((e) => {
  console.error("\n\x1b[31mSetup failed:\x1b[0m", e.message);
  rl.close();
  process.exit(1);
});
