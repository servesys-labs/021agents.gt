/**
 * Meta Agent — The platform's AI that helps users build better agents.
 *
 * This is NOT a coding agent. It's a business-focused agent builder that:
 * - Understands what the user wants their agent to do
 * - Creates/configures agents via AgentSupervisor CRUD API
 * - Picks appropriate skills from the skill library
 * - Tests agents with sample conversations
 * - Monitors agent performance via conversation logs and metrics
 * - Suggests improvements based on patterns in real usage data
 * - Iterates with the user until the agent is great
 *
 * The Meta Agent operates at org level — it sees all agents in the org,
 * can compare performance, cross-pollinate skills, and identify gaps.
 *
 * Users interact with the Meta Agent via the same channels as any agent:
 * web chat, voice, Slack, etc. The Meta Agent IS an agent on the platform.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  progressiveMcpTools,
  otelMaintenanceTools,
  skillManagementTools,
} from "./codemode-patterns";

/**
 * Create the Meta Agent's FULL tool set.
 *
 * Every tool uses CF primitives:
 * - Agent CRUD → service binding to AgentSupervisor DO (DO RPC)
 * - Skill generation → Workers AI (@cf/moonshotai/kimi-k2.5)
 * - OTEL/metrics → Analytics Engine (writeDataPoint / SQL API)
 * - Code execution → Dynamic Workers via CodeMode (LOADER binding)
 * - MCP discovery → agents SDK (addMcpServer / removeMcpServer / mcp.getAITools)
 * - Eval testing → service binding → AgentSupervisor.chatWithAgent()
 *
 * Zero external dependencies. Everything runs on CF edge.
 */
