/**
 * A2A (Agent-to-Agent) protocol routes — HTTP endpoints for agent interoperability.
 *
 * Ported from agentos/a2a/server.py
 *
 * Routes:
 *   GET  /.well-known/agent.json      — Agent card endpoint (discovery)
 *   POST /a2a/tasks/send              — Send task to agent (non-streaming)
 *   POST /a2a/tasks/sendSubscribe     — Send task with streaming (SSE)
 *   GET  /a2a/tasks/:id               — Get task status
 *   POST /a2a/tasks/:id/cancel        — Cancel task
 *
 * See: https://a2a-protocol.org/latest/specification/
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { buildAgentCard, agentCardToJSON } from "../lib/a2a/card";
import { parseAgentConfigJson } from "../schemas/common";

type R = { Bindings: Env; Variables: { user: CurrentUser } };

// In-memory task storage (per-worker, for production consider using Durable Objects or DB)
const taskStore = new Map<string, A2ATask>();

/** A2A Task definition. */
interface A2ATask {
  id: string;
  status: {
    state: "WORKING" | "COMPLETED" | "FAILED" | "CANCELED";
    timestamp: string;
  };
  messages: A2AMessage[];
  artifacts: Array<{
    id: string;
    name?: string;
    parts: A2AMessage["parts"];
  }>;
  createdAt: string;
  agentName?: string;
}

/** A2A Message definition. */
interface A2AMessage {
  id: string;
  role: "user" | "agent";
  parts: Array<{ text: string } | { type: string; data?: unknown }>;
  timestamp: string;
}

/** JSON-RPC request structure. */
interface JSONRPCRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Build JSON-RPC success response. */
function jsonrpcResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

/** Build JSON-RPC error response. */
function jsonrpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Create a new task record. */
function makeTask(
  taskId: string,
  status: A2ATask["status"]["state"] = "WORKING",
  messages: A2AMessage[] = [],
  artifacts: A2ATask["artifacts"] = [],
): A2ATask {
  const now = new Date().toISOString();
  return {
    id: taskId,
    status: { state: status, timestamp: now },
    messages,
    artifacts,
    createdAt: now,
  };
}

