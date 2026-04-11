/**
 * GPU router — manage dedicated GPU endpoints (placeholder CRUD).
 * Ported from agentos/api/routers/gpu.py
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let rows;
    if (status) {
      rows = await sql`
        SELECT * FROM gpu_endpoints WHERE status = ${status}
        ORDER BY created_at DESC
      `;
    } else {
      rows = await sql`
        SELECT * FROM gpu_endpoints ORDER BY created_at DESC
      `;
    }
    return c.json({ endpoints: rows });
  });
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

gpuRoutes.openapi(createEndpointRoute, async (_c): Promise<any> => {
  // Dedicated GPU provisioning is not wired up to a real provider yet.
  // The old implementation wrote a DB row with a fabricated
  // `dedicated-<id>.gmi-serving.com` URL that never resolved, set status
  // to "provisioning", and returned 200 OK — so callers thought they had
  // a working endpoint. Worse, the DELETE path then billed users for
  // hours-since-creation at $3.98/hr on compute that never existed.
  //
  // Until the real provisioning integration lands, refuse the create so
  // no new phantom endpoints accumulate in the billing pipeline.
  return _c.json({
    error: "Dedicated GPU provisioning is not available yet. Contact support if you need this feature.",
    code: "gpu_provisioning_unavailable",
  }, 501);
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
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM gpu_endpoints WHERE id = ${endpointId}
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

    // Only bill if the row actually has a provider-confirmed provisioned_at
    // timestamp in its config. Phantom rows from the legacy create endpoint
    // (which never provisioned anything) have no provisioned_at and must
    // not be charged. When the real GMI integration lands it will set this
    // field after confirming a successful provision.
    const wasReallyProvisioned =
      typeof (endpointConfig as any).provisioned_at === "string" &&
      (endpointConfig as any).provisioned_at.length > 0;
    if (wasReallyProvisioned) {
      try {
        await sql`
          INSERT INTO billing_records (org_id, cost_type, total_cost_usd, model, provider, created_at)
          VALUES (${user.org_id}, 'gpu_compute', ${costUsd}, ${String(endpoint.model || "")}, ${"dedicated"}, ${now})
        `;
        if (costUsd > 0) {
          deductCredits(sql, user.org_id, costUsd, `GPU compute: ${endpointId}`, "", "").catch(() => {});
        }
      } catch {}
    } else {
      console.warn(`[gpu/terminate] Skipping billing for ${endpointId} — no provisioned_at timestamp (phantom row from legacy create endpoint).`);
    }

    return c.json({
      endpoint_id: endpointId,
      status: "terminated",
      hours: Math.round(hours * 100) / 100,
      cost_usd: costUsd,
    });
  });
});