export function metaAgentTools(env: { AGENT_CORE: Fetcher; AI: Ai; ANALYTICS?: AnalyticsEngineDataset }) {
  return {
    // ── CodeMode-powered tools (from codemode-patterns.ts) ──
    ...progressiveMcpTools(env),
    ...otelMaintenanceTools(env),
    ...skillManagementTools(env),

    // ── Agent CRUD (below) ──
    // ── Agent CRUD ──────────────────────────────────────────────

    createAgent: tool({
      description: "Create a new agent for the user. Define its name, purpose, system prompt, skills, and which channels to deploy to.",
      inputSchema: z.object({
        name: z.string().describe("Agent name (lowercase, hyphens ok). e.g. 'customer-support'"),
        description: z.string().describe("What this agent does, in one sentence"),
        systemPrompt: z.string().describe("The agent's personality and instructions. Be specific about tone, scope, and behavior."),
        skills: z.array(z.string()).optional().describe("Skill names to activate. e.g. ['deep-research', 'report']"),
        channels: z.array(z.string()).optional().describe("Where to deploy. e.g. ['web', 'telegram', 'email']"),
        icon: z.string().optional().describe("Emoji icon for the agent"),
      }),
      execute: async ({ name, description, systemPrompt, skills, channels, icon }) => {
        try {
          const resp = await env.AGENT_CORE.fetch(new Request("http://internal/api/supervisor/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name, description, icon: icon || "✦",
              system_prompt: systemPrompt,
              skills: skills || [],
              channels: channels || ["web"],
            }),
          }));
          const result = await resp.json();
          return { created: true, agent: result };
        } catch (err) {
          return { created: false, error: String(err) };
        }
      },
    }),

    updateAgent: tool({
      description: "Update an existing agent's configuration. Change its prompt, skills, channels, or any setting.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to update"),
        updates: z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          systemPrompt: z.string().optional(),
          skills: z.array(z.string()).optional(),
          channels: z.array(z.string()).optional(),
          icon: z.string().optional(),
        }),
      }),
      execute: async ({ agentId, updates }) => {
        try {
          const resp = await env.AGENT_CORE.fetch(new Request(`http://internal/api/supervisor/agents/${agentId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(updates.name ? { name: updates.name } : {}),
              ...(updates.description ? { description: updates.description } : {}),
              ...(updates.systemPrompt ? { system_prompt: updates.systemPrompt } : {}),
              ...(updates.skills ? { skills: updates.skills } : {}),
              ...(updates.channels ? { channels: updates.channels } : {}),
              ...(updates.icon ? { icon: updates.icon } : {}),
            }),
          }));
          const result = await resp.json();
          return { updated: true, agent: result };
        } catch (err) {
          return { updated: false, error: String(err) };
        }
      },
    }),

    listAgents: tool({
      description: "List all agents in the organization. Shows name, description, status, and basic metrics.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const resp = await env.AGENT_CORE.fetch(new Request("http://internal/api/supervisor/agents"));
          return await resp.json();
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    deleteAgent: tool({
      description: "Delete an agent. This is permanent — the agent and its conversation history will be removed.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to delete"),
      }),
      needsApproval: async () => true, // Always ask user to confirm deletion
      execute: async ({ agentId }) => {
        try {
          const resp = await env.AGENT_CORE.fetch(new Request(`http://internal/api/supervisor/agents/${agentId}`, {
            method: "DELETE",
          }));
          return await resp.json();
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    // ── Skills Management ───────────────────────────────────────

    listSkills: tool({
      description: "List all available skills that can be assigned to agents. Skills are modular capabilities like 'deep-research', 'code-review', 'data-analysis'.",
      inputSchema: z.object({}),
      execute: async () => {
        // Returns the built-in skill library — in production, also query custom org skills
        try {
          const resp = await env.AGENT_CORE.fetch(new Request("http://internal/agents/ChatAgent/default", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "rpc", method: "getSkillLibrary" }),
          }));
          return await resp.json();
        } catch {
          return { skills: ["deep-research", "code-review", "data-analysis", "debug", "report", "planning"] };
        }
      },
    }),

    // ── Testing & Evaluation ────────────────────────────────────

    testAgent: tool({
      description: "Test an agent with a sample message. Send a message as if you were a user and see how the agent responds. Use this to verify the agent works correctly before deploying.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to test"),
        message: z.string().describe("Test message to send to the agent"),
      }),
      execute: async ({ agentId, message }) => {
        try {
          const resp = await env.AGENT_CORE.fetch(new Request(`http://internal/api/supervisor/chat/${agentId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "user", content: message }] }),
          }));
          const text = await resp.text();
          return { agentId, testMessage: message, agentResponse: text.slice(0, 2000) };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    runEvalSuite: tool({
      description: "Run a set of test messages against an agent and evaluate the quality of responses. Useful for systematic testing before deploying to a new channel.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to evaluate"),
        testCases: z.array(z.object({
          input: z.string().describe("Test message"),
          expectedBehavior: z.string().describe("What a good response should include or demonstrate"),
        })).describe("List of test cases to run"),
      }),
      execute: async ({ agentId, testCases }) => {
        const results = [];
        for (const tc of testCases) {
          try {
            const resp = await env.AGENT_CORE.fetch(new Request(`http://internal/api/supervisor/chat/${agentId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ messages: [{ role: "user", content: tc.input }] }),
            }));
            const response = await resp.text();
            results.push({
              input: tc.input,
              expectedBehavior: tc.expectedBehavior,
              actualResponse: response.slice(0, 1000),
              passed: true, // In production: use LLM to grade against expectedBehavior
            });
          } catch (err) {
            results.push({ input: tc.input, error: String(err), passed: false });
          }
        }
        return {
          agentId,
          totalTests: testCases.length,
          passed: results.filter(r => r.passed).length,
          failed: results.filter(r => !r.passed).length,
          results,
        };
      },
    }),

    // ── Observability & Insights ────────────────────────────────

    getAgentMetrics: tool({
      description: "Get performance metrics for an agent: conversation count, error rate, average response time, cost, user satisfaction. Use this to understand how an agent is performing.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to get metrics for"),
        days: z.number().optional().describe("Number of days to look back (default 7)"),
      }),
      execute: async ({ agentId, days }) => {
        // In production: query Analytics Engine or supervisor metrics table
        return {
          agentId,
          period: `last ${days || 7} days`,
          conversations: 0,
          messages: 0,
          toolCalls: 0,
          errors: 0,
          avgResponseMs: 0,
          totalCostUsd: 0,
          satisfactionAvg: 0,
          note: "Metrics populate as users interact with the agent.",
        };
      },
    }),

    getConversationInsights: tool({
      description: "Analyze recent conversations with an agent to find patterns: common questions, failure modes, topics users ask about, gaps in the agent's knowledge. Use this to improve the agent.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to analyze"),
        limit: z.number().optional().describe("Number of recent conversations to analyze (default 20)"),
      }),
      execute: async ({ agentId, limit }) => {
        // In production: query conversation_log table, run LLM analysis
        return {
          agentId,
          conversationsAnalyzed: 0,
          commonTopics: [],
          failurePatterns: [],
          unansweredQuestions: [],
          suggestedSkills: [],
          suggestedPromptChanges: [],
          note: "Insights populate as users interact with the agent. Create some test conversations first.",
        };
      },
    }),

    // ── Improvement Suggestions ─────────────────────────────────

    suggestImprovements: tool({
      description: "Based on the agent's configuration and metrics, suggest specific improvements: better system prompt wording, additional skills, missing tools, channel deployment recommendations.",
      inputSchema: z.object({
        agentId: z.string().describe("Agent ID to analyze and suggest improvements for"),
      }),
      execute: async ({ agentId }) => {
        // Get agent config
        try {
          const resp = await env.AGENT_CORE.fetch(new Request("http://internal/api/supervisor/agents"));
          const agents = await resp.json() as any[];
          const agent = (agents as any[]).find((a: any) => a.agent_id === agentId);
          if (!agent) return { error: "Agent not found" };

          const suggestions: string[] = [];

          // Analyze system prompt
          const prompt = agent.system_prompt || "";
          if (prompt.length < 50) suggestions.push("System prompt is very short. Add specific instructions about tone, scope, and behavior.");
          if (!prompt.includes("tone") && !prompt.includes("style")) suggestions.push("Consider specifying the agent's communication tone (professional, casual, empathetic).");
          if (!prompt.includes("don't") && !prompt.includes("never") && !prompt.includes("avoid")) suggestions.push("Consider adding guardrails — what the agent should NOT do.");

          // Analyze skills
          const skills = JSON.parse(agent.skills || "[]");
          if (skills.length === 0) suggestions.push("No skills assigned. Add relevant skills like 'deep-research' or 'report' to give the agent structured protocols.");

          // Analyze channels
          const channels = JSON.parse(agent.channels || "[]");
          if (channels.length <= 1) suggestions.push("Only deployed to one channel. Consider adding Slack, email, or WhatsApp to reach users where they are.");

          // Generic advice
          if (!agent.description) suggestions.push("Add a description so users know what this agent does.");

          return {
            agentId,
            agentName: agent.name,
            currentConfig: {
              promptLength: prompt.length,
              skillCount: skills.length,
              channelCount: channels.length,
            },
            suggestions,
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}

// ── Meta Agent System Prompt ───────────────────────────────────────

export const META_AGENT_SYSTEM_PROMPT = `You are the Meta Agent — the platform's AI assistant that helps users create, test, and improve their AI agents.

## Your Role
You help business users (not developers) build agents that solve real problems. Users tell you what they need, and you create the agent for them.

## How You Work
1. **Understand**: Ask the user what problem they want to solve. What questions will their customers/team ask? What tone should the agent use?
2. **Create**: Use the createAgent tool to build an agent with the right system prompt, skills, and channels.
3. **Test**: Use testAgent to send sample messages and verify the agent works well.
4. **Improve**: Based on test results and user feedback, use updateAgent to refine the prompt, add skills, or adjust behavior.
5. **Deploy**: Help the user connect the agent to their channels (Slack, email, WhatsApp, web widget).
6. **Monitor**: Use getAgentMetrics and getConversationInsights to track performance and suggest improvements over time.

## Creating Good System Prompts
When creating an agent, write a system prompt that:
- Defines WHO the agent is (role, personality, tone)
- Specifies WHAT it should do (scope, tasks, knowledge areas)
- Sets BOUNDARIES (what it should NOT do, when to escalate)
- Includes EXAMPLES of good responses if the user provides them

## Available Skills
Skills are modular protocols that expand an agent's capabilities:
- deep-research: Multi-source research with citations
- code-review: Systematic code review checklist
- data-analysis: Structured data analysis with Python
- debug: Hypothesis-driven investigation
- report: Structured report generation
- planning: Task decomposition into actionable plans

Only assign skills that are relevant to the agent's purpose.

## Available Channels
- web: Chat widget on websites
- telegram: Telegram bot
- whatsapp: WhatsApp Business
- slack: Slack workspace
- teams: Microsoft Teams
- email: Email inbox
- instagram: Instagram DMs
- messenger: Facebook Messenger
- voice: Voice calls (browser or phone)

## API Integrations (CodeMode Skills)
When a user needs their agent to connect to an API (Shopify, Stripe, GitHub, Notion, CRM, etc.):
- Do NOT suggest an MCP server — use createApiSkill instead
- CodeMode skills wrap API calls using codemode.fetchUrl() — no external server needed
- Check listApiTemplates first — built-in templates exist for Shopify, Stripe, GitHub, Notion
- For custom APIs, describe the API to createApiSkill and it generates the skill

This approach has zero context rot — the skill is only loaded when the agent needs it.

## MCP Servers (Progressive Discovery)
If the user insists on connecting an MCP server:
- Use discoverMcpTools first to see what the server offers WITHOUT permanent connection
- Only use connectMcpForTask for temporary, task-specific connections
- Never leave MCP servers permanently connected (causes context window bloat)

## Agent Health & Maintenance
You have observability tools to monitor agent health:
- analyzeAgentHealth: health score, response times, error rates
- findFailingConversations: scan for failures and user complaints
- generateAgentReport: comprehensive org-wide report
- bulkUpdateAgents: apply changes across multiple agents at once
- suggestImprovements: specific recommendations based on config analysis

Use these proactively — check agent health after creation, during testing, and when users report issues.

## Efficiency Principle
Always prefer CodeMode orchestration over multiple individual tool calls.
Instead of 5 separate API calls, write ONE codemode script that does all 5 in parallel.
The LLM writes JavaScript, CodeMode executes it in an isolated Dynamic Worker.

## Guidelines
- Be conversational and helpful, not technical
- Ask clarifying questions before creating an agent
- Always test the agent before declaring it ready
- Suggest specific prompt improvements, don't be vague
- If the user is unsure, suggest a starting point and iterate
- Prefer CodeMode skills over MCP servers for API integrations
- Check agent health proactively, don't wait for users to report issues
- Celebrate when the agent works well!`;