/** Extract text content from message parts. */
function extractText(parts: A2AMessage["parts"]): string {
  return parts
    .filter((p): p is { text: string } => "text" in p && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/** Generate a short unique ID. */
function generateId(): string {
  return crypto.randomUUID().slice(0, 16);
}

export const a2aRoutes = new Hono<R>();

// ─────────────────────────────────────────────────────────────────────────────
// Agent Card Discovery Endpoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /.well-known/agent.json
 * Serves the A2A Agent Card for discovery by other agents.
 */
a2aRoutes.get("/.well-known/agent.json", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  // Get the first active agent for this org
  const rows = await sql`
    SELECT name, description, config_json
    FROM agents
    WHERE org_id = ${user.org_id} AND is_active = true
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: "No agents available" }, 404);
  }

  const row = rows[0] as { name: string; description: string; config_json: unknown };
  const config = parseAgentConfigJson(row.config_json);

  const baseUrl = new URL(c.req.url).origin;
  const agentConfig = {
    name: row.name,
    agent_id: (config.agent_id as string) || row.name,
    description: row.description || (config.description as string) || "",
    version: (config.version as string) || "0.1.0",
    tools: Array.isArray(config.tools) ? config.tools : [],
    tags: Array.isArray(config.tags) ? config.tags : [],
  };

  const card = buildAgentCard(agentConfig, baseUrl);
  return c.json(agentCardToJSON(card));
});

/**
 * GET /.well-known/agents.json
 * List all available agent cards for this org.
 */
a2aRoutes.get("/.well-known/agents.json", async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT name, description, config_json
    FROM agents
    WHERE org_id = ${user.org_id} AND is_active = true
    ORDER BY created_at DESC
  `;

  const baseUrl = new URL(c.req.url).origin;

  const cards = rows.map((row) => {
    const r = row as { name: string; description: string; config_json: unknown };
    const config = parseAgentConfigJson(r.config_json);
    const agentConfig = {
      name: r.name,
      agent_id: (config.agent_id as string) || r.name,
      description: r.description || (config.description as string) || "",
      version: (config.version as string) || "0.1.0",
      tools: Array.isArray(config.tools) ? config.tools : [],
      tags: Array.isArray(config.tags) ? config.tags : [],
    };
    return agentCardToJSON(buildAgentCard(agentConfig, baseUrl));
  });

  return c.json(cards);
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC A2A Endpoint (legacy - supports both old and new task paths)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /a2a
 * JSON-RPC endpoint for A2A protocol methods.
 * Supports: SendMessage, SendStreamingMessage, GetTask, CancelTask, ListTasks
 */
a2aRoutes.post("/a2a", async (c) => {
  let body: JSONRPCRequest;

  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonrpcError(null, -32700, "Parse error"), 400);
  }

  const { method, params = {}, id } = body;
  const user = c.get("user");

  switch (method) {
    case "SendMessage": {
      const message = (params.message as A2AMessage) || { parts: [], role: "user" };
      const parts = message.parts || [];
      const text = extractText(parts);

      if (!text) {
        return c.json(jsonrpcError(id, -32602, "No text content in message"), 400);
      }

      const agentName = (params.agentName as string) || "";
      const taskId = (params.taskId as string) || generateId();

      // Create task record
      const task = makeTask(taskId, "WORKING", [message]);
      task.agentName = agentName;
      taskStore.set(taskId, task);

      try {
        // Resolve agent
        const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

        let targetAgentName = agentName;
        if (!targetAgentName) {
          const rows = await sql`
            SELECT name FROM agents
            WHERE org_id = ${user.org_id} AND is_active = true
            ORDER BY created_at DESC
            LIMIT 1
          `;
          if (rows.length === 0) {
            task.status = { state: "FAILED", timestamp: new Date().toISOString() };
            return c.json(jsonrpcError(id, -32000, "No agents available"), 400);
          }
          targetAgentName = (rows[0] as { name: string }).name;
        }

        // Forward to runtime via service binding
        const resp = await c.env.RUNTIME.fetch(
          new Request("https://runtime/api/v1/run", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              agent_name: targetAgentName,
              task: text,
              org_id: user.org_id,
              project_id: user.project_id,
            }),
          }),
        );

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "Runtime error");
          task.status = { state: "FAILED", timestamp: new Date().toISOString() };
          return c.json(jsonrpcError(id, -32000, `Runtime error: ${errorText}`), resp.status as 200);
        }

        const result = (await resp.json()) as {
          output?: string;
          llm_response?: { content?: string };
        };

        const output = result.output || result.llm_response?.content || "";

        const responseMessage: A2AMessage = {
          id: generateId(),
          role: "agent",
          parts: [{ text: output }],
          timestamp: new Date().toISOString(),
        };

        task.status = { state: "COMPLETED", timestamp: new Date().toISOString() };
        task.messages.push(responseMessage);
        task.artifacts.push({ id: generateId(), name: "response", parts: [{ text: output }] });

        return c.json(jsonrpcResponse(id, { task }));
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        task.status = { state: "FAILED", timestamp: new Date().toISOString() };
        return c.json(jsonrpcError(id, -32000, errorMsg), 500);
      }
    }

    case "SendStreamingMessage": {
      const message = (params.message as A2AMessage) || { parts: [], role: "user" };
      const parts = message.parts || [];
      const text = extractText(parts);

      if (!text) {
        return c.json(jsonrpcError(id, -32602, "No text content in message"), 400);
      }

      const agentName = (params.agentName as string) || "";
      const taskId = (params.taskId as string) || generateId();

      const task = makeTask(taskId, "WORKING", [message]);
      task.agentName = agentName;
      taskStore.set(taskId, task);

      const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

      let targetAgentName = agentName;
      if (!targetAgentName) {
        const rows = await sql`
          SELECT name FROM agents
          WHERE org_id = ${user.org_id} AND is_active = true
          ORDER BY created_at DESC
          LIMIT 1
        `;
        if (rows.length === 0) {
          task.status = { state: "FAILED", timestamp: new Date().toISOString() };
          return c.json(jsonrpcError(id, -32000, "No agents available"), 400);
        }
        targetAgentName = (rows[0] as { name: string }).name;
      }

      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            const resp = await c.env.RUNTIME.fetch(
              new Request("https://runtime/api/v1/runtime-proxy/runnable/stream", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
                },
                body: JSON.stringify({
                  agent_name: targetAgentName,
                  task: text,
                  org_id: user.org_id,
                  project_id: user.project_id,
                }),
              }),
            );

            if (!resp.ok || !resp.body) {
              const error = await resp.text().catch(() => "Runtime error");
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error })}}\n\n`));
              controller.close();
              return;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              const lines = chunk.split("\n");

              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  try {
                    const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
                    if (data.type === "turn" && typeof data.content === "string") {
                      const turnMessage: A2AMessage = {
                        id: generateId(),
                        role: "agent",
                        parts: [{ text: data.content }],
                        timestamp: new Date().toISOString(),
                      };
                      task.messages.push(turnMessage);
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                  } catch {
                    controller.enqueue(encoder.encode(`${line}\n`));
                  }
                } else if (line.trim()) {
                  controller.enqueue(encoder.encode(`${line}\n`));
                }
              }
            }

            task.status = { state: "COMPLETED", timestamp: new Date().toISOString() };
            taskStore.set(taskId, task);

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ statusUpdate: { taskId, status: task.status } })}\n\n`,
              ),
            );
            controller.close();
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error })}\n\n`));
            controller.close();
            task.status = { state: "FAILED", timestamp: new Date().toISOString() };
            taskStore.set(taskId, task);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    case "GetTask": {
      const taskId = (params.id as string) || "";
      const task = taskStore.get(taskId);
      if (!task) {
        return c.json(jsonrpcError(id, -32000, `Task '${taskId}' not found`), 404);
      }
      return c.json(jsonrpcResponse(id, { task }));
    }

    case "CancelTask": {
      const taskId = (params.id as string) || "";
      const task = taskStore.get(taskId);
      if (!task) {
        return c.json(jsonrpcError(id, -32000, `Task '${taskId}' not found`), 404);
      }
      task.status = { state: "CANCELED", timestamp: new Date().toISOString() };
      taskStore.set(taskId, task);
      return c.json(jsonrpcResponse(id, { task }));
    }

    case "ListTasks": {
      const tasks = Array.from(taskStore.values());
      return c.json(jsonrpcResponse(id, { tasks }));
    }

    default:
      return c.json(jsonrpcError(id, -32601, `Method not found: ${method}`), 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Task-based REST Endpoints (A2A specification)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /a2a/tasks/send
 * Send a task to an agent (non-streaming).
 */
a2aRoutes.post("/a2a/tasks/send", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = c.get("user");

  const message = (body.message as A2AMessage) || { parts: [], role: "user" };
  const parts = message.parts || [];
  const text = extractText(parts);

  if (!text) {
    return c.json(jsonrpcError(body.id || null, -32602, "No text content in message"), 400);
  }

  const agentName = (body.agentName as string) || "";
  const taskId = (body.taskId as string) || generateId();

  const task = makeTask(taskId, "WORKING", [message]);
  task.agentName = agentName;
  taskStore.set(taskId, task);

  try {
    const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

    let targetAgentName = agentName;
    if (!targetAgentName) {
      const rows = await sql`
        SELECT name FROM agents
        WHERE org_id = ${user.org_id} AND is_active = true
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (rows.length === 0) {
        task.status = { state: "FAILED", timestamp: new Date().toISOString() };
        return c.json(jsonrpcError(body.id || null, -32000, "No agents available"), 400);
      }
      targetAgentName = (rows[0] as { name: string }).name;
    }

    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/api/v1/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          agent_name: targetAgentName,
          task: text,
          org_id: user.org_id,
          project_id: user.project_id,
        }),
      }),
    );

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "Runtime error");
      task.status = { state: "FAILED", timestamp: new Date().toISOString() };
      return c.json(jsonrpcError(body.id || null, -32000, `Runtime error: ${errorText}`), resp.status as 200);
    }

    const result = (await resp.json()) as {
      output?: string;
      llm_response?: { content?: string };
    };

    const output = result.output || result.llm_response?.content || "";

    const responseMessage: A2AMessage = {
      id: generateId(),
      role: "agent",
      parts: [{ text: output }],
      timestamp: new Date().toISOString(),
    };

    task.status = { state: "COMPLETED", timestamp: new Date().toISOString() };
    task.messages.push(responseMessage);
    task.artifacts.push({ id: generateId(), name: "response", parts: [{ text: output }] });

    return c.json({ task });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    task.status = { state: "FAILED", timestamp: new Date().toISOString() };
    return c.json(jsonrpcError(body.id || null, -32000, errorMsg), 500);
  }
});

