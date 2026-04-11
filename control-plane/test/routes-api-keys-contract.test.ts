import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv, buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

// Shared tagged-template sql mock — individual tests replace its
// implementation by assigning mockSql directly.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;

vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

// Route import MUST come after the vi.mock call so the mocked db/client
// is resolved when the routes file loads.
import { apiKeyRoutes } from "../src/routes/api-keys";

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
    mockSql = (async (strings: TemplateStringsArray) => {
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
    }) as unknown as MockSqlFn;

    const app = buildApp();
    const res = await app.request("/", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]?.key_prefix).toBe("ak_12345678");
    expect(payload[0]?.name).toBe("prod");
  });
});
