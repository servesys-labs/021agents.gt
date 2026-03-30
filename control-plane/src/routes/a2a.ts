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
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { buildAgentCard, agentCardToJSON } from "../lib/a2a/card";
import { parseAgentConfigJson } from "../schemas/common";

// In-memory task cache (fast reads). Tasks also persisted to a2a_tasks DB table for audit.
const taskStore = new Map<string, A2ATask>();

/** Persist A2A task to DB for audit trail. */
async function persistA2ATask(env: any, task: A2ATask, callerOrgId: string, calleeOrgId: string, transferId?: string, amountUsd?: number) {
  try {
    const sql = await getDbForOrg(env.HYPERDRIVE, calleeOrgId);
    const firstUserMsg = task.messages.find((m: any) => m.role === "user");
    const input = String((firstUserMsg?.parts?.[0] as any)?.text || "");
    const output = String((task.artifacts?.[0]?.parts?.[0] as any)?.text || "");
    await sql`
      INSERT INTO a2a_tasks (task_id, caller_org_id, callee_org_id, caller_agent_name, callee_agent_name, status, input_text, output_text, transfer_id, amount_usd, created_at, completed_at)
      VALUES (${task.id}, ${callerOrgId}, ${calleeOrgId}, '', ${task.agentName || ''}, ${task.status.state.toLowerCase()}, ${input.slice(0, 5000)}, ${output.slice(0, 5000)}, ${transferId || ''}, ${amountUsd || 0}, ${task.status.timestamp || new Date().toISOString()}, ${task.status.state !== 'WORKING' ? task.status.timestamp : null})
      ON CONFLICT (task_id) DO UPDATE SET status = ${task.status.state.toLowerCase()}, output_text = ${output.slice(0, 5000)}, completed_at = ${task.status.state !== 'WORKING' ? task.status.timestamp : null}
    `;
  } catch {} // non-blocking
}

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

export const a2aRoutes = createOpenAPIRouter();

