/**
 * GPU router — manage dedicated GPU endpoints (placeholder CRUD).
 * Ported from agentos/api/routers/gpu.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";
import { deductCredits } from "../logic/credits";

export const gpuRoutes = createOpenAPIRouter();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HOURLY_RATES: Record<string, number> = { h100: 2.98, h200: 3.98 };

// ── GET /endpoints — List GPU endpoints ─────────────────────────────

const listEndpointsRoute = createRoute({
  method: "get",
  path: "/endpoints",
  tags: ["GPU"],
  summary: "List GPU endpoints",
  middleware: [requireScope("gpu:read")],
  request: {
    query: z.object({
      status: z.string().optional().openapi({ example: "running" }),
    }),
  },
  responses: {
    200: {
      description: "GPU endpoint list",
      content: { "application/json": { schema: z.object({ endpoints: z.array(z.record(z.unknown())) }) } },
    },
    ...errorResponses(500),
  },
});

gpuRoutes.openapi(listEndpointsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { status } = c.req.valid("query");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  let rows;
  if (status) {
    rows = await sql`
      SELECT * FROM gpu_endpoints WHERE org_id = ${user.org_id} AND status = ${status}
      ORDER BY created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT * FROM gpu_endpoints WHERE org_id = ${user.org_id} ORDER BY created_at DESC
    `;
  }
  return c.json({ endpoints: rows });
});

// ── POST /endpoints — Create a GPU endpoint ─────────────────────────

const createEndpointRoute = createRoute({
  method: "post",
  path: "/endpoints",
  tags: ["GPU"],
  summary: "Create a dedicated GPU endpoint",
  middleware: [requireScope("gpu:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            model_id: z.string().min(1).openapi({ example: "meta-llama/Llama-3-70b" }),
            gpu_type: z.string().default("h200").openapi({ example: "h200" }),
            gpu_count: z.coerce.number().int().min(1).max(8).default(1).openapi({ example: 1 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "GPU endpoint created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

gpuRoutes.openapi(createEndpointRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const modelId = String(body.model_id || "").trim();
  const gpuType = String(body.gpu_type || "h200");
  const gpuCount = Math.max(1, Math.min(8, Number(body.gpu_count || 1)));

  if (!modelId) return c.json({ error: "model_id is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const endpointId = genId();
  const hourlyRate = HOURLY_RATES[gpuType] ?? 3.98;
  const now = new Date().toISOString();

  const apiBase = `https://dedicated-${endpointId}.gmi-serving.com/v1`;
  const configJson = JSON.stringify({ gpu_type: gpuType, gpu_count: gpuCount, hourly_rate_usd: hourlyRate });
  await sql`
    INSERT INTO gpu_endpoints (id, org_id, name, model, url, provider, status, config, created_at)
    VALUES (${endpointId}, ${user.org_id}, ${`gpu-${endpointId}`}, ${modelId}, ${apiBase},
            ${"dedicated"}, 'provisioning', ${configJson}, ${now})
  `;

  return c.json({
    endpoint_id: endpointId,
    status: "provisioning",
    gpu_type: gpuType,
    gpu_count: gpuCount,
    model_id: modelId,
    hourly_rate_usd: hourlyRate,
  });
});

// ── DELETE /endpoints/:endpoint_id — Terminate a GPU endpoint ───────

const deleteEndpointRoute = createRoute({
  method: "delete",
  path: "/endpoints/{endpoint_id}",
  tags: ["GPU"],
  summary: "Terminate a GPU endpoint",
  middleware: [requireScope("gpu:write")],
  request: {
    params: z.object({ endpoint_id: z.string().openapi({ example: "abc123def456" }) }),
  },
  responses: {
    200: {
      description: "GPU endpoint terminated",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404, 500),
  },
});

gpuRoutes.openapi(deleteEndpointRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { endpoint_id: endpointId } = c.req.valid("param");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM gpu_endpoints WHERE id = ${endpointId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "GPU endpoint not found" }, 404);

  const endpoint = rows[0] as any;
  const endpointConfig = typeof endpoint.config === "object" && endpoint.config ? endpoint.config : {};
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const createdAtMs = endpoint.created_at ? new Date(endpoint.created_at).getTime() : nowMs;
  const hours = Math.max(0, (nowMs - createdAtMs) / 3600000);
  const costUsd = Math.round(hours * Number(endpointConfig.hourly_rate_usd || 3.98) * 100) / 100;

  await sql`
    UPDATE gpu_endpoints SET status = 'terminated', updated_at = ${now} WHERE id = ${endpointId}
  `;

  // Record billing
  try {
    await sql`
      INSERT INTO billing_records (org_id, cost_type, total_cost_usd, model, provider, created_at)
      VALUES (${user.org_id}, 'gpu_compute', ${costUsd}, ${String(endpoint.model || "")}, ${"dedicated"}, ${now})
    `;

    // Fire-and-forget credit deduction for GPU compute cost
    if (costUsd > 0) {
      // deductCredits expects USD, not cents
      deductCredits(sql, user.org_id, costUsd, `GPU compute: ${endpointId}`, "", "").catch(() => {});
    }
  } catch {}

  return c.json({
    endpoint_id: endpointId,
    status: "terminated",
    hours: Math.round(hours * 100) / 100,
    cost_usd: costUsd,
  });
});
