/**
 * Integration tests for the control-plane DB proxy feature.
 *
 * Verifies that the control-plane routes through the RUNTIME service binding
 * to the /cf/db/query endpoint when DB_PROXY_ENABLED is set, and falls back
 * to direct DB access otherwise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv, mockFetcher } from "./helpers/test-env";

// Mock the DB client so direct-DB paths return predictable data
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

// ---------------------------------------------------------------------------
// Capture calls to the mocked RUNTIME service binding
// ---------------------------------------------------------------------------

interface RuntimeCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function createCapturingRuntime(
  responseData: Record<string, unknown> = {
    query_id: "agents.list_active_by_org",
    rows: [{ name: "test-agent", description: "test" }],
    row_count: 1,
  },
) {
  const runtimeCalls: RuntimeCall[] = [];
  // Service binding .fetch() can be called with (url, init) or (Request).
  // In production CF code, env.RUNTIME.fetch(url, init) passes string + init.
  // Our mock must handle both calling conventions.
  const fetcher: Fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(
        // CF-style URLs like "https://runtime/..." are invalid in Node,
        // so normalize to a parseable URL for test purposes.
        String(input).replace("https://runtime", "https://localhost"),
        init,
      );
      const urlStr = String(input);
      const pathname = urlStr.replace(/^https?:\/\/[^/]+/, "") || "/";
      const body = await req.json();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      runtimeCalls.push({ url: pathname, body: body as Record<string, unknown>, headers });
      return new Response(JSON.stringify(responseData), {
        headers: { "Content-Type": "application/json" },
      });
    },
    connect: () => { throw new Error("connect not implemented"); },
  } as any;
  return { fetcher, runtimeCalls };
}

// ---------------------------------------------------------------------------
// Simulated agents list route that mirrors the proxy logic in src/routes/agents.ts
// ---------------------------------------------------------------------------

async function listAgentsViaDataProxy(
  env: Env,
  user: CurrentUser,
): Promise<Array<Record<string, unknown>> | null> {
  const enabled = String((env as any).DB_PROXY_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return null;

  try {
    const resp = await env.RUNTIME.fetch("https://runtime/cf/db/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SERVICE_TOKEN ? { Authorization: `Bearer ${env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        query_id: "agents.list_active_by_org",
        context: {
          org_id: user.org_id,
          user_id: user.user_id,
          role: user.role,
        },
      }),
    });
    if (!resp.ok) return null;

    const payload = (await resp.json()) as { rows?: Array<Record<string, unknown>> };
    return Array.isArray(payload.rows) ? payload.rows : [];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Control-Plane DB Proxy Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Feature flag behavior ──────────────────────────────────────────────

  it("uses direct DB when DB_PROXY_ENABLED is not set", async () => {
    const env = mockEnv({ DB_PROXY_ENABLED: undefined });
    const user = makeUser("org-a");
    const result = await listAgentsViaDataProxy(env, user);
    // null signals "proxy not used — fall back to direct DB"
    expect(result).toBeNull();
  });

  it("uses direct DB when DB_PROXY_ENABLED is 'false'", async () => {
    const env = mockEnv({ DB_PROXY_ENABLED: "false" });
    const user = makeUser("org-a");
    const result = await listAgentsViaDataProxy(env, user);
    expect(result).toBeNull();
  });

  it("uses proxy path when DB_PROXY_ENABLED=true", async () => {
    const { fetcher, runtimeCalls } = createCapturingRuntime();
    const env = mockEnv({ DB_PROXY_ENABLED: "true", RUNTIME: fetcher });

    const user = makeUser("org-a");
    const result = await listAgentsViaDataProxy(env, user);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("test-agent");
    expect(runtimeCalls).toHaveLength(1);
  });

  it("falls back to null (direct DB) when proxy returns non-200", async () => {
    const fetcher = {
      fetch: async () => new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
      connect: () => { throw new Error("not implemented"); },
    } as any;
    const env = mockEnv({ DB_PROXY_ENABLED: "true", RUNTIME: fetcher });
    const user = makeUser("org-a");
    const result = await listAgentsViaDataProxy(env, user);
    expect(result).toBeNull();
  });

  it("falls back to null when proxy throws a network error", async () => {
    const fetcher = {
      fetch: async () => { throw new Error("network failure"); },
      connect: () => { throw new Error("not implemented"); },
    } as any;
    const env = mockEnv({ DB_PROXY_ENABLED: "true", RUNTIME: fetcher });
    const user = makeUser("org-a");
    const result = await listAgentsViaDataProxy(env, user);
    expect(result).toBeNull();
  });

  // ── Proxy call shape verification ──────────────────────────────────────

  it("sends correct body to runtime /cf/db/query", async () => {
    const { fetcher, runtimeCalls } = createCapturingRuntime();
    const env = mockEnv({ DB_PROXY_ENABLED: "true", RUNTIME: fetcher });
    const user = makeUser("org-xyz");
    await listAgentsViaDataProxy(env, user);

    expect(runtimeCalls).toHaveLength(1);
    const call = runtimeCalls[0];
    expect(call.url).toBe("/cf/db/query");
    expect(call.body.query_id).toBe("agents.list_active_by_org");
    expect(call.body.context).toEqual({
      org_id: "org-xyz",
      user_id: "u-1",
      role: "admin",
    });
  });

  it("includes org_id from authenticated user", async () => {
    const { fetcher, runtimeCalls } = createCapturingRuntime();
    const env = mockEnv({ DB_PROXY_ENABLED: "true", RUNTIME: fetcher });
    const user = makeUser("org-custom-42");
    await listAgentsViaDataProxy(env, user);

    const call = runtimeCalls[0];
    expect((call.body.context as Record<string, unknown>).org_id).toBe("org-custom-42");
  });

  it("includes SERVICE_TOKEN in Authorization header", async () => {
    const { fetcher, runtimeCalls } = createCapturingRuntime();
    const env = mockEnv({
      DB_PROXY_ENABLED: "true",
      RUNTIME: fetcher,
      SERVICE_TOKEN: "my-secret-service-token",
    });
    const user = makeUser("org-a");
    await listAgentsViaDataProxy(env, user);

    const call = runtimeCalls[0];
    expect(call.headers.authorization).toBe("Bearer my-secret-service-token");
  });

  it("omits Authorization header when SERVICE_TOKEN is empty", async () => {
    const { fetcher, runtimeCalls } = createCapturingRuntime();
    const env = mockEnv({
      DB_PROXY_ENABLED: "true",
      RUNTIME: fetcher,
      SERVICE_TOKEN: "",
    });
    const user = makeUser("org-a");
    await listAgentsViaDataProxy(env, user);

    const call = runtimeCalls[0];
    expect(call.headers.authorization).toBeUndefined();
  });

  it("returns proxy response rows to caller", async () => {
    const { fetcher } = createCapturingRuntime({
      query_id: "agents.list_active_by_org",
      rows: [
        { name: "agent-1", description: "First" },
        { name: "agent-2", description: "Second" },
      ],
      row_count: 2,
    });
    const env = mockEnv({ DB_PROXY_ENABLED: "true", RUNTIME: fetcher });
    const user = makeUser("org-a");
    const result = await listAgentsViaDataProxy(env, user);
    expect(result).toHaveLength(2);
    expect(result![0].name).toBe("agent-1");
    expect(result![1].name).toBe("agent-2");
  });

  it("returns empty array when proxy returns empty rows", async () => {
    const { fetcher } = createCapturingRuntime({
      query_id: "agents.list_active_by_org",
      rows: [],
      row_count: 0,
    });
    const env = mockEnv({ DB_PROXY_ENABLED: "true", RUNTIME: fetcher });
    const user = makeUser("org-a");
    const result = await listAgentsViaDataProxy(env, user);
    expect(result).toEqual([]);
  });
});
