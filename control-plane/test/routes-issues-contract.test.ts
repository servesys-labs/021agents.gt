import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { issueRoutes } from "../src/routes/issues";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDb: vi.fn(),
  getDbForOrg: vi.fn(),
}));

import { getDb, getDbForOrg } from "../src/db/client";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: "org-a",
    project_id: "",
    env: "",
    role: "admin",
    scopes: ["*"],
    auth_method: "jwt",
  };
}

function buildApp() {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser());
    await next();
  });
  app.route("/", issueRoutes);
  return app;
}

describe("issues route contracts", () => {
  it("GET /:issue_id returns issue_id in payload", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT * FROM issues WHERE issue_id")) {
        return [
          {
            issue_id: "iss-123",
            org_id: "org-a",
            agent_name: "agent-a",
            title: "Example issue",
            status: "open",
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp();
    const res = await app.request("/iss-123", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as Record<string, unknown>;
    expect(payload.issue_id).toBe("iss-123");
    expect(payload.title).toBe("Example issue");
  });
});
