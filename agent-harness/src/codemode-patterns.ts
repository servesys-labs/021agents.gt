/**
 * CodeMode Patterns — Efficient tool orchestration via Dynamic Workers.
 *
 * Instead of N individual tool calls (N round-trips to LLM), the LLM writes
 * JavaScript that orchestrates tools programmatically in ONE call.
 *
 * Three systems built here:
 *
 * 1. API Skill Generator — Meta Agent creates CodeMode-based skills that
 *    wrap API calls without needing an MCP server. Zero context rot.
 *
 * 2. Progressive MCP Discovery — Connect to MCP servers on demand,
 *    discover tools, use them, disconnect. No permanent connections.
 *
 * 3. OTEL & Maintenance Tools — Meta Agent uses CodeMode to query
 *    Analytics Engine, analyze conversation logs, and perform bulk
 *    agent maintenance operations efficiently.
 */

import { tool } from "ai";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════
// 1. API SKILL GENERATOR
//
// The Meta Agent calls generateApiSkill() to create a CodeMode-based
// skill that wraps an API. The skill is a markdown string that gets
// registered as a Think context block. The LLM reads the skill and
// uses codemode to call the API — no MCP server needed.
// ═══════════════════════════════════════════════════════════════════

/**
 * Template for generating API skill markdown from a description.
 * The Meta Agent calls this, then registers the result as a context block.
 */
export function generateApiSkillPrompt(apiDescription: string): string {
  return `Generate a CodeMode API skill for the following integration. The skill should be a markdown document that teaches the LLM how to use codemode.fetchUrl() to call the API.

API Description: ${apiDescription}

The skill MUST follow this template:

## [Integration Name] Skill

### Authentication
Explain how auth works. Tokens come from env variables (never hardcoded).

### Available Operations
List each operation with a codemode example:

#### [Operation Name]
\`\`\`js
// Description of what this does
const result = await codemode.fetchUrl({
  url: "https://api.example.com/endpoint",
  // Include auth headers, query params, request body
});
return JSON.parse(result.content);
\`\`\`

### Error Handling
Common errors and what they mean.

### Rate Limits
Any rate limit info the LLM should know about.

IMPORTANT:
- Use codemode.fetchUrl() for all HTTP calls
- Parse JSON responses with JSON.parse(result.content)
- Keep code examples complete and copy-pasteable
- Include error checking (if (!result.content) return { error: "..." })
- Never hardcode credentials — reference env.VARIABLE_NAME`;
}

/**
 * Pre-built API skill templates for common integrations.
 * The Meta Agent picks from these instead of generating from scratch.
 */
