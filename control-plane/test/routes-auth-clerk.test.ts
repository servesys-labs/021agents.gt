import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv, buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

// Shared tagged-template sql mock — individual tests replace its
// implementation by assigning mockSql directly.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;

vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

vi.mock("../src/auth/cf-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/cf-access")>();
  return {
    ...actual,
    cfAccessEnabled: () => true,
    verifyCfAccessToken: vi.fn(),
  };
});

// Route import MUST come after the vi.mock call so the mocked db/client
// is resolved when the routes file loads.
import { verifyCfAccessToken } from "../src/auth/cf-access";
import { authRoutes } from "../src/routes/auth";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function buildApp() {
  const app = new Hono<AppType>();
  app.route("/", authRoutes);
  return app;
}

describe("auth cf-access exchange parity", () => {
  it("maps CF Access identity and upserts org membership", async () => {
    let insertedRole: string | null = null;

    vi.mocked(verifyCfAccessToken).mockResolvedValue({
      sub: "cf-user-1",
      email: "cfuser@test.com",
      name: "CF User",
      provider: "cf_access",
      org_id: "",
      role: "member",
      iat: 1,
      exp: 9999999999,
    });

    mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("SELECT user_id, email, name FROM users WHERE user_id")) return [];
      if (query.includes("SELECT user_id, email, name FROM users WHERE email")) return [];
      if (query.includes("INSERT INTO users")) return [];
      if (query.includes("SELECT org_id, role FROM org_members WHERE user_id")) return [];
      if (query.includes("INSERT INTO orgs")) return [];
      if (query.includes("INSERT INTO org_members")) {
        insertedRole = String(values[2] || "");
        return [];
      }
      if (query.includes("INSERT INTO org_settings")) return [];
      return [];
    }) as unknown as MockSqlFn;

    const app = buildApp();
    const env = mockEnv({
      AUTH_JWT_SECRET: "test-secret",
      CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud-1",
    });

    const res = await app.request(
      "/cf-access/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cf_access_token: "cf-token" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as { provider?: string; org_id?: string; token?: string };
    expect(payload.provider).toBe("cf_access");
    expect(typeof payload.org_id).toBe("string");
    expect(typeof payload.token).toBe("string");
    // New user auto-provision creates org with "owner" role
    expect(insertedRole).toBe("owner");
  });
});
