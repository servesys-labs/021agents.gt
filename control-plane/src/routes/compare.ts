/**
 * Compare router — A/B test agent versions.
 *
 * The actual eval logic (EvalGym, graders, agent invocation) lives in the
 * runtime worker. The control-plane validates input and proxies to RUNTIME.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses } from "../schemas/openapi";
import { requireScope } from "../middleware/auth";

export const compareRoutes = createOpenAPIRouter();

const compareRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Compare"],
  summary: "Run A/B comparison between agent versions",
  middleware: [requireScope("compare:read")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_name: z.string().min(1).openapi({ example: "my-agent" }),
            version_a: z.string().default("current").openapi({ example: "current" }),
            version_b: z.string().default("current").openapi({ example: "current" }),
            eval_file: z.string().default("eval/smoke-test.json").openapi({ example: "eval/smoke-test.json" }),
            trials: z.coerce.number().int().min(1).max(20).default(3).openapi({ example: 3 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Comparison results from runtime",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 500),
  },
});

compareRoutes.openapi(compareRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const agentName = String(body.agent_name || "").trim();
  const versionA = String(body.version_a || "current");
  const versionB = String(body.version_b || "current");
  const evalFile = String(body.eval_file || "eval/smoke-test.json");
  const trials = Math.max(1, Math.min(20, Number(body.trials) || 3));

  if (!agentName) {
    return c.json({ error: "agent_name is required" }, 400);
  }

  // Proxy to RUNTIME service binding — the runtime has access to Agent,
  // EvalGym, and graders needed to execute the comparison.
  const payload = {
    agent_name: agentName,
    version_a: versionA,
    version_b: versionB,
    eval_file: evalFile,
    trials,
  };

  try {
    const resp = await c.env.RUNTIME.fetch("https://runtime/api/v1/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.status >= 400) {
      const text = await resp.text();
      return c.json({ error: text.slice(0, 500) }, resp.status as any);
    }

    return c.json(await resp.json());
  } catch (e: any) {
    return c.json({ error: `Runtime compare proxy failed: ${e.message}` }, 502);
  }
});
