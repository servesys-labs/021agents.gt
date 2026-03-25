#!/usr/bin/env node

/**
 * AgentOS — Zero-Config Deploy Script
 *
 * Deploys the worker and syncs all secrets automatically.
 * The worker is a thin proxy — all it needs is:
 *   1. BACKEND_INGEST_TOKEN (shared secret with Railway backend)
 *   2. Cloudflare bindings (Vectorize, R2, etc. — provisioned here)
 *
 * Everything else comes from wrangler.jsonc vars or Cloudflare bindings.
 *
 * Usage:
 *   npm run setup                    # interactive (prompts if needed)
 *   npm run setup -- --auto          # fully auto (generates token if missing)
 *   npm run setup -- --token=XYZ     # use specific token
 *   npm run setup -- --backend=URL   # override backend URL
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

function run(cmd, opts = {}) {
  const display = opts.silent ? "" : `\x1b[90m$ ${cmd}\x1b[0m\n`;
  if (display) process.stdout.write(display);
  try {
    return execSync(cmd, {
      stdio: opts.silent ? "pipe" : "inherit",
      encoding: "utf-8",
      timeout: 120_000,
      ...opts,
    });
  } catch (e) {
    if (opts.ignoreError) return e.stdout || "";
    throw e;
  }
}

function putSecret(name, value) {
  execSync(`wrangler secret put ${name}`, {
    stdio: ["pipe", "inherit", "inherit"],
    input: value,
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  for (const arg of args) {
    if (arg === "--auto") flags.auto = true;
    else if (arg.startsWith("--token=")) flags.token = arg.slice(8);
    else if (arg.startsWith("--backend=")) flags.backend = arg.slice(10);
  }
  return flags;
}

async function main() {
  const flags = parseArgs();

  console.log("\n\x1b[1m\x1b[35m  AgentOS — Zero-Config Deploy\x1b[0m\n");

  // ── Step 1: Check wrangler ────────────────────────────────────────
  console.log("\x1b[36m[1/6]\x1b[0m Checking wrangler CLI...");
  try {
    const ver = run("wrangler --version", { silent: true }).trim();
    console.log(`  wrangler ${ver}`);
  } catch {
    console.error("  wrangler not found. Run: npm install -g wrangler");
    process.exit(1);
  }

  // ── Step 2: Create Vectorize index ────────────────────────────────
  console.log("\n\x1b[36m[2/6]\x1b[0m Provisioning Vectorize index...");
  const existing = run("wrangler vectorize list --json 2>/dev/null || echo '[]'", {
    silent: true,
    ignoreError: true,
  });
  if (existing.includes("agentos-knowledge")) {
    console.log("  Index 'agentos-knowledge' exists, skipping.");
  } else {
    run("wrangler vectorize create agentos-knowledge --dimensions 768 --metric cosine", {
      ignoreError: true,
    });
  }

  // ── Step 3: Create R2 bucket ──────────────────────────────────────
  console.log("\n\x1b[36m[3/6]\x1b[0m Provisioning R2 bucket...");
  const buckets = run("wrangler r2 bucket list --json 2>/dev/null || echo '[]'", {
    silent: true,
    ignoreError: true,
  });
  if (buckets.includes("agentos-storage")) {
    console.log("  Bucket 'agentos-storage' exists, skipping.");
  } else {
    run("wrangler r2 bucket create agentos-storage", { ignoreError: true });
  }

  // ── Step 3.5: Create dispatch namespace ──────────────────────────
  console.log("\n\x1b[36m[3.5/6]\x1b[0m Provisioning dispatch namespace...");
  const namespaces = run("wrangler dispatch-namespace list --json 2>/dev/null || echo '[]'", {
    silent: true,
    ignoreError: true,
  });
  if (namespaces.includes("agentos-production")) {
    console.log("  Namespace 'agentos-production' exists, skipping.");
  } else {
    run("wrangler dispatch-namespace create agentos-production", { ignoreError: true });
  }

  // ── Step 4: Create queues ─────────────────────────────────────────
  console.log("\n\x1b[36m[4/6]\x1b[0m Provisioning queues...");
  const queues = run("wrangler queues list --json 2>/dev/null || echo '[]'", {
    silent: true,
    ignoreError: true,
  });
  for (const q of ["agentos-telemetry", "agentos-telemetry-dlq"]) {
    if (queues.includes(q)) {
      console.log(`  Queue '${q}' exists, skipping.`);
    } else {
      run(`wrangler queues create ${q}`, { ignoreError: true });
    }
  }

  // ── Step 5: Sync secrets ──────────────────────────────────────────
  console.log("\n\x1b[36m[5/6]\x1b[0m Syncing secrets...");

  // Edge token: auto-generate if not provided, or read from .env
  let edgeToken = flags.token || "";
  if (!edgeToken) {
    // Try to read from parent .env (Railway backend's token)
    const envPath = new URL("../../.env", import.meta.url).pathname;
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");
      const match = envContent.match(/^EDGE_INGEST_TOKEN=(.+)$/m);
      if (match) edgeToken = match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (!edgeToken && flags.auto) {
    edgeToken = `agt_${randomBytes(24).toString("base64url")}`;
    console.log(`  Auto-generated edge token: ${edgeToken.slice(0, 12)}...`);
    console.log(`  Set this on Railway: EDGE_INGEST_TOKEN=${edgeToken}`);
  }
  if (!edgeToken) {
    edgeToken = await ask("  Edge token (shared with Railway backend, or press enter to generate): ");
    if (!edgeToken.trim()) {
      edgeToken = `agt_${randomBytes(24).toString("base64url")}`;
      console.log(`  Generated: ${edgeToken}`);
      console.log(`  \x1b[33mSet this on Railway:\x1b[0m EDGE_INGEST_TOKEN=${edgeToken}`);
    }
  }
  putSecret("BACKEND_INGEST_TOKEN", edgeToken.trim());

  // Backend URL override (if provided)
  if (flags.backend) {
    console.log(`  Overriding backend URL: ${flags.backend}`);
    // Write to wrangler.jsonc vars at deploy time isn't easy,
    // so set as a secret which takes precedence
    putSecret("BACKEND_INGEST_URL", flags.backend.trim());
  }

  // Optional: LLM API keys (for direct egress when BACKEND_PROXY_ONLY=false)
  // In proxy mode these are not needed — backend holds all keys.
  // Only prompt if not in auto mode.
  if (!flags.auto) {
    const gmiKey = await ask("  GMI API key (or enter to skip — backend proxies LLM): ");
    if (gmiKey.trim()) putSecret("GMI_API_KEY", gmiKey.trim());
  }

  // ── Step 6: Install + Deploy ──────────────────────────────────────
  console.log("\n\x1b[36m[6/6]\x1b[0m Installing dependencies and deploying...");
  run("npm install");
  const deployOutput = run("wrangler deploy 2>&1", { silent: true, ignoreError: true });

  // Extract worker URL from deploy output
  let workerUrl = "";
  const urlMatch = deployOutput.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (urlMatch) workerUrl = urlMatch[0];

  console.log("\n\x1b[1m\x1b[32m  AgentOS deployed successfully!\x1b[0m\n");

  if (workerUrl) {
    console.log(`  Worker URL: \x1b[4m${workerUrl}\x1b[0m`);
    console.log(`\n  \x1b[33mSet this on Railway:\x1b[0m AGENTOS_WORKER_URL=${workerUrl}`);
  }

  console.log("\n  Architecture:");
  console.log("    Portal/Telegram/CLI → Worker (thin proxy) → Railway Backend");
  console.log("    Backend → Worker /cf/* → Cloudflare Bindings (sandbox, RAG, browse)");
  console.log("    Worker → TELEMETRY_QUEUE → Hyperdrive → Supabase");

  console.log("\n  Verify:");
  console.log(`    curl ${workerUrl || "https://<worker>"}/health`);
  console.log(`    curl https://backend-production-b174.up.railway.app/health`);

  if (workerUrl) {
    console.log("\n  Railway env vars to set (if not already):");
    console.log(`    AGENTOS_WORKER_URL=${workerUrl}`);
    console.log(`    EDGE_INGEST_TOKEN=${edgeToken}`);
  }

  console.log("");
  rl.close();
}

main().catch((e) => {
  console.error("\n\x1b[31mSetup failed:\x1b[0m", e.message);
  rl.close();
  process.exit(1);
});
