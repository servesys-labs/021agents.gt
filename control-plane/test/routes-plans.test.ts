import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { plansRoutes } from "../src/routes/plans";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDb: vi.fn(),
  getDbForOrg: vi.fn(),
}));

import { getDb, getDbForOrg } from "../src/db/client";
import rawDefault from "../../config/default.json";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(orgId: string): CurrentUser {
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

function buildApp(orgId: string) {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser(orgId));
    await next();
  });
  app.route("/", plansRoutes);
  return app;
}

describe("plans routes", () => {
  it("GET / lists built-in plans with tier metadata shape", async () => {
    const app = buildApp("org-a");
    const res = await app.request("/", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { plans?: Record<string, { description?: string; tiers?: unknown; multimodal?: boolean }> };
    expect(payload.plans).toBeDefined();
    const builtin = (rawDefault as { llm?: { plans?: Record<string, unknown> } }).llm?.plans ?? {};
    expect(Object.keys(payload.plans!).sort()).toEqual(Object.keys(builtin).sort());
    const basic = payload.plans!.basic;
    expect(basic).toBeDefined();
    expect(typeof basic.description).toBe("string");
    expect(typeof basic.multimodal).toBe("boolean");
    expect(basic.tiers).toBeDefined();
  });

  it("GET /:name returns plan payload for built-in name", async () => {
    const app = buildApp("org-a");
    const res = await app.request("/standard", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { name?: string; plan?: Record<string, unknown>; error?: string };
    expect(payload.error).toBeUndefined();
    expect(payload.name).toBe("standard");
    expect(payload.plan).toBeDefined();
    expect(String(payload.plan?._description ?? "")).toContain("Production");
  });

  it("GET /:name returns not-found error payload", async () => {
    const app = buildApp("org-a");
    const res = await app.request("/no-such-plan-xyz", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { error?: string };
    expect(payload.error).toContain("not found");
  });

  it("POST / rejects missing org", async () => {
    const app = new Hono<AppType>();
    app.use("*", async (c, next) => {
      c.set("user", { ...makeUser(""), org_id: "" });
      await next();
    });
    app.route("/", plansRoutes);

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "custom-a",
          simple_model: "m1",
          moderate_model: "m2",
          complex_model: "m3",
        }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("POST / merges custom plan into project_configs", async () => {
    const mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("SELECT config FROM project_configs")) {
        return [{ config: '{"other":1,"plans":{"old":{"_description":"x"}}}' }];
      }
      if (query.includes("INSERT INTO project_configs")) {
        const orgId = values[0];
        const configJson = values[1] as string;
        expect(orgId).toBe("org-a");
        const parsed = JSON.parse(configJson) as { plans?: Record<string, unknown>; other?: number };
        expect(parsed.other).toBe(1);
        expect(parsed.plans?.old).toBeDefined();
        const custom = parsed.plans?.myplan as Record<string, unknown> | undefined;
        expect(custom?._description).toBe("Custom plan: myplan");
        expect((custom?.simple as { model?: string })?.model).toBe("s-model");
        expect((custom?.tool_call as { model?: string })?.model).toBe("t-model");
        expect((custom?.moderate as { provider?: string })?.provider).toBe("anthropic");
        return [];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "myplan",
          simple_model: "s-model",
          moderate_model: "m-model",
          complex_model: "c-model",
          tool_call_model: "t-model",
          provider: "anthropic",
        }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { created?: string; error?: string };
    expect(payload.created).toBe("myplan");
  });

  it("POST / defaults tool_call tier to moderate when tool_call_model empty", async () => {
    const mockSql2 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("SELECT config")) return [{ config: "{}" }];
      if (query.includes("INSERT INTO project_configs")) {
        const configJson = values[1] as string;
        const parsed = JSON.parse(configJson) as { plans?: Record<string, unknown> };
        expect((parsed.plans?.p1 as { tool_call?: { model?: string } })?.tool_call?.model).toBe("mod-here");
        return [];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);

    const app = buildApp("org-a");
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "p1",
          simple_model: "a",
          moderate_model: "mod-here",
          complex_model: "b",
        }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
  });
});
