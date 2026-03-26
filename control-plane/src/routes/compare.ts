/**
 * Compare router — A/B test agent versions.
 * Ported from agentos/api/routers/compare.py
 *
 * The actual eval logic (EvalGym, graders, agent invocation) lives in the
 * runtime worker. The control-plane validates input and proxies to RUNTIME.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const compareRoutes = new Hono<R>();

compareRoutes.post("/", requireScope("compare:read"), async (c) => {
  const body = await c.req.json();
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
