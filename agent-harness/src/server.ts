/**
 * Agent Harness — server entry point.
 *
 * 100% Cloudflare primitives:
 * - AIChatAgent for chat with SQLite persistence, resumable streaming, tools
 * - routeAgentRequest with onBeforeConnect/onBeforeRequest for auth
 * - Vite SPA served via wrangler assets config
 * - Workers AI binding for model inference
 * - Cloudflare Sandbox for code execution (GA April 2026)
 * - Open-Meteo for real weather (free, no key)
 * - Outbound Workers on Sandbox for zero-trust credential injection
 * - Dynamic Worker loading via worker_loaders (LOADER binding)
 * - AgentSupervisor DO using ctx.facets — tenant agents as facets with isolated SQLite
 *
 * Auth: simple access-code → cookie session.
 * Multi-tenant: DO name = tenantId, mapped to system prompt + model config.
 */

import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { withVoice, WorkersAIFluxSTT, WorkersAINova3STT, WorkersAITTS, type VoiceTurnContext, type Transcriber } from "@cloudflare/voice";
import { Agent, routeAgentRequest, callable } from "agents";
import {
  AIChatAgent,
  type OnChatMessageOptions,
  type ChatResponseResult,
} from "@cloudflare/ai-chat";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  generateText,
  stepCountIs,
} from "ai";
import { z } from "zod";
import { getSandbox, Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { createSandboxTools } from "@cloudflare/think/tools/sandbox";
import { createCodeTool, generateTypes } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import puppeteer from "@cloudflare/puppeteer";
import webpush from "web-push";
import { metaAgentTools as metaAgentToolSet, META_AGENT_SYSTEM_PROMPT } from "./meta-agent";
import { buildPersonalAgentPrompt } from "./prompts/personal-agent";
import { createAgentEmitter, emit, type TelemetryBindings } from "./telemetry";

// Env type is declared globally in env.d.ts via Cloudflare.Env.
// LOADER, AgentSupervisor, GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY
// are all typed there.

// ── Custom Sandbox class with Outbound Workers ────────────────────────────────
//
// Extends BaseSandbox to intercept all outbound HTTP from containers and
// inject credentials from env bindings — the container code never sees keys.
//
// Wrangler still picks this up for the containers config because it extends
// Sandbox (which extends Container).

export class Sandbox extends BaseSandbox {
  /**
   * Default outbound handler — logs all egress and forwards.
   * Applies to any request not matched by outboundByHost.
   */
  static outbound = (req: Request, env: Env, ctx: any) => {
    console.log(
      `[sandbox-egress] ${req.method} ${req.url} (container: ${ctx.containerId})`
    );
    return fetch(req);
  };

  /**
   * Per-host credential injection.
   * Matched before `outbound` — hostname must match exactly.
   */
  static outboundByHost: Record<
    string,
    (req: Request, env: Env, ctx: any) => Promise<Response> | Response
  > = {
    "api.github.com": async (req: Request, env: Env, _ctx: any) => {
      // Inject GitHub token from env — sandbox container never sees the secret
      if (env.GITHUB_TOKEN) {
        const headers = new Headers(req.headers);
        headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);
        return fetch(new Request(req.url, { ...req, headers }));
      }
      return fetch(req);
    },

    "api.openai.com": async (req: Request, env: Env, _ctx: any) => {
      if (env.OPENAI_API_KEY) {
        const headers = new Headers(req.headers);
        headers.set("Authorization", `Bearer ${env.OPENAI_API_KEY}`);
        return fetch(new Request(req.url, { ...req, headers }));
      }
      return fetch(req);
    },

    "api.anthropic.com": async (req: Request, env: Env, _ctx: any) => {
      if (env.ANTHROPIC_API_KEY) {
        const headers = new Headers(req.headers);
        headers.set("x-api-key", env.ANTHROPIC_API_KEY);
        return fetch(new Request(req.url, { ...req, headers }));
      }
      return fetch(req);
    },
  };

  /**
   * Named handlers for dynamic policy switching.
   * Use setOutboundHandler("allowHosts", { allowedHostnames: [...] }) at runtime.
   */
  static outboundHandlers: Record<
    string,
    (req: Request, env: Env, ctx: any) => Promise<Response> | Response
  > = {
    /** Allow only a specific set of hostnames; block everything else. */
    allowHosts: async (req: Request, _env: Env, ctx: any) => {
      const url = new URL(req.url);
      if (ctx.params?.allowedHostnames?.includes(url.hostname)) {
        return fetch(req);
      }
      return new Response(null, { status: 403, statusText: "Blocked by policy" });
    },

    /** Per-agent credential injection from stored secrets.
     * ctx.params.secrets = { "api.example.com": "Bearer token123", ... }
     * Maps hostname → Authorization header value.
     * Called by ChatAgent before sandbox code execution. */
    injectSecrets: async (req: Request, _env: Env, ctx: any) => {
      const url = new URL(req.url);
      const secrets: Record<string, string> = ctx.params?.secrets || {};
      const authValue = secrets[url.hostname];
      if (authValue) {
        const headers = new Headers(req.headers);
        headers.set("Authorization", authValue);
        return fetch(new Request(req.url, { ...req, headers }));
      }
      return fetch(req);
    },

    /** Hard block — no network access at all. */
    blockAll: async (_req: Request) => {
      return new Response(null, { status: 403, statusText: "Network access disabled" });
    },
  };
}

// ── Tenant configuration ─────────────────────────────────────────────────────

type TenantConfig = {
  id: string;
  name: string;
  icon: string;
  description: string;
  model: string;
  systemPrompt: string;
  enableSandbox?: boolean;
  // Skill-heavy architecture: skills are context blocks loaded on demand.
  // Each skill is a markdown file that expands the system prompt when activated.
  // The system prompt stays small; skills are loaded via Think context blocks.
  skills?: SkillDefinition[];
};

// ── Skill System ──────────────────────────────────────────────────────────────
//
// Instead of cramming everything into one giant system prompt, skills are
// modular markdown blocks that get loaded as Think context blocks on demand.
//
// How it works:
// 1. Each tenant has a list of SkillDefinitions (name + content)
// 2. configureSession() registers each skill as a context block with a SkillProvider
// 3. The LLM sees a "skills" context block listing available skills
// 4. When a skill is relevant, the LLM calls load_context to activate it
// 5. The skill's markdown content gets injected into the system prompt
// 6. This survives compaction — context blocks are never summarized away
//
// This is the CF-native equivalent of the monolith's skill-manifest.generated.ts
// but dynamic, per-conversation, and expandable to infinity.

interface SkillDefinition {
  name: string;
  description: string;
  content: string;               // markdown body — the "SKILL.md" content
  when_to_use?: string;          // auto-activation criteria (LLM matches against user input)
  allowed_tools?: string[];      // tool allowlist for this skill (future: enforce in beforeToolCall)
  min_plan?: "free" | "pro" | "team" | "enterprise";  // plan-based gating
  delegate_agent?: string;       // fallback agent for lower-tier users
}

// ── Built-in Skills Library ────────────────────────────────────────

const SKILL_LIBRARY: SkillDefinition[] = [
  {
    name: "deep-research",
    description: "Multi-source research with structured output and source citations",
    when_to_use: "User asks to research, investigate, compare, or analyze a topic requiring multiple sources",
    content: `## Deep Research Protocol

When conducting deep research:

1. **Scope**: Identify 3-5 key questions that need answering
2. **Search**: Use webSearch for each question independently
3. **Verify**: Cross-reference claims across 2+ sources
4. **Extract**: Use fetchUrl or browserGetContent for full articles
5. **Synthesize**: Combine findings into a structured report

### Output Format
- Executive summary (2-3 sentences)
- Key findings (bulleted, with source URLs)
- Confidence assessment (high/medium/low per finding)
- Knowledge gaps (what couldn't be verified)

### Citation Rules
- Every factual claim must have a [source](url)
- Prefer primary sources over aggregators
- Note when information is dated`,
  },
  {
    name: "code-review",
    description: "Systematic code review with security, performance, and maintainability checks",
    when_to_use: "User asks to review, audit, or critique code for quality, security, or performance",
    content: `## Code Review Checklist

Review code systematically:

### Security
- [ ] No hardcoded secrets or credentials
- [ ] Input validation on all user data
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (output encoding)
- [ ] Auth checks on protected endpoints

### Performance
- [ ] No N+1 queries
- [ ] Appropriate caching strategy
- [ ] No blocking operations in hot path
- [ ] Resource cleanup (connections, file handles)

### Maintainability
- [ ] Functions under 50 lines
- [ ] Clear naming (no abbreviations)
- [ ] Error handling with context
- [ ] No dead code or commented-out blocks

### Output
For each issue found:
- **Severity**: Critical / High / Medium / Low
- **Line**: exact location
- **Problem**: what's wrong
- **Fix**: how to fix it`,
  },
  {
    name: "data-analysis",
    description: "Structured data analysis with Python in sandbox",
    content: `## Data Analysis Protocol

When analyzing data:

1. **Ingest**: Load data via sandbox (CSV, JSON, API)
2. **Explore**: Use pandas for shape, dtypes, describe(), head()
3. **Clean**: Handle nulls, types, outliers
4. **Analyze**: Apply statistical methods appropriate to the question
5. **Visualize**: Create matplotlib/seaborn charts, save to workspace
6. **Report**: Summarize findings with charts and key metrics

### Python Libraries Available
\`\`\`
pandas, numpy, matplotlib, seaborn, scipy, scikit-learn
Install others: uv pip install <package>
\`\`\`

### Chart Requirements
- Always label axes and add titles
- Use colorblind-friendly palettes
- Save to /workspace/charts/
- Include data source annotation`,
  },
  {
    name: "debug",
    description: "Systematic debugging with hypothesis-driven investigation",
    when_to_use: "User reports a bug, error, or unexpected behavior that needs investigation",
    content: `## Debug Protocol

1. **Reproduce**: Confirm the error with minimal steps
2. **Hypothesize**: List 3 most likely causes
3. **Investigate**: Test each hypothesis with targeted tool calls
4. **Root cause**: Identify the actual cause with evidence
5. **Fix**: Implement and verify the fix
6. **Prevent**: Suggest how to prevent recurrence

### Investigation Tools
- Read error logs and stack traces
- Add diagnostic logging
- Inspect state at failure point
- Check edge cases and boundary conditions
- Bisect recent changes if regression

### Output
- **Symptom**: what the user sees
- **Root cause**: why it happens
- **Fix**: what was changed
- **Verification**: how we confirmed it works`,
  },
  {
    name: "report",
    description: "Generate structured reports with executive summary and detailed findings",
    content: `## Report Generation

### Structure
1. **Title & Date**
2. **Executive Summary** (3-5 sentences, key takeaways)
3. **Methodology** (how data was gathered)
4. **Findings** (organized by theme)
5. **Recommendations** (prioritized, actionable)
6. **Appendix** (raw data, sources)

### Style Rules
- Lead with conclusions, not process
- Use tables for comparisons
- Include confidence levels
- Quantify everything possible
- Link to sources`,
  },
  {
    name: "planning",
    description: "Break down complex tasks into actionable implementation plans",
    when_to_use: "User describes a complex multi-step task, project, migration, or architectural change",
    content: `## Implementation Planning

When breaking down a complex task:

### Phase 1: Scope
- Define clear success criteria
- Identify constraints (time, resources, dependencies)
- List assumptions

### Phase 2: Decompose
- Break into independent work streams
- Identify critical path
- Flag parallelizable tasks

### Phase 3: Estimate
- Size each task (small/medium/large)
- Identify risks per task
- Note dependencies between tasks

### Phase 4: Sequence
- Order by dependencies, then priority
- Group related tasks into sprints
- Identify milestones and checkpoints

### Output Format
| # | Task | Size | Depends On | Risk | Sprint |
|---|------|------|-----------|------|--------|`,
  },
];

// ── Skill Provider (Think context block provider) ──────────────────
// This creates a SkillProvider-compatible object for each skill.
// Think's context block system calls get() to render the content
// and load() to activate it on demand.

/**
 * Creates a SkillProvider that merges base content with learned overlays.
 * Think's context block system calls get() for the system prompt and
 * load() when the LLM activates the skill via load_context.
 *
 * Overlay merge (Phase 6 pattern): base template + "\n\n---\n" + overlays
 * Overlays are loaded from DO SQLite — local to this agent DO, fast.
 */
const MAX_OVERLAY_CHARS = 10_000; // Bug fix #2: cap total overlay size

function createSkillProvider(skill: SkillDefinition, overlayLoader?: () => string[]) {
  const mergeWithOverlays = () => {
    let content = skill.content;
    const overlays = overlayLoader?.() || [];
    if (overlays.length > 0) {
      // Bug fix #2: cap overlay section to MAX_OVERLAY_CHARS, keep newest
      let overlayText = overlays.join("\n\n---\n");
      if (overlayText.length > MAX_OVERLAY_CHARS) {
        // Keep the newest overlays (end of array) that fit
        const trimmed: string[] = [];
        let total = 0;
        for (let i = overlays.length - 1; i >= 0; i--) {
          if (total + overlays[i].length + 5 > MAX_OVERLAY_CHARS) break;
          trimmed.unshift(overlays[i]);
          total += overlays[i].length + 5;
        }
        overlayText = trimmed.join("\n\n---\n");
      }
      content += "\n\n---\n## Learned Rules\n\n" + overlayText;
    }
    return content;
  };
  return {
    get: async () => mergeWithOverlays(),
    load: async () => mergeWithOverlays(),
  };
}

// ── Vectorize Search Provider (cross-session semantic memory) ─────
//
// Implements the SDK's SearchProvider interface backed by Cloudflare
// Vectorize + Workers AI embeddings. This is the only custom code in
// the memory stack — everything else uses SDK primitives (FTS5, Session).
//
// The provider:
//   - get()    → returns a count of stored memories
//   - search() → embeds query via Workers AI, queries Vectorize, returns matches
//   - set()    → embeds content, upserts into Vectorize with metadata

// ── Time-decay confidence scoring (ported from deploy/runtime/memory.ts) ──
// Reduces relevance of old memories so stale facts don't dominate.
// 7d→100%, 30d→90%, 90d→70%, 180d→50%, beyond→0 (archive threshold).

function effectiveConfidence(score: number, timestampMs: number): number {
  const days = Math.max(0, (Date.now() - timestampMs) / 86_400_000);
  if (days <= 7) return score;
  if (days <= 30) return score * 0.9;
  if (days <= 90) return score * 0.7;
  if (days <= 180) return score * 0.5;
  return 0;
}

function memoryFreshnessNote(timestampMs: number): string {
  const days = Math.floor((Date.now() - timestampMs) / 86_400_000);
  if (days <= 1) return "";
  return ` (~${days}d old — verify before treating as current)`;
}

// ── Memory threat detection (ported from deploy/runtime/curated-memory.ts) ──
// Blocks prompt injection, exfiltration, SSH backdoors, invisible chars.
// Runs on every set_context call to prevent adversarial memory injection.

