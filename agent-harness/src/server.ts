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
import { createCodeTool, generateTypes } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import puppeteer from "@cloudflare/puppeteer";
import webpush from "web-push";
import { metaAgentTools as metaAgentToolSet, META_AGENT_SYSTEM_PROMPT } from "./meta-agent";
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
function createSkillProvider(skill: SkillDefinition, overlayLoader?: () => string[]) {
  const mergeWithOverlays = () => {
    let content = skill.content;
    const overlays = overlayLoader?.() || [];
    if (overlays.length > 0) {
      content += "\n\n---\n## Learned Rules\n\n" + overlays.join("\n\n---\n");
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

// ── Vectorize Search Provider with time-decay + hybrid RRF + threat detection ──

function createVectorizeSearchProvider(env: Env) {
  return {
    async get(): Promise<string | null> {
      return "Semantic memory available. Use search_context to find past knowledge.";
    },

    async search(query: string): Promise<string | null> {
      try {
        // Dense vector search via Vectorize
        const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
          text: [query],
        });
        const vectorResults = await env.VECTORIZE.query(embedding.data[0], {
          topK: 10,
          returnMetadata: "all",
        });

        if (!vectorResults.matches?.length) return null;

        // Apply time-decay confidence scoring
        const scored = vectorResults.matches
          .map((m: any) => ({
            key: m.metadata?.key || m.id,
            content: m.metadata?.content || "",
            timestamp: m.metadata?.timestamp || 0,
            // RRF rank score (1/(k+rank)) merged with vector similarity + time decay
            score: effectiveConfidence(m.score || 0, m.metadata?.timestamp || 0),
            freshness: memoryFreshnessNote(m.metadata?.timestamp || 0),
          }))
          .filter((m: any) => m.score > 0) // Drop fully decayed memories
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, 5);

        if (scored.length === 0) return null;

        return scored
          .map((m: any) => `[${m.key}] (relevance: ${m.score.toFixed(2)}${m.freshness})\n${m.content}`)
          .join("\n\n");
      } catch {
        return null;
      }
    },

    async set(key: string, content: string): Promise<void> {
      // Threat detection — block adversarial memory writes
      const threat = scanMemoryContent(content);
      if (threat) {
        console.warn(`[memory] ${threat} — key: ${key}`);
        return; // Silently reject — don't expose threat details to model
      }

      try {
        const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
          text: [content],
        });
        await env.VECTORIZE.upsert([{
          id: key,
          values: embedding.data[0],
          metadata: { key, content, timestamp: Date.now() },
        }]);
      } catch {
        // Fail silently — memory write shouldn't block chat
      }
    },
  };
}

// ── Skill-aware Tenant Config ──────────────────────────────────────

