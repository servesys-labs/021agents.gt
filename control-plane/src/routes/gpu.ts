/**
 * GPU router — manage dedicated GPU endpoints (placeholder CRUD).
 * Ported from agentos/api/routers/gpu.py
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const gpuRoutes = new Hono<R>();

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HOURLY_RATES: Record<string, number> = { h100: 2.98, h200: 3.98 };

gpuRoutes.get("/endpoints", requireScope("gpu:read"), async (c) => {
  const user = c.get("user");
  const status = c.req.query("status") || "";
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

gpuRoutes.post("/endpoints", requireScope("gpu:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const modelId = String(body.model_id || "").trim();
  const gpuType = String(body.gpu_type || "h200");
  const gpuCount = Math.max(1, Math.min(8, Number(body.gpu_count || 1)));

  if (!modelId) return c.json({ error: "model_id is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const endpointId = genId();
  const hourlyRate = HOURLY_RATES[gpuType] ?? 3.98;
  const now = Date.now() / 1000;

  await sql`
    INSERT INTO gpu_endpoints (endpoint_id, org_id, model_id, api_base, gpu_type, gpu_count, hourly_rate_usd, status, created_at)
    VALUES (${endpointId}, ${user.org_id}, ${modelId}, ${`https://dedicated-${endpointId}.gmi-serving.com/v1`},
            ${gpuType}, ${gpuCount}, ${hourlyRate}, 'provisioning', ${now})
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

gpuRoutes.delete("/endpoints/:endpoint_id", requireScope("gpu:write"), async (c) => {
  const user = c.get("user");
  const endpointId = c.req.param("endpoint_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const rows = await sql`
    SELECT * FROM gpu_endpoints WHERE endpoint_id = ${endpointId} AND org_id = ${user.org_id}
  `;
  if (rows.length === 0) return c.json({ error: "GPU endpoint not found" }, 404);

  const endpoint = rows[0] as any;
  const now = Date.now() / 1000;
  const createdAt = Number(endpoint.created_at || now);
  const hours = Math.max(0, (now - createdAt) / 3600);
  const costUsd = Math.round(hours * Number(endpoint.hourly_rate_usd || 3.98) * 100) / 100;

  await sql`
    UPDATE gpu_endpoints SET status = 'terminated', terminated_at = ${now} WHERE endpoint_id = ${endpointId}
  `;

  // Record billing
  try {
    await sql`
      INSERT INTO billing_records (org_id, cost_type, total_cost_usd, gpu_type, gpu_hours, gpu_cost_usd, description, created_at)
      VALUES (${user.org_id}, 'gpu_compute', ${costUsd}, ${endpoint.gpu_type || "h200"}, ${hours}, ${costUsd},
              ${`Dedicated GPU endpoint ${endpointId}`}, ${now})
    `;
  } catch {}

  return c.json({
    endpoint_id: endpointId,
    status: "terminated",
    hours: Math.round(hours * 100) / 100,
    cost_usd: costUsd,
  });
});
