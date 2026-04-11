/**
 * Plans router — list and create LLM plans.
 *
 * Built-in plans are read from repo config/default.json. Custom plans persist in
 * project_configs (edge parity for agentos.yaml plans).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { withOrgDb } from "../db/client";
import rawDefault from "../../../config/default.json";
import { parseJsonColumn } from "../lib/parse-json-column";

export const plansRoutes = createOpenAPIRouter();

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

// ── GET / — List all built-in plans ─────────────────────────────────

const listPlansRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Plans"],
  summary: "List all built-in LLM plans",
  responses: {
    200: {
      description: "Plan list",
      content: { "application/json": { schema: z.object({ plans: z.record(z.unknown()) }) } },
    },
  },
});

plansRoutes.openapi(listPlansRoute, (c): Promise<any> => {
  const plans = getBuiltinPlans();
  const result: Record<string, ReturnType<typeof summarizePlan>> = {};
  for (const [name, plan] of Object.entries(plans)) {
    if (!isRecord(plan)) continue;
    result[name] = summarizePlan(plan);
  }
  return c.json({ plans: result }) as any;
});

// ── GET /:name — Get a specific plan by name ────────────────────────

const getPlanRoute = createRoute({
  method: "get",
  path: "/{name}",
  tags: ["Plans"],
  summary: "Get a specific LLM plan by name",
  request: {
    params: z.object({ name: z.string().openapi({ example: "default" }) }),
  },
  responses: {
    200: {
      description: "Plan details",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});

plansRoutes.openapi(getPlanRoute, (c): Promise<any> => {
  const { name } = c.req.valid("param");
  const builtin = getBuiltinPlans()[name];
  if (isRecord(builtin)) {
    return c.json({ name, plan: builtin }) as any;
  }
  return c.json({ error: `Plan '${name}' not found` }) as any;
});

// ── POST / — Create a custom plan ───────────────────────────────────

const createPlanRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Plans"],
  summary: "Create a custom LLM plan",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).openapi({ example: "my-custom-plan" }),
            simple_model: z.string().min(1).openapi({ example: "gpt-4o-mini" }),
            moderate_model: z.string().min(1).openapi({ example: "gpt-4o" }),
            complex_model: z.string().min(1).openapi({ example: "claude-sonnet-4-20250514" }),
            tool_call_model: z.string().optional().openapi({ example: "gpt-4o" }),
            provider: z.string().default("openrouter").openapi({ example: "openrouter" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Plan created",
      content: { "application/json": { schema: z.object({ created: z.string() }) } },
    },
    ...errorResponses(400, 500),
  },
});

plansRoutes.openapi(createPlanRoute, async (c): Promise<any> => {
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
      const body = c.req.valid("json");
      name = String(body.name ?? "");
      simpleModel = String(body.simple_model ?? "");
      moderateModel = String(body.moderate_model ?? "");
      complexModel = String(body.complex_model ?? "");
      toolCallModel = String(body.tool_call_model ?? "");
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

  const now = new Date().toISOString();

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    let existing: Record<string, unknown> = {};
    try {
      const rows = await sql`
        SELECT config FROM project_configs LIMIT 1
      `;
      if (rows.length > 0) existing = parseJsonColumn(rows[0].config);
    } catch {
      return c.json({ error: "Failed to load project config" }, 500);
    }

    const plans = isRecord(existing.plans) ? { ...existing.plans } : {};
    plans[name] = planEntry;
    const merged = { ...existing, plans };
    const configJson = JSON.stringify(merged);

    try {
      await sql`
        INSERT INTO project_configs (org_id, config, updated_at)
        VALUES (${user.org_id}, ${configJson}, ${now})
        ON CONFLICT (org_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
      `;
    } catch {
      return c.json({ error: "Failed to save project config" }, 500);
    }

    return c.json({ created: name });
  });
});