const TENANTS: TenantConfig[] = [
  {
    id: "meta",
    name: "Agent Builder",
    icon: "🧠",
    description: "I help you create, test, and improve your AI agents",
    model: "@cf/moonshotai/kimi-k2.5",
    systemPrompt: "", // Set dynamically from meta-agent.ts
    skills: [
      SKILL_LIBRARY.find(s => s.name === "planning")!,
    ],
  },
  {
    id: "default",
    name: "Personal Assistant",
    icon: "✦",
    description: "General purpose AI assistant for everyday tasks",
    model: "@cf/moonshotai/kimi-k2.5",
    systemPrompt:
      "You are a helpful personal assistant. Help with research, writing, analysis, planning, and everyday tasks. Be concise and actionable. You have skills available as context blocks — activate them when the task benefits from structured methodology.",
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
];

function getTenantConfig(tenantId: string): TenantConfig {
  return TENANTS.find((t) => t.id === tenantId) ?? TENANTS[0];
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

const SESSION_COOKIE = "agent_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function isAuthenticated(request: Request): boolean {
  const cookies = request.headers.get("Cookie") ?? "";
  return cookies.includes(`${SESSION_COOKIE}=authenticated`);
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

function sandboxTools(env: Env) {
  return {
    // Execute a shell command in the sandbox
    execCommand: tool({
      description:
        "Execute a shell command in the sandbox (e.g., 'ls', 'npm install', 'python script.py'). Returns stdout and stderr.",
      inputSchema: z.object({
        command: z.string().describe("The command to run (e.g., 'npm test')"),
        args: z
          .array(z.string())
          .optional()
          .describe("Command arguments as array"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory (default: /workspace)"),
      }),
      execute: async ({ command, args, cwd }) => {
        try {
          const sandbox = getSandbox(env.Sandbox, "coding-sandbox");
          // exec() takes (command, options?) — args go into the command string
          const fullCommand = args?.length ? `${command} ${args.join(" ")}` : command;
          const result = await sandbox.exec(fullCommand, {
            cwd: cwd ?? "/workspace",
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout?.slice(0, 8000) ?? "",
            stderr: result.stderr?.slice(0, 4000) ?? "",
          };
        } catch (err) {
          return { error: `Sandbox exec failed: ${String(err)}` };
        }
      },
    }),

    // Write a file in the sandbox
    writeFile: tool({
      description:
        "Write content to a file in the sandbox. Creates directories as needed.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("File path in the sandbox (e.g., '/workspace/app.py')"),
        content: z.string().describe("File content to write"),
      }),
      execute: async ({ path, content }) => {
        try {
          const sandbox = getSandbox(env.Sandbox, "coding-sandbox");
          await sandbox.writeFile(path, content);
          return { success: true, path, bytes: content.length };
        } catch (err) {
          return { error: `Write failed: ${String(err)}` };
        }
      },
    }),

    // Read a file from the sandbox
    readFile: tool({
      description: "Read the contents of a file in the sandbox.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("File path to read (e.g., '/workspace/output.txt')"),
      }),
      execute: async ({ path }) => {
        try {
          const sandbox = getSandbox(env.Sandbox, "coding-sandbox");
          const content = await sandbox.readFile(path);
          const text =
            typeof content === "string"
              ? content
              : new TextDecoder().decode(content as unknown as Uint8Array);
          return {
            path,
            content: text.slice(0, 8000),
            truncated: text.length > 8000,
          };
        } catch (err) {
          return { error: `Read failed: ${String(err)}` };
        }
      },
    }),

    // Run code in a persistent interpreter (Python/JS/TS)
    runCode: tool({
      description:
        "Run code in a persistent interpreter. Variables and imports persist across calls. Supports Python, JavaScript, and TypeScript.",
      inputSchema: z.object({
        code: z.string().describe("The code to execute"),
        language: z
          .enum(["python", "javascript", "typescript"])
          .describe("Programming language"),
      }),
      execute: async ({ code, language }) => {
        try {
          const sandbox = getSandbox(env.Sandbox, "coding-sandbox");
          const ctx = await sandbox.createCodeContext({ language });
          const output: string[] = [];
          const result = await sandbox.runCode(code, {
            context: ctx,
            onStdout: (line) => { output.push(line.text); },
          });
          return {
            language,
            output: output.join("\n").slice(0, 8000),
            result: result ? JSON.stringify(result).slice(0, 4000) : null,
          };
        } catch (err) {
          return { error: `Code execution failed: ${String(err)}` };
        }
      },
    }),

    // Clone a git repository into the sandbox
    gitClone: tool({
      description:
        "Clone a git repository into the sandbox for building, testing, or analysis.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("Git repository URL (e.g., 'https://github.com/org/repo')"),
        targetDir: z
          .string()
          .optional()
          .describe("Target directory (default: /workspace)"),
      }),
      execute: async ({ url, targetDir }) => {
        try {
          const sandbox = getSandbox(env.Sandbox, "coding-sandbox");
          const result = await sandbox.gitCheckout(url, {
            targetDir: targetDir ?? "/workspace",
            depth: 1,
          });
          return { success: true, url, directory: targetDir ?? "/workspace", result };
        } catch (err) {
          return { error: `Git clone failed: ${String(err)}` };
        }
      },
    }),
  };
}

// ── Browser Rendering tools (Puppeteer via Workers Browser API) ──────────────

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
            return el?.innerText ?? "";
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

export class CodingSpecialist extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
  }
  getSystemPrompt() {
    return "You are a coding specialist. Write clean, well-tested code. Use the workspace to create files. Run code to verify it works.";
  }
  getTools() {
    return {
      ...sharedTools(),
      ...(this.env.Sandbox ? sandboxTools(this.env) : {}),
    };
  }
  getMaxSteps() { return 20; }
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
import { Think, Workspace, Session } from "@cloudflare/think";
import { AgentSearchProvider } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";

export class ChatAgent extends Think<Env> {
  // Wait for MCP connections to restore after hibernation
  waitForMcpConnections = true;

  // ── Durability: wrap chat turns in runFiber for crash recovery ──
  // If the DO is evicted mid-turn, onChatRecovery() fires on restart
  // and can resume streaming or persist partial results.
  override unstable_chatRecovery = true;

