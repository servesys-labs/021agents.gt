import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { evolveRoutes } from "../src/routes/evolve";
import { mockEnv } from "./helpers/test-env";

vi.mock("../src/db/client", () => ({
  getDbForOrg: vi.fn(),
}));

import { getDbForOrg } from "../src/db/client";

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
    scopes: ["evolve:read", "evolve:write"],
    auth_method: "jwt",
  };
}

describe("evolve apply autopilot gates", () => {
  it("allows manual apply without autopilot body", async () => {
    const sql = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const q = strings.join("?");
      if (q.includes("FROM evolution_proposals")) {
        return Promise.resolve([
          {
            proposal_id: "p1",
            agent_name: "a1",
            org_id: "org-a",
            status: "approved",
            title: "t",
            config_diff_json: "{}",
          },
        ]);
      }
      if (q.includes("FROM agents") && q.includes("config")) {
        return Promise.resolve([{ config: "{}" }]);
      }
      if (q.includes("FROM sessions") && q.includes("agent_name")) {
        return Promise.resolve([
          { session_id: "s1", status: "success", cost_total_usd: 0, step_count: 1 },
        ]);
      }
      if (q.includes("FROM conversation_analytics")) {
        return Promise.resolve([]);
      }
      if (q.includes("FROM eval_runs")) {
        return Promise.resolve([]);
      }
      if (q.includes("FROM evolution_reports") && q.includes("ORDER BY created_at DESC")) {
        return Promise.resolve([]);
      }
      if (q.includes("UPDATE agents SET config")) {
        return Promise.resolve([]);
      }
      if (q.includes("INSERT INTO evolution_ledger")) {
        return Promise.resolve([]);
      }
      if (q.includes("UPDATE evolution_reports SET report")) {
        return Promise.resolve([]);
      }
      if (q.includes("UPDATE evolution_proposals SET status = 'applied'")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    vi.mocked(getDbForOrg).mockResolvedValue(sql as any);

    const app = new Hono<AppType>();
    app.use("*", async (c, next) => {
      c.set("user", makeUser());
      await next();
    });
    app.route("/api/v1/evolve", evolveRoutes);

    const res = await app.request(
      "http://localhost/api/v1/evolve/a1/proposals/p1/apply",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied?: boolean; autopilot?: boolean };
    expect(body.applied).toBe(true);
    expect(body.autopilot).toBe(false);
  });

  it("blocks autopilot apply when gates fail", async () => {
    const sql = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const q = strings.join("?");
      if (q.includes("FROM evolution_proposals")) {
        return Promise.resolve([
          {
            proposal_id: "p1",
            agent_name: "a1",
            org_id: "org-a",
            status: "approved",
            title: "t",
            config_diff_json: "{}",
          },
        ]);
      }
      if (q.includes("FROM agents") && q.includes("config")) {
        return Promise.resolve([{ config: "{}" }]);
      }
      if (q.includes("FROM sessions") && q.includes("agent_name")) {
        return Promise.resolve([]);
      }
      if (q.includes("FROM eval_runs")) {
        return Promise.resolve([]);
      }
      if (q.includes("FROM evolution_reports") && q.includes("ORDER BY created_at DESC LIMIT 1")) {
        return Promise.resolve([
          { report: JSON.stringify({ success_rate: 0.5 }), session_count: 3, created_at: 1 },
        ]);
      }
      return Promise.resolve([]);
    });

    vi.mocked(getDbForOrg).mockResolvedValue(sql as any);

    const app = new Hono<AppType>();
    app.use("*", async (c, next) => {
      c.set("user", makeUser());
      await next();
    });
    app.route("/api/v1/evolve", evolveRoutes);

    const res = await app.request(
      "http://localhost/api/v1/evolve/a1/proposals/p1/apply",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autopilot: true }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("autopilot_apply_blocked");
  });
});
