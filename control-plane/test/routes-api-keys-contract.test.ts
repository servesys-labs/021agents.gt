import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { apiKeyRoutes } from "../src/routes/api-keys";
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
  app.route("/", apiKeyRoutes);
  return app;
}

describe("api-keys route contracts", () => {
  it("list returns array with key_prefix field", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM api_keys")) {
        return [
          {
            key_id: "k1",
            name: "prod",
            key_prefix: "ak_12345678",
            scopes: '["*"]',
            project_id: "",
            env: "",
            created_at: 1700000000,
            last_used_at: null,
            is_active: 1,
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp();
    const res = await app.request("/", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]?.key_prefix).toBe("ak_12345678");
    expect(payload[0]?.name).toBe("prod");
  });
});
