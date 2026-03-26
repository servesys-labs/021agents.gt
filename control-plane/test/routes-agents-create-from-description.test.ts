import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { agentRoutes } from "../src/routes/agents";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDb: vi.fn(),
  getDbForOrg: vi.fn(),
}));

vi.mock("../src/logic/meta-agent", () => ({
  defaultNoCodeGraph: () => ({ nodes: [{ id: "start", kind: "input" }], edges: [] }),
  buildFromDescription: async () => ({
    name: "generated-agent",
    description: "Generated",
    model: "test-model",
    tools: [],
    tags: [],
    version: "0.1.0",
    harness: {},
  }),
  recommendTools: () => [],
}));

vi.mock("../src/logic/graph-autofix", () => ({
  lintAndAutofixGraph: () => ({
    autofix_applied: false,
    graph: { nodes: [{ id: "start", kind: "input" }], edges: [] },
    lint_after: { valid: true, errors: [], warnings: [], summary: {} },
  }),
}));

vi.mock("../src/logic/gate-pack", () => ({
  latestEvalGate: async () => ({ latest_eval_run: null, passed: false }),
  rolloutRecommendation: () => ({ decision: "hold", reason: "forced by test" }),
  lintSuggestionsFromErrors: () => [],
}));

import { getDb, getDbForOrg } from "../src/db/client";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(orgId = "org-a"): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: orgId,
    project_id: "",
    env: "",
    role: "admin",
    scopes: ["*"],
    auth_method: "jwt",
  };
}

function buildApp(orgId = "org-a") {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser(orgId));
    await next();
  });
  app.route("/", agentRoutes);
  return app;
}

describe("agents create-from-description hold gate behavior", () => {
  it("returns 409 when rollout is hold and override is missing", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");

    const res = await app.request(
      "/create-from-description",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "create a support agent",
          include_contracts_validate: false,
        }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(409);
    const payload = await res.json() as { override_required?: boolean };
    expect(payload.override_required).toBe(true);
  });

  it("returns 422 when override is requested without reason", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");

    const res = await app.request(
      "/create-from-description",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "create a support agent",
          override_hold: true,
          override_reason: "   ",
          include_contracts_validate: false,
        }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(422);
  });
});
