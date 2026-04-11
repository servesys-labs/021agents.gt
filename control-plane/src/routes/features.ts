/**
 * Phase 7.3: Feature flag management endpoints.
 */
import { createOpenAPIRouter } from "../lib/openapi";

const DEFAULTS: Record<string, boolean> = {
  concurrent_tools: true,
  deferred_tool_loading: true,
  context_compression: true,
  scratchpad: true,
  detailed_cost_tracking: true,
  mailbox_ipc: true,
  idle_watchdog: true,
  prompt_caching: true,
};

export const featuresRoutes = createOpenAPIRouter();

// GET /features — list all flags for the user's org
featuresRoutes.get("/", async (c) => {
  const user = c.get("user");
  const kv = (c.env as any).AGENT_PROGRESS_KV;
  if (!kv) return c.json({ ...DEFAULTS });

  const cacheKey = user.org_id || "global";
  try {
    const raw = await kv.get(`features/${cacheKey}`);
    const flags = raw ? JSON.parse(raw) : {};
    return c.json({ ...DEFAULTS, ...flags });
  } catch {
    return c.json({ ...DEFAULTS });
  }
});

// POST /features/:flag — set flag value
featuresRoutes.post("/:flag", async (c) => {
  const user = c.get("user");
  if (user.role !== "owner" && user.role !== "admin") {
    return c.json({ error: "Only org owners/admins can toggle feature flags" }, 403);
  }

  const flag = c.req.param("flag");
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  const value = body.enabled !== false;

  const kv = (c.env as any).AGENT_PROGRESS_KV;
  if (!kv) {
    console.error("[features] AGENT_PROGRESS_KV binding is missing");
    return c.json({ error: "Feature flags are temporarily unavailable. Contact support." }, 503);
  }

  const cacheKey = user.org_id || "global";
  const raw = await kv.get(`features/${cacheKey}`);
  const flags = raw ? JSON.parse(raw) : {};
  flags[flag] = value;
  await kv.put(`features/${cacheKey}`, JSON.stringify(flags));
  return c.json({ flag, enabled: value });
});

// DELETE /features/:flag — reset to default
featuresRoutes.delete("/:flag", async (c) => {
  const user = c.get("user");
  if (user.role !== "owner" && user.role !== "admin") {
    return c.json({ error: "Only org owners/admins can toggle feature flags" }, 403);
  }

  const flag = c.req.param("flag");
  const kv = (c.env as any).AGENT_PROGRESS_KV;
  if (!kv) {
    console.error("[features] AGENT_PROGRESS_KV binding is missing");
    return c.json({ error: "Feature flags are temporarily unavailable. Contact support." }, 503);
  }

  const cacheKey = user.org_id || "global";
  const raw = await kv.get(`features/${cacheKey}`);
  const flags = raw ? JSON.parse(raw) : {};
  delete flags[flag];
  await kv.put(`features/${cacheKey}`, JSON.stringify(flags));
  return c.json({ flag, enabled: DEFAULTS[flag] ?? false, reset: true });
});