// ─────────────────────────────────────────────────────────────────────────────
// Agent Card Discovery Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const agentCardRoute = createRoute({
  method: "get",
  path: "/.well-known/agent.json",
  tags: ["A2A"],
  summary: "Get A2A agent card for discovery",
  responses: {
    200: {
      description: "Agent card",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
a2aRoutes.openapi(agentCardRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT name, description, config_json
    FROM agents
    WHERE org_id = ${user.org_id} AND is_active = 1
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

// ─────────────────────────────────────────────────────────────────────────────

const agentCardsRoute = createRoute({
  method: "get",
  path: "/.well-known/agents.json",
  tags: ["A2A"],
  summary: "List all available agent cards",
  responses: {
    200: {
      description: "Agent cards list",
      content: { "application/json": { schema: z.array(z.record(z.unknown())) } },
    },
  },
});
a2aRoutes.openapi(agentCardsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT name, description, config_json
    FROM agents
    WHERE org_id = ${user.org_id} AND is_active = 1
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
// Agents list for portal consumption
// ─────────────────────────────────────────────────────────────────────────────

const agentsListRoute = createRoute({
  method: "get",
  path: "/api/v1/a2a/agents",
  tags: ["A2A"],
  summary: "List all agents in portal format",
  responses: {
    200: {
      description: "Agents list",
      content: { "application/json": { schema: z.object({ agents: z.array(z.record(z.unknown())) }) } },
    },
  },
});
a2aRoutes.openapi(agentsListRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let agents: Array<Record<string, unknown>> = [];
  try {
    const rows = await sql`
      SELECT name, description, config_json, is_active, created_at, updated_at
      FROM agents
      WHERE org_id = ${user.org_id}
      ORDER BY created_at DESC
    `;

    const baseUrl = new URL(c.req.url).origin;

    agents = rows.map((row: any) => {
      const config = parseAgentConfigJson(row.config_json);
      return {
        agent_id: (config.agent_id as string) || row.name,
        name: row.name,
        description: row.description || (config.description as string) || "",
        url: `${baseUrl}/a2a`,
        status: Number(row.is_active) === 1 ? "active" : "inactive",
        capabilities: Array.isArray(config.capabilities) ? config.capabilities : [],
        skills: Array.isArray(config.tools) ? config.tools : [],
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at,
      };
    });
  } catch {}

  return c.json({ agents });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC A2A Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const jsonrpcRoute = createRoute({
  method: "post",
  path: "/a2a",
  tags: ["A2A"],
  summary: "JSON-RPC endpoint for A2A protocol methods",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            jsonrpc: z.literal("2.0"),
            id: z.union([z.string(), z.number(), z.null()]).optional(),
            method: z.string(),
            params: z.record(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "JSON-RPC response",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404, 500),
  },
});
a2aRoutes.openapi(jsonrpcRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");

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
            WHERE org_id = ${user.org_id} AND is_active = 1
            ORDER BY created_at DESC
            LIMIT 1
          `;
          if (rows.length === 0) {
            task.status = { state: "FAILED", timestamp: new Date().toISOString() };
            return c.json(jsonrpcError(id, -32000, "No agents available"), 400);
          }
          targetAgentName = (rows[0] as { name: string }).name;
        }

        // ── x-402 Payment Gate ──────────────────────────────────
        // Check if agent requires payment. If so, verify receipt or return 402.
        const agentRows = await sql`
          SELECT config_json FROM agents WHERE name = ${targetAgentName} AND org_id = ${user.org_id} AND is_active = 1 LIMIT 1
        `.catch(() => []);
        if (agentRows.length > 0) {
          const { getAgentPricing, build402Headers, verifyPaymentReceipt } = await import("../logic/agent-payments");
          const cfg = typeof agentRows[0].config_json === "string" ? JSON.parse(agentRows[0].config_json) : agentRows[0].config_json || {};
          const pricing = getAgentPricing(cfg);

          if (pricing?.requires_payment) {
            const paymentReceipt = params.payment_receipt as { transfer_id?: string } | undefined;

            if (!paymentReceipt?.transfer_id) {
              // No payment — return 402 with x-402 headers
              task.status = { state: "FAILED", timestamp: new Date().toISOString() };
              const headers402 = build402Headers(pricing, targetAgentName, user.org_id);
              return c.json(jsonrpcError(id, -32000, "Payment required"), {
                status: 402 as any,
                headers: headers402,
              });
            }

            // Verify payment receipt
            const verification = await verifyPaymentReceipt(sql, paymentReceipt.transfer_id, user.org_id, pricing.price_per_task_usd);
            if (!verification.valid) {
              task.status = { state: "FAILED", timestamp: new Date().toISOString() };
              return c.json(jsonrpcError(id, -32000, `Payment verification failed: ${verification.error}`), 402 as any);
            }
          }
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

        // Persist to DB for audit
        const paymentReceipt = params.payment_receipt as { transfer_id?: string } | undefined;
        persistA2ATask(c.env, task, user.org_id, user.org_id, paymentReceipt?.transfer_id);

        return c.json(jsonrpcResponse(id, { task }));
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        task.status = { state: "FAILED", timestamp: new Date().toISOString() };

        // Persist failure to DB
        persistA2ATask(c.env, task, user.org_id, user.org_id);

        // Refund payment if task failed after payment
        const paymentReceipt = params.payment_receipt as { transfer_id?: string } | undefined;
        if (paymentReceipt?.transfer_id) {
          try {
            const { refundTransfer } = await import("../logic/agent-payments");
            const refundSql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
            await refundTransfer(refundSql, paymentReceipt.transfer_id, user.org_id, user.org_id, 0, `A2A task failed: ${errorMsg.slice(0, 200)}`);
          } catch {} // best-effort refund
        }

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
          WHERE org_id = ${user.org_id} AND is_active = 1
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

const taskSendRoute = createRoute({
  method: "post",
  path: "/a2a/tasks/send",
  tags: ["A2A"],
  summary: "Send a task to an agent (non-streaming)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.union([z.string(), z.number(), z.null()]).optional(),
            message: z.record(z.unknown()).optional(),
            agentName: z.string().optional(),
            taskId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Task result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});
a2aRoutes.openapi(taskSendRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const user = c.get("user");

  const message = (body.message as unknown as A2AMessage) || { parts: [], role: "user" };
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
        WHERE org_id = ${user.org_id} AND is_active = 1
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

// ─────────────────────────────────────────────────────────────────────────────

const taskSendSubscribeRoute = createRoute({
  method: "post",
  path: "/a2a/tasks/sendSubscribe",
  tags: ["A2A"],
  summary: "Send a task with streaming response (SSE)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.union([z.string(), z.number(), z.null()]).optional(),
            message: z.record(z.unknown()).optional(),
            agentName: z.string().optional(),
            taskId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "SSE stream",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
a2aRoutes.openapi(taskSendSubscribeRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const user = c.get("user");

  const message = (body.message as unknown as A2AMessage) || { parts: [], role: "user" };
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
      WHERE org_id = ${user.org_id} AND is_active = 1
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

// ─────────────────────────────────────────────────────────────────────────────

const getTaskRoute = createRoute({
  method: "get",
  path: "/a2a/tasks/{id}",
  tags: ["A2A"],
  summary: "Get task status by ID",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Task status",
      content: { "application/json": { schema: z.object({ task: z.record(z.unknown()) }) } },
    },
    ...errorResponses(404),
  },
});
a2aRoutes.openapi(getTaskRoute, async (c): Promise<any> => {
  const { id: taskId } = c.req.valid("param");
  const task = taskStore.get(taskId);

  if (!task) {
    return c.json({ error: `Task '${taskId}' not found` }, 404);
  }

  return c.json({ task });
});

// ─────────────────────────────────────────────────────────────────────────────

const cancelTaskRoute = createRoute({
  method: "post",
  path: "/a2a/tasks/{id}/cancel",
  tags: ["A2A"],
  summary: "Cancel a running task",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Task canceled",
      content: { "application/json": { schema: z.object({ task: z.record(z.unknown()) }) } },
    },
    ...errorResponses(404),
  },
});
a2aRoutes.openapi(cancelTaskRoute, async (c): Promise<any> => {
  const { id: taskId } = c.req.valid("param");
  const task = taskStore.get(taskId);

  if (!task) {
    return c.json({ error: `Task '${taskId}' not found` }, 404);
  }

  task.status = { state: "CANCELED", timestamp: new Date().toISOString() };
  taskStore.set(taskId, task);

  return c.json({ task });
});
