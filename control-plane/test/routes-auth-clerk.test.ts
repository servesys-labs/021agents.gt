import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDb: vi.fn(),
  getDbForOrg: vi.fn(),
}));

vi.mock("../src/auth/clerk", () => ({
  clerkEnabled: () => true,
  verifyClerkToken: vi.fn(),
}));

import { getDb, getDbForOrg } from "../src/db/client";
import { verifyClerkToken } from "../src/auth/clerk";
import { authRoutes } from "../src/routes/auth";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function buildApp() {
  const app = new Hono<AppType>();
  app.route("/", authRoutes);
  return app;
}

describe("auth clerk exchange parity", () => {
  it("maps Clerk org role and upserts org membership", async () => {
    let insertedRole: string | null = null;

    vi.mocked(verifyClerkToken).mockResolvedValue({
      sub: "clerk-user-1",
      email: "clerk@test.com",
      name: "Clerk User",
      provider: "clerk",
      org_id: "org_ext_1",
      role: "org:admin",
      iat: 1,
      exp: 9999999999,
    });

    const mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("SELECT user_id, email, name FROM users WHERE user_id")) return [];
      if (query.includes("SELECT user_id, email, name FROM users WHERE email")) return [];
      if (query.includes("INSERT INTO users")) return [];
      if (query.includes("SELECT org_id FROM orgs WHERE slug")) return [{ org_id: "org-internal-1" }];
      if (query.includes("SELECT role FROM org_members WHERE org_id")) return [];
      if (query.includes("INSERT INTO org_members")) {
        insertedRole = String(values[2] || "");
        return [];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp();
    const env = mockEnv({
      AUTH_JWT_SECRET: "test-secret",
      CLERK_ISSUER: "https://clerk.example.com",
      CLERK_AUDIENCE: "aud-1",
    });

    const res = await app.request(
      "/clerk/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clerk_token: "clerk-token" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as { provider?: string; org_id?: string; token?: string };
    expect(payload.provider).toBe("clerk");
    expect(payload.org_id).toBe("org-internal-1");
    expect(typeof payload.token).toBe("string");
    expect(insertedRole).toBe("admin");
  });
});
