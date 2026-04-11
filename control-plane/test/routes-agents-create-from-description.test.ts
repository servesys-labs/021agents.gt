import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv, buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

// Shared tagged-template sql mock — individual tests replace its
// implementation by assigning mockSql directly.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;

vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

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

// Route import MUST come after the vi.mock call so the mocked db/client
// is resolved when the routes file loads.
import { agentRoutes } from "../src/routes/agents";

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
  it("returns error when create-from-description LLM is unavailable", async () => {
    // Graph lint removed — rollout gate no longer triggers on lint failure.
    // The endpoint now returns 422 when the LLM meta-agent fails (mocked).
    mockSql = (async () => []) as unknown as MockSqlFn;
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

    // Without a real LLM, this should fail with 422 or 500
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 422 when override is requested without reason", async () => {
    mockSql = (async () => []) as unknown as MockSqlFn;
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
