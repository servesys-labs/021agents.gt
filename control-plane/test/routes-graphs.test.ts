import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { graphRoutes } from "../src/routes/graphs";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDb: vi.fn(),
  getDbForOrg: vi.fn(),
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
  app.route("/", graphRoutes);
  return app;
}

describe("graph gate-pack validation and ownership", () => {
  it("requires agent_name in request payload", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");
    const res = await app.request(
      "/gate-pack",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strict_graph_lint: true }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("denies gate-pack when agent is not owned by org", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT 1 FROM agents")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request(
      "/gate-pack",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_name: "agent-x",
          graph: { nodes: [{ id: "start", kind: "input" }], edges: [] },
          strict_graph_lint: true,
        }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("contracts validate returns summary with contracts", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");
    const res = await app.request(
      "/contracts/validate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: {
            nodes: [
              { id: "start", type: "input" },
              { id: "llm", type: "llm" },
              { id: "finish", type: "output" },
            ],
            edges: [
              { from: "start", to: "llm" },
              { from: "llm", to: "finish" },
            ],
          },
          strict: true,
        }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      valid?: boolean;
      summary?: { contracts?: unknown };
    };
    expect(typeof payload.valid).toBe("boolean");
    expect(payload.summary && "contracts" in payload.summary).toBe(true);
  });
});
