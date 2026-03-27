/**
 * OpenAPI 3.1 specification for the AgentOS Public API.
 *
 * Served at GET /v1/openapi.json — auto-discoverable by developer tools.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const openapiRoutes = new Hono<R>();

const spec = {
  openapi: "3.1.0",
  info: {
    title: "AgentOS Public API",
    version: "1.0.0",
    description:
      "Developer-facing API for running AI agents, managing conversations, and integrating AgentOS into your applications.\n\nAuthenticate with an API key: `Authorization: Bearer ak_...`",
    contact: { name: "AgentOS", url: "https://agentos.dev" },
  },
  servers: [
    { url: "https://{org}.agentos.dev/v1", description: "Org subdomain", variables: { org: { default: "demo" } } },
    { url: "https://agentos-control-plane.servesys.workers.dev/v1", description: "Direct (requires API key)" },
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Health check",
        tags: ["System"],
        security: [],
        responses: {
          "200": {
            description: "Service status",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } } },
          },
        },
      },
    },
    "/agents/{name}/run": {
      post: {
        operationId: "runAgent",
        summary: "Run an agent (synchronous)",
        description: "Execute an agent and wait for the full response. For streaming, use `/agents/{name}/run/stream`.",
        tags: ["Agents"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" }, description: "Agent name" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunRequest" },
              example: { input: "What is the weather in San Francisco?", user_id: "user-123" },
            },
          },
        },
        responses: {
          "200": {
            description: "Agent response",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RunResult" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/RateLimited" },
          "500": { $ref: "#/components/responses/ServerError" },
        },
      },
    },
    "/agents/{name}/run/stream": {
      post: {
        operationId: "streamAgent",
        summary: "Run an agent (streaming SSE)",
        description: "Execute an agent with Server-Sent Events streaming. Returns tokens as they are generated.\n\nEvents:\n- `start` — Agent execution started\n- `token` — Token chunk (incremental output)\n- `done` — Execution complete with full result\n- `error` — Error occurred",
        tags: ["Agents"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RunRequest" } } },
        },
        responses: {
          "200": {
            description: "SSE event stream",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
                example: 'event: token\ndata: {"content":"Hello"}\n\nevent: done\ndata: {"output":"Hello! How can I help?","success":true}\n\n',
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },
    "/agents/{name}/conversations": {
      get: {
        operationId: "listConversations",
        summary: "List conversations",
        tags: ["Conversations"],
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "user_id", in: "query", schema: { type: "string" }, description: "Filter by end-user ID" },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "Conversation list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { conversations: { type: "array", items: { $ref: "#/components/schemas/ConversationSummary" } } },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createConversation",
        summary: "Create a conversation",
        description: "Create a new conversation thread. Optionally send the first message immediately.",
        tags: ["Conversations"],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateConversationRequest" },
              example: { title: "Support chat", user_id: "user-123", input: "I need help with billing" },
            },
          },
        },
        responses: {
          "201": {
            description: "Conversation created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationDetail" } } },
          },
        },
      },
    },
    "/agents/{name}/conversations/{id}": {
      get: {
        operationId: "getConversation",
        summary: "Get conversation with messages",
        tags: ["Conversations"],
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "before", in: "query", schema: { type: "string", format: "date-time" }, description: "Pagination cursor" },
        ],
        responses: {
          "200": {
            description: "Conversation with messages",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationDetail" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        operationId: "deleteConversation",
        summary: "Delete a conversation",
        tags: ["Conversations"],
        parameters: [
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "string" } } } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key",
        description: "API key prefixed with `ak_`. Create one in the AgentOS portal under Settings > API Keys.",
      },
    },
    schemas: {
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          service: { type: "string", example: "agentos-public-api" },
          version: { type: "string", example: "1.0.0" },
          org_id: { type: "string" },
          domain: { type: "string" },
          timestamp: { type: "integer" },
        },
      },
      RunRequest: {
        type: "object",
        required: ["input"],
        properties: {
          input: { type: "string", description: "The user message or task for the agent" },
          conversation_id: { type: "string", format: "uuid", description: "Continue an existing conversation thread" },
          user_id: { type: "string", description: "Your end-user's ID for conversation isolation" },
          metadata: { type: "object", additionalProperties: true, description: "Custom metadata attached to this run" },
        },
      },
      RunResult: {
        type: "object",
        properties: {
          output: { type: "string", description: "The agent's response" },
          session_id: { type: "string", description: "AgentOS session ID for tracing" },
          success: { type: "boolean" },
          turns: { type: "integer", description: "Number of LLM turns executed" },
          tool_calls: { type: "integer", description: "Number of tool calls made" },
          cost_usd: { type: "number", description: "Estimated cost in USD" },
          latency_ms: { type: "number", description: "Total execution time in milliseconds" },
          model: { type: "string", description: "LLM model used" },
          conversation_id: { type: "string", nullable: true },
        },
      },
      CreateConversationRequest: {
        type: "object",
        properties: {
          title: { type: "string", description: "Human-readable conversation title" },
          user_id: { type: "string", description: "Your end-user's ID" },
          metadata: { type: "object", additionalProperties: true },
          input: { type: "string", description: "Optional first message — if provided, the agent responds immediately" },
        },
      },
      ConversationSummary: {
        type: "object",
        properties: {
          conversation_id: { type: "string", format: "uuid" },
          agent_name: { type: "string" },
          user_id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["active", "archived"] },
          metadata: { type: "object", additionalProperties: true },
          message_count: { type: "integer" },
          last_message_at: { type: "string", format: "date-time", nullable: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      ConversationDetail: {
        allOf: [
          { $ref: "#/components/schemas/ConversationSummary" },
          {
            type: "object",
            properties: {
              messages: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    role: { type: "string", enum: ["user", "assistant", "system"] },
                    content: { type: "string" },
                    cost_usd: { type: "number" },
                    model: { type: "string" },
                    created_at: { type: "string", format: "date-time" },
                  },
                },
              },
              output: { type: "string", description: "Last assistant response (only when created with initial input)" },
              session_id: { type: "string" },
            },
          },
        ],
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
    responses: {
      BadRequest: { description: "Bad request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      Unauthorized: { description: "Missing or invalid API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      Forbidden: { description: "API key not authorized for this resource", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      NotFound: { description: "Resource not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      RateLimited: {
        description: "Rate limit exceeded. Check `Retry-After` header.",
        headers: {
          "Retry-After": { schema: { type: "integer" }, description: "Seconds until rate limit resets" },
          "X-RateLimit-Limit": { schema: { type: "integer" }, description: "Requests allowed per minute" },
          "X-RateLimit-Remaining": { schema: { type: "integer" }, description: "Requests remaining in window" },
        },
        content: {
          "application/json": {
            schema: { type: "object", properties: { error: { type: "string" }, limit: { type: "string" }, retry_after_seconds: { type: "integer" } } },
          },
        },
      },
      ServerError: { description: "Internal server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  },
  "x-webhooks": {
    "agent.run.completed": {
      post: {
        summary: "Agent run completed",
        description: "Sent when an agent run completes via the public API. Configure webhook URLs in the AgentOS portal under Settings > Webhooks.\n\nThe payload is signed with HMAC-SHA256. Verify using the `X-AgentOS-Signature` header:\n```\nsignature = HMAC-SHA256(webhook_secret, \"${X-AgentOS-Timestamp}.${body}\")\n```",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  event: { type: "string", example: "agent.run.completed" },
                  timestamp: { type: "string", format: "date-time" },
                  data: { $ref: "#/components/schemas/RunResult" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Acknowledge receipt" } },
      },
    },
  },
  tags: [
    { name: "System", description: "Health and status endpoints" },
    { name: "Agents", description: "Execute AI agents" },
    { name: "Conversations", description: "Multi-turn conversation threads" },
  ],
};

openapiRoutes.get("/openapi.json", (c) => {
  return c.json(spec);
});

openapiRoutes.get("/docs", (c) => {
  // Serve a minimal Scalar API reference UI
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>AgentOS API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/v1/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
  return c.html(html);
});