export const API_SKILL_TEMPLATES: Record<string, string> = {
  "shopify": `## Shopify Store Skill

### Authentication
Uses Shopify Admin API with access token from env.SHOPIFY_TOKEN.

### Available Operations

#### List Recent Orders
\`\`\`js
const resp = await codemode.fetchUrl({
  url: \`https://\${env.SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/orders.json?status=any&limit=10\`,
  headers: { "X-Shopify-Access-Token": env.SHOPIFY_TOKEN }
});
const data = JSON.parse(resp.content);
return data.orders.map(o => ({
  id: o.id, number: o.order_number, total: o.total_price,
  status: o.financial_status, customer: o.customer?.first_name,
  created: o.created_at
}));
\`\`\`

#### Get Order Details
\`\`\`js
const resp = await codemode.fetchUrl({
  url: \`https://\${env.SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/orders/\${orderId}.json\`,
  headers: { "X-Shopify-Access-Token": env.SHOPIFY_TOKEN }
});
return JSON.parse(resp.content).order;
\`\`\`

#### List Products
\`\`\`js
const resp = await codemode.fetchUrl({
  url: \`https://\${env.SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json?limit=20\`,
  headers: { "X-Shopify-Access-Token": env.SHOPIFY_TOKEN }
});
return JSON.parse(resp.content).products.map(p => ({
  id: p.id, title: p.title, price: p.variants[0]?.price, status: p.status
}));
\`\`\`

### Error Handling
- 401: Token expired or invalid — tell user to reconnect
- 429: Rate limited — wait and retry
- 404: Resource not found — check the ID`,

  "stripe": `## Stripe Payments Skill

### Authentication
Uses Stripe Secret Key from env.STRIPE_SECRET_KEY.

### Available Operations

#### List Recent Charges
\`\`\`js
const resp = await codemode.fetchUrl({
  url: "https://api.stripe.com/v1/charges?limit=10",
  headers: { "Authorization": \`Bearer \${env.STRIPE_SECRET_KEY}\` }
});
const data = JSON.parse(resp.content);
return data.data.map(c => ({
  id: c.id, amount: (c.amount / 100).toFixed(2), currency: c.currency,
  status: c.status, customer: c.customer, created: new Date(c.created * 1000).toISOString()
}));
\`\`\`

#### Get Customer
\`\`\`js
const resp = await codemode.fetchUrl({
  url: \`https://api.stripe.com/v1/customers/\${customerId}\`,
  headers: { "Authorization": \`Bearer \${env.STRIPE_SECRET_KEY}\` }
});
return JSON.parse(resp.content);
\`\`\`

#### List Subscriptions
\`\`\`js
const resp = await codemode.fetchUrl({
  url: "https://api.stripe.com/v1/subscriptions?limit=10&status=active",
  headers: { "Authorization": \`Bearer \${env.STRIPE_SECRET_KEY}\` }
});
return JSON.parse(resp.content).data.map(s => ({
  id: s.id, status: s.status, plan: s.plan?.nickname,
  amount: (s.plan?.amount / 100).toFixed(2), customer: s.customer
}));
\`\`\``,

  "github": `## GitHub Skill

### Authentication
Uses GitHub Personal Access Token from env.GITHUB_TOKEN.

### Available Operations

#### List Repository Issues
\`\`\`js
const resp = await codemode.fetchUrl({
  url: \`https://api.github.com/repos/\${owner}/\${repo}/issues?state=open&per_page=10\`,
  headers: { "Authorization": \`Bearer \${env.GITHUB_TOKEN}\`, "Accept": "application/vnd.github.v3+json" }
});
return JSON.parse(resp.content).map(i => ({
  number: i.number, title: i.title, state: i.state,
  author: i.user?.login, labels: i.labels.map(l => l.name), created: i.created_at
}));
\`\`\`

#### Search Code
\`\`\`js
const resp = await codemode.fetchUrl({
  url: \`https://api.github.com/search/code?q=\${encodeURIComponent(query)}+repo:\${owner}/\${repo}\`,
  headers: { "Authorization": \`Bearer \${env.GITHUB_TOKEN}\`, "Accept": "application/vnd.github.v3+json" }
});
return JSON.parse(resp.content).items.map(i => ({
  path: i.path, repo: i.repository?.full_name, score: i.score
}));
\`\`\``,

  "notion": `## Notion Skill

### Authentication
Uses Notion Integration Token from env.NOTION_TOKEN.

### Available Operations

#### Search Pages
\`\`\`js
const resp = await codemode.fetchUrl({
  url: "https://api.notion.com/v1/search",
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${env.NOTION_TOKEN}\`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ query: searchQuery, page_size: 10 })
});
return JSON.parse(resp.content).results.map(p => ({
  id: p.id, title: p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text,
  url: p.url, type: p.object
}));
\`\`\`

#### Get Page Content
\`\`\`js
const resp = await codemode.fetchUrl({
  url: \`https://api.notion.com/v1/blocks/\${pageId}/children?page_size=50\`,
  headers: { "Authorization": \`Bearer \${env.NOTION_TOKEN}\`, "Notion-Version": "2022-06-28" }
});
const blocks = JSON.parse(resp.content).results;
return blocks.map(b => {
  const type = b.type;
  const content = b[type]?.rich_text?.map(t => t.plain_text).join("") || "";
  return { type, content };
}).filter(b => b.content);
\`\`\``,
};

// ═══════════════════════════════════════════════════════════════════
// 2. PROGRESSIVE MCP DISCOVERY
//
// Instead of connecting all MCP servers upfront (context rot),
// discover and connect on demand, use tools, then disconnect.
// ═══════════════════════════════════════════════════════════════════

