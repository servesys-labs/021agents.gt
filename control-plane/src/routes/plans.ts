/**
 * Plans router — list and create LLM plans.
 * Ported from agentos/api/routers/plans.py
 *
 * Built-in plans are read from repo config/default.json. Custom plans persist in
 * project_configs (edge parity for agentos.yaml plans).
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import rawDefault from "../../../config/default.json";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const plansRoutes = new Hono<R>();

const ALL_TIERS = [
  "simple",
  "moderate",
  "complex",
  "tool_call",
  "image_gen",
  "vision",
  "tts",
  "stt",
] as const;

const MULTIMODAL_TOP = new Set(["image_gen", "vision", "tts", "stt"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function summarizePlan(plan: Record<string, unknown>): {
  description: string;
  tiers: Record<string, Record<string, unknown>>;
  multimodal: boolean;
} {
  const tiers: Record<string, Record<string, unknown>> = {};
  for (const tier of ALL_TIERS) {
    if (!(tier in plan)) continue;
    const raw = plan[tier];
    if (!isRecord(raw)) continue;
    const tierData: Record<string, unknown> = {
      model: String(raw.model ?? ""),
      provider: String(raw.provider ?? ""),
    };
    if ("max_tokens" in raw) tierData.max_tokens = raw.max_tokens;
    if ("per_request" in raw) tierData.per_request = raw.per_request;
    if (raw.dedicated) tierData.dedicated = true;
    tiers[tier] = tierData;
  }
  return {
    description: String(plan._description ?? ""),
    tiers,
    multimodal: [...MULTIMODAL_TOP].some((t) => t in plan),
  };
}

function getBuiltinPlans(): Record<string, unknown> {
  const raw = rawDefault as { llm?: { plans?: Record<string, unknown> } };
  return raw.llm?.plans ?? {};
}

plansRoutes.get("/", (c) => {
  const plans = getBuiltinPlans();
  const result: Record<string, ReturnType<typeof summarizePlan>> = {};
  for (const [name, plan] of Object.entries(plans)) {
    if (!isRecord(plan)) continue;
    result[name] = summarizePlan(plan);
  }
  return c.json({ plans: result });
});

plansRoutes.get("/:name", (c) => {
  const name = c.req.param("name");
  const builtin = getBuiltinPlans()[name];
  if (isRecord(builtin)) {
    return c.json({ name, plan: builtin });
  }
  return c.json({ error: `Plan '${name}' not found` });
});

plansRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (!user.org_id) {
    return c.json({ error: "Organization required to save a custom plan" }, 400);
  }

  let name = "";
  let simpleModel = "";
  let moderateModel = "";
  let complexModel = "";
  let toolCallModel = "";
  let provider = "openrouter";

  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      name = String(body.name ?? "");
      simpleModel = String(body.simple_model ?? body.simple ?? "");
      moderateModel = String(body.moderate_model ?? body.moderate ?? "");
      complexModel = String(body.complex_model ?? body.complex ?? "");
      toolCallModel = String(body.tool_call_model ?? body.tool_call ?? "");
      if (body.provider !== undefined && body.provider !== null) {
        provider = String(body.provider);
      }
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
  } else {
    const q = c.req.query();
    name = q.name ?? "";
    simpleModel = q.simple_model ?? "";
    moderateModel = q.moderate_model ?? "";
    complexModel = q.complex_model ?? "";
    toolCallModel = q.tool_call_model ?? "";
    if (q.provider) provider = q.provider;
  }

  if (!name.trim()) return c.json({ error: "name is required" }, 400);
  if (!simpleModel.trim() || !moderateModel.trim() || !complexModel.trim()) {
    return c.json({ error: "simple_model, moderate_model, and complex_model are required" }, 400);
  }

  const toolModel = toolCallModel.trim() || moderateModel;
  const planEntry = {
    _description: `Custom plan: ${name}`,
    simple: { provider, model: simpleModel, max_tokens: 1024 },
    moderate: { provider, model: moderateModel, max_tokens: 4096 },
    complex: { provider, model: complexModel, max_tokens: 8192 },
    tool_call: { provider, model: toolModel, max_tokens: 4096 },
  };

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const now = Date.now() / 1000;

  let existing: Record<string, unknown> = {};
  try {
    const rows = await sql`
      SELECT config_json FROM project_configs WHERE org_id = ${user.org_id} LIMIT 1
    `;
    if (rows.length > 0) existing = JSON.parse(String(rows[0].config_json || "{}"));
  } catch {
    return c.json({ error: "Failed to load project config" }, 500);
  }

  const plans = isRecord(existing.plans) ? { ...existing.plans } : {};
  plans[name] = planEntry;
  const merged = { ...existing, plans };
  const configJson = JSON.stringify(merged);

  try {
    await sql`
      INSERT INTO project_configs (org_id, config_json, updated_at)
      VALUES (${user.org_id}, ${configJson}, ${now})
      ON CONFLICT (org_id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = EXCLUDED.updated_at
    `;
  } catch {
    return c.json({ error: "Failed to save project config" }, 500);
  }

  return c.json({ created: name });
});
