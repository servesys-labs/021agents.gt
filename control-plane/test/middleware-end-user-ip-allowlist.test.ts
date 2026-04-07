import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createToken } from "../src/auth/jwt";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { authMiddleware } from "../src/middleware/auth";
import { ipAllowlistMiddleware } from "../src/middleware/ip-allowlist";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../src/db/client";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function buildApp() {
  const app = new Hono<AppType>();
  app.use("*", authMiddleware);
  app.use("*", ipAllowlistMiddleware);
  app.get("/v1/ping", (c) => c.json({ ok: true }));
  return app;
}

function makeSql(ipAllowlist: unknown) {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM end_user_tokens")) {
      return [{
        token_id: "tok-1",
        api_key_id: "key-1",
        allowed_agents: [],
        rate_limit_rpm: 60,
        rate_limit_rpd: 1000,
        revoked: false,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }];
    }
    if (query.includes("SELECT ip_allowlist FROM api_keys")) {
      return [{ ip_allowlist: ipAllowlist }];
    }
    return [];
  }) as any;
}

async function makeEndUserToken(secret: string): Promise<string> {
  return createToken(secret, "end-user-1", {
    email: "end-user-1@test.com",
    org_id: "org-1",
    extra: {
      type: "end_user",
      api_key_id: "key-1",
      allowed_agents: [],
    },
  });
}

describe("ip allowlist middleware with end-user tokens", () => {
  it("allows request when client IP matches parent API key allowlist", async () => {
    vi.mocked(getDb).mockResolvedValue(makeSql(["203.0.113.10", "198.51.100.0/24"]));
    const app = buildApp();
    const secret = "end-user-test-secret";
    const env = mockEnv({ AUTH_JWT_SECRET: secret });
    const token = await makeEndUserToken(secret);

    const res = await app.request(
      "/v1/ping",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": "198.51.100.42",
        },
      },
      env,
    );

    expect(res.status).toBe(200);
    const payload = await res.json() as { ok?: boolean };
    expect(payload.ok).toBe(true);
  });

  it("rejects request when client IP is outside parent API key allowlist", async () => {
    vi.mocked(getDb).mockResolvedValue(makeSql(["203.0.113.10"]));
    const app = buildApp();
    const secret = "end-user-test-secret";
    const env = mockEnv({ AUTH_JWT_SECRET: secret });
    const token = await makeEndUserToken(secret);

    const res = await app.request(
      "/v1/ping",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": "203.0.113.99",
        },
      },
      env,
    );

    expect(res.status).toBe(403);
    const payload = await res.json() as { error?: string };
    expect(payload.error).toBe("IP address not allowed");
  });
});