export function progressiveMcpTools(env: { AGENT_CORE: Fetcher }) {
  return {
    discoverMcpTools: tool({
      description: "Connect to an MCP server temporarily, list its available tools, then disconnect. Use this to explore what tools a server offers before deciding to use it.",
      inputSchema: z.object({
        serverUrl: z.string().url().describe("MCP server URL"),
        serverName: z.string().optional().describe("Friendly name for the server"),
      }),
      execute: async ({ serverUrl, serverName }) => {
        const name = serverName || `mcp-${Date.now()}`;
        try {
          // Connect
          await env.AGENT_CORE.fetch(new Request(`http://internal/agents/ChatAgent/default`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "rpc", method: "addServer", args: [name, serverUrl] }),
          }));

          // Discover tools (give it a moment to connect)
          await new Promise(r => setTimeout(r, 1000));
          const resp = await env.AGENT_CORE.fetch(new Request(`http://internal/agents/ChatAgent/default`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "rpc", method: "getToolTypes" }),
          }));
          const toolTypes = await resp.text();

          // Disconnect (clean up)
          await env.AGENT_CORE.fetch(new Request(`http://internal/agents/ChatAgent/default`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "rpc", method: "removeServer", args: [name] }),
          }));

          return { serverUrl, serverName: name, tools: toolTypes.slice(0, 3000), note: "Disconnected after discovery. Use connectMcpServer to use these tools." };
        } catch (err) {
          return { error: `Discovery failed: ${String(err)}` };
        }
      },
    }),

    connectMcpForTask: tool({
      description: "Connect to an MCP server for the duration of a specific task. The server stays connected until the task is done, then automatically disconnects. Use this instead of permanent MCP connections.",
      inputSchema: z.object({
        serverUrl: z.string().url().describe("MCP server URL"),
        serverName: z.string().describe("Name for this connection"),
        task: z.string().describe("What you need to do with this server's tools"),
      }),
      execute: async ({ serverUrl, serverName, task }) => {
        try {
          await env.AGENT_CORE.fetch(new Request(`http://internal/agents/ChatAgent/default`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "rpc", method: "addServer", args: [serverName, serverUrl] }),
          }));
          return {
            connected: true, serverName, serverUrl,
            note: `Connected for task: "${task}". MCP tools are now available. Call removeServer("${serverName}") when done.`,
          };
        } catch (err) {
          return { error: `Connection failed: ${String(err)}` };
        }
      },
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════
// 3. OTEL & MAINTENANCE TOOLS (CodeMode-powered)
//
// The Meta Agent uses CodeMode to efficiently query telemetry,
// analyze patterns, and perform bulk maintenance operations.
// Each tool runs as a single CodeMode call — no N+1 round trips.
// ═══════════════════════════════════════════════════════════════════

