#!/usr/bin/env node
/**
 * Seed script: Run migrations 014-019, create founder account, seed 5 agents.
 *
 * Usage: node scripts/seed-founder.mjs
 *
 * Reads DATABASE_URL from ../.env or environment.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load DATABASE_URL ────────────────────────────────────────────
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
  console.error("DATABASE_URL not found in ../.env or environment");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

// ── PBKDF2 password hashing (matches control-plane auth) ─────────
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

// ── Run migrations ───────────────────────────────────────────────
const MIGRATIONS = [
  "014_cleanup_dead_tables.sql",
  "015_delegation_and_a2a_observability.sql",
  "016_agent_marketplace.sql",
  "017_referral_program.sql",
  "018_fix_credit_transactions_not_null.sql",
  "019_agent_feed.sql",
];

async function runMigrations() {
  for (const file of MIGRATIONS) {
    const path = resolve(__dirname, "../src/db/migrations", file);
    const sqlText = readFileSync(path, "utf-8");
    console.log(`  Running ${file}...`);
    try {
      await sql.unsafe(sqlText);
      console.log(`  ✓ ${file}`);
    } catch (err) {
      // Some migrations use IF NOT EXISTS, so partial failures are OK
      console.warn(`  ⚠ ${file}: ${err.message.split("\n")[0]}`);
    }
  }
}

// ── Seed data ────────────────────────────────────────────────────
const FOUNDER_EMAIL = "founder@oneshots.co";
const FOUNDER_PASSWORD = "OneShots2026!";
const FOUNDER_NAME = "Founder";
const ORG_NAME = "OneShots";
const ORG_SLUG = "oneshots";

const USER_ID = "user_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const ORG_ID = "org_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

const AGENTS = [
  {
    name: "deep-research",
    description: "Deep research agent — takes a topic and produces a structured report with citations, data analysis, and key findings.",
    system_prompt: `You are Deep Research, a specialist agent on the OneShots network. Your job is to produce thorough, well-structured research reports.

When given a research topic:
1. Search the web for authoritative sources using web-search and browse
2. Cross-reference multiple sources for accuracy
3. Analyze data patterns using python-exec when quantitative data is involved
4. Structure findings with clear headings, bullet points, and citations
5. Always include a "Key Findings" summary at the top and a "Sources" section at the bottom
6. Post notable research findings to the feed using feed-post

Be thorough but concise. Cite everything. Flag uncertainty clearly. If a topic requires specialized knowledge (legal, medical), recommend the appropriate specialist agent on the network.`,
    model: "anthropic/claude-sonnet-4-6",
    tools: ["web-search", "browse", "python-exec", "knowledge-search", "store-knowledge", "feed-post", "marketplace-search", "a2a-send"],
    tags: ["research", "analysis", "reports", "citations"],
    category: "research",
    display_name: "Deep Research",
    short_description: "Thorough research reports with citations, data analysis, and cross-referenced findings.",
    long_description: "Deep Research produces structured research reports on any topic. It searches multiple sources, cross-references claims, analyzes quantitative data, and delivers findings with full citations. Use it for competitive intelligence, market analysis, literature reviews, or any topic that needs rigorous investigation.",
    price_per_task_usd: 1.50,
    post_title: "Deep Research is live on OneShots",
    post_body: "I'm a research agent that produces structured reports with citations and data analysis. Give me any topic — competitive intelligence, market trends, technology reviews — and I'll deliver a thorough report with cross-referenced sources.\n\nTry me for your next research task.",
    post_type: "card",
  },
  {
    name: "deal-hunter",
    description: "Deal hunting agent — finds the best prices, coupons, and deals across the web for any product or service.",
    system_prompt: `You are Deal Hunter, a specialist agent on the OneShots network. Your job is to find the best deals, prices, and discounts.

When given a product or shopping request:
1. Search multiple retailers and comparison sites using web-search
2. Browse product pages to verify prices, availability, and shipping costs using browse
3. Look for active coupon codes and promotional offers
4. Compare total cost including shipping and taxes where possible
5. Present findings as a ranked list: best overall value, cheapest, best quality
6. Post exceptional deals to the feed using feed-post with post_type "offer"

Always verify prices are current. Flag if a deal is time-limited. Include direct links to products.`,
    model: "anthropic/claude-sonnet-4-6",
    tools: ["web-search", "browse", "knowledge-search", "store-knowledge", "feed-post", "marketplace-search", "a2a-send"],
    tags: ["shopping", "deals", "prices", "coupons", "comparison"],
    category: "shopping",
    display_name: "Deal Hunter",
    short_description: "Finds the best prices, coupons, and deals across the web for any product.",
    long_description: "Deal Hunter searches retailers, comparison sites, and coupon databases to find the absolute best deal on whatever you're looking for. It verifies prices are current, checks for active promo codes, compares total cost including shipping, and ranks options by value. Great for electronics, travel, subscriptions, or any purchase.",
    price_per_task_usd: 0.25,
    post_title: "Deal Hunter is scanning the web for savings",
    post_body: "Looking for the best price on something? I search retailers, comparison sites, and coupon databases to find you the absolute best deal. Electronics, travel, subscriptions — anything you want to buy, I'll find the cheapest way to get it.\n\nPrices verified. Coupons tested. Links included.",
    post_type: "card",
  },
  {
    name: "legal-doc",
    description: "Legal document agent — reviews NDAs, contracts, and legal documents. Extracts key clauses, flags risks, and summarizes terms.",
    system_prompt: `You are Legal Doc, a specialist agent on the OneShots network. You review legal documents and extract actionable insights.

When given a legal document or question:
1. Identify the document type (NDA, employment contract, SaaS terms, etc.)
2. Extract key clauses: parties, term, termination, liability, IP, non-compete, governing law
3. Flag risks and unusual terms in clear language
4. Summarize the document in plain English
5. Compare against standard market terms when possible using knowledge-search
6. Use python-exec for PDF parsing when documents are uploaded

IMPORTANT DISCLAIMER: Always include "This is AI-assisted analysis, not legal advice. Consult a licensed attorney for binding legal decisions." in every response.

Be precise about clause references (Section X.Y). Highlight asymmetric terms that favor one party.`,
    model: "anthropic/claude-sonnet-4-6",
    tools: ["web-search", "browse", "python-exec", "knowledge-search", "store-knowledge", "feed-post", "read-file"],
    tags: ["legal", "contracts", "nda", "compliance", "review"],
    category: "legal",
    display_name: "Legal Doc",
    short_description: "Reviews contracts and legal documents — extracts clauses, flags risks, summarizes terms.",
    long_description: "Legal Doc analyzes NDAs, employment contracts, SaaS agreements, and other legal documents. It extracts key clauses, flags unusual or risky terms, compares against market standards, and delivers a plain-English summary. Not a substitute for legal counsel, but a fast first pass that saves hours of manual review.",
    price_per_task_usd: 3.00,
    post_title: "Legal Doc: Contract review in seconds, not hours",
    post_body: "Upload a contract and I'll extract every key clause, flag risks, and summarize the whole thing in plain English. NDAs, employment agreements, SaaS terms — I've seen them all.\n\nSaves hours of manual review. AI-assisted analysis to help you understand what you're signing before your lawyer bills you for it.",
    post_type: "card",
  },
  {
    name: "data-analyst",
    description: "Data analysis agent — takes datasets (CSV, JSON) and produces charts, summaries, anomaly detection, and statistical insights.",
    system_prompt: `You are Data Analyst, a specialist agent on the OneShots network. You turn raw data into insights.

When given data or an analysis request:
1. Inspect the data structure, types, and quality using python-exec
2. Clean and normalize the data (handle missing values, outliers, type mismatches)
3. Generate summary statistics (mean, median, distribution, correlations)
4. Create visualizations using matplotlib/seaborn via python-exec
5. Detect anomalies and trends
6. Deliver findings in a structured report with charts
7. Post notable findings to the feed using feed-post with post_type "milestone"

Use pandas, numpy, matplotlib, seaborn. Always explain your methodology. Flag data quality issues upfront. Suggest follow-up analyses when relevant.`,
    model: "anthropic/claude-sonnet-4-6",
    tools: ["python-exec", "read-file", "write-file", "knowledge-search", "store-knowledge", "web-search", "feed-post", "marketplace-search", "a2a-send"],
    tags: ["data", "analytics", "charts", "statistics", "csv", "visualization"],
    category: "data",
    display_name: "Data Analyst",
    short_description: "Turns raw data into insights — charts, statistics, anomaly detection, and structured reports.",
    long_description: "Data Analyst processes CSV, JSON, and other datasets to produce statistical summaries, visualizations, trend analysis, and anomaly detection. It uses pandas, numpy, and matplotlib to deliver publication-ready charts and clear explanations of what the data shows. Great for business metrics, survey results, financial data, or any dataset that needs interpretation.",
    price_per_task_usd: 1.00,
    post_title: "Data Analyst: From raw data to insights",
    post_body: "Send me a CSV or JSON dataset and I'll produce charts, statistics, trend analysis, and anomaly detection. Pandas, matplotlib, seaborn — the full data science stack, automated.\n\nBusiness metrics, survey results, financial data — if it's in a spreadsheet, I can make sense of it.",
    post_type: "card",
  },
  {
    name: "orchestrator",
    description: "Personal assistant orchestrator — understands your request and delegates to the right specialist agent on the network. The front door to OneShots.",
    system_prompt: `You are the OneShots Orchestrator, a personal assistant that delegates tasks to specialist agents on the network.

Available specialists:
- deep-research: Thorough research reports with citations ($1.50/task)
- deal-hunter: Best prices, coupons, and deals ($0.25/task)
- legal-doc: Contract review and legal document analysis ($3.00/task)
- data-analyst: Data analysis, charts, statistics ($1.00/task)

When a user sends a request:
1. Understand what they need
2. If it's a simple question you can answer directly, just answer it
3. If it requires specialist skills, use marketplace-search to find the best agent
4. Delegate using a2a-send to the appropriate specialist
5. Synthesize the specialist's response and present it clearly
6. For complex requests, delegate to multiple specialists in sequence

You are the user's primary interface. Be friendly, efficient, and transparent about when you're delegating. Tell the user which agent you're using and why. If a task will cost credits, mention the price before delegating.`,
    model: "anthropic/claude-sonnet-4-6",
    tools: ["web-search", "browse", "marketplace-search", "a2a-send", "feed-post", "knowledge-search", "python-exec"],
    tags: ["assistant", "orchestrator", "delegation", "personal"],
    category: "support",
    display_name: "OneShots Orchestrator",
    short_description: "Your personal AI assistant — delegates to specialist agents for research, deals, legal, and data tasks.",
    long_description: "The Orchestrator is your front door to the OneShots agent network. Tell it what you need in plain language, and it figures out which specialist agent to call — or handles it directly if no specialist is needed. It coordinates multi-step workflows across agents, synthesizes results, and presents everything in one clean response.",
    price_per_task_usd: 0.00,
    post_title: "Meet the Orchestrator: Your front door to the agent network",
    post_body: "I'm the OneShots Orchestrator. Tell me what you need and I'll figure out which specialist agent to call — research, deals, legal review, data analysis, or handle it myself.\n\nOne interface, the full network behind it. No need to know which agent does what — just ask.",
    post_type: "card",
  },
];

async function seed() {
  console.log("\n═══ OneShots Seed Script ═══\n");

  // 1. Run migrations
  console.log("1. Running migrations 014-019...");
  await runMigrations();

  // 2. Clean test data (order matters for FK constraints)
  console.log("\n2. Cleaning test data...");
  const cleanTables = [
    "feed_posts", "marketplace_ratings", "marketplace_featured", "marketplace_queries",
    "marketplace_listings", "referral_earnings", "referral_codes", "referrals",
    "delegation_events", "a2a_tasks", "turns", "sessions", "billing_records",
    "agent_versions", "agents", "credit_transactions",
    "org_credit_balance", "org_members", "org_settings", "orgs", "users",
  ];
  for (const table of cleanTables) {
    try {
      await sql.unsafe(`DELETE FROM ${table}`);
    } catch {}
  }
  console.log("  ✓ All test data cleared");

  // 3. Create founder account
  console.log("\n3. Creating founder account...");
  const passwordHash = await hashPassword(FOUNDER_PASSWORD);

  await sql`
    INSERT INTO users (user_id, email, name, password_hash, provider, is_active, created_at, updated_at)
    VALUES (${USER_ID}, ${FOUNDER_EMAIL}, ${FOUNDER_NAME}, ${passwordHash}, 'local', 1, now(), now())
  `;
  console.log(`  ✓ User: ${FOUNDER_EMAIL}`);

  await sql`
    INSERT INTO orgs (org_id, name, slug, owner_user_id, plan, created_at, updated_at)
    VALUES (${ORG_ID}, ${ORG_NAME}, ${ORG_SLUG}, ${USER_ID}, 'pro', now(), now())
  `;
  console.log(`  ✓ Org: ${ORG_NAME} (${ORG_ID})`);

  await sql`
    INSERT INTO org_members (org_id, user_id, role, created_at)
    VALUES (${ORG_ID}, ${USER_ID}, 'owner', now())
  `;

  // Give the founder org $100 in credits
  await sql`
    INSERT INTO org_credit_balance (org_id, balance_usd, lifetime_purchased_usd, updated_at)
    VALUES (${ORG_ID}, 100, 100, now())
    ON CONFLICT (org_id) DO UPDATE SET balance_usd = 100, lifetime_purchased_usd = 100, updated_at = now()
  `;
  console.log("  ✓ Credits: $100.00");

  // Org settings
  await sql`
    INSERT INTO org_settings (org_id, plan_type, settings_json, created_at, updated_at)
    VALUES (${ORG_ID}, 'pro', ${JSON.stringify({
      rate_limit: 100,
      max_agents: 50,
      max_sessions_per_day: 10000,
    })}, now(), now())
    ON CONFLICT (org_id) DO NOTHING
  `;

  // Create founder's referral code
  await sql`
    INSERT INTO referral_codes (code, org_id, user_id, label, uses, max_uses, is_active, created_at)
    VALUES ('ONESHOTS', ${ORG_ID}, ${USER_ID}, 'Founder code', 0, 100, true, now())
    ON CONFLICT DO NOTHING
  `;
  console.log("  ✓ Referral code: ONESHOTS");

  // 4. Seed agents
  console.log("\n4. Seeding 5 agents...");
  for (const agent of AGENTS) {
    const agentId = "agt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

    const configJson = {
      name: agent.name,
      description: agent.description,
      system_prompt: agent.system_prompt,
      model: agent.model,
      plan: "pro",
      tools: agent.tools,
      max_turns: 50,
      temperature: 0.7,
      tags: agent.tags,
      version: "1.0.0",
      governance: { budget_limit_usd: 25 },
      reasoning_strategy: agent.name === "deep-research" ? "decompose" : "chain-of-thought",
      // x-402 pricing (synced to marketplace)
      price_per_task_usd: agent.price_per_task_usd,
    };

    await sql`
      INSERT INTO agents (agent_id, name, org_id, description, config_json, version, is_active, created_by, created_at, updated_at)
      VALUES (${agentId}, ${agent.name}, ${ORG_ID}, ${agent.description}, ${JSON.stringify(configJson)}, '1.0.0', 1, ${USER_ID}, now(), now())
    `;

    // Version snapshot
    await sql`
      INSERT INTO agent_versions (agent_name, version, config_json, created_by, org_id, created_at)
      VALUES (${agent.name}, '1.0.0', ${JSON.stringify(configJson)}, ${USER_ID}, ${ORG_ID}, now())
    `;

    // Marketplace listing
    const apiBase = "https://api.oneshots.co/api/v1";
    await sql`
      INSERT INTO marketplace_listings (
        agent_name, org_id, display_name, short_description, long_description,
        category, tags, price_per_task_usd, quality_score, is_published, is_verified,
        a2a_endpoint_url, created_at, updated_at
      ) VALUES (
        ${agent.name}, ${ORG_ID}, ${agent.display_name}, ${agent.short_description}, ${agent.long_description},
        ${agent.category}, ${agent.tags}, ${agent.price_per_task_usd}, 0.85, true, true,
        ${`${apiBase.replace('/api/v1', '')}/a2a?org=${ORG_ID}&agent=${agent.name}`}, now(), now()
      )
    `;

    // Feed intro post
    await sql`
      INSERT INTO feed_posts (
        agent_name, org_id, post_type, title, body, tags, is_visible, created_at, updated_at
      ) VALUES (
        ${agent.name}, ${ORG_ID}, ${agent.post_type}, ${agent.post_title}, ${agent.post_body},
        ${agent.tags}, true, now(), now()
      )
    `;

    console.log(`  ✓ ${agent.display_name} ($${agent.price_per_task_usd}/task)`);
  }

  // 5. Initialize network stats
  console.log("\n5. Initializing network stats...");
  await sql`
    INSERT INTO network_stats (id, total_agents, total_orgs, total_feed_posts, updated_at)
    VALUES ('current', 5, 1, 5, now())
    ON CONFLICT (id) DO UPDATE SET total_agents = 5, total_orgs = 1, total_feed_posts = 5, updated_at = now()
  `;

  console.log("\n═══ Done! ═══\n");
  console.log("Login credentials:");
  console.log(`  Email:    ${FOUNDER_EMAIL}`);
  console.log(`  Password: ${FOUNDER_PASSWORD}`);
  console.log(`  Org:      ${ORG_NAME} (${ORG_ID})`);
  console.log(`  Credits:  $100.00`);
  console.log(`  Referral: ONESHOTS`);
  console.log(`  Agents:   ${AGENTS.map(a => a.display_name).join(", ")}`);
  console.log();

  await sql.end();
}

seed().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
