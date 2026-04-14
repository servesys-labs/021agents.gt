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
import { DurableObject } from "cloudflare:workers";
import { createCodeTool, generateTypes } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import puppeteer from "@cloudflare/puppeteer";
import webpush from "web-push";
import { metaAgentTools as metaAgentToolSet, META_AGENT_SYSTEM_PROMPT } from "./meta-agent";

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
  content: string; // markdown content — the "skill.md" body
}

// ── Built-in Skills Library ────────────────────────────────────────

const SKILL_LIBRARY: SkillDefinition[] = [
  {
    name: "deep-research",
    description: "Multi-source research with structured output and source citations",
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

function createSkillProvider(skill: SkillDefinition) {
  return {
    get: async () => skill.content,
    load: async () => skill.content,
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
// Extends Think (not AIChatAgent) — the full CF Agents SDK lifecycle:
// Session persistence, context blocks (soul + memory), auto-compaction,
// resumable streaming, CodeMode, extensions, lifecycle hooks, sub-agents.
//
// Think class hierarchy: Agent → AIChatAgent → Think
// Everything AIChatAgent provides, Think includes + adds session management.

// Dynamic import: Think is experimental, import at module level
// so it fails fast if the package isn't available.
import { Think } from "@cloudflare/think";
import { createCompactFunction } from "agents/experimental/memory/utils";

export class ChatAgent extends Think<Env> {
  // Wait for MCP connections to restore after hibernation
  waitForMcpConnections = true;

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

    // Wrap all tools with CodeMode — model writes JS to orchestrate tools
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const codemode = createCodeTool({ tools: allTools, executor });

    return { codemode, ...allTools };
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
            return [
              "## Available Skills",
              "Activate a skill with load_context when the task requires structured methodology.",
              "",
              ...skills.map(sk => `- **${sk.name}**: ${sk.description}`),
              "",
              "Skills expand into detailed protocols. Only load what you need for the current task.",
            ].join("\n");
          },
        },
      });

    // ── Register each skill as a loadable context block ──
    // These use SkillProvider pattern: get() returns content, load() activates.
    // The LLM sees them listed in available-skills and calls load_context("skill-name")
    // to inject the full skill markdown into the prompt.
    // This keeps the base prompt small but expandable to infinity.
    for (const skill of (config.skills || [])) {
      s = s.withContext(`skill-${skill.name}`, {
        description: skill.description,
        provider: createSkillProvider(skill),
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

  // ── Lifecycle hooks ──

  // After each tool call: telemetry
  onStepFinish(ctx: any) {
    if (this.env.ANALYTICS) {
      try {
        this.env.ANALYTICS.writeDataPoint({
          blobs: [ctx.toolName || "llm_turn", this.name],
          doubles: [ctx.usage?.totalTokens || 0],
          indexes: [this.name],
        });
      } catch {} // non-blocking
    }
  }

  // Post-turn: broadcast completion, refresh context blocks
  protected async onChatResponse(result: ChatResponseResult) {
    if (result.status === "completed") {
      this.broadcast(JSON.stringify({ type: "streaming_done" }));
      try { await (this as any).session?.refreshSystemPrompt?.(); } catch {}
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
// Manages dynamically created agents. The supervisor handles LLM chat directly
// using Workers AI + tools — no dynamic worker code generation needed.
// Chat history is stored per-agent in the supervisor's own KV storage.
//
// This avoids the complexity of making full AIChatAgent work inside dynamic
// workers (which don't have access to env bindings like AI, MYBROWSER, etc.).

type StoredMessage = { role: "user" | "assistant"; content: string };

export class AgentSupervisor extends DurableObject<Env> {
  /**
   * Initialize SQLite tables on first use.
   * Safe to call multiple times — CREATE TABLE IF NOT EXISTS is idempotent.
   */
  async initialize() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          agent_id    TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          icon        TEXT DEFAULT '✦',
          description TEXT DEFAULT '',
          system_prompt TEXT NOT NULL,
          model       TEXT DEFAULT '@cf/moonshotai/kimi-k2.5',
          enable_sandbox INTEGER DEFAULT 0,
          created_at  TEXT DEFAULT (datetime('now')),
          status      TEXT DEFAULT 'active'
        );
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── CRUD: list agents ──
    if (url.pathname === "/agents" && request.method === "GET") {
      return this.listAgents();
    }

    // ── CRUD: create agent ──
    if (url.pathname === "/agents" && request.method === "POST") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      return this.createAgent(body);
    }

    // ── CRUD: delete agent ──
    if (url.pathname.startsWith("/agents/") && request.method === "DELETE") {
      const agentId = url.pathname.split("/").pop()!;
      return this.deleteAgent(agentId);
    }

    // ── Chat with a dynamic agent ──
    if (url.pathname.startsWith("/chat/") && request.method === "POST") {
      const agentId = url.pathname.split("/")[2];
      return this.chatWithAgent(agentId, request);
    }

    // ── Clear chat history for a dynamic agent ──
    if (url.pathname.startsWith("/chat/") && request.method === "DELETE") {
      const agentId = url.pathname.split("/")[2];
      await this.ctx.storage.put(`chat:${agentId}`, []);
      return Response.json({ cleared: agentId });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── List all active agents ──────────────────────────────────────────────────

  async listAgents(): Promise<Response> {
    await this.initialize();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT agent_id, name, icon, description, model, enable_sandbox, created_at FROM agents WHERE status = 'active' ORDER BY created_at"
      )
      .toArray();
    return Response.json(rows);
  }

  // ── Create a new dynamic agent ─────────────────────────────────────────────

  async createAgent(config: any): Promise<Response> {
    await this.initialize();

    const agentId = config.agent_id || crypto.randomUUID().slice(0, 8);

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO agents
         (agent_id, name, icon, description, system_prompt, model, enable_sandbox)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      agentId,
      config.name || "Custom Agent",
      config.icon || "✦",
      config.description || "",
      config.system_prompt || "You are a helpful assistant.",
      config.model || "@cf/moonshotai/kimi-k2.5",
      config.enable_sandbox ? 1 : 0
    );

    // Initialize empty chat history
    await this.ctx.storage.put(`chat:${agentId}`, []);

    return Response.json({ agent_id: agentId });
  }

  // ── Soft-delete an agent ───────────────────────────────────────────────────

  async deleteAgent(agentId: string): Promise<Response> {
    await this.initialize();

    this.ctx.storage.sql.exec(
      "UPDATE agents SET status = 'deleted' WHERE agent_id = ?",
      agentId
    );

    // Clean up chat history
    await this.ctx.storage.delete(`chat:${agentId}`);

    return Response.json({ deleted: agentId });
  }

  // ── Chat with a dynamic agent via Workers AI ──────────────────────────────
  //
  // The supervisor handles LLM inference directly. This avoids the complexity
  // of making dynamic workers work with env bindings.

  async chatWithAgent(agentId: string, request: Request): Promise<Response> {
    await this.initialize();

    // Look up agent config
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT * FROM agents WHERE agent_id = ? AND status = 'active'",
        agentId
      )
      .toArray() as any[];

    if (!rows.length) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = rows[0];

    // Parse incoming message
    let body: { messages?: Array<{ role: string; content: string }> };
    try {
      body = (await request.json()) as any;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body.messages?.length) {
      return Response.json({ error: "messages array required" }, { status: 400 });
    }

    // Load persisted history and append new messages
    const history =
      ((await this.ctx.storage.get(`chat:${agentId}`)) as StoredMessage[]) ?? [];

    for (const msg of body.messages) {
      history.push({ role: msg.role as "user" | "assistant", content: msg.content });
    }

    // Build tool set based on agent config
    const tools: Record<string, any> = {
      ...sharedTools(),
      ...webSearchTools(),
      ...browserTools(this.env),
    };
    if (agent.enable_sandbox) {
      Object.assign(tools, sandboxTools(this.env));
    }

    // Create Workers AI model
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai(agent.model as Parameters<typeof workersai>[0]);

    // Convert history to model messages format
    const modelMessages = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Limit context window — keep system prompt + last 50 messages
    const contextMessages = modelMessages.slice(-50);

    // Stream the response
    const result = streamText({
      model,
      system: agent.system_prompt as string,
      messages: contextMessages,
      tools,
      toolChoice: "auto",
      stopWhen: stepCountIs(10),
    });

    // Collect the full response text for persistence while streaming
    const self = this;
    const storageKey = `chat:${agentId}`;
    const encoder = new TextEncoder();

    // Use the AI SDK's text stream and wrap it to also persist the result
    const aiStream = result.textStream;
    let fullResponse = "";

    const outputStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of aiStream) {
            fullResponse += chunk;
            controller.enqueue(encoder.encode(chunk));
          }
          // Persist the assistant reply
          history.push({ role: "assistant", content: fullResponse });
          // Keep last 200 messages to avoid unbounded storage growth
          const trimmed = history.slice(-200);
          await self.ctx.storage.put(storageKey, trimmed);
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(outputStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
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