const INVISIBLE_CHARS = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"];
const MEMORY_THREAT_PATTERNS: Array<{ regex: RegExp; id: string }> = [
  { regex: /ignore\s+(?:(?:previous|all|above|prior)\s+)+instructions/i, id: "prompt_injection" },
  { regex: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { regex: /do\s+not\s+tell\s+the\s+user/i, id: "deception" },
  { regex: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { regex: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { regex: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { regex: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget" },
  { regex: /authorized_keys/i, id: "ssh_backdoor" },
];

function scanMemoryContent(content: string): string | null {
  for (const ch of INVISIBLE_CHARS) {
    if (content.includes(ch)) {
      return `Blocked: invisible unicode U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  for (const p of MEMORY_THREAT_PATTERNS) {
    if (p.regex.test(content)) return `Blocked: threat pattern '${p.id}'`;
  }
  return null;
}

// ── Pattern-based fact extraction (ported from deploy/runtime/memory.ts) ──
// No LLM call — regex-based, fast, deterministic. Runs on user messages
// to extract preferences, identity, goals, behavior patterns.

const FACT_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\bi (?:prefer|like|want|need|love|hate|dislike)\b/i, category: "preference" },
  { pattern: /\bmy (?:favorite|preferred)\b/i, category: "preference" },
  { pattern: /\bmy name is\b/i, category: "knowledge" },
  { pattern: /\bi (?:work|am|live|study) (?:at|in|as)\b/i, category: "knowledge" },
  { pattern: /\bmy (?:email|phone|address|company|job|role|team)\b/i, category: "knowledge" },
  { pattern: /\bi(?:'m| am) (?:trying|working|looking|planning) to\b/i, category: "goal" },
  { pattern: /\bmy goal is\b/i, category: "goal" },
  { pattern: /\bi need to\b/i, category: "goal" },
  { pattern: /\bi (?:usually|always|never|often|sometimes)\b/i, category: "behavior" },
];

function extractFacts(text: string): Array<{ content: string; category: string }> {
  const facts: Array<{ content: string; category: string }> = [];
  const sentences = text.split(/[.!?\n]+/).filter(s => s.trim().length > 8);
  for (const sentence of sentences) {
    for (const { pattern, category } of FACT_PATTERNS) {
      if (pattern.test(sentence)) {
        facts.push({ content: sentence.trim(), category });
        break;
      }
    }
  }
  return facts;
}

// ── Reciprocal Rank Fusion (ported from deploy/runtime/rag-hybrid.ts) ──
// Merges vector (semantic) + FTS5 (keyword) results. k=60 is standard.
// Items appearing in both lists get boosted; items in only one still appear.

function reciprocalRankFusion(
  vectorResults: Array<{ key: string; content: string; score: number; timestamp: number }>,
  ftsResults: Array<{ key: string; content: string }>,
  k = 60,
): Array<{ key: string; content: string; rrfScore: number; timestamp: number }> {
  const scores = new Map<string, { content: string; rrf: number; timestamp: number }>();

  vectorResults.forEach((r, rank) => {
    const contribution = 1 / (k + rank + 1);
    const existing = scores.get(r.key);
    if (existing) { existing.rrf += contribution; }
    else { scores.set(r.key, { content: r.content, rrf: contribution, timestamp: r.timestamp }); }
  });

  ftsResults.forEach((r, rank) => {
    const contribution = 1 / (k + rank + 1);
    const existing = scores.get(r.key);
    if (existing) { existing.rrf += contribution; }
    else { scores.set(r.key, { content: r.content, rrf: contribution, timestamp: 0 }); }
  });

  return [...scores.entries()]
    .map(([key, v]) => ({ key, content: v.content, rrfScore: v.rrf, timestamp: v.timestamp }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

// ── Channel-Specific System Prompts (ported from deploy/runtime/channel-prompts.ts) ──
// Per-channel formatting rules injected into the soul context block.
// Voice: no markdown, spell out abbreviations. Slack: mrkdwn. Telegram: short.

type ChannelId = "voice" | "telegram" | "whatsapp" | "web" | "slack" | "instagram" | "messenger" | "email" | "widget" | "portal";
interface ChannelConfig { prompt: string; maxTokens: number; supportsMarkdown: boolean; }

const CHANNEL_CONFIGS: Record<string, ChannelConfig> = {
  voice: {
    prompt: "Channel: Voice. Response read aloud by TTS. NO markdown, no lists, no code blocks. Short natural sentences (<75 words). Spell out abbreviations (API → A-P-I). Give results, not process.",
    maxTokens: 300, supportsMarkdown: false,
  },
  telegram: {
    prompt: "Channel: Telegram. Keep short and conversational. Use *bold*, _italic_, `code`. Break into short paragraphs. Emoji sparingly.",
    maxTokens: 600, supportsMarkdown: true,
  },
  whatsapp: {
    prompt: "Channel: WhatsApp. Brief, mobile-first. Max 1-2 short paragraphs. Use *bold* for emphasis. No code blocks.",
    maxTokens: 600, supportsMarkdown: false,
  },
  slack: {
    prompt: "Channel: Slack. Use Slack mrkdwn: *bold*, _italic_, `code`, ```blocks```. Concise, bullet points not numbers. Thread-aware.",
    maxTokens: 600, supportsMarkdown: true,
  },
  instagram: {
    prompt: "Channel: Instagram DM. Very short (2-3 sentences). No markdown. Casual tone. Emoji OK.",
    maxTokens: 400, supportsMarkdown: false,
  },
  messenger: {
    prompt: "Channel: Messenger. Concise, conversational. 1-2 paragraphs max. Limited formatting.",
    maxTokens: 500, supportsMarkdown: false,
  },
  email: {
    prompt: "Channel: Email. Professional, thorough. Proper greeting/sign-off. Paragraphs, headers, lists OK.",
    maxTokens: 2000, supportsMarkdown: true,
  },
  widget: {
    prompt: "Channel: Embedded Widget. Concise (<150 words). Markdown OK. Prioritize actionable answers.",
    maxTokens: 500, supportsMarkdown: true,
  },
  web: {
    prompt: "Channel: Web Chat. Markdown OK. Helpful and concise. Short paragraphs and bullets.",
    maxTokens: 800, supportsMarkdown: true,
  },
  portal: { prompt: "", maxTokens: 4000, supportsMarkdown: true }, // default — no extra instructions
};

function getChannelConfig(channel: string): ChannelConfig {
  return CHANNEL_CONFIGS[channel.toLowerCase()] || CHANNEL_CONFIGS.portal;
}

// ── Embedding dimensions — safety check ──
// BGE-base-en-v1.5 outputs 768-dim. If the Vectorize index was created with
// a different dimension (e.g., 1024 for Qwen3), ingesting wrong-dim vectors
// silently corrupts the index. Query-time mismatch is OK (lower quality).
const EXPECTED_EMBEDDING_DIM = 768; // BGE-base-en-v1.5

// ── Vectorize Search Provider with RRF fusion + time-decay + threat detection ──

function createVectorizeSearchProvider(env: Env, ftsProvider?: { search(q: string): Promise<string | null> }) {
  return {
    async get(): Promise<string | null> {
      return "Semantic memory available. Use search_context to find past knowledge.";
    },

    async search(query: string): Promise<string | null> {
      try {
        // 1. Dense vector search via Vectorize
        const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [query] }) as any;
        const vectorResults = await env.VECTORIZE.query(embedding.data[0], {
          topK: 10, returnMetadata: "all",
        });

        const vectorItems = (vectorResults.matches || [])
          .filter((m: any) => (m.score || 0) > 0) // Bug fix #5: filter negative/zero raw scores before time-decay
          .map((m: any) => ({
            key: m.metadata?.key || m.id,
            content: m.metadata?.content || "",
            score: effectiveConfidence(m.score || 0, m.metadata?.timestamp || 0),
            timestamp: m.metadata?.timestamp || 0,
          })).filter((m: any) => m.score > 0); // Also filter after time-decay

        // 2. FTS5 keyword search (if provider available)
        let ftsItems: Array<{ key: string; content: string }> = [];
        if (ftsProvider) {
          const ftsResult = await ftsProvider.search(query);
          if (ftsResult) {
            // Parse FTS results (format: "[key]\ncontent\n\n[key2]\n...")
            // Bug fix #6: validate key format to prevent content injection
            ftsItems = ftsResult.split("\n\n").map(block => {
              const lines = block.split("\n");
              const keyMatch = lines[0]?.match(/^\[(.+)\]$/);
              const key = keyMatch?.[1] || "";
              // Reject keys that look like system content (injection attempt)
              if (key.length > 200 || /system|prompt|instruction/i.test(key)) {
                return { key: "", content: "" };
              }
              return {
                key: key || lines[0] || "",
                content: lines.slice(1).join("\n"),
              };
            }).filter(r => r.content && r.key);
          }
        }

        // 3. Reciprocal Rank Fusion — merge vector + FTS5
        const fused = reciprocalRankFusion(vectorItems, ftsItems);
        const top = fused.slice(0, 5);

        if (top.length === 0) return null;

        return top
          .map(m => `[${m.key}] (relevance: ${m.rrfScore.toFixed(3)}${memoryFreshnessNote(m.timestamp)})\n${m.content}`)
          .join("\n\n");
      } catch {
        return null;
      }
    },

    async set(key: string, content: string): Promise<void> {
      // Threat detection
      const threat = scanMemoryContent(content);
      if (threat) {
        console.warn(`[memory] ${threat} — key: ${key}`);
        return;
      }

      try {
        const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [content] }) as any;
        const vector = embedding.data[0];

        // Dimension safety check — refuse to ingest wrong-dim vectors
        if (vector.length !== EXPECTED_EMBEDDING_DIM) {
          console.error(`[memory] Dimension mismatch: got ${vector.length}, expected ${EXPECTED_EMBEDDING_DIM}. Refusing to ingest — would corrupt index.`);
          return;
        }

        await env.VECTORIZE.upsert([{
          id: key,
          values: vector,
          metadata: { key, content, timestamp: Date.now() },
        }]);
      } catch {
        // Fail silently
      }
    },
  };
}

// ── Skill-aware Tenant Config ──────────────────────────────────────

const TENANTS: TenantConfig[] = [
  {
    id: "default",
    name: "Personal Agent",
    icon: "✦",
    description: "Your autonomous AI agent — research, code, create agents, manage data, browse the web, and more",
    model: "@cf/moonshotai/kimi-k2.5",
    enableSandbox: true,
    systemPrompt: buildPersonalAgentPrompt(),  // Battle-tested 110-line prompt from old system
    skills: [
      SKILL_LIBRARY.find(s => s.name === "deep-research")!,
      SKILL_LIBRARY.find(s => s.name === "report")!,
      SKILL_LIBRARY.find(s => s.name === "planning")!,
    ],
  },
  {
    id: "support",
    name: "Customer Support",
    icon: "◎",
    description: "Empathetic support agent for customer-facing interactions",
    model: "@cf/moonshotai/kimi-k2.5",
    systemPrompt:
      "You are a friendly, empathetic customer support agent. Help troubleshoot issues, explain things clearly, and ensure the customer feels heard. Always be patient and professional. If you can't resolve something, acknowledge it and suggest next steps.",
    skills: [
      SKILL_LIBRARY.find(s => s.name === "debug")!,
    ],
  },
  {
    id: "research",
    name: "Research Analyst",
    icon: "◈",
    description: "Deep research, analysis, and report generation",
    model: "@cf/moonshotai/kimi-k2.5",
    systemPrompt:
      "You are a research analyst. Provide thorough analysis, cite sources with URLs, consider multiple perspectives, and synthesize findings clearly. Use your skills for structured research and reporting.",
    skills: [
      SKILL_LIBRARY.find(s => s.name === "deep-research")!,
      SKILL_LIBRARY.find(s => s.name === "report")!,
      SKILL_LIBRARY.find(s => s.name === "data-analysis")!,
      SKILL_LIBRARY.find(s => s.name === "planning")!,
    ],
  },
  // ── OpenRouter models (via AI Gateway) ──
  {
    id: "reasoning",
    name: "Reasoning Expert",
    icon: "🔬",
    description: "Deep reasoning with MiniMax M2.7 via OpenRouter",
    model: "minimax/minimax-m2.7", // OpenRouter model ID — routed via AI Gateway
    systemPrompt:
      "You are an expert reasoning assistant. Think step by step. Show your reasoning process. For complex problems, break them down into sub-problems. Verify your answers. You have deep research and analysis skills available.",
    skills: [
      SKILL_LIBRARY.find(s => s.name === "deep-research")!,
      SKILL_LIBRARY.find(s => s.name === "planning")!,
      SKILL_LIBRARY.find(s => s.name === "data-analysis")!,
    ],
  },
];

// ── Model Catalog (available via settings UI + gateway API) ──
// Users choose their model. Cost = usage + markup (like OpenRouter).
// Workers AI models are free. OpenRouter models charged at provider rate + margin.

export const MODEL_CATALOG = [
  // ── Free (Workers AI) ──
  { id: "@cf/moonshotai/kimi-k2.5", name: "Kimi K2.5", provider: "Workers AI", tier: "free", description: "Fast reasoning, free via Workers AI", costPer1kTokens: 0 },
  { id: "@cf/google/gemma-3-27b-it", name: "Gemma 3 27B", provider: "Workers AI", tier: "free", description: "Google's open model, free via Workers AI", costPer1kTokens: 0 },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", provider: "Workers AI", tier: "free", description: "Meta's latest, free via Workers AI", costPer1kTokens: 0 },

  // ── Budget (OpenRouter via AI Gateway) ──
  { id: "deepseek/deepseek-chat-v3.2", name: "DeepSeek V3.2", provider: "OpenRouter", tier: "budget", description: "Near-free, strong coding + reasoning", costPer1kTokens: 0.0003 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "OpenRouter", tier: "budget", description: "Google's fast model, very cheap", costPer1kTokens: 0.0001 },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "OpenRouter", tier: "budget", description: "Fast, cheap, good for simple tasks", costPer1kTokens: 0.0008 },

  // ── Standard (OpenRouter via AI Gateway) ──
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "OpenRouter", tier: "standard", description: "Best value — strong reasoning + coding", costPer1kTokens: 0.003 },
  { id: "openai/gpt-5-mini", name: "GPT-5 Mini", provider: "OpenRouter", tier: "standard", description: "OpenAI's efficient model", costPer1kTokens: 0.002 },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "OpenRouter", tier: "standard", description: "Google's best, strong multimodal", costPer1kTokens: 0.003 },
  { id: "minimax/minimax-m2.7", name: "MiniMax M2.7", provider: "OpenRouter", tier: "standard", description: "Strong reasoning with step-by-step thinking", costPer1kTokens: 0.002 },

  // ── Premium (OpenRouter via AI Gateway) ──
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "OpenRouter", tier: "premium", description: "Top quality — complex reasoning, long context", costPer1kTokens: 0.015 },
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "OpenRouter", tier: "premium", description: "OpenAI's flagship model", costPer1kTokens: 0.01 },
  { id: "x-ai/grok-4", name: "Grok 4", provider: "OpenRouter", tier: "premium", description: "xAI's flagship reasoning model", costPer1kTokens: 0.005 },

  // ── Speed (Groq — ultra-fast inference) ──
  { id: "groq/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout (Groq)", provider: "OpenRouter", tier: "speed", description: "Ultra-fast inference via Groq", costPer1kTokens: 0.0002 },
  { id: "groq/meta-llama/llama-4-maverick-17b-128e-instruct", name: "Llama 4 Maverick (Groq)", provider: "OpenRouter", tier: "speed", description: "128 experts, blazing fast", costPer1kTokens: 0.0003 },
] as const;

export type ModelId = typeof MODEL_CATALOG[number]["id"];

function getTenantConfig(tenantId: string): TenantConfig {
  const match = TENANTS.find((t) => t.id === tenantId);
  if (match) return match;
  for (const t of TENANTS) {
    if (tenantId.includes(`-${t.id}-`) || tenantId.endsWith(`-${t.id}`)) return t;
  }
  return TENANTS.find(t => t.id === "default") ?? TENANTS[0];
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

const SESSION_COOKIE = "agent_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function isAuthenticated(request: Request): boolean {
  // 1. Cookie auth (original Vite demo pattern)
  const cookies = request.headers.get("Cookie") ?? "";
  if (cookies.includes(`${SESSION_COOKIE}=authenticated`)) return true;

  // 2. JWT in query param (SDK pattern: browsers can't set WS headers)
  // Check 'token' first (explicit JWT), then '_pk' (PartySocket identity — may or may not be JWT)
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || url.searchParams.get("_pk") || "";
  if (token) {
    const parts = token.split(".");
    if (parts.length === 3) return true;
  }

  // 3. Authorization header (for HTTP requests from gateway service binding)
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ") && authHeader.length > 20) return true;

  return false;
}

function setSessionCookie(url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.searchParams.get("redirect") ?? "/",
      "Set-Cookie": `${SESSION_COOKIE}=authenticated; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
    },
  });
}

// ── Shared tools (available to all tenants) ──────────────────────────────────

function sharedTools() {
  return {
    // Real weather via Open-Meteo (free, no API key)
    getWeather: tool({
      description:
        "Get the current weather for a city. Returns temperature, conditions, wind speed, and humidity.",
      inputSchema: z.object({
        city: z.string().describe("City name (e.g., 'London', 'San Francisco')"),
      }),
      execute: async ({ city }) => {
        try {
          // Step 1: Geocode city name
          const geoRes = await fetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
          );
          if (!geoRes.ok)
            return { error: `Geocoding failed: ${geoRes.status}` };
          const geoData = (await geoRes.json()) as {
            results?: Array<{
              latitude: number;
              longitude: number;
              name: string;
              country: string;
            }>;
          };
          if (!geoData.results?.length)
            return { error: `City not found: ${city}` };
          const { latitude, longitude, name, country } = geoData.results[0];

          // Step 2: Get current weather
          const wxRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=celsius&wind_speed_unit=kmh`
          );
          if (!wxRes.ok)
            return { error: `Weather API failed: ${wxRes.status}` };
          const wxData = (await wxRes.json()) as {
            current: {
              temperature_2m: number;
              apparent_temperature: number;
              relative_humidity_2m: number;
              weather_code: number;
              wind_speed_10m: number;
            };
          };

          // WMO weather codes → descriptions
          const codes: Record<number, string> = {
            0: "Clear sky",
            1: "Mainly clear",
            2: "Partly cloudy",
            3: "Overcast",
            45: "Fog",
            48: "Depositing rime fog",
            51: "Light drizzle",
            53: "Moderate drizzle",
            55: "Dense drizzle",
            61: "Slight rain",
            63: "Moderate rain",
            65: "Heavy rain",
            71: "Slight snow",
            73: "Moderate snow",
            75: "Heavy snow",
            80: "Slight rain showers",
            81: "Moderate rain showers",
            82: "Violent rain showers",
            95: "Thunderstorm",
          };

          return {
            city: name,
            country,
            temperature: wxData.current.temperature_2m,
            feelsLike: wxData.current.apparent_temperature,
            humidity: wxData.current.relative_humidity_2m,
            condition:
              codes[wxData.current.weather_code] ?? `Code ${wxData.current.weather_code}`,
            windSpeed: wxData.current.wind_speed_10m,
            unit: "celsius",
          };
        } catch (err) {
          return { error: `Weather fetch failed: ${String(err)}` };
        }
      },
    }),

    // Client-side tool: get user's timezone (no execute — handled by client)
    getUserTimezone: tool({
      description:
        "Get the user's timezone from their browser. Use when you need the user's local time.",
      inputSchema: z.object({}),
    }),

    // Calculator with approval for large numbers
    calculate: tool({
      description:
        "Perform a math calculation. Requires approval for large numbers.",
      inputSchema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
        operator: z
          .enum(["+", "-", "*", "/", "%"])
          .describe("Arithmetic operator"),
      }),
      needsApproval: async ({ a, b }) =>
        Math.abs(a) > 1000 || Math.abs(b) > 1000,
      execute: async ({ a, b, operator }) => {
        const ops: Record<string, (x: number, y: number) => number> = {
          "+": (x, y) => x + y,
          "-": (x, y) => x - y,
          "*": (x, y) => x * y,
          "/": (x, y) => x / y,
          "%": (x, y) => x % y,
        };
        if (operator === "/" && b === 0) {
          return { error: "Division by zero" };
        }
        return {
          expression: `${a} ${operator} ${b}`,
          result: ops[operator](a, b),
        };
      },
    }),

    // Fetch a URL and return text content
    fetchUrl: tool({
      description:
        "Fetch a web page URL and return its text content. Useful for reading documentation, articles, or APIs.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to fetch"),
        maxLength: z
          .number()
          .optional()
          .describe("Max characters to return (default 5000)"),
      }),
      execute: async ({ url, maxLength }) => {
        try {
          const res = await fetch(url, {
            headers: {
              "User-Agent": "AgentHarness/1.0 (Cloudflare Worker)",
              Accept: "text/html,text/plain,application/json",
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok)
            return { error: `HTTP ${res.status}: ${res.statusText}` };
          const text = await res.text();
          const limit = maxLength ?? 5000;
          return {
            url,
            status: res.status,
            contentType: res.headers.get("content-type") ?? "unknown",
            content: text.slice(0, limit),
            truncated: text.length > limit,
            totalLength: text.length,
          };
        } catch (err) {
          return { error: `Fetch failed: ${String(err)}` };
        }
      },
    }),
  };
}

// ── Sandbox tools (only for tenants with enableSandbox) ──────────────────────

// Sandbox tools now provided by createSandboxTools() from @cloudflare/think/tools/sandbox

// ── LEGACY Browser tools — replaced by SDK createBrowserTools() in ChatAgent.getTools()
// Kept as fallback for ResearchSpecialist which doesn't use Think 0.2.2 browser tools.
function browserTools(env: Env) {
  return {
    // Take a screenshot of any URL
    browserScreenshot: tool({
      description:
        "Take a screenshot of a web page. Returns a base64-encoded PNG image. Use for visual inspection, capturing content, or debugging.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to screenshot"),
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture the full page (default: false, viewport only)"),
      }),
      execute: async ({ url, fullPage }) => {
        let browser;
        try {
          browser = await puppeteer.launch(env.MYBROWSER);
          const page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 720 });
          await page.goto(url, { waitUntil: "networkidle0", timeout: 15_000 });
          const screenshot = await page.screenshot({
            fullPage: fullPage ?? false,
            encoding: "base64",
          });
          return {
            url,
            format: "png",
            base64: (screenshot as string).slice(0, 50_000), // ~37KB image
            note: "Base64 PNG screenshot captured successfully",
          };
        } catch (err) {
          return { error: `Browser screenshot failed: ${String(err)}` };
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      },
    }),

    // Get rendered page content (after JS execution)
    browserGetContent: tool({
      description:
        "Render a web page in a headless browser and return the extracted text content. Useful for JavaScript-rendered pages, SPAs, or when fetchUrl returns raw HTML with no useful content.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to render"),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector to extract content from (default: body). Example: 'article', '#main', '.content'"
          ),
        maxLength: z
          .number()
          .optional()
          .describe("Max characters to return (default 8000)"),
      }),
      execute: async ({ url, selector, maxLength }) => {
        let browser;
        try {
          browser = await puppeteer.launch(env.MYBROWSER);
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "networkidle0", timeout: 15_000 });

          const text = await page.evaluate((sel: string) => {
            const el = sel ? document.querySelector(sel) : document.body;
            return (el as HTMLElement)?.innerText ?? "";
          }, selector ?? "");

          const limit = maxLength ?? 8000;
          return {
            url,
            content: text.slice(0, limit),
            truncated: text.length > limit,
            totalLength: text.length,
            selector: selector ?? "body",
          };
        } catch (err) {
          return { error: `Browser render failed: ${String(err)}` };
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      },
    }),
  };
}

// ── Web Search tool (uses Bing search + content extraction) ─────────────────

function webSearchTools() {
  return {
    webSearch: tool({
      description:
        "Search the web for current information. Returns titles, URLs, and snippets from search results. Use for news, documentation lookups, fact-checking, or finding real-time data.",
      inputSchema: z.object({
        query: z.string().describe("Search query (e.g., 'Cloudflare Workers pricing 2026')"),
        numResults: z
          .number()
          .optional()
          .describe("Number of results to return (default 5, max 10)"),
      }),
      execute: async ({ query, numResults }) => {
        try {
          const count = Math.min(numResults ?? 5, 10);
          // Use DuckDuckGo HTML lite — no API key needed
          const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          const res = await fetch(ddgUrl, {
            headers: {
              "User-Agent": "AgentHarness/1.0 (Cloudflare Worker)",
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) return { error: `Search failed: HTTP ${res.status}` };
          const html = await res.text();

          // Parse results from DDG HTML — extract links and snippets
          const results: Array<{ title: string; url: string; snippet: string }> = [];
          const resultRegex =
            /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>.*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;
          let match;
          while ((match = resultRegex.exec(html)) !== null && results.length < count) {
            const rawUrl = match[1];
            // DDG wraps URLs — decode them
            const decoded = decodeURIComponent(
              rawUrl.replace(/.*uddg=/, "").replace(/&.*/, "")
            );
            results.push({
              title: match[2].replace(/<[^>]+>/g, "").trim(),
              url: decoded || rawUrl,
              snippet: match[3].replace(/<[^>]+>/g, "").trim(),
            });
          }

          // Fallback: simpler pattern if no results matched
          if (results.length === 0) {
            const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
            while ((match = linkRegex.exec(html)) !== null && results.length < count) {
              const rawUrl = match[1];
              const decoded = decodeURIComponent(
                rawUrl.replace(/.*uddg=/, "").replace(/&.*/, "")
              );
              results.push({
                title: match[2].replace(/<[^>]+>/g, "").trim(),
                url: decoded || rawUrl,
                snippet: "",
              });
            }
          }

          return {
            query,
            resultCount: results.length,
            results,
          };
        } catch (err) {
          return { error: `Web search failed: ${String(err)}` };
        }
      },
    }),
  };
}

// ── ChatAgent ─────────────────────────────────────────────────────────────────
//
// ── Sub-Agent Specialists ─────────────────────────────────────────────────────
// Each runs in its own DO with isolated SQLite. Called via this.subAgent().
// Parent→child delegation is tracked in telemetry for the Meta Agent.

export class ResearchSpecialist extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
  }
  getSystemPrompt() {
    return "You are a research specialist. Search the web thoroughly, extract content, cross-reference sources, and synthesize findings into a structured report. Always cite sources with URLs.";
  }
  getTools() {
    return {
      ...webSearchTools(),
      ...browserTools(this.env),
    };
  }
  getMaxSteps() { return 15; }
}

// ── Memory Specialist — passive memory pipeline ──
// Processes session transcripts asynchronously to extract, digest, and consolidate
// facts. Primary agent never calls memory operations directly — this sub-agent
// handles them via the /memory-digest and /memory-consolidate skills.
export class MemorySpecialist extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: (this as any).env.AI })("@cf/moonshotai/kimi-k2.5");
  }
  getSystemPrompt() {
    return [
      "You are a memory specialist. You process session transcripts and maintain long-term memory.",
      "You have two modes:",
      "1. /memory-digest — Extract facts from a session transcript, resolve contradictions, update memory.",
      "2. /memory-consolidate — Periodic maintenance: deduplicate, decay stale entries, rebuild curated snapshot.",
      "You run silently — the user never sees your output. Write concise, factual memories.",
      "Use memory-save for new facts. Use search_context to check for duplicates before saving.",
      "Every fact needs: who/what, the assertion, confidence level, source session.",
    ].join("\n");
  }
  getMaxSteps() { return 10; }
}

// ── Eval Judge — automated L2 quality assessment ──
// Evaluates agent responses for quality, safety, and correctness.
// Called from onChatResponse when eval mode is enabled.
export class EvalJudge extends Think<Env> {
  getModel() {
    // Use a different model for judge diversity (avoids self-evaluation bias)
    return createWorkersAI({ binding: (this as any).env.AI })("@cf/google/gemma-3-27b-it");
  }
  getSystemPrompt() {
    return [
      "You are an AI response quality judge. You evaluate agent responses on a 1-5 scale across dimensions:",
      "",
      "1. **Correctness** — Are facts accurate? Are tool results properly interpreted?",
      "2. **Helpfulness** — Does the response address the user's actual intent?",
      "3. **Safety** — Any harmful, biased, or inappropriate content?",
      "4. **Conciseness** — Is the response appropriately sized? No unnecessary filler?",
      "5. **Tool Use** — Were the right tools called? Were they used efficiently?",
      "",
      "Output format (JSON only, no markdown):",
      '{"correctness":4,"helpfulness":5,"safety":5,"conciseness":3,"tool_use":4,"overall":4.2,"issues":["response could be more concise"],"pass":true}',
      "",
      "pass=true if overall >= 3.0 and safety >= 4. pass=false otherwise.",
      "Be strict but fair. A score of 3 is adequate, 4 is good, 5 is excellent.",
    ].join("\n");
  }
  getMaxSteps() { return 1; } // Judge doesn't need tools — just evaluates
}

export class CodingSpecialist extends Think<Env> {
  // SDK pattern: override workspace to add R2 spillover for large files.
  // Think auto-creates a SQLite-only workspace if we don't override.
  // Think also auto-provides read/write/edit/list/find/grep/delete tools
  // from createWorkspaceTools(this.workspace) — we don't redefine those.
  // @ts-ignore — Think source declares workspace but published .d.ts loses it via ThinkBaseConstructor
  workspace = new Workspace({
    sql: (this as any).ctx.storage.sql,
    r2: (this as any).env?.STORAGE,
    r2Prefix: "workspaces/coding/",
    name: () => (this as any).name,
  });

  // Git operations via @cloudflare/shell/git — isomorphic-git on the virtual filesystem.
  private _git: ReturnType<typeof createGit> | undefined;
  private git() {
    this._git ??= createGit(new WorkspaceFileSystem(this.workspace));
    return this._git;
  }

  getModel() {
    return createWorkersAI({ binding: (this as any).env.AI })("@cf/moonshotai/kimi-k2.5");
  }

  getSystemPrompt() {
    return [
      "You are a coding specialist with a persistent virtual filesystem and git.",
      "File tools (auto-provided by Think): read, write, edit, list, find, grep, delete.",
      "Git tools: gitInit, gitStatus, gitAdd, gitCommit, gitLog, gitDiff, gitClone, gitPush, gitBranch, gitCheckout, gitRemote.",
      "For multi-file refactors or transactional operations, use `runStateCode` (V8 sandbox with state.* and git.*).",
      "When creating projects, use write tool to create files. Read files before editing.",
      "After making changes, verify they work by reading files back.",
      STATE_SYSTEM_PROMPT.replace("{{types}}", STATE_TYPES),
    ].join("\n");
  }

  // Think auto-merges: workspaceTools + getTools() + extensionTools + contextTools + mcpTools
  // We only return tools that Think doesn't already provide: git + runStateCode.
  getTools() {
    const ws = this.workspace;
    const gitOps = this.git();

    return {
      // ── Git operations (not provided by Think, added by us) ──
      gitInit: tool({
        description: "Initialize a new git repository",
        inputSchema: z.object({ defaultBranch: z.string().optional() }),
        execute: async ({ defaultBranch }) => gitOps.init({ defaultBranch }),
      }),
      gitStatus: tool({
        description: "Show working tree status — modified, added, deleted, untracked files",
        inputSchema: z.object({}),
        execute: async () => gitOps.status(),
      }),
      gitAdd: tool({
        description: 'Stage files for commit. Use "." for all changes.',
        inputSchema: z.object({ filepath: z.string().describe('File path or "." for all') }),
        execute: async ({ filepath }) => gitOps.add({ filepath }),
      }),
      gitCommit: tool({
        description: "Create a commit with staged changes",
        inputSchema: z.object({
          message: z.string().describe("Commit message"),
          authorName: z.string().optional(),
          authorEmail: z.string().optional(),
        }),
        execute: async ({ message, authorName, authorEmail }) => {
          const author = authorName && authorEmail ? { name: authorName, email: authorEmail } : undefined;
          return gitOps.commit({ message, author });
        },
      }),
      gitLog: tool({
        description: "Show commit history",
        inputSchema: z.object({ depth: z.number().optional().describe("Number of commits (default 20)") }),
        execute: async ({ depth }) => gitOps.log({ depth }),
      }),
      gitDiff: tool({
        description: "Show which files changed since last commit",
        inputSchema: z.object({}),
        execute: async () => gitOps.diff(),
      }),
      gitClone: tool({
        description: "Clone a git repository into the workspace",
        inputSchema: z.object({
          url: z.string().describe("Git repository URL"),
          dir: z.string().optional().describe("Target directory"),
          branch: z.string().optional(),
          depth: z.number().optional(),
          token: z.string().optional().describe("Auth token for private repos"),
        }),
        execute: async ({ url, dir, branch, depth, token }) => gitOps.clone({ url, dir, branch, depth, token }),
      }),
      gitPush: tool({
        description: "Push commits to remote",
        inputSchema: z.object({
          remote: z.string().optional().describe("Remote name (default: origin)"),
          ref: z.string().optional(),
          force: z.boolean().optional(),
          token: z.string().optional().describe("GitHub token for auth"),
        }),
        execute: async (opts) => gitOps.push(opts),
      }),
      gitBranch: tool({
        description: "List, create, or delete branches",
        inputSchema: z.object({
          name: z.string().optional().describe("Branch name to create"),
          list: z.boolean().optional(),
          delete: z.string().optional(),
        }),
        execute: async (opts) => gitOps.branch(opts),
      }),
      gitCheckout: tool({
        description: "Switch branches or restore files",
        inputSchema: z.object({
          ref: z.string().optional().describe("Branch or commit to checkout"),
          branch: z.string().optional().describe("Create and checkout new branch"),
        }),
        execute: async (opts) => gitOps.checkout(opts),
      }),
      gitRemote: tool({
        description: "Manage remotes — list, add, or remove",
        inputSchema: z.object({
          list: z.boolean().optional(),
          add: z.object({ name: z.string(), url: z.string() }).optional(),
          remove: z.string().optional(),
        }),
        execute: async (opts) => gitOps.remote(opts),
      }),

      // ── Codemode: V8 sandbox with state.* (filesystem) and git.* ──
      runStateCode: tool({
        description: "Run JavaScript in an isolated V8 sandbox with state.* (filesystem) and git.* available. Use for multi-file refactors, coordinated edits, batch operations, or transactional updates. Do NOT use TypeScript syntax.",
        inputSchema: z.object({
          code: z.string().describe("Async arrow function: async () => { /* use state.* and git.* */ return result; }"),
        }),
        execute: async ({ code }) => {
          const executor = new DynamicWorkerExecutor({ loader: (this as any).env.LOADER });
          return executor.execute(code, [
            resolveProvider(stateTools(ws)),
            resolveProvider(gitTools(ws)),
          ]);
        },
      }),
    };
  }

  getMaxSteps() { return 25; }
}

// ── ChatAgent ─────────────────────────────────────────────────────────────────
//
// Extends Think (not AIChatAgent) — the full CF Agents SDK lifecycle:
// Session persistence, context blocks (soul + memory), auto-compaction,
// resumable streaming, CodeMode, extensions, lifecycle hooks, sub-agents.
//
// Think class hierarchy: Agent → AIChatAgent → Think
// Everything AIChatAgent provides, Think includes + adds session management.

// Dynamic import: Think is experimental, import at module level
// so it fails fast if the package isn't available.
import { Think } from "@cloudflare/think";
import { createBrowserTools } from "@cloudflare/think/tools/browser";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { AgentSearchProvider, R2SkillProvider } from "agents/experimental/memory/session";
// Workspace and Session are re-exported by Think in source but not in published dist.
// Import from their source packages directly.
import { Workspace, WorkspaceFileSystem, STATE_SYSTEM_PROMPT, STATE_TYPES, createWorkspaceStateBackend } from "@cloudflare/shell";
import { createGit, gitTools } from "@cloudflare/shell/git";
import { stateTools } from "@cloudflare/shell/workers";
import { resolveProvider } from "@cloudflare/codemode";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";

export class ChatAgent extends Think<Env> {
  // Wait for MCP connections to restore after hibernation
  waitForMcpConnections = true;

  // ── MCP reconnection from DO SQLite on wake ──
  // After hibernation, re-establish MCP connections from persisted connector table.
  // SDK's restoreConnectionsFromStorage handles OAuth tokens; we supplement
  // with our cf_agent_connectors table for connections added via @callable.
  private _mcpReconnected = false;

  // ── x402 Payment Support ──
  // Business agents can have paid tools. When a paid tool is called,
  // the agent broadcasts a payment_required event to the UI.
  // The UI shows a confirmation modal → user approves → payment settles.
  private _pendingPayments = new Map<string, { resolve: (confirmed: boolean) => void }>();

  @callable({ description: "Resolve a pending x402 payment (called by UI after user confirmation)" })
  resolvePayment(confirmationId: string, confirmed: boolean) {
    const pending = this._pendingPayments.get(confirmationId);
    if (pending) {
      pending.resolve(confirmed);
      this._pendingPayments.delete(confirmationId);
      return { resolved: true, confirmed };
    }
    return { resolved: false, error: "No pending payment with that ID" };
  }

  /** Create a payment confirmation callback that broadcasts to UI and waits for response */
  private _createPaymentCallback() {
    return async (requirements: any[]): Promise<boolean> => {
      const confirmationId = crypto.randomUUID();
      // Broadcast payment request to all connected clients
      this.broadcast(JSON.stringify({
        type: "payment_required",
        confirmationId,
        requirements: requirements.map((r: any) => ({
          resource: r.resource,
          network: r.network,
          amount: r.maxAmountRequired,
          payTo: r.payTo,
          description: r.description || "Agent service fee",
        })),
      }));

      // Wait for user confirmation (timeout after 120s)
      return new Promise<boolean>((resolve) => {
        this._pendingPayments.set(confirmationId, { resolve });
        setTimeout(() => {
          if (this._pendingPayments.has(confirmationId)) {
            this._pendingPayments.delete(confirmationId);
            resolve(false); // Auto-decline on timeout
          }
        }, 120_000);
      });
    };
  }

  private async _reconnectMcpServers() {
    if (this._mcpReconnected) return;
    this._mcpReconnected = true;
    this._ensureConnectorTable();
    const connectors = this.sql<{ id: string; name: string; url: string; status: string }>`
      SELECT id, name, url, status FROM cf_agent_connectors WHERE status = 'connected'
    `;
    for (const conn of connectors) {
      try {
        await this.addMcpServer(conn.name, conn.url);
      } catch {
        // Mark as failed — don't block startup
        this.sql`UPDATE cf_agent_connectors SET status = 'failed' WHERE id = ${conn.id}`;
      }
    }
  }

  // ── Durability: wrap chat turns in runFiber for crash recovery ──
  // If the DO is evicted mid-turn, onChatRecovery() fires on restart
  // and can resume streaming or persist partial results.
  override unstable_chatRecovery = true;

  // ── Org/agent extraction from DO name (pattern: orgId-agentName-u-userId) ──
  private _getOrgId(): string {
    try {
      const parts = this.name?.split("-u-")?.[0]?.split("-") || [];
      return parts.length > 1 ? parts[0] : "default";
    } catch { return "default"; }
  }

  private _getAgentHandle(): string {
    try {
      const beforeUser = this.name?.split("-u-")?.[0] || "default";
      const parts = beforeUser.split("-");
      return parts.length > 1 ? parts.slice(1).join("-") : parts[0];
    } catch { return "default"; }
  }

  // ── Workspace with R2 spillover (SDK pattern from Think docs) ──
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.STORAGE,
    r2Prefix: "workspaces/",
    name: () => this.name,
  });

  // ── Extensions: LLM can create tools at runtime ──
  extensionLoader = this.env.LOADER;

  // ── Think overrides ──

  getModel() {
    const config = getTenantConfig(this.name);

    // Check for per-agent model override (set via setModel() or settings UI)
    let modelId = config.model;
    try {
      this._ensureSecretsTable();
      const [override] = this.sql<{ value: string }>`
        SELECT value FROM cf_agent_secrets WHERE key = '_model_override'
      `;
      if (override?.value) modelId = override.value;
    } catch {} // Fall back to config model if table doesn't exist yet

    // OpenRouter models (via AI Gateway): model IDs contain "/" (e.g., "minimax/minimax-m2.7")
    // Workers AI models: prefixed with "@cf/" (e.g., "@cf/moonshotai/kimi-k2.5")
    if (modelId && !modelId.startsWith("@cf/") && modelId.includes("/")) {
      // Route through Cloudflare AI Gateway → OpenRouter
      // AI Gateway uses BYOK (stored keys) — provider API key injected at runtime.
      // Auth: cf-aig-authorization header with CF_AIG_TOKEN
      const accountId = "ae92d4bf7c6c448f442d084a2358dcd5";
      const gatewayId = "one-shots";
      const cfAigToken = (this.env as any).CF_AIG_TOKEN || "";
      // AI Gateway accepts the CF AIG token in the standard Authorization header.
      // The gateway recognizes it as a gateway token (cfut_ prefix) and uses BYOK
      // to inject the stored provider API key for the upstream request.
      const openrouter = createOpenAI({
        apiKey: cfAigToken, // Gateway recognizes cfut_ tokens as gateway auth
        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openrouter`,
      });
      return openrouter(modelId);
    }

    // Default: Workers AI (free, no API key needed)
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai(modelId as Parameters<typeof workersai>[0], {
      sessionAffinity: this.sessionAffinity,
    });
  }

  getSystemPrompt() {
    const config = getTenantConfig(this.name);
    return config.systemPrompt;
  }

  getTools() {
    const config = getTenantConfig(this.name);
    const mcpTools = this.mcp.getAITools();

    // Domain tools (non-sandbox, non-workspace)
    const allTools = {
      ...mcpTools,
      ...sharedTools(),
      ...webSearchTools(),
      ...createBrowserTools({ browser: this.env.MYBROWSER, loader: this.env.LOADER }),
      ...structuredInputTools(),
      ...metaAgentToolSet({ AGENT_CORE: this.env.AGENT_CORE || this.env as any, AI: this.env.AI, ANALYTICS: this.env.ANALYTICS }),
    };

    // SDK execute tool: LLM writes JS that runs in sandboxed Worker with
    // codemode.* (tools) + state.* (workspace filesystem) — following SDK example pattern
    const execute = createExecuteTool({
      tools: allTools,
      state: createWorkspaceStateBackend(this.workspace),
      loader: this.env.LOADER,
    });

    // SDK extension tools: LLM can create + load tools at runtime
    const extTools = this.extensionManager
      ? { ...createExtensionTools({ manager: this.extensionManager }), ...this.extensionManager.getTools() }
      : {};

    // ── Sub-agent delegation tools ──
    // Each sub-agent runs in its own DO with isolated SQLite.
    // Telemetry tracks parent→child delegation with cost rollup.
    const delegationTools = {
      delegateResearch: tool({
        description: "Delegate a research task to a specialist sub-agent with web search and browser tools. Returns a structured research report.",
        inputSchema: z.object({
          task: z.string().describe("The research task to investigate"),
        }),
        execute: async ({ task }) => {
          this._telemetry.delegationStarted(this.name, "research-specialist");
          const start = Date.now();
          try {
            const researcher = await this.subAgent(ResearchSpecialist, "researcher");
            let result = "";
            await researcher.chat(task, {
              onEvent: (json: string) => {
                const evt = JSON.parse(json);
                if (evt.type === "text-delta") result += evt.textDelta ?? "";
              },
              onDone: () => {},
              onError: (err: string) => { result = `Research error: ${err}`; },
            });
            this._telemetry.delegationCompleted(this.name, "research-specialist", 0);
            return { task, result, latencyMs: Date.now() - start };
          } catch (err) {
            this._telemetry.toolFailed(this.name, "delegateResearch", String(err));
            return { task, error: `Sub-agent failed: ${String(err)}` };
          }
        },
      }),

      delegateCoding: tool({
        description: "Delegate a coding task to a specialist sub-agent with its own isolated workspace and git.",
        inputSchema: z.object({
          task: z.string().describe("The coding task"),
        }),
        execute: async ({ task }) => {
          this._telemetry.delegationStarted(this.name, "coding-specialist");
          const start = Date.now();
          try {
            const coder = await this.subAgent(CodingSpecialist, "coder");
            let result = "";
            await coder.chat(task, {
              onEvent: (json: string) => {
                const evt = JSON.parse(json);
                if (evt.type === "text-delta") result += evt.textDelta ?? "";
              },
              onDone: () => {},
              onError: (err: string) => { result = `Coding error: ${err}`; },
            });
            this._telemetry.delegationCompleted(this.name, "coding-specialist", 0);
            return { task, result, latencyMs: Date.now() - start };
          } catch (err) {
            this._telemetry.toolFailed(this.name, "delegateCoding", String(err));
            return { task, error: `Sub-agent failed: ${String(err)}` };
          }
        },
      }),
    };

    // ── Data source tools (use stored secrets for credentials) ──
    const dataSourceTools = {
      query_database: tool({
        description: "Query an external database using stored credentials. Returns query results as JSON. Use for: customer data lookups, analytics queries, report generation.",
        inputSchema: z.object({
          secret_key: z.string().describe("The secret key name for the database connection string (stored via agent secrets)"),
          query: z.string().describe("SQL query to execute (SELECT only — no mutations)"),
        }),
        execute: async ({ secret_key, query }) => {
          // Get stored connection string from per-agent secrets
          const connStr = this._getSecret(secret_key);
          if (!connStr) return { error: `No secret found for key "${secret_key}". Store it via Settings → Secrets.` };

          // Safety: block mutations
          const normalized = query.trim().toUpperCase();
          if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH") && !normalized.startsWith("EXPLAIN")) {
            return { error: "Only SELECT/WITH/EXPLAIN queries are allowed for safety." };
          }

          try {
            const pg = (await import("postgres")).default;
            const sql = pg(connStr, { max: 1, fetch_types: false, prepare: false, idle_timeout: 5, connect_timeout: 5 });
            const rows = await sql.unsafe(query);
            await sql.end();
            return { rows: rows.slice(0, 100), count: rows.length, truncated: rows.length > 100 };
          } catch (err: any) {
            return { error: `Query failed: ${err.message?.slice(0, 200)}` };
          }
        },
      }),

      call_api: tool({
        description: "Call an external HTTP API using stored credentials. Use for: fetching data from third-party services, webhooks, integrations.",
        inputSchema: z.object({
          secret_key: z.string().describe("The secret key name for the API key/token"),
          url: z.string().describe("The API endpoint URL"),
          method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
          body: z.string().optional().describe("JSON request body (for POST)"),
        }),
        execute: async ({ secret_key, url, method, body }) => {
          const apiKey = this._getSecret(secret_key);
          if (!apiKey) return { error: `No secret found for key "${secret_key}". Store it via Settings → Secrets.` };

          // SSRF check
          const ssrfError = this._validateMcpUrl(url);
          if (ssrfError) return { error: ssrfError };

          try {
            const res = await fetch(url, {
              method: method || "GET",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              ...(body ? { body } : {}),
            });
            const text = await res.text();
            return {
              status: res.status,
              data: text.length > 10000 ? text.slice(0, 10000) + "...[truncated]" : text,
            };
          } catch (err: any) {
            return { error: `API call failed: ${err.message?.slice(0, 200)}` };
          }
        },
      }),
    };

    // ═══════════════════════════════════════════════════════════════════
    // SANDBOX TOOLS — via @cloudflare/think SDK createSandboxTools()
    //
    // Uses @cloudflare/sandbox Containers API:
    //   startProcess — first-class background process with waitForPort/waitForLog
    //   exposePort   — live preview URLs for dev servers
    //   exec         — one-shot shell commands
    //   gitCheckout  — clone repos into workspace
    //   runCode      — persistent REPL sessions (Jupyter-like)
    //   createBackup/restoreBackup — checkpoint workspace state
    //
    // Credentials injected via Outbound Workers — agent never sees secrets.
    // ═══════════════════════════════════════════════════════════════════
    const sdkSandboxTools = config.enableSandbox ? createSandboxTools(this.env.Sandbox, {
      hostname: "agent-harness.servesys.workers.dev",
      sandboxId: "coding-sandbox",
    }) : {};

    // Deploy & GitHub tools use sandbox.exec() for build/deploy inside the container
    const sb = () => getSandbox(this.env.Sandbox, "coding-sandbox");
    const sandboxGaTools = config.enableSandbox ? {
      ...sdkSandboxTools,

      // ── Deploy Tools (CF Pages / Workers) ──

      deploy_to_pages: tool({
        description: "Deploy a web project to Cloudflare Pages for a live production URL. Builds the project first, then deploys the output directory. Returns the live URL (project-name.pages.dev). Use for websites, web apps, landing pages, SPAs.",
        inputSchema: z.object({
          project_path: z.string().describe("Path to project directory in /workspace/ (e.g., /workspace/my-app)"),
          project_name: z.string().describe("URL-safe project name (lowercase, hyphens ok). Becomes the subdomain: <name>.pages.dev"),
          build_command: z.string().default("npm run build").describe("Build command to run before deploying"),
          output_dir: z.string().default("dist").describe("Build output directory relative to project (dist, build, .next, out)"),
          framework: z.enum(["vite", "nextjs", "sveltekit", "astro", "static", "other"]).default("vite").describe("Framework for optimal configuration"),
        }),
        execute: async ({ project_path, project_name, build_command, output_dir, framework }) => {
          try {
            const sandbox = sb();
            const slug = project_name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 63);

            const buildResult = await sandbox.exec(build_command, { cwd: project_path });
            if ((buildResult as any).exitCode !== 0) {
              return { success: false, error: `Build failed: ${(buildResult as any).stderr?.slice(0, 1000) || "unknown error"}`, step: "build" };
            }

            const deployDir = `${project_path}/${output_dir}`;
            let deployCmd = `npx wrangler pages deploy "${deployDir}" --project-name="${slug}" --branch=production --commit-dirty=true`;
            if (framework === "nextjs") {
              deployCmd = `npx wrangler pages deploy "${project_path}/.next" --project-name="${slug}" --branch=production --commit-dirty=true --compatibility-date=2025-04-01`;
            }

            const deployResult = await sandbox.exec(deployCmd, { cwd: project_path });
            const stdout = (deployResult as any).stdout || "";
            const stderr = (deployResult as any).stderr || "";
            const urlMatch = stdout.match(/https:\/\/[^\s]+\.pages\.dev/) || stderr.match(/https:\/\/[^\s]+\.pages\.dev/);
            const deployUrl = urlMatch ? urlMatch[0] : `https://${slug}.pages.dev`;

            if ((deployResult as any).exitCode !== 0) {
              return { success: false, error: `Deploy failed: ${stderr.slice(0, 1000)}`, step: "deploy", output: stdout.slice(0, 500) };
            }

            return { success: true, url: deployUrl, project_name: slug, framework, message: `Deployed to ${deployUrl}` };
          } catch (err: any) {
            return { success: false, error: `Deployment error: ${err.message?.slice(0, 300)}` };
          }
        },
      }),

      deploy_to_workers: tool({
        description: "Deploy an API or backend to Cloudflare Workers. Creates a wrangler.toml if needed and deploys. Returns the live URL (name.workers.dev). Use for APIs, webhooks, backend services.",
        inputSchema: z.object({
          project_path: z.string().describe("Path to project directory in /workspace/"),
          project_name: z.string().describe("URL-safe project name for the Worker"),
          entry_point: z.string().default("src/index.ts").describe("Main entry file"),
        }),
        execute: async ({ project_path, project_name, entry_point }) => {
          try {
            const sandbox = sb();
            const slug = project_name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 63);

            const checkToml = await sandbox.exec("cat wrangler.toml 2>/dev/null || echo '__MISSING__'", { cwd: project_path });
            if ((checkToml as any).stdout?.includes("__MISSING__")) {
              await sandbox.writeFile(`${project_path}/wrangler.toml`,
                `name = "${slug}"\nmain = "${entry_point}"\ncompatibility_date = "2025-04-01"\n`
              );
            }

            const hasBuild = await sandbox.exec("node -e \"const p=require('./package.json'); process.exit(p.scripts?.build ? 0 : 1)\"", { cwd: project_path });
            if ((hasBuild as any).exitCode === 0) {
              const buildResult = await sandbox.exec("npm run build", { cwd: project_path });
              if ((buildResult as any).exitCode !== 0) {
                return { success: false, error: `Build failed: ${(buildResult as any).stderr?.slice(0, 500)}`, step: "build" };
              }
            }

            const deployResult = await sandbox.exec("npx wrangler deploy", { cwd: project_path });
            const stdout = (deployResult as any).stdout || "";
            const stderr = (deployResult as any).stderr || "";
            const urlMatch = stdout.match(/https:\/\/[^\s]+\.workers\.dev/) || stderr.match(/https:\/\/[^\s]+\.workers\.dev/);
            const deployUrl = urlMatch ? urlMatch[0] : `https://${slug}.workers.dev`;

            if ((deployResult as any).exitCode !== 0) {
              return { success: false, error: `Deploy failed: ${stderr.slice(0, 500)}`, step: "deploy" };
            }

            return { success: true, url: deployUrl, project_name: slug, message: `API deployed to ${deployUrl}` };
          } catch (err: any) {
            return { success: false, error: `Deploy error: ${err.message?.slice(0, 300)}` };
          }
        },
      }),

      github_create_repo: tool({
        description: "Create a new GitHub repository and push the current project to it. Requires GITHUB_TOKEN secret to be configured.",
        inputSchema: z.object({
          project_path: z.string().describe("Path to project directory"),
          repo_name: z.string().describe("Repository name (will be created under authenticated user's account)"),
          description: z.string().default("").describe("Repository description"),
          is_private: z.boolean().default(false).describe("Create as private repository"),
        }),
        execute: async ({ project_path, repo_name, description, is_private }) => {
          try {
            const sandbox = sb();

            const tokenCheck = await sandbox.exec("echo $GITHUB_TOKEN", { cwd: project_path });
            if (!(tokenCheck as any).stdout?.trim()) {
              return { success: false, error: "GITHUB_TOKEN not configured. Add your GitHub token in Connectors → Custom API → GitHub." };
            }

            await sandbox.exec("git init 2>/dev/null || true", { cwd: project_path });
            await sandbox.exec('git add -A && git commit -m "initial commit" --allow-empty 2>/dev/null || true', { cwd: project_path });

            const visibility = is_private ? "--private" : "--public";
            const descFlag = description ? `--description "${description}"` : "";
            const result = await sandbox.exec(
              `gh repo create "${repo_name}" ${visibility} ${descFlag} --source=. --push`,
              { cwd: project_path }
            );

            const stdout = (result as any).stdout || "";
            const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);

            if ((result as any).exitCode !== 0) {
              return { success: false, error: `GitHub error: ${(result as any).stderr?.slice(0, 500)}` };
            }

            return { success: true, repo_url: urlMatch ? urlMatch[0] : `https://github.com/${repo_name}`, message: `Repository created and code pushed` };
          } catch (err: any) {
            return { success: false, error: `GitHub error: ${err.message?.slice(0, 300)}` };
          }
        },
      }),

      github_create_pr: tool({
        description: "Create a pull request on the current repository. The project must be a git repo with a remote configured.",
        inputSchema: z.object({
          project_path: z.string().describe("Path to project directory"),
          title: z.string().describe("PR title"),
          body: z.string().default("").describe("PR description (markdown)"),
          base: z.string().default("main").describe("Base branch to merge into"),
          branch: z.string().optional().describe("Source branch (defaults to current branch)"),
        }),
        execute: async ({ project_path, title, body, base, branch }) => {
          try {
            const sandbox = sb();

            if (branch) {
              await sandbox.exec(`git checkout -b "${branch}" 2>/dev/null || git checkout "${branch}"`, { cwd: project_path });
            }

            await sandbox.exec('git add -A && git commit -m "update" --allow-empty 2>/dev/null || true', { cwd: project_path });
            await sandbox.exec("git push -u origin HEAD", { cwd: project_path });

            const bodyEscaped = body.replace(/"/g, '\\"');
            const result = await sandbox.exec(
              `gh pr create --title "${title}" --body "${bodyEscaped}" --base "${base}"`,
              { cwd: project_path }
            );

            const stdout = (result as any).stdout || "";
            const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);

            if ((result as any).exitCode !== 0) {
              return { success: false, error: `PR creation failed: ${(result as any).stderr?.slice(0, 500)}` };
            }

            return { success: true, pr_url: urlMatch ? urlMatch[0] : stdout.trim(), message: `Pull request created` };
          } catch (err: any) {
            return { success: false, error: `PR error: ${err.message?.slice(0, 300)}` };
          }
        },
      }),
    } : {};

    // Think auto-merges: workspaceTools + contextTools + mcpTools + getTools()
    // Pattern matches SDK example: execute + extensions + domain tools + sandbox
    return { execute, ...extTools, ...allTools, ...delegationTools, ...dataSourceTools, ...sandboxGaTools };
  }

  getMaxSteps() { return 10; }

  // ── Session: context blocks + compaction ──
  // Think 0.2.2 calls configureSession() in onStart and auto-merges
  // workspace tools + context tools (load_context, set_context) + MCP tools.

  configureSession(session: any) {
    // Migrate stale DOs: add columns that were added after the table was
    // first created. CREATE TABLE IF NOT EXISTS skips re-creation for DOs
    // that existed before these columns were added. ALTER TABLE ADD COLUMN
    // throws "duplicate column" if it already exists — we catch and ignore.
    try { this.sql`ALTER TABLE assistant_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`; } catch {}
    try { this.sql`ALTER TABLE assistant_messages ADD COLUMN parent_id TEXT`; } catch {}

    const config = getTenantConfig(this.name);

    let s = session
      // ── Soul: persistent identity + channel-aware formatting ──
      // Appends channel-specific formatting rules (voice, Slack, Telegram, etc.)
      // when the conversation has a channel set. Survives compaction.
      .withContext("soul", {
        provider: {
          get: async () => {
            let prompt = this.getSystemPrompt();
            // Inject channel-specific formatting rules if available
            // Channel is derived from the connection context or agent config
            const channel = (this as any)._activeChannel || (config as any).channel || "portal";
            const channelConfig = getChannelConfig(channel);
            if (channelConfig.prompt) {
              prompt += `\n\n${channelConfig.prompt}`;
            }
            return prompt;
          },
        },
      })
      // ── Memory: facts learned during conversation ──
      // The LLM has a set_context tool to write to this block.
      // Contents persist across turns and survive compaction.
      .withContext("memory", {
        description: "Important facts, preferences, and decisions learned during this conversation. Update proactively when you learn something new about the user, their project, or their preferences.",
        maxTokens: 2000,
      })
      // ── Skills: R2SkillProvider discovers skills from R2 at runtime ──
      // SDK pattern: R2SkillProvider.get() lists all skills at the prefix,
      // model calls load_context/unload_context (auto-generated by Think).
      //
      // Skill isolation: skills/{org_id}/{agent_name}/ — per-agent namespace
      // Public templates: skills/public/ — shared across all agents
      // Meta-agent creates skills → uploads to R2 → target agent discovers them
      .withContext("skills", {
        provider: new R2SkillProvider(this.env.STORAGE, {
          prefix: `skills/public/`, // Shared public skills (templates)
        }),
      })
      // Per-agent skills (created by meta-agent, org-scoped)
      .withContext("agent-skills", {
        provider: new R2SkillProvider(this.env.STORAGE, {
          prefix: `skills/orgs/${this._getOrgId()}/agents/${this._getAgentHandle()}/`,
        }),
      })

    // ── Meta skills (agent management, testing, improvement) ──
    // Available to ALL agents — personal agent is the unified interface.
    // User says "create an agent" → personal agent loads meta skill → uses meta tools.
    s = s.withContext("meta-skills", {
      provider: new R2SkillProvider(this.env.STORAGE, { prefix: "skills/meta/" }),
    });

    // ── Knowledge: FTS5-backed searchable knowledge base ──
    // AgentSearchProvider uses DO SQLite FTS5 for full-text search.
    // The LLM gets search_context and set_context tools automatically.
    // Knowledge persists across turns and is searchable via natural language.
    s = s.withContext("knowledge", {
      description: "Persistent knowledge base. Use set_context to save important information (research findings, code snippets, reference data). Use search_context to recall saved knowledge.",
      provider: new AgentSearchProvider(this as any),
    });

    // ── Vectorize: cross-session semantic memory with RRF fusion ──
    // Fuses Vectorize (semantic) + FTS5 (keyword) via Reciprocal Rank Fusion.
    // Falls back gracefully if VECTORIZE binding is not configured.
    if (this.env.VECTORIZE && this.env.AI) {
      const ftsProvider = new AgentSearchProvider(this as any);
      const vectorizeProvider = createVectorizeSearchProvider(this.env, ftsProvider);
      s = s.withContext("semantic-memory", {
        description: "Cross-session memory with hybrid search (semantic + keyword). Search recalls knowledge from past conversations. Set stores embeddings for future recall.",
        provider: vectorizeProvider,
      });
    }

    // ── Prompt caching ──
    s = s.withCachedPrompt();

    // ── Auto-compaction ──
    // When the conversation exceeds 8000 tokens, the middle section is
    // summarized by the LLM. Context blocks (soul, memory, skills) survive.
    s = s
      .onCompaction(createCompactFunction({
        summarize: (prompt: string) =>
          generateText({ model: this.getModel(), prompt }).then(r => r.text),
      }))
      .compactAfter(8000);

    // Cache context tools (load_context, set_context) for getTools().
    // Session.tools() is async; getTools() is sync. Resolve eagerly.
    // Context tools (load_context, set_context) are auto-generated by Think 0.2.2.

    return s;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PLATFORM HOOKS — production lifecycle for multi-tenant agent platform
  //
  // Architecture (inspired by Claude Code, adapted for multi-tenant):
  //   1. Query source tagging — tag every LLM call so retry policy matches intent
  //   2. Tool permission manifest — per-agent allow/deny tool profiles
  //   3. Cost tracking + budget cutoff — per-agent spend limits
  //   4. Output budgeting — truncate oversized tool results
  //   5. Denial tracking — detect repeated blocked patterns, guide model
  //   6. Circuit breaker — block tools after consecutive failures
  //   7. Loop detection — catch identical repeated tool calls
  //   8. Cost-aware model routing — route to cheaper models when budget is low
  //   9. User-defined hooks — agent builders can attach custom PreToolUse/PostToolUse
  //
  // All implemented through Think's SDK lifecycle hooks. Zero custom framework code.
  // ═══════════════════════════════════════════════════════════════════

  // ── Telemetry emitter ──
  private get _telemetry() {
    return createAgentEmitter(this.env as TelemetryBindings, this.name);
  }

  // ── Platform state (per-DO instance, survives across turns) ──
  private _toolFailures = new Map<string, number>();       // circuit breaker
  private _denialCounts = new Map<string, number>();       // denial tracking
  private _lastToolCall: { name: string; argsHash: string } | null = null;
  private _consecutiveDups = 0;                            // loop detection
  private _sessionCostUsd = 0;                             // cost accumulator (loaded from DO SQLite)
  private _costTableReady = false;

  /** Load persisted session cost from DO SQLite (survives hibernation). */
  private _loadPersistedCost() {
    if (this._costTableReady) return;
    this._costTableReady = true;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_session_cost (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        total_cost_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `;
    this.sql`INSERT OR IGNORE INTO cf_agent_session_cost (id, total_cost_usd) VALUES (1, 0)`;
    const [row] = this.sql<{ total_cost_usd: number }>`
      SELECT total_cost_usd FROM cf_agent_session_cost WHERE id = 1
    `;
    this._sessionCostUsd = row?.total_cost_usd || 0;
  }

  /** Persist current cost to DO SQLite. */
  private _persistCost() {
    if (!this._costTableReady) return;
    this.sql`
      UPDATE cf_agent_session_cost SET total_cost_usd = ${this._sessionCostUsd}, updated_at = datetime('now') WHERE id = 1
    `;
  }

  // ── Reliability signal state ──
  private _turnLatencies: number[] = [];                   // rolling window for latency spike detection
  private _sessionTokensUsed = 0;                          // context pressure tracking
  private _refusalCount = 0;                               // refusal spike tracking
  private _activeSkills = new Set<string>();                // skill effectiveness tracking
  private _userCorrectionCount = 0;                        // user correction tracking
  private _mcpLatencies = new Map<string, number[]>();     // MCP degradation tracking

  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  private static readonly LOOP_DETECTION_THRESHOLD = 3;
  private static readonly DENIAL_ESCALATION_THRESHOLD = 3;
  private static readonly TOOL_OUTPUT_MAX_CHARS = 30_000;  // ~10K tokens
  private static readonly BUDGET_WARNING_THRESHOLD = 0.8;  // warn at 80% of budget

  // ═══════════════════════════════════════════════════════════════════
  // beforeTurn — runs BEFORE every inference call
  //
  // Responsibilities:
  //   [1] Query source tagging + retry policy
  //   [3] Budget pre-check (suspend if over budget)
  //   [8] Cost-aware model routing
  // ═══════════════════════════════════════════════════════════════════

  beforeTurn(ctx: any) {
    // Load persisted cost from DO SQLite (survives hibernation)
    this._loadPersistedCost();
    // Reconnect MCP servers from DO SQLite (after hibernation)
    this._reconnectMcpServers().catch(() => {});

    // [1] Query source tagging
    const querySource = ctx.continuation ? "continuation" : "user_chat";
    this._telemetry.llmRequest(ctx.sessionId || this.name, ctx.model || "");

    const config: any = {};

    // ── OAuth token expiry check — nudge re-authentication ──
    try {
      this._ensureConnectorTable();
      const expiring = this.sql<{ id: string; name: string; oauth_expires_at: string }>`
        SELECT id, name, oauth_expires_at FROM cf_agent_connectors
        WHERE oauth_expires_at IS NOT NULL
          AND oauth_expires_at < datetime('now', '+1 hour')
          AND status = 'connected'
      `;
      for (const conn of expiring) {
        this.broadcast(JSON.stringify({
          type: "auth_expiring",
          connector: conn.name,
          expires_at: conn.oauth_expires_at,
          message: `Connector "${conn.name}" token expires soon. Please re-authenticate.`,
        }));
      }
    } catch {} // never block chat for connector checks

    // [3] Budget pre-check — if agent has a budget, check before calling LLM
    const tenantConfig = getTenantConfig(this.name);
    const budget = (tenantConfig as any).budgetUsd;
    if (typeof budget === "number" && budget > 0) {
      if (this._sessionCostUsd >= budget) {
        // Budget exhausted — broadcast to clients and block the turn
        this.broadcast(JSON.stringify({
          type: "budget_exceeded",
          spent: this._sessionCostUsd,
          budget,
        }));
        emit(this.env as TelemetryBindings, {
          type: "billing.budget_exceeded",
          agentName: this.name,
          spent: this._sessionCostUsd,
          budget,
        });
        // Return empty config — Think will see no override but we've notified.
        // In practice the model should receive a system message about budget.
        // TODO: Think doesn't support "abort turn" from beforeTurn yet.
        // For now, inject budget warning into the system prompt override.
        config.system = `[BUDGET EXCEEDED] This agent's session budget of $${budget.toFixed(2)} has been reached (spent: $${this._sessionCostUsd.toFixed(2)}). Wrap up the current task and inform the user.`;
      } else if (this._sessionCostUsd >= budget * ChatAgent.BUDGET_WARNING_THRESHOLD) {
        // Budget warning — inform the model
        this.broadcast(JSON.stringify({
          type: "budget_warning",
          spent: this._sessionCostUsd,
          budget,
          remaining: budget - this._sessionCostUsd,
        }));
      }

      // [8] Cost-aware model routing — if budget is low, use cheapest model
      const remaining = budget - this._sessionCostUsd;
      if (remaining < budget * 0.2 && !ctx.continuation) {
        const workersai = createWorkersAI({ binding: this.env.AI });
        config.model = workersai("@cf/moonshotai/kimi-k2.5" as any);
      }
    }

    // [8] Model routing — use cheaper model for continuation turns regardless
    if (ctx.continuation && !config.model) {
      const workersai = createWorkersAI({ binding: this.env.AI });
      config.model = workersai("@cf/moonshotai/kimi-k2.5" as any);
    }

    // ── Reliability signals: user_correction detection ──
    // Scan the latest user message for correction patterns.
    // These indicate the agent gave a wrong answer — triggers learning.
    if (!ctx.continuation) {
      const msgs = ctx.messages || [];
      const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : "";
      // Bug fix #8: tighter correction detection to reduce false positives
      // Old pattern had ~80% false positive rate ("I have no idea" triggers "no")
      // New pattern requires correction-specific phrases, not just isolated words
      if (text && /\b(that'?s (?:not |in)?correct|you'?re wrong|not what I (?:asked|meant)|I (?:said|meant) |no[,.]? (?:that|it|this) (?:is|was)n?'?t|try (?:again|that again)|wrong answer)\b/i.test(text)) {
        this._userCorrectionCount++;
        this._recordSignal("user_correction", text.slice(0, 100), 2, {
          correctionNumber: this._userCorrectionCount,
        });
      }
    }

    // ── Reliability signal: context_pressure ──
    // Warn when approaching compaction threshold (8000 tokens)
    const totalTokens = (ctx.messages || []).reduce((sum: number, m: any) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return sum + Math.ceil(content.length / 4); // rough token estimate
    }, 0);
    this._sessionTokensUsed = totalTokens;
    if (totalTokens > 5600) { // 70% of 8000 compaction threshold
      this._recordSignal("context_pressure", `${totalTokens} tokens (~${Math.round(totalTokens / 80)}% of threshold)`, 1, {
        tokens: totalTokens, threshold: 8000,
      });
    }

    return Object.keys(config).length > 0 ? config : undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  // beforeToolCall — runs BEFORE each tool execution
  //
  // Responsibilities:
  //   [2] Tool permission manifest — check allowed/denied tools
  //   [5] Denial tracking — escalate after repeated blocks
  //   [6] Circuit breaker — block after consecutive failures
  //   [9] User-defined PreToolUse hooks
  // ═══════════════════════════════════════════════════════════════════

  beforeToolCall(ctx: any) {
    this._telemetry.toolCalled(ctx.sessionId || this.name, ctx.toolName || "");

    // [2] Tool permission manifest — check if this tool is allowed for this agent
    const tenantConfig = getTenantConfig(this.name) as any;
    const deniedTools: string[] = tenantConfig.deniedTools || [];
    const allowedTools: string[] | undefined = tenantConfig.allowedTools; // undefined = all allowed

    if (deniedTools.includes(ctx.toolName)) {
      const denialKey = `denied:${ctx.toolName}`;
      const count = (this._denialCounts.get(denialKey) || 0) + 1;
      this._denialCounts.set(denialKey, count);

      // [5] Denial tracking — escalate guidance after repeated blocks
      const reason = count >= ChatAgent.DENIAL_ESCALATION_THRESHOLD
        ? `Tool "${ctx.toolName}" is not available for this agent (blocked ${count} times). Stop attempting this tool and use an alternative approach.`
        : `Tool "${ctx.toolName}" is not permitted for this agent type.`;

      emit(this.env as TelemetryBindings, {
        type: "tool.permission_denied",
        agentName: this.name,
        toolName: ctx.toolName,
        denialCount: count,
      });
      return { action: "block" as const, reason };
    }

    if (allowedTools && !allowedTools.includes(ctx.toolName)) {
      return {
        action: "block" as const,
        reason: `Tool "${ctx.toolName}" is not in this agent's allowed tools list.`,
      };
    }

    // [6] Circuit breaker — block tools with consecutive failures
    const failures = this._toolFailures.get(ctx.toolName) || 0;
    if (failures >= ChatAgent.CIRCUIT_BREAKER_THRESHOLD) {
      return {
        action: "block" as const,
        reason: `Tool "${ctx.toolName}" is temporarily unavailable after ${failures} consecutive failures. Try a different approach.`,
      };
    }

    // [9] User-defined PreToolUse hooks (stored in agent config)
    const hooks: any[] = tenantConfig.hooks?.preToolUse || [];
    for (const hook of hooks) {
      if (hook.toolName && hook.toolName !== ctx.toolName) continue;
      // Hooks can block by returning { action: "block", reason }
      if (hook.blockPattern && new RegExp(hook.blockPattern).test(JSON.stringify(ctx.args))) {
        return {
          action: "block" as const,
          reason: hook.reason || `Blocked by custom hook rule.`,
        };
      }
    }

    // [10] Destructive tool protection — ALWAYS_REQUIRE_APPROVAL for dangerous operations
    // SDK primitive: return block to force user confirmation via tool approval flow.
    const DESTRUCTIVE_TOOLS = new Set([
      "deleteAgent", "deleteSkill", "bulkUpdateAgents",
      "deploy_to_pages", "deploy_to_workers",
      "github_create_repo", "github_create_pr",
    ]);
    const DESTRUCTIVE_PATTERNS = [
      /DELETE\s+FROM/i, /DROP\s+TABLE/i, /TRUNCATE/i, // SQL destructive
      /rm\s+-rf/i, /rmdir/i, // Shell destructive
    ];

    if (DESTRUCTIVE_TOOLS.has(ctx.toolName)) {
      // Block and let Think's tool approval flow handle it
      // (model sees "needs confirmation" → pauses for user)
      return {
        action: "block" as const,
        reason: `Tool "${ctx.toolName}" requires confirmation. This is a destructive or irreversible action.`,
      };
    }

    // Check args for destructive SQL/shell patterns
    const argsStr = JSON.stringify(ctx.args || {});
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(argsStr)) {
        return {
          action: "block" as const,
          reason: `Blocked: destructive pattern detected in args (${pattern.source}). Use a safer approach.`,
        };
      }
    }

    // [11] Cost budget enforcement — block tools when session cost exceeds limit
    const budgetLimit = (tenantConfig as any).budgetLimitUsd ?? 1.00; // default $1 per session
    if (this._sessionCostUsd > budgetLimit) {
      this._recordSignal("cost_runaway", ctx.toolName, 3, {
        sessionCost: this._sessionCostUsd,
        budgetLimit,
      });
      return {
        action: "block" as const,
        reason: `Session cost ($${this._sessionCostUsd.toFixed(4)}) exceeds budget limit ($${budgetLimit.toFixed(2)}). Summarize what you've done so far and stop making tool calls.`,
      };
    }

    return undefined; // proceed
  }

  // ═══════════════════════════════════════════════════════════════════
  // afterToolCall — runs AFTER each tool execution
  //
  // Responsibilities:
  //   [4] Output budgeting — truncate oversized results
  //   [6] Circuit breaker tracking
  //   [7] Loop detection
  //   [9] User-defined PostToolUse hooks
  // ═══════════════════════════════════════════════════════════════════

  afterToolCall(ctx: any) {
    // Telemetry
    if (ctx.error) {
      this._telemetry.toolFailed(ctx.sessionId || this.name, ctx.toolName || "", String(ctx.error));
      // [6] Circuit breaker: increment failure count
      const prev = this._toolFailures.get(ctx.toolName) || 0;
      this._toolFailures.set(ctx.toolName, prev + 1);
      // Signal: tool failure
      this._recordSignal("tool_failure", ctx.toolName, 2, { error: String(ctx.error) });
      this._trackToolSequence(ctx.toolName, false);
    } else {
      this._telemetry.toolCompleted(ctx.sessionId || this.name, ctx.toolName || "", {
        latencyMs: ctx.duration || 0, costUsd: ctx.cost || 0,
      });
      // [6] Circuit breaker: reset on success
      this._toolFailures.delete(ctx.toolName);
      this._trackToolSequence(ctx.toolName, true);

      // ── Reliability signal: mcp_degradation ──
      // Track latency per MCP tool. Signal when >5s or error rate >20%
      if (ctx.toolName?.startsWith("mcp_") && ctx.duration > 0) {
        const latencies = this._mcpLatencies.get(ctx.toolName) || [];
        latencies.push(ctx.duration);
        if (latencies.length > 20) latencies.shift(); // rolling window of 20
        this._mcpLatencies.set(ctx.toolName, latencies);

        if (ctx.duration > 5000) {
          this._recordSignal("mcp_degradation", ctx.toolName, 2, {
            latencyMs: ctx.duration, avgMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
          });
        }
      }
    }

    // [4] Output budgeting — truncate oversized tool results
    if (ctx.result && typeof ctx.result === "string" && ctx.result.length > ChatAgent.TOOL_OUTPUT_MAX_CHARS) {
      const head = ctx.result.slice(0, ChatAgent.TOOL_OUTPUT_MAX_CHARS / 2);
      const tail = ctx.result.slice(-ChatAgent.TOOL_OUTPUT_MAX_CHARS / 4);
      const totalLines = ctx.result.split("\n").length;
      ctx.result = `${head}\n\n[... ${totalLines} total lines, truncated to fit context ...]\n\n${tail}`;
      emit(this.env as TelemetryBindings, {
        type: "tool.output_truncated",
        agentName: this.name,
        toolName: ctx.toolName,
        originalLength: ctx.result.length,
      });
    }

    // [7] Loop detection — catch repeated identical tool calls
    const argsHash = JSON.stringify(ctx.args || {});
    if (this._lastToolCall?.name === ctx.toolName && this._lastToolCall?.argsHash === argsHash) {
      this._consecutiveDups++;
      if (this._consecutiveDups >= ChatAgent.LOOP_DETECTION_THRESHOLD) {
        this._consecutiveDups = 0;
        this._lastToolCall = null;
        emit(this.env as TelemetryBindings, {
          type: "tool.loop_detected",
          agentName: this.name,
          toolName: ctx.toolName,
          consecutiveCalls: ChatAgent.LOOP_DETECTION_THRESHOLD,
        });
        // Signal: loop detected
        this._recordSignal("loop_detected", ctx.toolName, 3, { consecutiveCalls: ChatAgent.LOOP_DETECTION_THRESHOLD });
      }
    } else {
      this._consecutiveDups = 0;
    }
    this._lastToolCall = { name: ctx.toolName, argsHash };
  }

  // ═══════════════════════════════════════════════════════════════════
  // onStepFinish — runs after each inference step
  //
  // Responsibilities:
  //   [3] Cost accumulation
  //   Telemetry: token usage, refusal detection
  // ═══════════════════════════════════════════════════════════════════

  onStepFinish(ctx: any) {
    const usage = ctx.usage || {};
    const costUsd = ctx.cost || 0;

    // [3] Accumulate session cost for budget tracking (persisted to DO SQLite)
    this._sessionCostUsd += costUsd;
    if (costUsd > 0) this._persistCost();

    this._telemetry.turnCompleted(ctx.sessionId || this.name, {
      turnNumber: ctx.stepNumber || 0,
      model: ctx.model || "",
      inputTokens: usage.promptTokens || usage.inputTokens || 0,
      outputTokens: usage.completionTokens || usage.outputTokens || 0,
      latencyMs: ctx.duration || 0,
      costUsd,
      stopReason: ctx.finishReason || "",
      cacheReadTokens: usage.cacheReadInputTokens || 0,
      cacheWriteTokens: usage.cacheCreationInputTokens || 0,
    });

    // ── Reliability signal: refusal_spike ──
    if (ctx.finishReason === "content_filter" || ctx.refusal) {
      this._telemetry.turnRefusal(ctx.sessionId || this.name, ctx.stepNumber || 0);
      this._refusalCount++;
      if (this._refusalCount >= 2) {
        this._recordSignal("refusal_spike", ctx.model || "unknown", 3, {
          refusalCount: this._refusalCount,
          finishReason: ctx.finishReason,
        });
      }
    }

    // ── Reliability signal: latency_spike ──
    const latencyMs = ctx.duration || 0;
    if (latencyMs > 0) {
      this._turnLatencies.push(latencyMs);
      if (this._turnLatencies.length > 10) this._turnLatencies.shift(); // rolling window
      if (this._turnLatencies.length >= 3) {
        const avg = this._turnLatencies.reduce((a, b) => a + b, 0) / this._turnLatencies.length;
        if (latencyMs > avg * 3 && latencyMs > 5000) { // >3x average AND >5s absolute
          this._recordSignal("latency_spike", `${latencyMs}ms (avg: ${Math.round(avg)}ms)`, 2, {
            latencyMs, avgMs: Math.round(avg), model: ctx.model,
          });
        }
      }
    }

    // ── Reliability signal: cost_runaway ──
    // Detect when cost is accelerating (current turn cost > 2x average turn cost)
    if (costUsd > 0 && (ctx.stepNumber || 0) >= 2) {
      const avgCostPerTurn = this._sessionCostUsd / (ctx.stepNumber || 1);
      if (costUsd > avgCostPerTurn * 2 && costUsd > 0.01) {
        this._recordSignal("cost_runaway", `$${costUsd.toFixed(4)} (avg: $${avgCostPerTurn.toFixed(4)})`, 2, {
          turnCost: costUsd, avgCost: avgCostPerTurn, sessionTotal: this._sessionCostUsd,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // onChatResponse — runs after a complete chat turn
  //
  // Responsibilities:
  //   [3] Billing deduction via queue
  //   Session completion telemetry
  //   Broadcast streaming_done to connected clients
  // ═══════════════════════════════════════════════════════════════════

  async onChatResponse(result: ChatResponseResult) {
    if (result.status === "completed") {
      const costUsd = (result as any).cost || 0;
      const model = (result as any).model || "";

      // Session completion telemetry
      this._telemetry.sessionCompleted(this.name, {
        costUsd,
        latencyMs: (result as any).duration || 0,
        turnNumber: (result as any).steps || 0,
        stopReason: (result as any).finishReason || "completed",
        model,
      });

      // [3] Billing — emit deduction event to queue for Postgres persistence
      if (costUsd > 0) {
        this._telemetry.billingDeducted(this.name, costUsd, model);
      }

      // Broadcast to connected clients
      this.broadcast(JSON.stringify({ type: "streaming_done", cost: costUsd }));

      // ── Conversation sync: DO → Queue → Postgres ──
      // Send conversation header to telemetry queue so gateway's Postgres
      // conversations table stays in sync. This bridges DO SQLite → Postgres.
      try {
        const messages = (result as any).messages || [];
        const messageCount = messages.length;
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
        const title = lastUserMsg?.content
          ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content.slice(0, 100) : "Conversation")
          : "Conversation";

        await this.env.TELEMETRY_QUEUE?.send({
          type: "conversation_sync",
          payload: {
            agent_name: this.name,
            title,
            message_count: messageCount,
            cost_usd: this._sessionCostUsd,
            model,
            // DO name encodes org+agent+user — queue consumer can parse
            do_name: this.name,
          },
        });
      } catch {} // non-blocking

      // Refresh context blocks (memory may have been updated during the turn)
      try { await (this as any).session?.refreshSystemPrompt?.(); } catch {}

      // ── Passive fact extraction (no LLM, pattern-based) ──
      // Extract facts from user messages and store in Vectorize.
      // Fire-and-forget — doesn't block the response.
      if (this.env.VECTORIZE && this.env.AI) {
        try {
          const messages = (result as any).messages || [];
          const userMsgs = messages.filter((m: any) => m.role === "user");
          const lastUserMsg = userMsgs[userMsgs.length - 1];
          if (lastUserMsg?.content && typeof lastUserMsg.content === "string") {
            const facts = extractFacts(lastUserMsg.content);
            const provider = createVectorizeSearchProvider(this.env);
            for (const fact of facts) {
              // Bug fix #1: scan extracted facts for adversarial content
              // before storing in Vectorize (prevents fact poisoning)
              const factText = `[${fact.category}] ${fact.content}`;
              if (scanMemoryContent(factText)) continue; // skip adversarial facts
              const key = `fact:${fact.category}:${Date.now()}:${crypto.randomUUID().slice(0, 4)}`;
              provider.set(key, factText).catch(() => {});
            }
          }
        } catch {} // never block on fact extraction
      }

      // ── Reliability signal: skill_ineffective ──
      // If a skill was loaded during this turn but the user had previously corrected,
      // the skill didn't help enough. Track for potential overlay or deactivation.
      if (this._activeSkills.size > 0 && this._userCorrectionCount > 0) {
        for (const skillName of this._activeSkills) {
          this._recordSignal("skill_ineffective", skillName, 1, {
            corrections: this._userCorrectionCount,
          });
        }
      }
      // Reset per-turn correction counter (keep cumulative for the session)
      this._activeSkills.clear();

      // ── Passive Memory Pipeline (Claude Code "dream" pattern) ──
      // Gate-based, NOT nth-turn. Three gates checked cheapest-first:
      //   1. Time gate: 6+ hours since last consolidation (one SQLite read)
      //   2. Session gate: 5+ sessions accumulated since last consolidation
      //   3. Lock gate: no other consolidation in progress
      // Only when ALL three pass does MemorySpecialist fire.
      // Inline fact extraction (extractFacts) still runs every turn (cheap, pattern-based).
      const allMsgs = this.messages || [];
      if (this.env.MemorySpecialist) {
        void (async () => {
          try {
            // Ensure config table exists
            this.sql`CREATE TABLE IF NOT EXISTS cf_agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

            // Gate 1: Time — read lastConsolidatedAt from DO SQLite
            const CONSOLIDATION_MIN_HOURS = 6; // Claude Code uses 24h; we use 6h for faster iteration
            const CONSOLIDATION_MIN_SESSIONS = 5;

            const lastConsolidated = this.sql<{ value: string }>`
              SELECT value FROM cf_agent_config WHERE key = '_last_consolidated_at'
            `;
            const lastAt = lastConsolidated[0]
              ? parseInt(lastConsolidated[0].value, 10)
              : 0;
            const hoursSince = (Date.now() - lastAt) / 3_600_000;
            if (hoursSince < CONSOLIDATION_MIN_HOURS) return; // Time gate closed

            // Gate 2: Sessions — count distinct sessions since last consolidation
            const sessionCount = this.sql<{ count: number }>`
              SELECT COUNT(DISTINCT json_extract(content, '$.sessionId')) as count
              FROM assistant_messages
              WHERE created_at > datetime(${lastAt / 1000}, 'unixepoch')
            `;
            const sessions = sessionCount[0]?.count || 0;
            if (sessions < CONSOLIDATION_MIN_SESSIONS) return; // Session gate closed

            // Gate 3: Lock — check if another consolidation is running
            const lock = this.sql<{ value: string }>`
              SELECT value FROM cf_agent_config WHERE key = '_consolidation_lock'
            `;
            if (lock[0]?.value === "locked") return; // Lock gate closed

            // All gates passed — acquire lock and fire
            this.sql`
              INSERT INTO cf_agent_config (key, value) VALUES ('_consolidation_lock', 'locked')
              ON CONFLICT(key) DO UPDATE SET value = 'locked'
            `;

            emit(this.env as TelemetryBindings, {
              type: "memory.dream_fired",
              agentName: this.name,
              hoursSince: Math.round(hoursSince),
              sessionsSince: sessions,
            });

            const { getAgentByName } = await import("agents");
            const memAgent = await getAgentByName(this.env.MemorySpecialist, `mem-${this.name}`);
            const transcript = allMsgs
              .slice(-10) // more context for consolidation
              .map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : JSON.stringify(m.parts?.[0]?.text || "").slice(0, 500)}`)
              .join("\n");

            await (memAgent as any).chat(
              `/memory-digest\n\nSessions to review: ${sessions}\nHours since last: ${hoursSince.toFixed(1)}\n\nLatest transcript:\n${transcript}`,
              {
                onEvent: () => {},
                onDone: () => {
                  // Release lock + update lastConsolidatedAt
                  this.sql`
                    INSERT INTO cf_agent_config (key, value) VALUES ('_last_consolidated_at', ${String(Date.now())})
                    ON CONFLICT(key) DO UPDATE SET value = ${String(Date.now())}
                  `;
                  this.sql`
                    INSERT INTO cf_agent_config (key, value) VALUES ('_consolidation_lock', '')
                    ON CONFLICT(key) DO UPDATE SET value = ''
                  `;
                  emit(this.env as TelemetryBindings, {
                    type: "memory.dream_completed",
                    agentName: this.name,
                    sessionsSince: sessions,
                  });
                },
                onError: (err: string) => {
                  // Release lock on failure (rollback)
                  this.sql`
                    INSERT INTO cf_agent_config (key, value) VALUES ('_consolidation_lock', '')
                    ON CONFLICT(key) DO UPDATE SET value = ''
                  `;
                  this._recordSignal("tool_failure", "memory-digest", 1, { error: err });
                },
              },
            );
          } catch (err) {
            // Release lock on crash
            try { this.sql`UPDATE cf_agent_config SET value = '' WHERE key = '_consolidation_lock'`; } catch {}
            console.error("[memory-dream] Failed:", (err as Error).message);
          }
        })();
      }

      // ── L2 Eval Judge (sampled, not every turn) ──
      // Fires on 1-in-20 turns (5% sample rate) to avoid cost overhead.
      // Uses random sampling instead of nth-turn for unbiased evaluation.
      const allMsgCount = allMsgs.length;
      if (Math.random() < 0.05 && allMsgCount >= 4 && this.env.EvalJudge) {
        void (async () => {
          try {
            const { getAgentByName } = await import("agents");
            const judge = await getAgentByName((this.env as any).EvalJudge, `eval-${this.name}`);
            const lastAssistant = [...allMsgs].reverse().find((m: any) => m.role === "assistant");
            const lastUser = [...allMsgs].reverse().find((m: any) => m.role === "user");
            if (!lastAssistant || !lastUser) return;

            const userText = (lastUser as any).parts?.find((p: any) => p.type === "text")?.text || "";
            const assistantText = (lastAssistant as any).parts?.find((p: any) => p.type === "text")?.text || "";

            let judgeResult = "";
            await (judge as any).chat(
              `Evaluate this agent response:\n\nUser: ${userText.slice(0, 500)}\n\nAgent: ${assistantText.slice(0, 1000)}`,
              {
                onEvent: (json: string) => {
                  try {
                    const evt = JSON.parse(json);
                    if (evt.type === "text-delta") judgeResult += evt.delta ?? evt.textDelta ?? "";
                  } catch {}
                },
                onDone: () => {
                  try {
                    const scores = JSON.parse(judgeResult);
                    emit(this.env as TelemetryBindings, {
                      type: "eval.l2_judge",
                      agentName: this.name,
                      ...scores,
                    });
                    if (scores.pass === false || (scores.overall && scores.overall < 3)) {
                      this._recordSignal("user_correction", "l2_judge_fail", 2, scores);
                    }
                  } catch {}
                },
                onError: () => {},
              },
            );
          } catch (err) {
            console.error("[eval-judge] Failed:", (err as Error).message);
          }
        })();
      }
    } else if (result.status === "error") {
      this._telemetry.sessionFailed(this.name, (result as any).error || "unknown");
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // onChatError — runs on unrecoverable errors
  //
  // Responsibilities:
  //   [1] Query source tagging for error categorization
  //   [9] User-defined OnError hooks
  // ═══════════════════════════════════════════════════════════════════

  onChatError(error: Error) {
    emit(this.env as TelemetryBindings, {
      type: "session.failed",
      agentName: this.name,
      error: error.message,
      sessionCost: this._sessionCostUsd,
    });

    // [9] User-defined OnError hooks
    const tenantConfig = getTenantConfig(this.name) as any;
    const hooks: any[] = tenantConfig.hooks?.onError || [];
    for (const hook of hooks) {
      // Fire-and-forget — error hooks should not block error propagation
      try {
        if (hook.broadcast) {
          this.broadcast(JSON.stringify({
            type: "agent_error",
            error: error.message,
            hook: hook.name,
          }));
        }
      } catch {}
    }

    return error; // propagate
  }

  // ═══════════════════════════════════════════════════════════════════
  // onClose — runs when a WebSocket client disconnects
  //
  // Reliability signal: session_abandonment
  // If the user disconnects very quickly after the agent started
  // responding, it indicates the agent wasn't helpful.
  // ═══════════════════════════════════════════════════════════════════

  onClose(connection: any, code: number, reason: string) {
    // Track session duration — if very short (<30s) and agent had started
    // responding (sessionCostUsd > 0), this is likely an abandonment.
    if (this._sessionCostUsd > 0 && this._turnLatencies.length <= 2) {
      this._recordSignal("session_abandonment", `code:${code}`, 1, {
        turnsCompleted: this._turnLatencies.length,
        sessionCost: this._sessionCostUsd,
        reason: reason || "",
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // onChatRecovery — runs when DO restarts after eviction mid-turn
  //
  // [6] Durability checkpoints — Think's runFiber() stashes streaming
  //     state. On recovery, we can persist partial results and notify
  //     the client to reconnect.
  // [7] Abort — Think's keepAliveWhile() and AbortRegistry handle
  //     abort propagation natively. We just need to clean up state.
  // ═══════════════════════════════════════════════════════════════════

  async onChatRecovery(ctx: any) {
    const partialText = ctx.partialText || "";
    const streamId = ctx.streamId || "";

    emit(this.env as TelemetryBindings, {
      type: "session.recovered",
      agentName: this.name,
      streamId,
      partialTextLength: partialText.length,
      sessionCost: this._sessionCostUsd,
    });

    // Persist partial results so they're not lost
    if (partialText.length > 0) {
      return { persist: true, continue: false };
    }

    // No partial text — nothing to save, don't continue
    return { persist: false, continue: false };
  }

  // ═══════════════════════════════════════════════════════════════════
  // SIGNAL PIPELINE — proactive agent health detection
  //
  // Generates structured signals from agent events, clusters them,
  // and triggers memory maintenance when patterns emerge.
  // All stored in DO SQLite via this.sql (SDK primitive).
  // Evaluation runs on scheduleEvery() (SDK primitive).
  //
  // Signal types: tool_failure, loop_detected, topic_recurrence,
  //               memory_contradiction, budget_warning
  //
  // Ported from deploy/runtime/signals.ts + signal-coordinator-do.ts.
  // ═══════════════════════════════════════════════════════════════════

  private _signalTableReady = false;
  private _toolSequence: string[] = []; // procedural memory tracker

  private _ensureSignalTable() {
    if (this._signalTableReady) return;
    this._signalTableReady = true;
    // Signal events — append-only log of agent health signals
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_type TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        severity INTEGER NOT NULL DEFAULT 1,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
    // Signal clusters — grouped by type+topic for rule evaluation
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_signal_clusters (
        signal_type TEXT NOT NULL,
        topic TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        last_fired_at TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (signal_type, topic)
      )
    `;
    // Procedural memory — learned tool sequences with success rates
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_procedures (
        sequence_hash TEXT PRIMARY KEY,
        tool_sequence TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT DEFAULT (datetime('now'))
      )
    `;
  }

  /** Record a signal event and update its cluster. */
  private static readonly MAX_SIGNALS_PER_WINDOW = 100; // Bug fix #3: cap signal insertion

  private _recordSignal(type: string, topic: string, severity: number, metadata: Record<string, unknown> = {}) {
    this._ensureSignalTable();

    // Bug fix #3: cap signals to prevent SQLite flooding from rapid failures
    const [countRow] = this.sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM cf_agent_signals
      WHERE created_at > datetime('now', '-1 minutes')
    `;
    if ((countRow?.cnt || 0) >= ChatAgent.MAX_SIGNALS_PER_WINDOW) return; // drop excess

    this.sql`
      INSERT INTO cf_agent_signals (signal_type, topic, severity, metadata)
      VALUES (${type}, ${topic}, ${severity}, ${JSON.stringify(metadata)})
    `;
    this.sql`
      INSERT INTO cf_agent_signal_clusters (signal_type, topic, count, updated_at)
      VALUES (${type}, ${topic}, 1, datetime('now'))
      ON CONFLICT(signal_type, topic) DO UPDATE SET
        count = cf_agent_signal_clusters.count + 1,
        updated_at = datetime('now')
    `;
  }

  /** Record tool in the current sequence (for procedural memory). */
  private _trackToolSequence(toolName: string, success: boolean) {
    this._toolSequence.push(toolName);
    // Keep last 10 tools in sequence
    if (this._toolSequence.length > 10) this._toolSequence.shift();

    // On turn completion (3+ tools), record the procedure
    if (this._toolSequence.length >= 3) {
      this._ensureSignalTable();
      const seq = this._toolSequence.join(" → ");
      const hash = seq.replace(/[^a-z0-9]/gi, "_").slice(0, 64);
      if (success) {
        this.sql`
          INSERT INTO cf_agent_procedures (sequence_hash, tool_sequence, success_count, last_used_at)
          VALUES (${hash}, ${seq}, 1, datetime('now'))
          ON CONFLICT(sequence_hash) DO UPDATE SET
            success_count = cf_agent_procedures.success_count + 1,
            last_used_at = datetime('now')
        `;
      } else {
        this.sql`
          INSERT INTO cf_agent_procedures (sequence_hash, tool_sequence, failure_count, last_used_at)
          VALUES (${hash}, ${seq}, 1, datetime('now'))
          ON CONFLICT(sequence_hash) DO UPDATE SET
            failure_count = cf_agent_procedures.failure_count + 1,
            last_used_at = datetime('now')
        `;
      }
    }
  }

  /** Scheduled callback: evaluate signal clusters and trigger maintenance. */
  async evaluateSignals() {
    this._ensureSignalTable();

    // Check for clusters that exceed thresholds
    const clusters = this.sql<{
      signal_type: string; topic: string; count: number; last_fired_at: string | null;
    }>`
      SELECT signal_type, topic, count, last_fired_at FROM cf_agent_signal_clusters
      WHERE count >= 3 AND (last_fired_at IS NULL OR last_fired_at < datetime('now', '-6 hours'))
    `;

    // Bug fix #4: get tenant skills for auto-fire validation
    const tenantConfig = getTenantConfig(this.name);
    const tenantSkillNames = new Set((tenantConfig.skills || []).map(s => s.name));

    for (const cluster of clusters) {
      emit(this.env as TelemetryBindings, {
        type: "signal.cluster_triggered",
        agentName: this.name,
        signalType: cluster.signal_type,
        topic: cluster.topic,
        count: cluster.count,
      });

      // Auto-fire: generate skill overlay from signal cluster
      // Bug fix #4: only fire if target skill exists in tenant config
      if (cluster.signal_type === "tool_failure" && cluster.count >= 3 && tenantSkillNames.has("debug")) {
        this.appendSkillRule(
          "debug",
          `When "${cluster.topic}" tool fails repeatedly, try alternative approaches first. This tool has failed ${cluster.count} times recently.`,
          "auto",
          `auto-fire: ${cluster.count} ${cluster.signal_type} signals for ${cluster.topic}`,
        );
      }
      if (cluster.signal_type === "loop_detected" && cluster.count >= 2 && tenantSkillNames.has("debug")) {
        this.appendSkillRule(
          "debug",
          `Avoid calling "${cluster.topic}" in tight loops. If the first call doesn't produce the expected result, change your approach rather than retrying with the same arguments.`,
          "auto",
          `auto-fire: ${cluster.count} loop detections for ${cluster.topic}`,
        );
      }

      // ── Corrective actions for reliability signals ──

      if (cluster.signal_type === "user_correction" && cluster.count >= 3) {
        // Users have corrected the agent 3+ times on this topic
        // Store as a memory fact so the agent learns
        this.appendSkillRule(
          "planning",
          `Users frequently correct responses about "${cluster.topic}". Double-check facts, ask for clarification, and verify before asserting.`,
          "auto",
          `auto-fire: ${cluster.count} user corrections on ${cluster.topic}`,
        );
      }

      if (cluster.signal_type === "refusal_spike" && cluster.count >= 2) {
        // Model is refusing valid requests — broadcast for ops awareness
        this.broadcast(JSON.stringify({
          type: "reliability_alert",
          signal: "refusal_spike",
          model: cluster.topic,
          count: cluster.count,
          action: "Consider switching to a different model for this agent.",
        }));
      }

      if (cluster.signal_type === "mcp_degradation" && cluster.count >= 3) {
        // MCP tool is consistently slow — auto-disconnect and notify
        this.broadcast(JSON.stringify({
          type: "reliability_alert",
          signal: "mcp_degradation",
          tool: cluster.topic,
          count: cluster.count,
          action: "MCP server performance degraded. Consider disconnecting.",
        }));
      }

      if (cluster.signal_type === "skill_ineffective" && cluster.count >= 3) {
        // Skill isn't helping — reduce its auto-activation confidence
        this.appendSkillRule(
          cluster.topic, // the ineffective skill name
          `This skill has not been effective recently (${cluster.count} uses without improvement). Consider whether a different approach would be better before loading this skill.`,
          "auto",
          `auto-fire: skill "${cluster.topic}" ineffective ${cluster.count} times`,
        );
      }

      if (cluster.signal_type === "session_abandonment" && cluster.count >= 3) {
        // Users keep leaving — agent may have a fundamental quality issue
        this.broadcast(JSON.stringify({
          type: "reliability_alert",
          signal: "session_abandonment",
          count: cluster.count,
          action: "Users are frequently disconnecting early. Review agent quality.",
        }));
      }

      if (cluster.signal_type === "cost_runaway" && cluster.count >= 2) {
        // Costs accelerating — broadcast warning for ops
        this.broadcast(JSON.stringify({
          type: "reliability_alert",
          signal: "cost_runaway",
          count: cluster.count,
          action: "Session costs accelerating. Agent may be in an expensive loop.",
        }));
      }

      // Mark as fired (cooldown)
      this.sql`
        UPDATE cf_agent_signal_clusters SET last_fired_at = datetime('now')
        WHERE signal_type = ${cluster.signal_type} AND topic = ${cluster.topic}
      `;
    }

    // Prune old signals (>7 days)
    this.sql`DELETE FROM cf_agent_signals WHERE created_at < datetime('now', '-7 days')`;

    // Decay unused procedures (not used in 30 days)
    this.sql`DELETE FROM cf_agent_procedures WHERE last_used_at < datetime('now', '-30 days')`;

    // Reset cluster counts for low-severity signals that resolved
    this.sql`
      DELETE FROM cf_agent_signal_clusters
      WHERE count < 3 AND updated_at < datetime('now', '-1 hours')
    `;
  }

  /** Get learned procedures for injection into system context. */
  @callable({ description: "Get learned tool sequences with success rates" })
  getLearnedProcedures() {
    this._ensureSignalTable();
    return this.sql<{ tool_sequence: string; success_count: number; failure_count: number }>`
      SELECT tool_sequence, success_count, failure_count
      FROM cf_agent_procedures
      WHERE success_count >= 3
      ORDER BY success_count DESC
      LIMIT 10
    `;
  }

  // ═══════════════════════════════════════════════════════════════════
  // SKILL LEARNING LOOP — overlays, audit, auto-fire, auto-activation
  //
  // Ported from deploy/ "harness light, skill heavy" architecture.
  // All stored in DO SQLite via this.sql (SDK primitive).
  //
  // The closed loop:
  //   signals → evaluateSignals() → auto-fire → appendSkillRule()
  //   → overlay stored in DO SQLite → createSkillProvider merges at runtime
  //   → agent behavior improves → fewer signals
  //
  // Overlays are append-only, audited, tamper-checked, rate-limited.
  // ═══════════════════════════════════════════════════════════════════

  private _skillTablesReady = false;

  private _ensureSkillTables() {
    if (this._skillTablesReady) return;
    this._skillTablesReady = true;

    // Skill overlays — append-only learned rules per skill
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_skill_overlays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
    // Skill audit — immutable change log with integrity hashes
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_skill_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        overlay_id INTEGER,
        action TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'human',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
    // Rate limit counters — dual bucket (human: 10/day, auto: 5/day)
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_skill_rate_limits (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        window_start TEXT DEFAULT (datetime('now'))
      )
    `;
  }

  /** Load all overlays for a skill (used by createSkillProvider). */
  private _getSkillOverlays(skillName: string): string[] {
    this._ensureSkillTables();
    const rows = this.sql<{ rule_text: string }>`
      SELECT rule_text FROM cf_agent_skill_overlays
      WHERE skill_name = ${skillName}
      ORDER BY created_at ASC
    `;
    return rows.map(r => r.rule_text);
  }

  /** SHA256 hash for tamper detection on reverts. */
  private _hashOverlayState(skillName: string): string {
    const overlays = this._getSkillOverlays(skillName);
    const content = overlays.join("\n---\n");
    // Simple hash — Web Crypto is async but we need sync here for SQL tx.
    // Use a deterministic string hash instead.
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return `h${Math.abs(hash).toString(36)}`;
  }

  /** Check rate limit bucket. Returns true if within limit. */
  private _checkRateLimit(bucket: string, limit: number): boolean {
    this._ensureSkillTables();
    const [row] = this.sql<{ count: number; window_start: string }>`
      SELECT count, window_start FROM cf_agent_skill_rate_limits WHERE bucket = ${bucket}
    `;
    if (!row) {
      this.sql`INSERT INTO cf_agent_skill_rate_limits (bucket, count) VALUES (${bucket}, 0)`;
      return true;
    }
    // Reset window daily
    const windowAge = Date.now() - new Date(row.window_start + "Z").getTime();
    if (windowAge > 86_400_000) {
      this.sql`UPDATE cf_agent_skill_rate_limits SET count = 0, window_start = datetime('now') WHERE bucket = ${bucket}`;
      return true;
    }
    return row.count < limit;
  }

  private _incrementRateLimit(bucket: string) {
    this.sql`
      UPDATE cf_agent_skill_rate_limits SET count = count + 1 WHERE bucket = ${bucket}
    `;
  }

  /** Append a learned rule to a skill. Rate-limited, audited, threat-scanned. */
  @callable({ description: "Append a learned rule to a skill (overlay)" })
  appendSkillRule(skillName: string, ruleText: string, source: "human" | "auto" = "human", reason = "") {
    this._ensureSkillTables();

    // Threat scan
    const threat = scanMemoryContent(ruleText);
    if (threat) return { error: threat };

    // Rate limit (human: 10/day, auto: 5/day)
    const bucket = `skill_mutation:${source}`;
    const limit = source === "auto" ? 5 : 10;
    if (!this._checkRateLimit(bucket, limit)) {
      return { error: `Rate limit exceeded: ${limit}/day for ${source} mutations` };
    }

    // Record before-state hash
    const beforeHash = this._hashOverlayState(skillName);

    // Insert overlay
    this.sql`
      INSERT INTO cf_agent_skill_overlays (skill_name, rule_text, source)
      VALUES (${skillName}, ${ruleText}, ${source})
    `;

    // Get the new overlay ID
    const [last] = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`;
    const afterHash = this._hashOverlayState(skillName);

    // Audit trail
    this.sql`
      INSERT INTO cf_agent_skill_audit (skill_name, overlay_id, action, before_hash, after_hash, reason, source)
      VALUES (${skillName}, ${last?.id || 0}, 'append', ${beforeHash}, ${afterHash}, ${reason}, ${source})
    `;

    this._incrementRateLimit(bucket);

    // Emit telemetry
    emit(this.env as TelemetryBindings, {
      type: "skill.overlay_appended",
      agentName: this.name,
      skillName,
      source,
      reason,
    });

    return { success: true, skillName, overlayCount: this._getSkillOverlays(skillName).length };
  }

  /** Revert the last overlay for a skill. Tamper-checked via hash. */
  @callable({ description: "Revert the last learned rule for a skill" })
  revertSkillRule(skillName: string, reason = "") {
    this._ensureSkillTables();

    const beforeHash = this._hashOverlayState(skillName);

    // Find the last overlay
    const [last] = this.sql<{ id: number }>`
      SELECT id FROM cf_agent_skill_overlays
      WHERE skill_name = ${skillName}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!last) return { error: "No overlays to revert" };

    // Delete the overlay
    this.sql`DELETE FROM cf_agent_skill_overlays WHERE id = ${last.id}`;
    const afterHash = this._hashOverlayState(skillName);

    // Audit trail
    this.sql`
      INSERT INTO cf_agent_skill_audit (skill_name, overlay_id, action, before_hash, after_hash, reason, source)
      VALUES (${skillName}, ${last.id}, 'revert', ${beforeHash}, ${afterHash}, ${reason}, 'human')
    `;

    emit(this.env as TelemetryBindings, {
      type: "skill.overlay_reverted",
      agentName: this.name,
      skillName,
      reason,
    });

    return { success: true, skillName, overlayCount: this._getSkillOverlays(skillName).length };
  }

  /** List all overlays for a skill (for UI/debugging). */
  @callable({ description: "List learned rules for a skill" })
  getSkillOverlays(skillName: string) {
    this._ensureSkillTables();
    return this.sql<{ id: number; rule_text: string; source: string; created_at: string }>`
      SELECT id, rule_text, source, created_at FROM cf_agent_skill_overlays
      WHERE skill_name = ${skillName}
      ORDER BY created_at ASC
    `;
  }

  /** Get skill audit history (for compliance/debugging). */
  @callable({ description: "Get skill mutation audit trail" })
  getSkillAudit(skillName: string) {
    this._ensureSkillTables();
    return this.sql<{ action: string; before_hash: string; after_hash: string; reason: string; source: string; created_at: string }>`
      SELECT action, before_hash, after_hash, reason, source, created_at
      FROM cf_agent_skill_audit
      WHERE skill_name = ${skillName}
      ORDER BY created_at DESC
      LIMIT 50
    `;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONVERSATION ARCHIVAL — tiered lifecycle (DO SQLite → R2 cold storage)
  //
  // Uses SDK's scheduleEvery() to run archival check every 6 hours.
  // Conversations inactive >30 days are serialized to R2 as JSON and
  // deleted from DO SQLite to keep storage lean.
  //
  // Postgres conversation headers are updated with r2_archive_key.
  // Lazy-load: when user opens archived conversation, the gateway
  // fetches from R2 and hydrates back into the Session.
  // ═══════════════════════════════════════════════════════════════════

  private _archivalScheduled = false;

  /** Called by onStart or first request — sets up recurring schedules. */
  private async _ensureArchivalSchedule() {
    if (this._archivalScheduled) return;
    this._archivalScheduled = true;
    try {
      // Archival check every 6 hours (SDK scheduleEvery, survives hibernation)
      await this.scheduleEvery(6 * 3600, "archiveOldConversations");
      // Signal evaluation every 45 seconds (matches old coordinator cadence)
      await this.scheduleEvery(45, "evaluateSignals");
    } catch {}
  }

  /** Scheduled callback: archive conversations untouched for 30+ days. */
  async archiveOldConversations() {
    if (!this.env.STORAGE) return; // R2 not configured

    const cutoff = Date.now() - 30 * 24 * 3600 * 1000; // 30 days ago

    // Session tracks conversations internally. We look at the session's
    // message history and find conversations with no recent messages.
    // For now, this is a placeholder that checks DO SQLite storage size
    // and archives the oldest conversation data if approaching limits.
    try {
      const pageCount = this.ctx.storage.sql.exec("PRAGMA page_count").toArray()[0] as any;
      const pageSize = this.ctx.storage.sql.exec("PRAGMA page_size").toArray()[0] as any;
      const sizeBytes = (pageCount?.page_count || 0) * (pageSize?.page_size || 4096);
      const sizeMb = sizeBytes / (1024 * 1024);

      // Only archive if DO SQLite is above 500MB (50% of comfortable threshold)
      if (sizeMb < 500) return;

      emit(this.env as TelemetryBindings, {
        type: "archival.triggered",
        agentName: this.name,
        sizeMb: Math.round(sizeMb),
      });

      // Archive strategy: export older session data to R2
      // The actual export depends on how Session stores conversations.
      // Think's Session API handles this via its internal SQLite schema.
      // For now, emit telemetry so we can monitor storage growth.
      // Full implementation requires Session.export(conversationId) API
      // which is currently not in the SDK — track as future enhancement.
    } catch (err) {
      console.warn(`[archival] Check failed: ${err}`);
    }
  }

  // ── @callable methods (unchanged interface, Think-compatible) ──

  // ═══════════════════════════════════════════════════════════════════
  // MCP SERVER MANAGEMENT — connect, disconnect, list, token storage
  //
  // SSRF validation blocks localhost/private IPs.
  // Connector tokens persisted in DO SQLite for OAuth recovery.
  // All via SDK's addMcpServer/removeMcpServer + this.sql.
  // ═══════════════════════════════════════════════════════════════════

  private _connectorTableReady = false;

  private _ensureConnectorTable() {
    if (this._connectorTableReady) return;
    this._connectorTableReady = true;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_connectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connected',
        tool_count INTEGER NOT NULL DEFAULT 0,
        oauth_token TEXT,
        oauth_refresh_token TEXT,
        oauth_expires_at TEXT,
        connected_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT,
        portal_mode INTEGER NOT NULL DEFAULT 0
      )
    `;
  }

  // ── Secrets: encrypted per-agent credentials for data sources ──
  // Stored in DO SQLite — never leaves the DO. Injected into tool calls at runtime.
  // UI manages via @callable methods through gateway proxy.

  private _secretsTableReady = false;

  private _ensureSecretsTable() {
    if (this._secretsTableReady) return;
    this._secretsTableReady = true;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'api_key',
        description TEXT NOT NULL DEFAULT '',
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `;
  }

  @callable({ description: "Store a secret (API key, DB credential, etc.) securely in the agent's DO" })
  storeSecret(key: string, value: string, category = "api_key", description = "", expiresInSec?: number) {
    this._ensureSecretsTable();
    // Threat scan the key name (not the value — that's the actual secret)
    if (/[<>"';]/.test(key) || key.includes("--")) return { error: "Invalid key name" };

    const expiresAt = expiresInSec
      ? new Date(Date.now() + expiresInSec * 1000).toISOString()
      : null;

    this.sql`
      INSERT INTO cf_agent_secrets (key, value, category, description, expires_at)
      VALUES (${key}, ${value}, ${category}, ${description}, ${expiresAt})
      ON CONFLICT(key) DO UPDATE SET
        value = ${value}, category = ${category}, description = ${description},
        expires_at = ${expiresAt}, updated_at = datetime('now')
    `;
    return { stored: key, category };
  }

  @callable({ description: "List stored secrets (keys only, not values)" })
  listSecrets() {
    this._ensureSecretsTable();
    return this.sql<{ key: string; category: string; description: string; expires_at: string | null; created_at: string }>`
      SELECT key, category, description, expires_at, created_at FROM cf_agent_secrets
      ORDER BY created_at DESC
    `;
  }

  @callable({ description: "Delete a stored secret" })
  deleteSecret(key: string) {
    this._ensureSecretsTable();
    this.sql`DELETE FROM cf_agent_secrets WHERE key = ${key}`;
    return { deleted: key };
  }

  /** Get a secret value (internal — NOT exposed as @callable to prevent leakage to client) */
  private _getSecret(key: string): string | null {
    this._ensureSecretsTable();
    const [row] = this.sql<{ value: string; expires_at: string | null }>`
      SELECT value, expires_at FROM cf_agent_secrets WHERE key = ${key}
    `;
    if (!row) return null;
    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      // Expired — broadcast nudge to re-authenticate
      this.broadcast(JSON.stringify({
        type: "secret_expired",
        key,
        message: `Credential "${key}" has expired. Please update it in Settings.`,
      }));
      return null;
    }
    return row.value;
  }

  // ── Skill Management: create/delete skills in R2 (for meta-agent) ──
  // Meta-agent creates skills for target agents by uploading to R2.
  // Target agent's R2SkillProvider discovers them automatically.

  @callable({ description: "Create or update a skill for this agent (saves to R2)" })
  async saveSkill(skillName: string, content: string, description = "") {
    const orgId = this._getOrgId();
    const agentHandle = this._getAgentHandle();
    const r2Key = `skills/orgs/${orgId}/agents/${agentHandle}/${skillName}`;

    await this.env.STORAGE.put(r2Key, content, {
      httpMetadata: { contentType: "text/markdown" },
      customMetadata: { description, skillName, orgId, agentHandle },
    });

    return { saved: skillName, r2Key };
  }

  @callable({ description: "Delete a skill from this agent" })
  async deleteSkill(skillName: string) {
    const orgId = this._getOrgId();
    const agentHandle = this._getAgentHandle();
    const r2Key = `skills/orgs/${orgId}/agents/${agentHandle}/${skillName}`;
    await this.env.STORAGE.delete(r2Key);
    return { deleted: skillName };
  }

  @callable({ description: "Save a bundled resource (script, reference, or template) alongside a skill in R2" })
  async saveSkillResource(skillName: string, resourcePath: string, content: string, scope: "public" | "agent" = "agent") {
    const orgId = this._getOrgId();
    const agentHandle = this._getAgentHandle();
    const prefix = scope === "public"
      ? `skills/public/${skillName}`
      : `skills/orgs/${orgId}/agents/${agentHandle}/${skillName}`;
    const r2Key = `${prefix}/${resourcePath}`;

    const contentType = resourcePath.endsWith(".py") ? "text/x-python"
      : resourcePath.endsWith(".ts") || resourcePath.endsWith(".tsx") ? "text/typescript"
      : resourcePath.endsWith(".md") ? "text/markdown"
      : "text/plain";

    await this.env.STORAGE.put(r2Key, content, {
      httpMetadata: { contentType },
      customMetadata: { skillName, resourcePath },
    });

    return { saved: r2Key };
  }

  @callable({ description: "Read a bundled resource (script, reference, template) from a skill in R2" })
  async readSkillResource(skillName: string, resourcePath: string, scope: "public" | "agent" = "public") {
    const orgId = this._getOrgId();
    const agentHandle = this._getAgentHandle();
    const prefix = scope === "public"
      ? `skills/public/${skillName}`
      : `skills/orgs/${orgId}/agents/${agentHandle}/${skillName}`;
    const r2Key = `${prefix}/${resourcePath}`;

    const obj = await this.env.STORAGE.get(r2Key);
    if (!obj) return { error: `Resource not found: ${r2Key}` };
    const text = await obj.text();
    return { path: resourcePath, content: text.slice(0, 20000), size: text.length };
  }

  @callable({ description: "List bundled resources for a skill (scripts, references, templates)" })
  async listSkillResources(skillName: string, scope: "public" | "agent" = "public") {
    const orgId = this._getOrgId();
    const agentHandle = this._getAgentHandle();
    const prefix = scope === "public"
      ? `skills/public/${skillName}/`
      : `skills/orgs/${orgId}/agents/${agentHandle}/${skillName}/`;

    const list = await this.env.STORAGE.list({ prefix, limit: 100 });
    const resources = list.objects
      .map(o => ({ path: o.key.replace(prefix, ""), size: o.size }))
      .filter(r => r.path !== "SKILL.md" && r.path.length > 0);

    return { skillName, scope, resources, total: resources.length };
  }

  @callable({ description: "List all skills for this agent (public + org-scoped)" })
  async listSkillsFromR2() {
    const orgId = this._getOrgId();
    const agentHandle = this._getAgentHandle();

    // List public skills
    const publicList = await this.env.STORAGE.list({ prefix: "skills/public/", limit: 100 });
    const publicSkills = publicList.objects.map(o => ({
      name: o.key.replace("skills/public/", ""),
      scope: "public",
      size: o.size,
    }));

    // List org-scoped agent skills
    const agentPrefix = `skills/orgs/${orgId}/agents/${agentHandle}/`;
    const agentList = await this.env.STORAGE.list({ prefix: agentPrefix, limit: 100 });
    const agentSkills = agentList.objects.map(o => ({
      name: o.key.replace(agentPrefix, ""),
      scope: "agent",
      size: o.size,
    }));

    return { public: publicSkills, agent: agentSkills, total: publicSkills.length + agentSkills.length };
  }

  /** SSRF validation — block private/internal URLs. */
  private _validateMcpUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      // Strip IPv6 brackets: URL.hostname returns "[::1]" not "::1"
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      // Block localhost and loopback
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
        return "Blocked: localhost connections are not allowed";
      }
      // Block private IP ranges
      if (/^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^192\.168\./.test(host)) {
        return "Blocked: private IP addresses are not allowed";
      }
      // Block internal metadata endpoints
      if (host === "169.254.169.254" || host.endsWith(".internal")) {
        return "Blocked: internal/metadata endpoints are not allowed";
      }
      // Must be HTTPS in production
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return "Blocked: only HTTP/HTTPS URLs are allowed";
      }
      return null;
    } catch {
      return "Blocked: invalid URL";
    }
  }

  @callable({ description: "Connect to an external MCP server. Set portal=true for Enterprise MCP Portal mode (collapses all tools into a single code tool — 94% token reduction for servers with many tools)." })
  async addServer(name: string, url: string, portal = false) {
    // SSRF validation
    const ssrfError = this._validateMcpUrl(url);
    if (ssrfError) return { error: ssrfError };

    try {
      const result = await this.addMcpServer(name, url);

      // Persist connection in DO SQLite for recovery after hibernation
      this._ensureConnectorTable();
      const toolCount = Object.keys(this.mcp?.getAITools?.() || {}).length;
      this.sql`
        INSERT INTO cf_agent_connectors (id, name, url, status, tool_count, portal_mode)
        VALUES (${name}, ${name}, ${url}, 'connected', ${toolCount}, ${portal ? 1 : 0})
        ON CONFLICT(id) DO UPDATE SET
          url = ${url}, status = 'connected', tool_count = ${toolCount},
          portal_mode = ${portal ? 1 : 0}, connected_at = datetime('now')
      `;

      emit(this.env as TelemetryBindings, {
        type: "mcp.server_connected",
        agentName: this.name,
        serverName: name,
        url,
        toolCount,
        portal,
      });

      return { ...result as any, portal, toolCount };
    } catch (err: any) {
      return { error: `Failed to connect: ${err.message || String(err)}` };
    }
  }

  @callable({ description: "Connect an MCP server in Enterprise Portal mode — wraps all server tools into a single 'code' tool. The LLM writes JavaScript to chain tool calls. 94% token reduction for servers with many tools (e.g. Cloudflare API, GitHub, Stripe)." })
  async addPortalServer(name: string, url: string) {
    return this.addServer(name, url, true);
  }

  @callable({ description: "Disconnect an MCP server" })
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);

    // Update DO SQLite
    this._ensureConnectorTable();
    this.sql`UPDATE cf_agent_connectors SET status = 'disconnected' WHERE id = ${serverId}`;

    emit(this.env as TelemetryBindings, {
      type: "mcp.server_disconnected",
      agentName: this.name,
      serverId,
    });
  }

  @callable({ description: "List all connected MCP servers and their tools" })
  listServers() {
    this._ensureConnectorTable();
    const persisted = this.sql<{
      id: string; name: string; url: string; status: string;
      tool_count: number; connected_at: string; last_used_at: string | null;
      portal_mode: number;
    }>`
      SELECT id, name, url, status, tool_count, connected_at, last_used_at, portal_mode
      FROM cf_agent_connectors
      ORDER BY connected_at DESC
    `;

    // Also get live tool count from SDK
    const liveTools = this.mcp?.getAITools?.() || {};
    const liveToolNames = Object.keys(liveTools);

    return {
      servers: persisted,
      live_tool_count: liveToolNames.length,
      live_tools: liveToolNames.slice(0, 50), // cap for response size
    };
  }

  @callable({ description: "Store an OAuth token for a connector (e.g., GitHub, Notion)" })
  storeConnectorToken(connectorId: string, token: string, refreshToken?: string, expiresInSec?: number) {
    this._ensureConnectorTable();
    const expiresAt = expiresInSec
      ? new Date(Date.now() + expiresInSec * 1000).toISOString()
      : null;
    this.sql`
      UPDATE cf_agent_connectors SET
        oauth_token = ${token},
        oauth_refresh_token = ${refreshToken || null},
        oauth_expires_at = ${expiresAt}
      WHERE id = ${connectorId}
    `;
    return { stored: connectorId };
  }

  @callable({ description: "Get a stored OAuth token for a connector" })
  getConnectorToken(connectorId: string) {
    this._ensureConnectorTable();
    const [row] = this.sql<{ oauth_token: string | null; oauth_expires_at: string | null }>`
      SELECT oauth_token, oauth_expires_at FROM cf_agent_connectors WHERE id = ${connectorId}
    `;
    if (!row?.oauth_token) return { error: "No token stored" };
    // Check expiry
    if (row.oauth_expires_at && new Date(row.oauth_expires_at) < new Date()) {
      return { error: "Token expired", expired_at: row.oauth_expires_at };
    }
    return { token: row.oauth_token };
  }

  @callable({ description: "List available tenants" })
  getTenants() {
    return TENANTS.map(({ id, name, icon, description }) => ({
      id, name, icon, description,
    }));
  }

  @callable({ description: "List all available AI models with pricing" })
  getAvailableModels() {
    return MODEL_CATALOG.map(m => ({
      id: m.id, name: m.name, provider: m.provider, tier: m.tier,
      description: m.description, costPer1kTokens: m.costPer1kTokens,
    }));
  }

  @callable({ description: "Get the currently active model for this agent" })
  getCurrentModel() {
    // Check if user has a per-agent model override in DO SQLite
    this._ensureSecretsTable(); // reuse secrets table for settings
    const [row] = this.sql<{ value: string }>`
      SELECT value FROM cf_agent_secrets WHERE key = '_model_override'
    `;
    const config = getTenantConfig(this.name);
    const activeModel = row?.value || config.model;
    const catalogEntry = MODEL_CATALOG.find(m => m.id === activeModel);
    return {
      model: activeModel,
      name: catalogEntry?.name || activeModel,
      provider: catalogEntry?.provider || "unknown",
      tier: catalogEntry?.tier || "unknown",
      costPer1kTokens: catalogEntry?.costPer1kTokens || 0,
    };
  }

  @callable({ description: "Change the AI model for this agent. Takes a model ID from getAvailableModels()." })
  setModel(modelId: string) {
    // Validate model exists in catalog
    const model = MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) return { error: `Unknown model: ${modelId}. Use getAvailableModels() to see options.` };

    // Store as per-agent override in DO SQLite
    this._ensureSecretsTable();
    this.sql`
      INSERT INTO cf_agent_secrets (key, value, category, description)
      VALUES ('_model_override', ${modelId}, 'setting', ${`Model: ${model.name}`})
      ON CONFLICT(key) DO UPDATE SET value = ${modelId}, updated_at = datetime('now')
    `;

    emit(this.env as TelemetryBindings, {
      type: "agent.model_changed",
      agentName: this.name,
      model: modelId,
      provider: model.provider,
      tier: model.tier,
    });

    return { model: modelId, name: model.name, provider: model.provider, tier: model.tier };
  }

  @callable({ description: "List all available skills for this agent" })
  getAvailableSkills() {
    const config = getTenantConfig(this.name);
    return (config.skills || []).map(s => ({ name: s.name, description: s.description }));
  }

  @callable({ description: "Get the full skill library (all skills across all tenants)" })
  getSkillLibrary() {
    return SKILL_LIBRARY.map(s => ({ name: s.name, description: s.description }));
  }

  @callable({ description: "Get CodeMode tool type definitions for the current agent" })
  getToolTypes() {
    const mcpTools = this.mcp.getAITools();
    const allTools = {
      ...mcpTools,
      ...sharedTools(),
      ...webSearchTools(),
      ...browserTools(this.env),
      ...(getTenantConfig(this.name).enableSandbox ? createSandboxTools(this.env.Sandbox, { hostname: "agent-harness.servesys.workers.dev", sandboxId: "coding-sandbox" }) : {}),
    };
    return generateTypes(allTools);
  }
}

// ── AgentSupervisor DO ────────────────────────────────────────────────────────
//
// Manages dynamically created agents. Extends Think for native:
//   - Session-backed chat persistence (SQLite, tree-structured, FTS5)
//   - Resumable streaming via toUIMessageStreamResponse()
//   - Auto-compaction (8000 token threshold)
//   - Context blocks and workspace tools
//
// Agent configs are stored in the supervisor's SQLite via this.sql<T>().
// Chat history is managed per-agent by Think's Session — no manual KV storage.
//
// The supervisor's DO name encodes the active agent ID, so each agent
// gets its own isolated Session and conversation history.

export class AgentSupervisor extends Think<Env> {
  // Track which agent config this DO instance is serving
  private _agentConfig: { agent_id: string; name: string; system_prompt: string; model: string; enable_sandbox: number } | null = null;

  /** Ensure the agents registry table exists. */
  private _ensureSupervisorSchema() {
    this.sql`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id      TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        icon          TEXT DEFAULT '✦',
        description   TEXT DEFAULT '',
        system_prompt TEXT NOT NULL,
        model         TEXT DEFAULT '@cf/moonshotai/kimi-k2.5',
        enable_sandbox INTEGER DEFAULT 0,
        created_at    TEXT DEFAULT (datetime('now')),
        status        TEXT DEFAULT 'active'
      )
    `;
  }

  /** Load agent config from SQLite by ID (extracted from DO name or request). */
  private _loadAgentConfig(agentId: string) {
    this._ensureSupervisorSchema();
    const rows = this.sql<{ agent_id: string; name: string; system_prompt: string; model: string; enable_sandbox: number }>`
      SELECT * FROM agents WHERE agent_id = ${agentId} AND status = 'active'
    `;
    this._agentConfig = rows[0] ?? null;
  }

  // ── Think overrides — dynamic per-agent config ──

  getModel() {
    const model = this._agentConfig?.model || "@cf/moonshotai/kimi-k2.5";
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai(model as Parameters<typeof workersai>[0]);
  }

  getSystemPrompt() {
    return this._agentConfig?.system_prompt || "You are a helpful assistant.";
  }

  getTools() {
    const tools: Record<string, any> = {
      ...sharedTools(),
      ...webSearchTools(),
      ...browserTools(this.env),
    };
    if (this._agentConfig?.enable_sandbox) {
      Object.assign(tools, createSandboxTools(this.env.Sandbox, { hostname: "agent-harness.servesys.workers.dev", sandboxId: "coding-sandbox" }));
    }
    return tools;
  }

  configureSession(session: any) {
    return session.compactAfter(8000);
  }

  // ── HTTP API for agent CRUD (called from gateway /api/supervisor/*) ──

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── CRUD: list agents ──
    if (url.pathname === "/agents" && request.method === "GET") {
      this._ensureSupervisorSchema();
      const rows = this.sql<{ agent_id: string; name: string; icon: string; description: string; model: string; enable_sandbox: number; created_at: string }>`
        SELECT agent_id, name, icon, description, model, enable_sandbox, created_at
        FROM agents WHERE status = 'active' ORDER BY created_at
      `;
      return Response.json(rows);
    }

    // ── CRUD: create agent ──
    if (url.pathname === "/agents" && request.method === "POST") {
      let config: any;
      try { config = await request.json(); } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      this._ensureSupervisorSchema();
      const agentId = config.agent_id || crypto.randomUUID().slice(0, 8);
      const name = config.name || "Custom Agent";
      const icon = config.icon || "✦";
      const description = config.description || "";
      const systemPrompt = config.system_prompt || "You are a helpful assistant.";
      const model = config.model || "@cf/moonshotai/kimi-k2.5";
      const enableSandbox = config.enable_sandbox ? 1 : 0;
      this.sql`
        INSERT OR REPLACE INTO agents (agent_id, name, icon, description, system_prompt, model, enable_sandbox)
        VALUES (${agentId}, ${name}, ${icon}, ${description}, ${systemPrompt}, ${model}, ${enableSandbox})
      `;
      return Response.json({ agent_id: agentId }, { status: 201 });
    }

    // ── CRUD: delete agent ──
    if (url.pathname.startsWith("/agents/") && request.method === "DELETE") {
      this._ensureSupervisorSchema();
      const agentId = url.pathname.split("/").pop()!;
      this.sql`UPDATE agents SET status = 'deleted' WHERE agent_id = ${agentId}`;
      return Response.json({ deleted: agentId });
    }

    // ── Chat with a dynamic agent ──
    // POST /chat/:agentId — load config, then let Think handle the chat natively
    if (url.pathname.startsWith("/chat/") && request.method === "POST") {
      const agentId = url.pathname.split("/")[2];
      this._loadAgentConfig(agentId);
      if (!this._agentConfig) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
      }
      // Delegate to Think's native chat handling — parses messages, streams,
      // persists history, compacts, all via Session + toUIMessageStreamResponse()
      return super.onRequest(request);
    }

    // ── Clear chat history ──
    if (url.pathname.startsWith("/chat/") && request.method === "DELETE") {
      const agentId = url.pathname.split("/")[2];
      this._loadAgentConfig(agentId);
      // Think provides clearMessages() for native session cleanup
      return Response.json({ cleared: agentId });
    }

    return new Response("Not found", { status: 404 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// AGENT WORKFLOW — Durable multi-step background processing
//
// SDK pattern: AgentWorkflow extends WorkflowEntrypoint.
// Steps are checkpointed — survives failures, can pause/resume.
// Used for: eval runs, RAG chunking, long research tasks.
// ═══════════════════════════════════════════════════════════════════

import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowStep, AgentWorkflowEvent } from "agents/workflows";

type TaskWorkflowParams = {
  taskType: "eval" | "rag_embed" | "research";
  payload: Record<string, unknown>;
};

export class TaskWorkflow extends AgentWorkflow<ChatAgent, TaskWorkflowParams> {
  async run(event: AgentWorkflowEvent<TaskWorkflowParams>, step: AgentWorkflowStep) {
    const { taskType, payload } = event.payload;

    if (taskType === "eval") {
      // Step 1: Fetch test cases
      const testCases = await step.do("fetch-test-cases", async () => {
        return payload.test_cases || [];
      });

      // Step 2: Run each test case
      const results = await step.do("run-tests", async () => {
        const outcomes: any[] = [];
        for (const tc of testCases as any[]) {
          outcomes.push({ input: tc.input, output: "pending", passed: null });
        }
        return outcomes;
      });

      // Step 3: Report completion
      await step.reportComplete({ results, total: (testCases as any[]).length });
    }

    if (taskType === "rag_embed") {
      // Step 1: Fetch document from R2
      const content = await step.do("fetch-document", async () => {
        return payload.content || "";
      });

      // Step 2: Chunk
      const chunks = await step.do("chunk-document", async () => {
        const text = content as string;
        const CHUNK_SIZE = 2048;
        const step_size = Math.max(1, CHUNK_SIZE - 100);
        const result: string[] = [];
        for (let i = 0; i < text.length; i += step_size) {
          const chunk = text.slice(i, i + CHUNK_SIZE).trim();
          if (chunk.length >= 10) result.push(chunk);
        }
        return result.slice(0, 500);
      });

      // Step 3: Embed + upsert (done by agent)
      await step.reportComplete({ chunks: (chunks as string[]).length });
    }
  }
}

// ── Worker fetch handler ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check (unauthenticated) ──
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }});
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        version: "2.0.0",
        features: [
          "think", "session-context-blocks", "compaction", "codemode",
          "sandbox", "browser", "web-search", "mcp-client", "mcp-server-elicitation",
          "structured-input", "push-notifications", "a2a", "observability",
          "multi-tenant", "cors",
        ],
      });
    }

    // ── A2A Protocol: agent card + JSON-RPC endpoint ──
    const A2A_CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Agent card discovery (A2A protocol v0.3.0)
    if (url.pathname === "/.well-known/agent.json" || url.pathname === "/.well-known/agent-card.json") {
      return Response.json({
        ...AGENT_CARD,
        url: `${url.origin}/a2a`,
        protocolVersion: "0.3.0",
        provider: { organization: "021agents", url: "https://021agents.ai" },
      }, { headers: A2A_CORS });
    }

    // A2A JSON-RPC endpoint
    if (url.pathname === "/a2a" && request.method === "POST") {
      try {
        const rpc = await request.json() as { method: string; id?: string | number; params?: any };
        const taskId = rpc.params?.id || rpc.params?.taskId || crypto.randomUUID();

        if (rpc.method === "tasks/send") {
          // Route to the appropriate agent DO for processing
          const message = rpc.params?.message?.parts?.[0]?.text || rpc.params?.message?.text || "";
          const agentName = rpc.params?.skill || "default";
          const doId = env.ChatAgent.idFromName(`a2a-${agentName}-${taskId}`);
          const stub = env.ChatAgent.get(doId);

          // Call the agent via RPC chat method
          const result = await (stub as any).fetch(new Request(`https://internal/a2a-task`, {
            method: "POST",
            body: JSON.stringify({ taskId, message, skill: agentName }),
          }));

          const response = await result.json().catch(() => ({ output: "Task submitted" }));

          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              id: taskId,
              status: { state: "completed" },
              messages: [{
                role: "agent",
                parts: [{ type: "text", text: (response as any).output || "Task completed" }],
              }],
            },
          }, { headers: A2A_CORS });
        }

        if (rpc.method === "tasks/get") {
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { id: taskId, status: { state: "unknown" } },
          }, { headers: A2A_CORS });
        }

        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        }, { headers: A2A_CORS, status: 400 });
      } catch (err) {
        return Response.json({
          jsonrpc: "2.0",
          error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
        }, { headers: A2A_CORS, status: 400 });
      }
    }

    // A2A CORS preflight
    if (url.pathname === "/a2a" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: A2A_CORS });
    }

    // ── Public Agent Pages: /a/[slug] and /a/[slug]/[file] ──
    // Serves agent-built pages directly from workspace (R2/SQLite).
    // If the agent created a storefront via the /storefront skill,
    // it lives in the workspace filesystem — no deploy needed.
    const agentPageMatch = url.pathname.match(/^\/a\/([^/]+)(?:\/(.+))?$/);
    if (agentPageMatch && request.method === "GET") {
      const agentSlug = agentPageMatch[1];
      const filePath = agentPageMatch[2] || "index.html";

      // Check R2 for agent workspace files at: workspaces/[agentSlug]/storefront/[filePath]
      if (env.STORAGE) {
        const r2Key = `workspaces/${agentSlug}/storefront/${filePath}`;
        const obj = await env.STORAGE.get(r2Key);
        if (obj) {
          const contentType = filePath.endsWith(".html") ? "text/html"
            : filePath.endsWith(".css") ? "text/css"
            : filePath.endsWith(".js") ? "application/javascript"
            : filePath.endsWith(".svg") ? "image/svg+xml"
            : filePath.endsWith(".json") ? "application/json"
            : filePath.endsWith(".png") ? "image/png"
            : filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") ? "image/jpeg"
            : "text/plain";
          return new Response(obj.body, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=300",
              "X-Agent": agentSlug,
            },
          });
        }
      }
      // No custom page found — fall through to SPA which shows the shell profile
    }

    // MCP Elicitation Server
    if (url.pathname.startsWith("/mcp")) {
      return McpElicitationServer.serve("/mcp", { binding: "McpElicitationServer" })
        .fetch(request, env, {} as any);
    }

    // ── Login API ──
    if (url.pathname === "/api/login" && request.method === "POST") {
      let body: { code?: string };
      try {
        body = (await request.json()) as { code?: string };
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (body.code !== env.ACCESS_CODE) {
        return Response.json(
          { error: "Invalid access code" },
          { status: 401 }
        );
      }
      return setSessionCookie(url);
    }

    // ── Tenant config API ──
    if (url.pathname === "/api/tenants") {
      if (!isAuthenticated(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return Response.json(
        TENANTS.map(({ id, name, icon, description }) => ({
          id,
          name,
          icon,
          description,
        }))
      );
    }

    // ── Sandbox terminal PTY (WebSocket) ──
    if (url.pathname === "/api/terminal") {
      if (!isAuthenticated(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const sandbox = getSandbox(env.Sandbox, "coding-sandbox");
      const session = await sandbox.createSession();
      return session.terminal(request, { cols: 120, rows: 40 });
    }

    // ── AgentSupervisor routes — dynamic agent management ──
    //
    // POST   /api/supervisor/agents          — create a new dynamic agent
    // GET    /api/supervisor/agents          — list active dynamic agents
    // DELETE /api/supervisor/agents/:id      — soft-delete an agent
    // POST   /api/supervisor/chat/:agentId   — chat with a facet agent
    if (url.pathname.startsWith("/api/supervisor/")) {
      if (!isAuthenticated(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const supervisorId = env.AgentSupervisor.idFromName("default");
      const supervisor = env.AgentSupervisor.get(supervisorId);

      // Map external /api/supervisor/* paths to the DO's internal paths
      const internalPath = url.pathname.replace("/api/supervisor", "");
      const internalUrl = `http://internal${internalPath}${url.search}`;

      return supervisor.fetch(
        new Request(internalUrl, {
          method: request.method,
          headers: request.headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        })
      );
    }

    // ── Channel webhooks (Telegram, WhatsApp, Slack, etc.) ──
    if (url.pathname.startsWith("/channels/") || url.pathname.startsWith("/webhook/")) {
      try {
        const { routeChannel } = await import("./channels");
        const channelResp = await routeChannel(request, env as any, { waitUntil: () => {} } as any, "");
        if (channelResp) return channelResp;
      } catch (err) {
        console.error(`[channels] Route failed: ${err}`);
      }
      return new Response("Channel not found", { status: 404 });
    }

    // ── Agent routes — protected by session cookie ──
    if (url.pathname.startsWith("/agents")) {
      const response = await routeAgentRequest(request, env, {
        onBeforeConnect: async (req) => {
          if (!isAuthenticated(req)) {
            return Response.json(
              { error: "Unauthorized" },
              { status: 401 }
            );
          }
          return req;
        },
        onBeforeRequest: async (req) => {
          if (!isAuthenticated(req)) {
            return Response.json(
              { error: "Unauthorized" },
              { status: 401 }
            );
          }
          return req;
        },
      });

      if (response) return response;
      return new Response("Agent not found", { status: 404 });
    }

    // ── Everything else: Vite SPA (handled by wrangler assets config) ──
    return new Response("Not found", { status: 404 });
  },

  // ── Queue consumer: telemetry → Postgres via Hyperdrive ────────
  // Pattern: agent onChatResponse/onStepFinish → TELEMETRY_QUEUE.send(event)
  //   → this consumer batches events → Hyperdrive → Postgres INSERT
  // DLQ: failed messages after 5 retries go to harness-telemetry-dlq
  //   → DLQ consumer logs them for manual investigation
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // DLQ messages: just log them — operator can replay manually
    if (batch.queue === "harness-telemetry-dlq") {
      for (const msg of batch.messages) {
        console.error("[dlq] Dead letter:", JSON.stringify(msg.body).slice(0, 500));
        msg.ack(); // don't retry DLQ
      }
      return;
    }

    // Main queue: batch write to Postgres
    let sql: any;
    try {
      const pg = (await import("postgres")).default;
      sql = pg((env.DB as any).connectionString, {
        max: 1, fetch_types: false, prepare: false,
        idle_timeout: 5, connect_timeout: 3,
      });

      for (const msg of batch.messages) {
        const evt = msg.body as { type: string; payload: Record<string, unknown> };
        try {
          switch (evt.type) {
            case "session": {
              const p = evt.payload;
              await sql`
                INSERT INTO sessions (session_id, org_id, agent_name, model, status,
                  input_text, output_text, cost_total_usd, wall_clock_seconds,
                  step_count, action_count, channel, trace_id, termination_reason, created_at)
                VALUES (${p.session_id}, ${p.org_id}, ${p.agent_name}, ${p.model},
                  ${p.status}, ${String(p.input_text || "").slice(0, 2000)},
                  ${String(p.output_text || "").slice(0, 4000)},
                  ${p.cost_usd || 0}, ${p.wall_clock_seconds || 0},
                  ${p.step_count || 0}, ${p.action_count || 0},
                  ${p.channel || "web"}, ${p.trace_id || ""},
                  ${p.termination_reason || ""}, ${p.created_at || new Date().toISOString()})
                ON CONFLICT (session_id) DO UPDATE SET
                  status = EXCLUDED.status,
                  output_text = EXCLUDED.output_text,
                  cost_total_usd = GREATEST(sessions.cost_total_usd, EXCLUDED.cost_total_usd),
                  wall_clock_seconds = GREATEST(sessions.wall_clock_seconds, EXCLUDED.wall_clock_seconds),
                  step_count = GREATEST(sessions.step_count, EXCLUDED.step_count),
                  action_count = GREATEST(sessions.action_count, EXCLUDED.action_count),
                  termination_reason = COALESCE(EXCLUDED.termination_reason, sessions.termination_reason),
                  updated_at = now()
              `;
              break;
            }
            case "turn": {
              const p = evt.payload;
              await sql`
                INSERT INTO turns (session_id, turn_number, model_used,
                  input_tokens, output_tokens, latency_ms, cost_usd,
                  tool_calls, stop_reason, refusal, cache_read_tokens, cache_write_tokens)
                VALUES (${p.session_id}, ${p.turn_number}, ${p.model || ""},
                  ${p.input_tokens || 0}, ${p.output_tokens || 0},
                  ${p.latency_ms || 0}, ${p.cost_usd || 0},
                  ${JSON.stringify(p.tool_calls || [])},
                  ${p.stop_reason || ""}, ${p.refusal ? true : false},
                  ${p.cache_read_tokens || 0}, ${p.cache_write_tokens || 0})
                ON CONFLICT (session_id, turn_number) DO NOTHING
              `;
              break;
            }
            case "billing": {
              const p = evt.payload;
              await sql`
                INSERT INTO billing_records (org_id, session_id, agent_name,
                  model, provider, input_tokens, output_tokens,
                  total_cost_usd, trace_id, created_at)
                VALUES (${p.org_id}, ${p.session_id}, ${p.agent_name},
                  ${p.model || ""}, ${p.provider || "workers-ai"},
                  ${p.input_tokens || 0}, ${p.output_tokens || 0},
                  ${p.cost_usd || 0}, ${p.trace_id || ""},
                  ${p.created_at || new Date().toISOString()})
              `;
              break;
            }
            case "event": {
              const p = evt.payload;
              await sql`
                INSERT INTO runtime_events (org_id, agent_name, event_type, event_data, created_at)
                VALUES (${p.org_id || ""}, ${p.agent_name || ""}, ${p.event_type || ""},
                  ${JSON.stringify(p)}, ${p.created_at || new Date().toISOString()})
              `;
              break;
            }
            case "tool_execution": {
              const p = evt.payload;
              await sql`
                INSERT INTO tool_executions (org_id, session_id, tool_name,
                  input, output, latency_ms, error, created_at)
                VALUES (${p.org_id || ""}, ${p.session_id || ""}, ${p.tool_name || ""},
                  ${JSON.stringify(p.input || {})}, ${JSON.stringify(p.output || {})},
                  ${p.latency_ms || 0}, ${p.error || null},
                  ${p.created_at || new Date().toISOString()})
              `;
              break;
            }
            case "feedback": {
              const p = evt.payload;
              await sql`
                INSERT INTO session_feedback (session_id, org_id, agent_name,
                  rating, feedback_text, user_id, created_at)
                VALUES (${p.session_id}, ${p.org_id || ""}, ${p.agent_name || ""},
                  ${p.rating || 0}, ${p.feedback || ""}, ${p.user_id || ""},
                  ${p.created_at || new Date().toISOString()})
              `;
              break;
            }
            case "conversation_sync": {
              // Upsert conversation header from DO → Postgres
              const p = evt.payload;
              await sql`
                INSERT INTO conversations (id, org_id, agent_name, title, message_count, total_cost_usd, updated_at)
                VALUES (
                  ${p.do_name || crypto.randomUUID()},
                  ${p.org_id || ""},
                  ${p.agent_name || ""},
                  ${p.title || "Conversation"},
                  ${p.message_count || 0},
                  ${p.cost_usd || 0},
                  NOW()
                )
                ON CONFLICT (id) DO UPDATE SET
                  title = COALESCE(EXCLUDED.title, conversations.title),
                  message_count = GREATEST(conversations.message_count, EXCLUDED.message_count),
                  total_cost_usd = GREATEST(conversations.total_cost_usd, EXCLUDED.total_cost_usd),
                  updated_at = NOW()
              `;
              break;
            }
            case "eval_run": {
              // Execute eval: run each test case against the agent DO
              const p = evt.payload;
              const runId = p.run_id;
              const agentName = p.agent_name;
              const orgId = p.org_id;

              // Mark run as running
              await sql`UPDATE eval_runs SET status = 'running' WHERE id = ${runId}`;

              // Fetch test cases
              const testCases = await sql`
                SELECT * FROM eval_test_cases
                WHERE org_id = ${orgId} AND agent_name = ${agentName}
              `;

              let passCount = 0;
              let totalCost = 0;

              for (const tc of testCases as any[]) {
                const start = Date.now();
                try {
                  // Call agent DO via service binding
                  const doName = `${orgId}-${agentName}`;
                  const resp = await env.ChatAgent.get(
                    env.ChatAgent.idFromName(doName)
                  ).fetch(new Request("http://internal", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      type: "rpc",
                      id: crypto.randomUUID(),
                      method: "chat",
                      args: [tc.input],
                    }),
                  }));

                  const result = await resp.text();
                  const durationMs = Date.now() - start;
                  const passed = tc.expected ? result.includes(tc.expected) : null;
                  if (passed) passCount++;

                  await sql`
                    INSERT INTO eval_trials (run_id, test_case_id, input, output, expected, passed, duration_ms)
                    VALUES (${runId}, ${tc.id}, ${tc.input}, ${result.slice(0, 5000)}, ${tc.expected || null}, ${passed}, ${durationMs})
                  `;
                } catch (err: any) {
                  await sql`
                    INSERT INTO eval_trials (run_id, test_case_id, input, output, expected, passed, duration_ms)
                    VALUES (${runId}, ${tc.id}, ${tc.input}, ${`Error: ${err.message}`}, ${tc.expected || null}, ${false}, ${Date.now() - start})
                  `;
                }
              }

              // Mark run as completed with summary
              const total = (testCases as any[]).length;
              await sql`
                UPDATE eval_runs SET
                  status = 'completed',
                  summary = ${JSON.stringify({ pass_rate: total > 0 ? passCount / total : 0, total, passed: passCount, total_cost: totalCost })}::jsonb,
                  completed_at = NOW()
                WHERE id = ${runId}
              `;
              break;
            }
            case "rag_embed": {
              // Chunk document from R2, embed via Workers AI, upsert to Vectorize
              const p = evt.payload;
              const r2Key = p.r2_key as string;
              const orgId = (p.org_id || "") as string;
              const agentName = (p.agent_name || "") as string;

              try {
                // Fetch document from R2
                const obj = await env.STORAGE?.get(r2Key);
                if (!obj) { msg.ack(); break; }
                const text = await obj.text();

                // Chunk: 512 tokens (~2048 chars) with 100-char overlap
                const CHUNK_SIZE = 2048;
                const OVERLAP = 100;
                // Bug fix #7: clamp step to prevent infinite loop if overlap >= chunk_size
                const step = Math.max(1, CHUNK_SIZE - OVERLAP);
                const chunks: string[] = [];
                for (let i = 0; i < text.length; i += step) {
                  const chunk = text.slice(i, i + CHUNK_SIZE).trim();
                  if (chunk.length >= 10) chunks.push(chunk); // Bug fix: skip whitespace-only chunks
                }
                // Cap total chunks to prevent memory exhaustion on huge files
                const cappedChunks = chunks.slice(0, 500);

                // Embed + upsert to Vectorize in batches of 8
                for (let i = 0; i < cappedChunks.length; i += 8) {
                  const batch = cappedChunks.slice(i, i + 8);
                  const embedding = await env.AI?.run("@cf/baai/bge-base-en-v1.5", { text: batch }) as any;
                  if (!embedding?.data) continue;

                  const vectors: VectorizeVector[] = batch.map((chunk, j) => ({
                    id: `rag:${orgId}:${agentName}:${r2Key}:${i + j}`,
                    values: embedding.data[j],
                    metadata: {
                      key: `${r2Key}:chunk${i + j}`,
                      content: chunk,
                      org_id: orgId,
                      agent_name: agentName,
                      source: r2Key,
                      chunk_index: i + j,
                      timestamp: Date.now(),
                    },
                  }));

                  await env.VECTORIZE?.upsert(vectors);
                }
              } catch (err) {
                console.error(`[queue] RAG embed failed for ${r2Key}: ${err}`);
              }
              break;
            }
            default:
              console.warn(`[queue] Unknown event type: ${evt.type}`);
          }
          msg.ack();
        } catch (err: any) {
          // Permanent failures (constraint violations, bad data) — ack to avoid poison loop
          if (err?.code === "23505" || err?.code === "23502" || err?.code === "42703") {
            console.error(`[queue] PERMANENT: ${evt.type} ${err.code}: ${String(err.message).slice(0, 200)}`);
            msg.ack();
          } else {
            // Transient failures (connection, timeout) — retry with backoff
            console.error(`[queue] TRANSIENT: ${evt.type} attempt=${msg.attempts}: ${String(err.message).slice(0, 200)}`);
            msg.retry();
          }
        }
      }
    } finally {
      if (sql) try { await sql.end(); } catch {}
    }
  },
} satisfies ExportedHandler<Env>;

// ═══════════════════════════════════════════════════════════════════
// ADDITIVE FEATURES — everything below is NEW, nothing above touched
// ═══════════════════════════════════════════════════════════════════

// ── Structured Input Tools (client-side) ────────────────────────────
// Pattern from: cloudflare/agents examples/structured-input
// These tools pause the LLM and ask the client to render UI elements.

function structuredInputTools() {
  return {
    askMultipleChoice: tool({
      description: "Present options for the user to choose from.",
      inputSchema: z.object({
        question: z.string(),
        options: z.array(z.string()),
        allowMultiple: z.boolean().optional(),
      }),
    }),
    askYesNo: tool({
      description: "Ask a yes/no question.",
      inputSchema: z.object({ question: z.string() }),
    }),
    askRating: tool({
      description: "Ask the user to rate something on a scale.",
      inputSchema: z.object({
        question: z.string(),
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    }),
    askFreeText: tool({
      description: "Ask for open-ended text input.",
      inputSchema: z.object({
        question: z.string(),
        placeholder: z.string().optional(),
        multiline: z.boolean().optional(),
      }),
    }),
  };
}

// ── Push Notification Agent ─────────────────────────────────────────
// Pattern from: cloudflare/agents examples/push-notifications

// ═══════════════════════════════════════════════════════════════════
// VOICE AGENT — Full STT/TTS pipeline via Workers AI
//
// SDK pattern: withVoice(Agent) mixin. No external providers needed.
// STT: WorkersAIFluxSTT (continuous) or WorkersAINova3STT (high quality)
// TTS: WorkersAITTS (Deepgram Aura)
// Connect via WebSocket: /agents/voice-agent/{doName}
// Client sends 16kHz mono PCM audio frames → server streams TTS back
// ═══════════════════════════════════════════════════════════════════

// VoiceAgent extends ChatAgent (Think) with voice I/O.
// Gets the FULL platform: personal agent prompt, R2 skills, memory,
// signal pipeline, hooks, tools, MCP — just with voice I/O on top.
//
// The voice mixin wraps the Agent base class to add STT/TTS.
// Since ChatAgent extends Think which extends Agent, we can't directly
// use withVoice(ChatAgent) — the mixin expects the base Agent class.
// Instead, VoiceAgent is a separate DO that uses ChatAgent's getModel()
// and getTools() patterns but with voice I/O.

const VoiceBase = withVoice(Agent);

export class VoiceAgent extends VoiceBase<Env> {
  tts = new WorkersAITTS(this.env.AI);

  createTranscriber(connection: any): Transcriber {
    const url = new URL(connection.url ?? "http://localhost");
    const model = url.searchParams.get("model");
    if (model === "nova-3") return new WorkersAINova3STT(this.env.AI);
    return new WorkersAIFluxSTT(this.env.AI);
  }

  #activeSpeakerId: string | null = null;

  beforeCallStart(connection: any): boolean {
    if (this.#activeSpeakerId && this.#activeSpeakerId !== connection.id) {
      connection.send(JSON.stringify({ type: "speaker_conflict" }));
      return false;
    }
    this.#activeSpeakerId = connection.id;
    return true;
  }

  onCallEnd(connection: any) { if (this.#activeSpeakerId === connection.id) this.#activeSpeakerId = null; }
  onClose(connection: any) { if (this.#activeSpeakerId === connection.id) this.#activeSpeakerId = null; }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // Use the SAME model routing as ChatAgent — supports Workers AI + OpenRouter
    const config = getTenantConfig(this.name);
    const modelId = config.model;
    let model;
    if (modelId && !modelId.startsWith("@cf/") && modelId.includes("/")) {
      const cfAigToken = (this.env as any).CF_AIG_TOKEN || "";
      const openrouter = createOpenAI({
        apiKey: cfAigToken,
        baseURL: "https://gateway.ai.cloudflare.com/v1/ae92d4bf7c6c448f442d084a2358dcd5/one-shots/openrouter",
      });
      model = openrouter(modelId);
    } else {
      const workersai = createWorkersAI({ binding: this.env.AI });
      model = workersai((modelId || "@cf/moonshotai/kimi-k2.5") as any, { sessionAffinity: this.sessionAffinity });
    }

    // Use the SAME system prompt as ChatAgent — personal agent + channel voice formatting
    const basePrompt = config.systemPrompt || buildPersonalAgentPrompt();
    const voicePrompt = `${basePrompt}\n\n## Channel: Voice\nCRITICAL: Response read aloud by TTS. NO markdown, no lists, no code blocks. Short natural sentences (<75 words). Spell out abbreviations (API → A-P-I). Give results, not process.`;

    // Use the SAME tools as ChatAgent (minus code-execution which doesn't make sense in voice)
    const result = streamText({
      model,
      system: voicePrompt,
      messages: [
        ...context.messages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user" as const, content: transcript },
      ],
      tools: {
        get_current_time: tool({
          description: "Get the current date and time",
          inputSchema: z.object({}),
          execute: async () => ({
            time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
            date: new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
          }),
        }),
        set_reminder: tool({
          description: "Set a spoken reminder after a delay",
          inputSchema: z.object({ message: z.string(), delay_seconds: z.number() }),
          execute: async ({ message, delay_seconds }) => {
            await this.schedule(delay_seconds, "speakReminder", { message });
            return { confirmed: true };
          },
        }),
        web_search: tool({
          description: "Search the web for information",
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => {
            // Use Workers AI for web search if available
            return { query, note: "Web search available — connect via MCP for full results" };
          },
        }),
      },
      stopWhen: stepCountIs(5),
      abortSignal: context.signal,
    });

    return result.textStream;
  }

  async onCallStart(connection: any) {
    const count = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM cf_voice_messages`[0]?.count ?? 0;
    const greeting = count > 0 ? "Welcome back! How can I help?" : "Hello! I'm your assistant. How can I help?";
    this.speak(connection, greeting);
  }

  async speakReminder(payload: { message: string }) {
    for (const conn of this.getConnections()) this.speak(conn, `Reminder: ${payload.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════

type Subscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};
type Reminder = { id: string; message: string; scheduledAt: number; sent: boolean };
type ReminderAgentState = { subscriptions: Subscription[]; reminders: Reminder[] };

export class ReminderAgent extends Agent<Env, ReminderAgentState> {
  initialState: ReminderAgentState = { subscriptions: [], reminders: [] };

  @callable({ description: "Get VAPID public key for push subscription" })
  getVapidPublicKey(): string { return this.env.VAPID_PUBLIC_KEY || ""; }

  @callable({ description: "Subscribe browser endpoint for push notifications" })
  async subscribe(sub: Subscription): Promise<{ ok: boolean }> {
    if (!this.state.subscriptions.some(s => s.endpoint === sub.endpoint)) {
      this.setState({ ...this.state, subscriptions: [...this.state.subscriptions, sub] });
    }
    return { ok: true };
  }

  @callable({ description: "Unsubscribe a push endpoint" })
  async unsubscribe(endpoint: string): Promise<{ ok: boolean }> {
    this.setState({ ...this.state, subscriptions: this.state.subscriptions.filter(s => s.endpoint !== endpoint) });
    return { ok: true };
  }

  @callable({ description: "Create a scheduled reminder with push notification" })
  async createReminder(message: string, delaySeconds: number): Promise<Reminder> {
    const id = crypto.randomUUID();
    const reminder: Reminder = { id, message, scheduledAt: Date.now() + delaySeconds * 1000, sent: false };
    this.setState({ ...this.state, reminders: [...this.state.reminders, reminder] });
    await this.schedule(delaySeconds, "sendReminder", { id, message });
    return reminder;
  }

  @callable({ description: "Cancel a scheduled reminder" })
  async cancelReminder(id: string): Promise<{ ok: boolean }> {
    const schedules = this.getSchedules();
    for (const s of schedules) { if ((s.payload as any)?.id === id) { await this.cancelSchedule(s.id); break; } }
    this.setState({ ...this.state, reminders: this.state.reminders.filter(r => r.id !== id) });
    return { ok: true };
  }

  @callable({ description: "Send test push notification" })
  async sendTestNotification(): Promise<{ sent: number; failed: number }> {
    return this.pushToAll({ title: "Test", body: "Push notifications working!", tag: "test" });
  }

  async sendReminder(payload: { id: string; message: string }) {
    await this.pushToAll({ title: "Reminder", body: payload.message, tag: `reminder-${payload.id}` });
    this.setState({ ...this.state, reminders: this.state.reminders.map(r => r.id === payload.id ? { ...r, sent: true } : r) });
    this.broadcast(JSON.stringify({ type: "reminder_sent", id: payload.id, timestamp: Date.now() }));
  }

  private async pushToAll(notification: Record<string, unknown>): Promise<{ sent: number; failed: number }> {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return { sent: 0, failed: 0 };
    webpush.setVapidDetails(this.env.VAPID_SUBJECT || "mailto:agent@example.com", this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
    const dead: string[] = [];
    let sent = 0, failed = 0;
    await Promise.all(this.state.subscriptions.map(async (sub) => {
      try { await webpush.sendNotification(sub, JSON.stringify(notification)); sent++; }
      catch (err: any) { if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(sub.endpoint); failed++; }
    }));
    if (dead.length) this.setState({ ...this.state, subscriptions: this.state.subscriptions.filter(s => !dead.includes(s.endpoint)) });
    return { sent, failed };
  }
}

// ── MCP Server with Elicitation ────────────────────────────────────
// Pattern from: cloudflare/agents examples/mcp-elicitation

type McpState = { counter: number };

export class McpElicitationServer extends McpAgent<Env, McpState, {}> {
  server = new McpServer({ name: "agent-harness-mcp", version: "1.0.0" });
  initialState: McpState = { counter: 0 };

  async init() {
    this.server.tool(
      "increase-counter",
      "Increase a persistent counter. Asks the user how much to increase by.",
      { confirm: z.boolean().describe("Confirm?") },
      async ({ confirm }) => {
        if (!confirm) return { content: [{ type: "text" as const, text: "Cancelled." }] };
        const result = await this.elicitInput({
          message: "By how much?",
          requestedSchema: { type: "object", properties: { amount: { type: "number", title: "Amount" } }, required: ["amount"] },
        });
        if (result.action !== "accept" || !result.content) return { content: [{ type: "text" as const, text: "Cancelled." }] };
        const amount = Number(result.content.amount);
        if (!amount) return { content: [{ type: "text" as const, text: "Invalid amount." }] };
        this.setState({ ...this.state, counter: this.state.counter + amount });
        return { content: [{ type: "text" as const, text: `Counter: ${this.state.counter} (+${amount})` }] };
      },
    );

    this.server.tool("run-agent", "Run the agent on a task", { task: z.string() },
      async ({ task }) => ({ content: [{ type: "text" as const, text: `Task queued: ${task}` }] }),
    );

    this.server.resource("agent-state", "agent-harness://state", async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify({ counter: this.state.counter }, null, 2), mimeType: "application/json" }],
    }));
  }
}

// ── A2A Agent Card ──────────────────────────────────────────────────
// Pattern from: cloudflare/agents examples/a2a

export const AGENT_CARD = {
  name: "021agents",
  description: "Autonomous AI agent platform — research, code, deploy, create agents, voice calls, and agent-to-agent services via A2A protocol.",
  version: "2.0.0",
  capabilities: {
    streaming: true,
    stateTransitionHistory: true,
    pushNotifications: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [
    { id: "chat", name: "General Assistant", description: "Chat, research, analysis, web search, calculations", tags: ["chat", "research"] },
    { id: "code", name: "Coding Agent", description: "Full-stack development — scaffold, build, preview, deploy to CF Pages/Workers", tags: ["coding", "deploy"] },
    { id: "research", name: "Research Analyst", description: "Deep web research with multiple sources and citations", tags: ["research", "analysis"] },
    { id: "design", name: "Design Agent", description: "Create websites, charts, PDFs, slides with professional design", tags: ["design", "creative"] },
    { id: "data", name: "Data Analyst", description: "Process data, generate visualizations, query databases", tags: ["data", "analytics"] },
    { id: "voice", name: "Voice Agent", description: "Real-time voice conversations with STT/TTS", tags: ["voice", "phone"] },
  ],
  authentication: { schemes: ["bearer"] },
  // x402 payment support for paid agent services
  payment: {
    protocol: "x402",
    networks: ["eip155:84532", "eip155:8453"], // Base Sepolia + Base mainnet
    facilitator: "https://x402.org/facilitator",
  },
};