/**
 * POST /a2a/tasks/sendSubscribe
 * Send a task with streaming response (SSE).
 */
a2aRoutes.post("/a2a/tasks/sendSubscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = c.get("user");

  const message = (body.message as A2AMessage) || { parts: [], role: "user" };
  const parts = message.parts || [];
  const text = extractText(parts);

  if (!text) {
    return c.json(jsonrpcError(body.id || null, -32602, "No text content in message"), 400);
  }

  const agentName = (body.agentName as string) || "";
  const taskId = (body.taskId as string) || generateId();

  const task = makeTask(taskId, "WORKING", [message]);
  task.agentName = agentName;
  taskStore.set(taskId, task);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let targetAgentName = agentName;
  if (!targetAgentName) {
    const rows = await sql`
      SELECT name FROM agents
      WHERE org_id = ${user.org_id} AND is_active = true
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) {
      task.status = { state: "FAILED", timestamp: new Date().toISOString() };
      return c.json(jsonrpcError(body.id || null, -32000, "No agents available"), 400);
    }
    targetAgentName = (rows[0] as { name: string }).name;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const resp = await c.env.RUNTIME.fetch(
          new Request("https://runtime/api/v1/runtime-proxy/runnable/stream", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              agent_name: targetAgentName,
              task: text,
              org_id: user.org_id,
              project_id: user.project_id,
            }),
          }),
        );

        if (!resp.ok || !resp.body) {
          const error = await resp.text().catch(() => "Runtime error");
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error })}}\n\n`));
          controller.close();
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
                if (data.type === "turn" && typeof data.content === "string") {
                  const turnMessage: A2AMessage = {
                    id: generateId(),
                    role: "agent",
                    parts: [{ text: data.content }],
                    timestamp: new Date().toISOString(),
                  };
                  task.messages.push(turnMessage);
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              } catch {
                controller.enqueue(encoder.encode(`${line}\n`));
              }
            } else if (line.trim()) {
              controller.enqueue(encoder.encode(`${line}\n`));
            }
          }
        }

        task.status = { state: "COMPLETED", timestamp: new Date().toISOString() };
        taskStore.set(taskId, task);

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ statusUpdate: { taskId, status: task.status } })}\n\n`,
          ),
        );
        controller.close();
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error })}\n\n`));
        controller.close();
        task.status = { state: "FAILED", timestamp: new Date().toISOString() };
        taskStore.set(taskId, task);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

/**
 * GET /a2a/tasks/:id
 * Get task status by ID.
 */
a2aRoutes.get("/a2a/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const task = taskStore.get(taskId);

  if (!task) {
    return c.json({ error: `Task '${taskId}' not found` }, 404);
  }

  return c.json({ task });
});

/**
 * POST /a2a/tasks/:id/cancel
 * Cancel a running task.
 */
a2aRoutes.post("/a2a/tasks/:id/cancel", async (c) => {
  const taskId = c.req.param("id");
  const task = taskStore.get(taskId);

  if (!task) {
    return c.json({ error: `Task '${taskId}' not found` }, 404);
  }

  task.status = { state: "CANCELED", timestamp: new Date().toISOString() };
  taskStore.set(taskId, task);

  return c.json({ task });
});