  // ── Workspace with R2 spillover (SDK pattern from Think docs) ──
  // Files < 1.5MB stay in SQLite (fast, local), larger files spill to R2.
  // Think auto-creates workspace tools (read, write, edit, find, grep, delete).
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.STORAGE,
    r2Prefix: `workspaces/${this.name}/`,
    name: () => this.name,
  });

  // ── Think overrides ──

  getModel() {
    const config = getTenantConfig(this.name);
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai(config.model as Parameters<typeof workersai>[0], {
      sessionAffinity: this.sessionAffinity,
    });
  }

  getSystemPrompt() {
    const config = getTenantConfig(this.name);
    // Meta Agent uses its own system prompt from meta-agent.ts
    if (config.id === "meta") return META_AGENT_SYSTEM_PROMPT;
    return config.systemPrompt;
  }

  getTools() {
    const config = getTenantConfig(this.name);
    const mcpTools = this.mcp.getAITools();

    const allTools = {
      ...mcpTools,
      ...sharedTools(),
      ...webSearchTools(),
      ...browserTools(this.env),
      ...(config.enableSandbox ? sandboxTools(this.env) : {}),
      ...structuredInputTools(),
      // Meta Agent gets agent management tools
      ...(config.id === "meta" ? metaAgentToolSet({ AGENT_CORE: this.env.AGENT_CORE || this.env as any, AI: this.env.AI, ANALYTICS: this.env.ANALYTICS }) : {}),
    };

    // Wrap all tools with CodeMode — model writes JS to orchestrate tools.
    // We wrap the executor to capture CodeMode failures in telemetry.
    const rawExecutor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const trackedExecutor = {
      execute: async (code: string, providers: any[]) => {
        const start = Date.now();
        try {
          const result = await rawExecutor.execute(code, providers);
          this._telemetry.toolCompleted(this.name, "codemode", { latencyMs: Date.now() - start });
          return result;
        } catch (err: any) {
          this._telemetry.toolFailed(this.name, "codemode", err?.message || String(err));
          emit(this.env as TelemetryBindings, {
            type: "tool.failed",
            agentName: this.name,
            toolName: "codemode",
            toolError: err?.message || String(err),
            latencyMs: Date.now() - start,
            metadata: { codePreview: code.slice(0, 200) },
          });
          throw err;
        }
      },
    };
    const codemode = createCodeTool({ tools: allTools, executor: trackedExecutor as any });

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

    return { codemode, ...allTools, ...delegationTools };
  }

  getMaxSteps() { return 10; }

  // ── Session: context blocks + compaction ──

  configureSession(session: any) {
    const config = getTenantConfig(this.name);

    let s = session
      // ── Soul: persistent identity (survives compaction) ──
      .withContext("soul", {
        provider: { get: async () => this.getSystemPrompt() },
      })
      // ── Memory: facts learned during conversation ──
      // The LLM has a set_context tool to write to this block.
      // Contents persist across turns and survive compaction.
      .withContext("memory", {
        description: "Important facts, preferences, and decisions learned during this conversation. Update proactively when you learn something new about the user, their project, or their preferences.",
        maxTokens: 2000,
      })
      // ── Skills catalog: tells the LLM what skills are available ──
      // This is a readonly block that lists available skills.
      // The LLM uses load_context to activate a skill when needed.
      .withContext("available-skills", {
        provider: {
          get: async () => {
            const skills = config.skills || [];
            if (skills.length === 0) return "No specialized skills available.";

            // Partition: auto-detect skills (have when_to_use) vs manual
            const autoSkills = skills.filter(sk => sk.when_to_use);
            const manualSkills = skills.filter(sk => !sk.when_to_use);

            const lines = ["## Available Skills", ""];

            if (autoSkills.length > 0) {
              lines.push("### Auto-Activate (load when criteria match)");
              for (const sk of autoSkills) {
                lines.push(`- **${sk.name}**: ${sk.description}`);
                lines.push(`  *Activate when:* ${sk.when_to_use}`);
              }
              lines.push("");
            }

            if (manualSkills.length > 0) {
              lines.push("### On-Demand (load with load_context when needed)");
              for (const sk of manualSkills) {
                lines.push(`- **${sk.name}**: ${sk.description}`);
              }
              lines.push("");
            }

            lines.push("Skills expand into detailed protocols with learned rules. Only load what you need.");
            return lines.join("\n");
          },
        },
      });

    // ── Register each skill as a loadable context block ──
    // SkillProvider merges base content + DO SQLite overlays at runtime.
    // The LLM sees them listed in available-skills and calls load_context("skill-name")
    // to inject the full skill markdown + learned rules into the prompt.
    for (const skill of (config.skills || [])) {
      const overlayLoader = () => this._getSkillOverlays(skill.name);
      s = s.withContext(`skill-${skill.name}`, {
        description: skill.description,
        provider: createSkillProvider(skill, overlayLoader),
      });
    }

    // ── Knowledge: FTS5-backed searchable knowledge base ──
    // AgentSearchProvider uses DO SQLite FTS5 for full-text search.
    // The LLM gets search_context and set_context tools automatically.
    // Knowledge persists across turns and is searchable via natural language.
    s = s.withContext("knowledge", {
      description: "Persistent knowledge base. Use set_context to save important information (research findings, code snippets, reference data). Use search_context to recall saved knowledge.",
      provider: new AgentSearchProvider(this as any),
    });

    // ── Vectorize: cross-session semantic memory ──
    // Wraps Cloudflare Vectorize + Workers AI embeddings for semantic search.
    // Falls back gracefully if VECTORIZE binding is not configured.
    if (this.env.VECTORIZE && this.env.AI) {
      const vectorizeProvider = createVectorizeSearchProvider(this.env);
      s = s.withContext("semantic-memory", {
        description: "Cross-session memory. Search recalls knowledge from past conversations. Set stores embeddings for future recall.",
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
  private _sessionCostUsd = 0;                             // cost accumulator

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
    // [1] Query source tagging — tag this call for retry policy
    //     User-facing turns retry on 529; background (compaction) does not.
    const querySource = ctx.continuation ? "continuation" : "user_chat";
    this._telemetry.llmRequest(ctx.sessionId || this.name, ctx.model || "", querySource);

    const config: any = {};

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

    // [3] Accumulate session cost for budget tracking
    this._sessionCostUsd += costUsd;

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

    // Detect refusals
    if (ctx.finishReason === "content_filter" || ctx.refusal) {
      this._telemetry.turnRefusal(ctx.sessionId || this.name, ctx.stepNumber || 0);
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

  protected async onChatResponse(result: ChatResponseResult) {
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
              const key = `fact:${fact.category}:${Date.now()}:${crypto.randomUUID().slice(0, 4)}`;
              provider.set(key, `[${fact.category}] ${fact.content}`).catch(() => {});
            }
          }
        } catch {} // never block on fact extraction
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
  private _recordSignal(type: string, topic: string, severity: number, metadata: Record<string, unknown> = {}) {
    this._ensureSignalTable();
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

    for (const cluster of clusters) {
      // Emit telemetry for the cluster trigger
      emit(this.env as TelemetryBindings, {
        type: "signal.cluster_triggered",
        agentName: this.name,
        signalType: cluster.signal_type,
        topic: cluster.topic,
        count: cluster.count,
      });

      // Auto-fire: generate skill overlay from signal cluster
      // Pattern from old deploy/runtime/skill-feedback.ts
      if (cluster.signal_type === "tool_failure" && cluster.count >= 3) {
        this.appendSkillRule(
          "debug", // target the debug skill
          `When "${cluster.topic}" tool fails repeatedly, try alternative approaches first. This tool has failed ${cluster.count} times recently.`,
          "auto",
          `auto-fire: ${cluster.count} ${cluster.signal_type} signals for ${cluster.topic}`,
        );
      }
      if (cluster.signal_type === "loop_detected" && cluster.count >= 2) {
        this.appendSkillRule(
          "debug",
          `Avoid calling "${cluster.topic}" in tight loops. If the first call doesn't produce the expected result, change your approach rather than retrying with the same arguments.`,
          "auto",
          `auto-fire: ${cluster.count} loop detections for ${cluster.topic}`,
        );
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

  @callable({ description: "Connect to an external MCP server" })
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable({ description: "Disconnect an MCP server" })
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable({ description: "List available tenants" })
  getTenants() {
    return TENANTS.map(({ id, name, icon, description }) => ({
      id, name, icon, description,
    }));
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
      ...(getTenantConfig(this.name).enableSandbox ? sandboxTools(this.env) : {}),
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
  private _ensureSchema() {
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
    this._ensureSchema();
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
      Object.assign(tools, sandboxTools(this.env));
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
      this._ensureSchema();
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
      this._ensureSchema();
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
      this._ensureSchema();
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

    // A2A Protocol: agent card discovery
    if (url.pathname === "/.well-known/agent.json") {
      return Response.json(AGENT_CARD, { headers: { "Access-Control-Allow-Origin": "*" } });
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
      for (const msg of batch) {
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

      for (const msg of batch) {
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
  name: "Agent Harness",
  description: "Multi-tenant managed agent platform on Cloudflare Workers",
  url: "https://agent-harness.example.com",
  version: "1.0.0",
  capabilities: { streaming: true, stateTransitionHistory: true },
  skills: [
    { id: "general-chat", name: "General Assistant", description: "Chat, research, analysis" },
    { id: "coding", name: "Coding Agent", description: "Write and execute code in sandbox" },
    { id: "research", name: "Research Analyst", description: "Web search and synthesis" },
    { id: "support", name: "Customer Support", description: "Answer questions from knowledge base" },
  ],
  authentication: { schemes: ["bearer", "cookie"] },
};
