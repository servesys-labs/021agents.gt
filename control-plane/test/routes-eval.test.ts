import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { evalRoutes } from "../src/routes/eval";
import { mockEnv, mockR2Bucket } from "./helpers/test-env";

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
  app.route("/", evalRoutes);
  return app;
}

describe("eval routes contracts", () => {
  it("returns 400 when run is missing agent_name", async () => {
    const app = buildApp();
    const env = mockEnv();
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: [{ name: "t1", input: "x", expected: "y" }] }),
    }, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 when run is missing tasks", async () => {
    const app = buildApp();
    const env = mockEnv();
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_name: "agent-a", tasks: [] }),
    }, env);
    expect(res.status).toBe(400);
  });

  it("proxies run to runtime worker", async () => {
    const app = buildApp("org-a");
    const env = mockEnv({
      RUNTIME: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          expect(url).toContain("/api/v1/eval/run");
          expect((init?.method || "GET").toUpperCase()).toBe("POST");
          return new Response(
            JSON.stringify({ run_id: "run-1", pass_rate: 0.9, total_trials: 3, total_tasks: 1 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      } as unknown as Fetcher,
    });

    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: "agent-a",
        eval_name: "smoke",
        trials: 3,
        tasks: [{ name: "task-1", input: "hi", expected: "hello", grader: "contains" }],
      }),
    }, env);
    expect(res.status).toBe(200);
    const payload = await res.json() as { run_id?: string };
    expect(payload.run_id).toBe("run-1");
  });

  it("preserves runtime failure status and error envelope", async () => {
    const app = buildApp("org-a");
    const env = mockEnv({
      RUNTIME: {
        fetch: async () => new Response("downstream unavailable", { status: 502 }),
      } as unknown as Fetcher,
    });
    const res = await app.request("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: "agent-a",
        eval_name: "smoke",
        tasks: [{ name: "task-1", input: "hi", expected: "hello", grader: "contains" }],
      }),
    }, env);
    expect(res.status).toBe(502);
    const payload = await res.json() as { error?: string };
    expect(payload.error || "").toMatch(/downstream unavailable/i);
  });

  it("lists only org-scoped datasets from R2 prefix", async () => {
    const app = buildApp("org-a");
    const bucket = mockR2Bucket();
    await bucket.put("org-a/eval/datasets/ds-a.json", JSON.stringify([{ input: "a" }]));
    await bucket.put("org-b/eval/datasets/ds-b.json", JSON.stringify([{ input: "b" }]));
    const env = mockEnv({ STORAGE: bucket });

    const res = await app.request("/datasets", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const payload = await res.json() as { datasets?: Array<{ name: string }> };
    const names = (payload.datasets || []).map((d) => d.name);
    expect(names).toContain("ds-a");
    expect(names).not.toContain("ds-b");
  });
});
