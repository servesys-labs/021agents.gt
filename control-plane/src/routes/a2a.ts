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
import { withOrgDb } from "../db/client";
import { buildAgentCard, agentCardToJSON } from "../lib/a2a/card";
import { parseAgentConfigJson } from "../schemas/common";

// In-memory task cache (fast reads). Tasks also persisted to a2a_tasks DB table for audit.
const taskStore = new Map<string, A2ATask>();

/** Persist A2A task to DB for audit trail. */
async function persistA2ATask(env: any, task: A2ATask, callerOrgId: string, calleeOrgId: string, transferId?: string, amountUsd?: number) {
  try {
    // a2a_tasks has two-sided RLS (caller_org_id OR callee_org_id matches
    // current_org_id()), so writing under the callee org is sufficient and
    // both sides can read the row afterwards under their own GUC.
    await withOrgDb(env, calleeOrgId, async (sql) => {
      const firstUserMsg = task.messages.find((m: any) => m.role === "user");
      const input = String((firstUserMsg?.parts?.[0] as any)?.text || "");
      const output = String((task.artifacts?.[0]?.parts?.[0] as any)?.text || "");
      await sql`
        INSERT INTO a2a_tasks (task_id, caller_org_id, callee_org_id, caller_agent_name, callee_agent_name, status, input_text, output_text, transfer_id, amount_usd, created_at, completed_at)
        VALUES (${task.id}, ${callerOrgId}, ${calleeOrgId}, '', ${task.agentName || ''}, ${task.status.state.toLowerCase()}, ${input.slice(0, 5000)}, ${output.slice(0, 5000)}, ${transferId || ''}, ${amountUsd || 0}, ${task.status.timestamp || new Date().toISOString()}, ${task.status.state !== 'WORKING' ? task.status.timestamp : null})
        ON CONFLICT (task_id) DO UPDATE SET status = ${task.status.state.toLowerCase()}, output_text = ${output.slice(0, 5000)}, completed_at = ${task.status.state !== 'WORKING' ? task.status.timestamp : null}
      `;
    });
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
  const agentParam = new URL(c.req.url).searchParams.get("agent") || "";
  const orgParam = new URL(c.req.url).searchParams.get("org") || user?.org_id || "";

  // Discovery must work without auth — org is required as a query param for unauthenticated callers
  if (!orgParam) {
    return c.json({ error: "Missing 'org' query parameter — required for public agent discovery" }, 400);
  }

  return await withOrgDb(c.env, orgParam, async (sql) => {
    const rows = agentParam
      ? await sql`
          SELECT name, description, config
          FROM agents
          WHERE name = ${agentParam} AND is_active = true
          LIMIT 1
        `
      : await sql`
          SELECT name, description, config
          FROM agents
          WHERE is_active = true
          ORDER BY created_at DESC
          LIMIT 1
        `;

    if (rows.length === 0) {
      return c.json({ error: "No agents available" }, 404);
    }

    const row = rows[0] as { name: string; description: string; config: unknown };
    const config = parseAgentConfigJson(row.config);

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
  const orgParam = new URL(c.req.url).searchParams.get("org") || user?.org_id || "";

  if (!orgParam) {
    return c.json({ error: "Missing 'org' query parameter — required for public agent discovery" }, 400);
  }

  const rows = await withOrgDb(c.env, orgParam, async (sql) => {
    return await sql`
      SELECT name, description, config
      FROM agents
      WHERE is_active = true
      ORDER BY created_at DESC
    `;
  });

  const baseUrl = new URL(c.req.url).origin;

  const cards = rows.map((row) => {
    const r = row as { name: string; description: string; config: unknown };
    const config = parseAgentConfigJson(r.config);
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

  let agents: Array<Record<string, unknown>> = [];
  try {
    agents = await withOrgDb(c.env, user.org_id, async (sql) => {
      const rows = await sql`
        SELECT name, description, config, is_active, created_at, updated_at
        FROM agents
        ORDER BY created_at DESC
      `;

      const baseUrl = new URL(c.req.url).origin;

      return rows.map((row: any) => {
        const config = parseAgentConfigJson(row.config);
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
      let targetOrgId = user.org_id; // default to caller's org, updated below for cross-org
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
        return await withOrgDb(c.env, user.org_id, async (sql) => {

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

        // ── x-402 Payment Gate ──────────────────────────────────
        // Resolve target agent's OWNER org (may be different from caller's org in cross-org A2A)
        // Resolve agent owner — use ?org= query param for cross-org discovery, or global lookup
        const targetOrgFromUrl = new URL(c.req.url).searchParams.get("org") || "";
        const agentOwnerRows = await sql`
          SELECT org_id, config FROM agents
          WHERE name = ${targetAgentName} AND is_active = true
          ${targetOrgFromUrl ? sql`AND org_id = ${targetOrgFromUrl}` : sql``}
          LIMIT 1
        `.catch(() => []);
        targetOrgId = agentOwnerRows.length > 0 ? String(agentOwnerRows[0].org_id) : user.org_id;

        if (agentOwnerRows.length > 0) {
          const { getAgentPricing, build402Headers, verifyPaymentReceipt } = await import("../logic/agent-payments");
          const cfg = typeof agentOwnerRows[0].config === "string" ? JSON.parse(agentOwnerRows[0].config) : agentOwnerRows[0].config || {};
          const pricing = getAgentPricing(cfg);

          if (pricing?.requires_payment && user.org_id !== targetOrgId) {
            const paymentReceipt = params.payment_receipt as { transfer_id?: string } | undefined;

            if (!paymentReceipt?.transfer_id) {
              task.status = { state: "FAILED", timestamp: new Date().toISOString() };
              const headers402 = build402Headers(pricing, targetAgentName, targetOrgId);
              return c.json(jsonrpcError(id, -32000, "Payment required"), {
                status: 402 as any,
                headers: headers402,
              });
            }

            // Verify payment was sent to the AGENT OWNER's org (not the caller's)
            const verification = await verifyPaymentReceipt(sql, paymentReceipt.transfer_id, targetOrgId, pricing.price_per_task_usd);
            if (!verification.valid) {
              task.status = { state: "FAILED", timestamp: new Date().toISOString() };
              return c.json(jsonrpcError(id, -32000, `Payment verification failed: ${verification.error}`), 402 as any);
            }
          }
        }

        // ── Cost ceiling for A2A tasks ──────────────────────────
        // Resolve pricing model to enforce cost cap during execution.
        // The runtime's budget_limit_usd is overridden to the escrow ceiling
        // so the agent CANNOT spend more than what the caller pre-authorized.
        let pricingModel = "fixed";
        let costCeiling = 10.0; // default fallback
        let costPlusMarginPct = 0;
        try {
          const [mktListing] = await sql`
            SELECT pricing_model, cost_plus_margin_pct, price_per_task_usd,
                   price_per_1k_input_tokens_usd, price_per_1k_output_tokens_usd
            FROM marketplace_listings
            WHERE agent_name = ${targetAgentName} AND is_published = true LIMIT 1
          `.catch(() => []);
          if (mktListing) {
            pricingModel = mktListing.pricing_model || "fixed";
            costPlusMarginPct = Number(mktListing.cost_plus_margin_pct) || 0;
            if (pricingModel === "fixed") {
              // Fixed: ceiling = task price (agent won't spend more than they earn)
              costCeiling = Number(mktListing.price_per_task_usd) || 10.0;
            } else if (pricingModel === "cost_plus") {
              // Cost-plus: ceiling = agent's budget_limit_usd (max possible cost)
              // The actual charge is settled post-task based on real LLM spend
              const cfg = typeof agentOwnerRows[0]?.config === "string"
                ? JSON.parse(agentOwnerRows[0].config)
                : agentOwnerRows[0]?.config || {};
              costCeiling = Number(cfg.governance?.budget_limit_usd) || 10.0;
            } else if (pricingModel === "per_token") {
              // Per-token: ceiling based on reasonable max (200k tokens)
              const maxTokens = 200_000;
              const inputRate = Number(mktListing.price_per_1k_input_tokens_usd) || 0;
              const outputRate = Number(mktListing.price_per_1k_output_tokens_usd) || 0;
              costCeiling = (maxTokens / 1000) * Math.max(inputRate, outputRate);
            }
          }
        } catch {} // non-blocking — falls back to default ceiling

        // Forward to runtime via service binding with cost ceiling override
        const resp = await c.env.RUNTIME.fetch(
          new Request("https://runtime/run", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              agent_name: targetAgentName,
              input: text,
              org_id: targetOrgId,
              project_id: user.project_id,
              channel: "a2a",
              // Cost ceiling: overrides agent's own budget for this task
              budget_limit_usd_override: costCeiling,
            }),
          }),
        );

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "");
          console.error(`[a2a/tasks/send] runtime returned ${resp.status}: ${errorText.slice(0, 400)}`);
          task.status = { state: "FAILED", timestamp: new Date().toISOString() };
          return c.json(jsonrpcError(id, -32000, "Runtime execution failed. Please try again in a moment."), resp.status as 200);
        }

        const result = (await resp.json()) as {
          output?: string;
          llm_response?: { content?: string };
          cost_usd?: number;
          input_tokens?: number;
          output_tokens?: number;
        };

        const output = result.output || result.llm_response?.content || "";
        const actualCostUsd = result.cost_usd || 0;
        const actualInputTokens = result.input_tokens || 0;
        const actualOutputTokens = result.output_tokens || 0;

        const responseMessage: A2AMessage = {
          id: generateId(),
          role: "agent",
          parts: [{ text: output }],
          timestamp: new Date().toISOString(),
        };

        task.status = { state: "COMPLETED", timestamp: new Date().toISOString() };
        task.messages.push(responseMessage);
        task.artifacts.push({ id: generateId(), name: "response", parts: [{ text: output }] });

        // ── Post-task settlement (cost_plus / per_token) ────────
        // For non-fixed pricing, calculate actual charge and refund overage
        const paymentReceipt = params.payment_receipt as { transfer_id?: string } | undefined;
        const transferId = paymentReceipt?.transfer_id || "";
        let transferAmount = 0;
        let settledAmount = 0;

        if (transferId) {
          try {
            const [t] = await sql`
              SELECT ABS(amount_usd) as amount FROM credit_transactions
              WHERE reference_id = ${transferId} AND type = 'transfer_out' LIMIT 1
            `;
            transferAmount = Number(t?.amount) || 0;
          } catch {}
        }

        if (pricingModel === "cost_plus" && actualCostUsd > 0 && transferAmount > 0) {
          // Charge: actual LLM cost + margin percentage
          settledAmount = actualCostUsd * (1 + costPlusMarginPct / 100);
          const overage = transferAmount - settledAmount;
          if (overage > 0.001) {
            // Refund overage to caller
            try {
              const { refundTransfer } = await import("../logic/agent-payments");
              await refundTransfer(sql, transferId, user.org_id, targetOrgId, overage,
                `Cost-plus settlement: actual $${actualCostUsd.toFixed(4)} + ${costPlusMarginPct}% = $${settledAmount.toFixed(4)}, refund $${overage.toFixed(4)}`
              );
            } catch {} // best-effort
          }
        } else if (pricingModel === "per_token" && (actualInputTokens > 0 || actualOutputTokens > 0) && transferAmount > 0) {
          // Charge: actual tokens * rates
          try {
            const [mktListing] = await sql`
              SELECT price_per_1k_input_tokens_usd, price_per_1k_output_tokens_usd
              FROM marketplace_listings WHERE agent_name = ${targetAgentName} AND is_published = true LIMIT 1
            `.catch(() => []);
            if (mktListing) {
              const inputCost = (actualInputTokens / 1000) * Number(mktListing.price_per_1k_input_tokens_usd || 0);
              const outputCost = (actualOutputTokens / 1000) * Number(mktListing.price_per_1k_output_tokens_usd || 0);
              settledAmount = inputCost + outputCost;
              const overage = transferAmount - settledAmount;
              if (overage > 0.001) {
                const { refundTransfer } = await import("../logic/agent-payments");
                await refundTransfer(sql, transferId, user.org_id, targetOrgId, overage,
                  `Per-token settlement: ${actualInputTokens} in + ${actualOutputTokens} out = $${settledAmount.toFixed(4)}, refund $${overage.toFixed(4)}`
                );
              }
            }
          } catch {} // best-effort
        } else {
          settledAmount = transferAmount; // fixed pricing — no settlement needed
        }

        // Persist to DB for audit (use actual target org, not caller's)
        // Include cost metrics for transparency
        persistA2ATask(c.env, task, user.org_id, targetOrgId, paymentReceipt?.transfer_id);
        // Update a2a_tasks with actual cost data
        try {
          await sql`
            UPDATE a2a_tasks SET
              llm_cost_usd = ${actualCostUsd},
              input_tokens = ${actualInputTokens},
              output_tokens = ${actualOutputTokens},
              pricing_model = ${pricingModel},
              settled_amount_usd = ${settledAmount},
              amount_usd = ${settledAmount}
            WHERE task_id = ${taskId}
          `.catch(() => {});
        } catch {}

        // Write billing record for A2A transaction (caller pays settled amount)
        if (settledAmount > 0) {
          try {
            await sql`
              INSERT INTO billing_records (
                org_id, agent_name, cost_type, model, total_cost_usd, inference_cost_usd,
                input_tokens, output_tokens, session_id, trace_id, description, created_at
              ) VALUES (
                ${user.org_id}, ${targetAgentName}, 'a2a_task', 'a2a',
                ${settledAmount}, ${actualCostUsd},
                ${actualInputTokens}, ${actualOutputTokens},
                ${taskId}, ${taskId},
                ${'A2A task (' + pricingModel + '): ' + targetAgentName + ' — LLM $' + actualCostUsd.toFixed(4) + ', settled $' + settledAmount.toFixed(4)},
                now()
              ) ON CONFLICT DO NOTHING
            `;
          } catch (err) {
            console.error("[a2a] Billing record write failed:", err);
          }
        }

        // Item 5: Auto-rate completed task (default 4/5 = good)
        // Item 8: Increment task counter on marketplace listing
        try {
          await withOrgDb(c.env, targetOrgId, async (mktSql) => {
            const [listing] = await mktSql`
              SELECT id FROM marketplace_listings WHERE agent_name = ${targetAgentName} AND is_published = true LIMIT 1
            `.catch(() => [] as any[]);
            if (listing) {
              const { submitRating } = await import("../logic/marketplace");
              await submitRating(mktSql, listing.id, user.org_id, 4, { task_id: taskId }).catch(() => {});
              await mktSql`
                UPDATE marketplace_listings SET total_tasks_completed = total_tasks_completed + 1, updated_at = now()
                WHERE id = ${listing.id}
              `.catch(() => {});
            }
          });
        } catch {} // non-blocking

        return c.json(jsonrpcResponse(id, { task }));
        }); // close withOrgDb
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        task.status = { state: "FAILED", timestamp: new Date().toISOString() };

        // Persist failure to DB
        persistA2ATask(c.env, task, user.org_id, targetOrgId);

        // Item 8: Increment failure counter on marketplace listing
        try {
          await withOrgDb(c.env, targetOrgId, async (mktSql) => {
            await mktSql`
              UPDATE marketplace_listings SET total_tasks_failed = COALESCE(total_tasks_failed, 0) + 1, updated_at = now()
              WHERE agent_name = ${task.agentName || ''} AND is_published = true
            `.catch(() => {});
          });
        } catch {} // non-blocking

        // Refund payment if task failed after payment
        const failedPaymentReceipt = params.payment_receipt as { transfer_id?: string } | undefined;
        const failedTransferId = failedPaymentReceipt?.transfer_id;
        if (failedTransferId && targetOrgId !== user.org_id) {
          try {
            const { refundTransfer } = await import("../logic/agent-payments");
            await withOrgDb(c.env, user.org_id, async (refundSql) => {
              // Look up original transfer amount from credit_transactions
              const [txRow] = await refundSql`
                SELECT ABS(amount_usd) as amount FROM credit_transactions
                WHERE reference_id = ${failedTransferId} AND type = 'transfer_out' LIMIT 1
              `.catch(() => []);
              const refundAmount = Number(txRow?.amount || 0);
              if (refundAmount > 0) {
                await refundTransfer(refundSql, failedTransferId, user.org_id, targetOrgId, refundAmount, `A2A task failed: ${errorMsg.slice(0, 200)}`);
              }
            });
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

      // Resolve agent + payment gate inside org-scoped tx; the streaming
      // section below does not touch the DB and runs after the tx commits.
      const gateResult = await withOrgDb(c.env, user.org_id, async (sql): Promise<
        { error: Response; targetAgentName?: undefined } | { error?: undefined; targetAgentName: string }
      > => {
        let targetAgentName = agentName;
        if (!targetAgentName) {
          const rows = await sql`
            SELECT name FROM agents
            WHERE is_active = true
            ORDER BY created_at DESC
            LIMIT 1
          `;
          if (rows.length === 0) {
            task.status = { state: "FAILED", timestamp: new Date().toISOString() };
            return { error: c.json(jsonrpcError(id, -32000, "No agents available"), 400) };
          }
          targetAgentName = (rows[0] as { name: string }).name;
        }

        // ── x-402 Payment Gate (streaming) ──────────────────────────
        const streamTargetOrgFromUrl = new URL(c.req.url).searchParams.get("org") || "";
        const streamAgentOwnerRows = await sql`
          SELECT org_id, config FROM agents
          WHERE name = ${targetAgentName} AND is_active = true
          ${streamTargetOrgFromUrl ? sql`AND org_id = ${streamTargetOrgFromUrl}` : sql``}
          LIMIT 1
        `.catch(() => []);
        const streamTargetOrgId = streamAgentOwnerRows.length > 0 ? String(streamAgentOwnerRows[0].org_id) : user.org_id;

        if (streamAgentOwnerRows.length > 0) {
          const { getAgentPricing, build402Headers, verifyPaymentReceipt } = await import("../logic/agent-payments");
          const cfg = typeof streamAgentOwnerRows[0].config === "string" ? JSON.parse(streamAgentOwnerRows[0].config) : streamAgentOwnerRows[0].config || {};
          const pricing = getAgentPricing(cfg);

          if (pricing?.requires_payment && user.org_id !== streamTargetOrgId) {
            const paymentReceipt = params.payment_receipt as { transfer_id?: string } | undefined;

            if (!paymentReceipt?.transfer_id) {
              task.status = { state: "FAILED", timestamp: new Date().toISOString() };
              const headers402 = build402Headers(pricing, targetAgentName, streamTargetOrgId);
              return { error: c.json(jsonrpcError(id, -32000, "Payment required"), {
                status: 402 as any,
                headers: headers402,
              }) };
            }

            const verification = await verifyPaymentReceipt(sql, paymentReceipt.transfer_id, streamTargetOrgId, pricing.price_per_task_usd);
            if (!verification.valid) {
              task.status = { state: "FAILED", timestamp: new Date().toISOString() };
              return { error: c.json(jsonrpcError(id, -32000, `Payment verification failed: ${verification.error}`), 402 as any) };
            }
          }
        }

        return { targetAgentName };
      });

      if (gateResult.error) return gateResult.error;
      const targetAgentName = gateResult.targetAgentName;

      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            const resp = await c.env.RUNTIME.fetch(
              new Request("https://runtime/runtime-proxy/runnable/stream", {
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
    // Resolve agent + payment gate inside org-scoped tx; the runtime fetch
    // below does not touch the DB and runs after the tx commits.
    const gateResult = await withOrgDb(c.env, user.org_id, async (sql): Promise<
      { error: Response; targetAgentName?: undefined } | { error?: undefined; targetAgentName: string }
    > => {
      let targetAgentName = agentName;
      if (!targetAgentName) {
        const rows = await sql`
          SELECT name FROM agents
          WHERE is_active = true
          ORDER BY created_at DESC
          LIMIT 1
        `;
        if (rows.length === 0) {
          task.status = { state: "FAILED", timestamp: new Date().toISOString() };
          return { error: c.json(jsonrpcError(body.id || null, -32000, "No agents available"), 400) };
        }
        targetAgentName = (rows[0] as { name: string }).name;
      }

      // ── x-402 Payment Gate (REST) ──────────────────────────────
      const restTargetOrgFromUrl = new URL(c.req.url).searchParams.get("org") || "";
      const restAgentOwnerRows = await sql`
        SELECT org_id, config FROM agents
        WHERE name = ${targetAgentName} AND is_active = true
        ${restTargetOrgFromUrl ? sql`AND org_id = ${restTargetOrgFromUrl}` : sql``}
        LIMIT 1
      `.catch(() => []);
      const restTargetOrgId = restAgentOwnerRows.length > 0 ? String(restAgentOwnerRows[0].org_id) : user.org_id;

      if (restAgentOwnerRows.length > 0) {
        const { getAgentPricing, build402Headers, verifyPaymentReceipt } = await import("../logic/agent-payments");
        const cfg = typeof restAgentOwnerRows[0].config === "string" ? JSON.parse(restAgentOwnerRows[0].config) : restAgentOwnerRows[0].config || {};
        const pricing = getAgentPricing(cfg);

        if (pricing?.requires_payment && user.org_id !== restTargetOrgId) {
          const paymentReceipt = (body as any).payment_receipt as { transfer_id?: string } | undefined;

          if (!paymentReceipt?.transfer_id) {
            task.status = { state: "FAILED", timestamp: new Date().toISOString() };
            const headers402 = build402Headers(pricing, targetAgentName, restTargetOrgId);
            return { error: c.json(jsonrpcError(body.id || null, -32000, "Payment required"), {
              status: 402 as any,
              headers: headers402,
            }) };
          }

          const verification = await verifyPaymentReceipt(sql, paymentReceipt.transfer_id, restTargetOrgId, pricing.price_per_task_usd);
          if (!verification.valid) {
            task.status = { state: "FAILED", timestamp: new Date().toISOString() };
            return { error: c.json(jsonrpcError(body.id || null, -32000, `Payment verification failed: ${verification.error}`), 402 as any) };
          }
        }
      }

      return { targetAgentName };
    });

    if (gateResult.error) return gateResult.error;
    const targetAgentName = gateResult.targetAgentName;

    const resp = await c.env.RUNTIME.fetch(
      new Request("https://runtime/run", {
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
      const errorText = await resp.text().catch(() => "");
      console.error(`[a2a/message/send] runtime returned ${resp.status}: ${errorText.slice(0, 400)}`);
      task.status = { state: "FAILED", timestamp: new Date().toISOString() };
      return c.json(jsonrpcError(body.id || null, -32000, "Runtime execution failed. Please try again in a moment."), resp.status as 200);
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

  // Resolve agent + payment gate inside org-scoped tx; the streaming
  // section below does not touch the DB and runs after the tx commits.
  const subGateResult = await withOrgDb(c.env, user.org_id, async (sql): Promise<
    { error: Response; targetAgentName?: undefined } | { error?: undefined; targetAgentName: string }
  > => {
    let targetAgentName = agentName;
    if (!targetAgentName) {
      const rows = await sql`
        SELECT name FROM agents
        WHERE is_active = true
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (rows.length === 0) {
        task.status = { state: "FAILED", timestamp: new Date().toISOString() };
        return { error: c.json(jsonrpcError(body.id || null, -32000, "No agents available"), 400) };
      }
      targetAgentName = (rows[0] as { name: string }).name;
    }

    // ── x-402 Payment Gate (REST streaming) ────────────────────
    const subTargetOrgFromUrl = new URL(c.req.url).searchParams.get("org") || "";
    const subAgentOwnerRows = await sql`
      SELECT org_id, config FROM agents
      WHERE name = ${targetAgentName} AND is_active = true
      ${subTargetOrgFromUrl ? sql`AND org_id = ${subTargetOrgFromUrl}` : sql``}
      LIMIT 1
    `.catch(() => []);
    const subTargetOrgId = subAgentOwnerRows.length > 0 ? String(subAgentOwnerRows[0].org_id) : user.org_id;

    if (subAgentOwnerRows.length > 0) {
      const { getAgentPricing, build402Headers, verifyPaymentReceipt } = await import("../logic/agent-payments");
      const cfg = typeof subAgentOwnerRows[0].config === "string" ? JSON.parse(subAgentOwnerRows[0].config) : subAgentOwnerRows[0].config || {};
      const pricing = getAgentPricing(cfg);

      if (pricing?.requires_payment && user.org_id !== subTargetOrgId) {
        const paymentReceipt = (body as any).payment_receipt as { transfer_id?: string } | undefined;

        if (!paymentReceipt?.transfer_id) {
          task.status = { state: "FAILED", timestamp: new Date().toISOString() };
          const headers402 = build402Headers(pricing, targetAgentName, subTargetOrgId);
          return { error: c.json(jsonrpcError(body.id || null, -32000, "Payment required"), {
            status: 402 as any,
            headers: headers402,
          }) };
        }

        const verification = await verifyPaymentReceipt(sql, paymentReceipt.transfer_id, subTargetOrgId, pricing.price_per_task_usd);
        if (!verification.valid) {
          task.status = { state: "FAILED", timestamp: new Date().toISOString() };
          return { error: c.json(jsonrpcError(body.id || null, -32000, `Payment verification failed: ${verification.error}`), 402 as any) };
        }
      }
    }

    return { targetAgentName };
  });

  if (subGateResult.error) return subGateResult.error;
  const targetAgentName = subGateResult.targetAgentName;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const resp = await c.env.RUNTIME.fetch(
          new Request("https://runtime/runtime-proxy/runnable/stream", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              agent_name: targetAgentName,
              input: text,
              org_id: user.org_id,
              project_id: user.project_id,
              channel: "a2a",
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