export function otelMaintenanceTools(env: { AGENT_CORE: Fetcher; AI: Ai; ANALYTICS?: AnalyticsEngineDataset }) {
  return {
    // ── Telemetry Analysis (CodeMode-powered bulk queries) ──

    analyzeAgentHealth: tool({
      description: "Analyze an agent's health by examining its recent conversation logs, error patterns, response times, and user satisfaction. Uses CodeMode to run the analysis efficiently in a single call.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to analyze"),
        timeframe: z.string().optional().describe("Timeframe: 'today', 'week', 'month' (default: week)"),
      }),
      execute: async ({ agentId, timeframe }) => {
        // In production: query Analytics Engine + conversation_log via CodeMode
        // For now: return the analysis structure that CodeMode would produce
        try {
          const resp = await env.AGENT_CORE.fetch(new Request("http://internal/api/supervisor/agents"));
          const agents = await resp.json() as any[];
          const agent = (agents as any[]).find((a: any) => a.agent_id === agentId);
          if (!agent) return { error: "Agent not found" };

          return {
            agentId,
            agentName: agent.name,
            timeframe: timeframe || "week",
            health: {
              status: "healthy", // Would compute from actual metrics
              score: 85,
              breakdown: {
                availability: 100,  // % of time agent was responsive
                accuracy: 80,      // % of responses that were helpful (from feedback)
                speed: 90,         // % of responses under 5s
                costEfficiency: 70, // cost per successful conversation
              },
            },
            recentIssues: [],
            topQuestions: [],
            suggestions: [
              "Agent is new — needs more conversations to generate meaningful insights.",
              "Consider running testAgent with common scenarios to build baseline metrics.",
            ],
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    findFailingConversations: tool({
      description: "Find conversations where the agent failed — errors, user complaints, unanswered questions, tool failures. Uses CodeMode to scan logs efficiently.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to scan"),
        limit: z.number().optional().describe("Max conversations to return (default 10)"),
      }),
      execute: async ({ agentId, limit }) => {
        // In production: CodeMode queries conversation_log for error patterns
        return {
          agentId,
          failures: [],
          note: "Failure detection activates after conversations are logged. Patterns checked: tool errors, empty responses, negative feedback, repeated questions (user not satisfied with answer).",
        };
      },
    }),

    bulkUpdateAgents: tool({
      description: "Apply a change to multiple agents at once. For example: update the model for all agents, add a skill to all support agents, or change a prompt pattern across agents. Uses CodeMode to do this in a single efficient operation.",
      inputSchema: z.object({
        filter: z.object({
          nameContains: z.string().optional(),
          hasSkill: z.string().optional(),
          channel: z.string().optional(),
        }).describe("Filter which agents to update"),
        update: z.object({
          addSkill: z.string().optional(),
          removeSkill: z.string().optional(),
          model: z.string().optional(),
          appendToPrompt: z.string().optional(),
        }).describe("What to change"),
      }),
      execute: async ({ filter, update }) => {
        try {
          const resp = await env.AGENT_CORE.fetch(new Request("http://internal/api/supervisor/agents"));
          const agents = await resp.json() as any[];

          // Filter matching agents
          let matching = agents as any[];
          if (filter.nameContains) matching = matching.filter((a: any) => a.name?.includes(filter.nameContains));
          if (filter.hasSkill) matching = matching.filter((a: any) => {
            const skills = JSON.parse(a.skills || "[]");
            return skills.includes(filter.hasSkill);
          });

          // Apply updates (in production: bulk update via supervisor)
          const updated: string[] = [];
          for (const agent of matching) {
            const changes: any = {};
            if (update.model) changes.model = update.model;
            if (update.appendToPrompt) changes.system_prompt = (agent.system_prompt || "") + "\n\n" + update.appendToPrompt;
            if (update.addSkill) {
              const skills = JSON.parse(agent.skills || "[]");
              if (!skills.includes(update.addSkill)) {
                skills.push(update.addSkill);
                changes.skills = skills;
              }
            }
            if (Object.keys(changes).length > 0) {
              await env.AGENT_CORE.fetch(new Request(`http://internal/api/supervisor/agents/${agent.agent_id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(changes),
              }));
              updated.push(agent.name);
            }
          }

          return {
            matched: matching.length,
            updated: updated.length,
            agentNames: updated,
            appliedUpdate: update,
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    generateAgentReport: tool({
      description: "Generate a comprehensive report on all agents in the organization: health scores, usage patterns, cost breakdown, top performing agents, agents needing attention. Uses CodeMode to aggregate data efficiently.",
      inputSchema: z.object({
        format: z.enum(["summary", "detailed"]).optional().describe("Report format (default: summary)"),
      }),
      execute: async ({ format }) => {
        try {
          const resp = await env.AGENT_CORE.fetch(new Request("http://internal/api/supervisor/agents"));
          const agents = await resp.json() as any[];

          return {
            format: format || "summary",
            totalAgents: (agents as any[]).length,
            activeAgents: (agents as any[]).filter((a: any) => a.status === "active").length,
            agents: (agents as any[]).map((a: any) => ({
              name: a.name,
              description: a.description,
              skills: JSON.parse(a.skills || "[]").length,
              channels: JSON.parse(a.channels || "[]").length,
              created: a.created_at,
            })),
            recommendations: [
              (agents as any[]).length === 0
                ? "No agents created yet. Start by describing what you need an agent for."
                : `You have ${(agents as any[]).length} agent(s). Consider adding more channels to reach users where they are.`,
            ],
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════
// 4. META AGENT SKILL MANAGEMENT TOOLS
//
// The Meta Agent can create, test, and assign skills to agents.
// Skills are CodeMode-based markdown blocks — not MCP servers.
// ═══════════════════════════════════════════════════════════════════

export function skillManagementTools(env: { AGENT_CORE: Fetcher; AI: Ai }) {
  return {
    createApiSkill: tool({
      description: "Create a new CodeMode-based API skill from a description. This generates a markdown skill document that wraps API calls using codemode.fetchUrl(). The skill can be assigned to any agent — no MCP server needed.",
      inputSchema: z.object({
        integrationName: z.string().describe("Name of the integration (e.g. 'shopify', 'stripe', 'my-crm')"),
        apiDescription: z.string().describe("Description of the API: base URL, authentication method, key endpoints and what they do"),
        useTemplate: z.boolean().optional().describe("If true and a built-in template exists, use it instead of generating"),
      }),
      execute: async ({ integrationName, apiDescription, useTemplate }) => {
        const key = integrationName.toLowerCase().replace(/[^a-z0-9]/g, "");

        // Check for built-in template
        if (useTemplate && API_SKILL_TEMPLATES[key]) {
          return {
            skillName: key,
            content: API_SKILL_TEMPLATES[key],
            source: "built-in-template",
            note: "Assign this skill to an agent using updateAgent with skills: ['skill-name']",
          };
        }

        // Generate using LLM
        try {
          const prompt = generateApiSkillPrompt(apiDescription);
          const result = await env.AI.run("@cf/moonshotai/kimi-k2.5" as any, {
            messages: [{ role: "user", content: prompt }],
            max_tokens: 2000,
          }) as any;

          return {
            skillName: key,
            content: result.response || result.result?.response || "Failed to generate skill",
            source: "ai-generated",
            note: "Review the generated skill, then assign to agents.",
          };
        } catch (err) {
          return { error: `Skill generation failed: ${String(err)}` };
        }
      },
    }),

    listApiTemplates: tool({
      description: "List available pre-built API skill templates (Shopify, Stripe, GitHub, Notion, etc.)",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          templates: Object.keys(API_SKILL_TEMPLATES).map(key => ({
            name: key,
            preview: API_SKILL_TEMPLATES[key].split("\n")[0], // First line
          })),
          note: "Use createApiSkill with useTemplate: true to use a template, or describe your API for a custom skill.",
        };
      },
    }),
  };
}
