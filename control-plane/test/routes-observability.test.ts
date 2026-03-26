import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { observabilityRoutes } from "../src/routes/observability";
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
  app.route("/", observabilityRoutes);
  return app;
}

describe("observability ownership and maintenance contracts", () => {
  it("meta-proposals listing denies non-owned agents", async () => {
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("COUNT(*) as cnt FROM sessions")) return [{ cnt: 0 }];
      if (query.includes("COUNT(*) as cnt FROM agents")) return [{ cnt: 0 }];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request("/agents/agent-x/meta-proposals", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("maintenance dry_run keeps persisted=false even when persist_proposals=true", async () => {
    const mockSql2 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("COUNT(*) as cnt FROM sessions")) return [{ cnt: 1 }];
      if (query.includes("COUNT(*) as cnt FROM agents")) return [{ cnt: 1 }];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);

    const app = buildApp("org-a");
    const res = await app.request(
      "/agents/agent-x/autonomous-maintenance-run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true, persist_proposals: true }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      proposals?: { persisted?: boolean };
      dry_run?: boolean;
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.proposals?.persisted).toBe(false);
  });

  it("meta-control-plane returns expected contract sections", async () => {
    const mockSql3 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM sessions WHERE agent_name")) {
        return [{ total: 2, avg_turns: 4, success_rate: 0.5, avg_cost: 0.2 }];
      }
      if (query.includes("FROM eval_runs")) {
        return [{ pass_rate: 0.8, total_trials: 10 }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql3);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql3);

    const app = buildApp("org-a");
    const res = await app.request("/agents/agent-x/meta-control-plane", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      agent_name?: string;
      signals?: Record<string, unknown>;
      entrypoints?: Record<string, unknown>;
    };
    expect(payload.agent_name).toBe("agent-x");
    expect(typeof payload.signals).toBe("object");
    expect(typeof payload.entrypoints).toBe("object");
    expect(payload.entrypoints && "agent_crud" in payload.entrypoints).toBe(true);
    expect(payload.entrypoints && "graph_design" in payload.entrypoints).toBe(true);
  });

  it("annotations validates required fields", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");
    const missingTrace = await app.request(
      "/annotations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      },
      mockEnv(),
    );
    expect(missingTrace.status).toBe(400);

    const missingMessage = await app.request(
      "/annotations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trace_id: "trace-1" }),
      },
      mockEnv(),
    );
    expect(missingMessage.status).toBe(400);
  });

  it("summary returns numeric observability metrics contract", async () => {
    const mockSql4 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM sessions WHERE org_id")) {
        return [{ total: 5, cost: 1.2, avg_latency: 2.3, success_rate: 0.8 }];
      }
      if (query.includes("FROM billing_records WHERE org_id")) {
        return [{ total_cost: 3.4, input_tokens: 100, output_tokens: 200 }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql4);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql4);

    const app = buildApp("org-a");
    const res = await app.request("/summary?since_days=14", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as Record<string, unknown>;
    expect(typeof payload.total_sessions).toBe("number");
    expect(typeof payload.total_cost_usd).toBe("number");
    expect(typeof payload.avg_latency_seconds).toBe("number");
    expect(typeof payload.success_rate).toBe("number");
    expect(typeof payload.total_input_tokens).toBe("number");
    expect(typeof payload.total_output_tokens).toBe("number");
    expect(payload.since_days).toBe(14);
  });

  it("trace returns sessions and events for owned trace", async () => {
    const mockSql5 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("COUNT(*) as cnt FROM sessions WHERE trace_id")) return [{ cnt: 1 }];
      if (query.includes("SELECT * FROM sessions WHERE trace_id")) {
        return [{ session_id: "sess-1", trace_id: "trace-1", org_id: "org-a" }];
      }
      if (query.includes("SELECT * FROM runtime_events WHERE trace_id")) {
        return [{ event_id: "evt-1", trace_id: "trace-1", org_id: "org-a" }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql5);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql5);

    const app = buildApp("org-a");
    const res = await app.request("/trace/trace-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { trace_id?: string; sessions?: unknown[]; events?: unknown[] };
    expect(payload.trace_id).toBe("trace-1");
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.sessions?.length).toBe(1);
  });
});
