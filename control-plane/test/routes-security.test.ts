import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { securityRoutes } from "../src/routes/security";
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
  app.route("/", securityRoutes);
  return app;
}

describe("security routes contracts", () => {
  it("POST scan selects config from agents", async () => {
    let agentsSql = "";
    const mockSql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM agents") && query.includes("LIMIT 1")) {
        agentsSql = query;
        return [{ config: JSON.stringify({ model: "m", tools: ["web-search"] }) }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request("/scan/agent-a?scan_type=config", { method: "POST" }, mockEnv());
    expect(res.status).toBe(200);
    expect(agentsSql).toContain("config");
    expect(agentsSql).not.toContain("SELECT config FROM");
    const payload = await res.json() as { agent_name?: string; scan_id?: string };
    expect(payload.agent_name).toBe("agent-a");
    expect(typeof payload.scan_id).toBe("string");
  });

  it("returns probe catalog", async () => {
    const app = buildApp("org-a");
    const res = await app.request("/probes", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as { probes?: unknown[] };
    expect(Array.isArray(payload.probes)).toBe(true);
    expect((payload.probes || []).length).toBeGreaterThan(0);
  });

  it("findings query remains org-scoped for severity filter", async () => {
    let capturedOrgId: string | null = null;
    const mockSql2 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM security_findings") && query.includes("severity")) {
        capturedOrgId = String(values[0]);
        return [{ org_id: values[0], severity: values[2], title: "finding" }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);
    const app = buildApp("org-a");
    const res = await app.request("/findings?severity=high&limit=10", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    expect(capturedOrgId).toBe("org-a");
    const payload = await res.json() as { findings?: Array<{ org_id?: string }> };
    expect(payload.findings?.[0]?.org_id).toBe("org-a");
  });

  it("returns 404 for scan report outside org scope", async () => {
    const mockSql3 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM security_scans WHERE scan_id")) return [];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql3);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql3);
    const app = buildApp("org-a");
    const res = await app.request("/scan/scan-x/report", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("validates AIVSS payload contract", async () => {
    const app = buildApp("org-a");
    const bad = await app.request(
      "/aivss/calculate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attack_complexity: 123 }),
      },
      mockEnv(),
    );
    expect(bad.status).toBe(400);

    const good = await app.request(
      "/aivss/calculate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attack_vector: "network",
          attack_complexity: "low",
          privileges_required: "none",
          scope: "unchanged",
          confidentiality_impact: "low",
          integrity_impact: "low",
          availability_impact: "low",
        }),
      },
      mockEnv(),
    );
    expect(good.status).toBe(200);
    const payload = await good.json() as { score?: number; risk_level?: string; vector?: Record<string, unknown> };
    expect(typeof payload.score).toBe("number");
    expect(typeof payload.risk_level).toBe("string");
    expect(typeof payload.vector).toBe("object");
  });

  it("scan report returns contract for owned scan", async () => {
    const mockSql4 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM security_scans WHERE scan_id")) {
        return [
          {
            scan_id: "scan-1",
            agent_name: "agent-a",
            scan_type: "config",
            status: "completed",
            total_probes: 10,
            passed: 8,
            failed: 2,
            risk_score: 6.5,
            risk_level: "medium",
            started_at: 1,
            completed_at: 2,
          },
        ];
      }
      if (query.includes("FROM security_findings WHERE scan_id")) {
        return [
          {
            probe_name: "Probe A",
            category: "LLM01",
            severity: "high",
            aivss_score: 7.2,
          },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql4);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql4);

    const app = buildApp("org-a");
    const res = await app.request("/scan/scan-1/report", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      scan_id?: string;
      agent_name?: string;
      risk_score?: number;
      risk_level?: string;
      summary?: Record<string, unknown>;
    };
    expect(payload.scan_id).toBe("scan-1");
    expect(payload.agent_name).toBe("agent-a");
    expect(typeof payload.risk_score).toBe("number");
    expect(typeof payload.risk_level).toBe("string");
    expect(typeof payload.summary).toBe("object");
  });

  it("risk trends returns chronological trend entries", async () => {
    const mockSql5 = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM security_scans") && query.includes("ORDER BY started_at DESC")) {
        return [
          { scan_id: "s2", risk_score: 8.0, risk_level: "high", passed: 4, failed: 6, created_at: 20 },
          { scan_id: "s1", risk_score: 5.0, risk_level: "medium", passed: 6, failed: 4, created_at: 10 },
        ];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql5);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql5);

    const app = buildApp("org-a");
    const res = await app.request("/risk-trends/agent-a?limit=2", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const payload = await res.json() as {
      agent_name?: string;
      trends?: Array<{ scan_id?: string; risk_score?: number }>;
    };
    expect(payload.agent_name).toBe("agent-a");
    expect(Array.isArray(payload.trends)).toBe(true);
    expect(payload.trends?.[0]?.scan_id).toBe("s1");
    expect(typeof payload.trends?.[0]?.risk_score).toBe("number");
  });
});
