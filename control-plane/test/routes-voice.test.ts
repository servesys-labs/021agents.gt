import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { voiceRoutes } from "../src/routes/voice";
import { mockEnv } from "./helpers/test-env";
import { verifyWebhookHmac } from "../src/logic/voice-webhook";

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
  app.route("/", voiceRoutes);
  return app;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("voice routes", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReset();
    vi.mocked(getDbForOrg).mockReset();
  });

  it("GET unknown platform calls returns 404", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp();
    const res = await app.request("/elevenlabs/calls", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("GET vapi call detail is org-scoped (404 other org)", async () => {
    const mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join("?");
      if (q.includes("FROM voice_calls") && q.includes("org_id")) {
        return [];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql);

    const app = buildApp("org-a");
    const res = await app.request("/vapi/calls/call-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("GET vapi call detail returns row when org matches", async () => {
    const mockSql2 = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join("?");
      if (q.includes("FROM voice_calls") && q.includes("org_id")) {
        return [{ call_id: "call-1", org_id: "org-a", platform: "vapi" }];
      }
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql2);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql2);

    const app = buildApp("org-a");
    const res = await app.request("/vapi/calls/call-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { call_id: string };
    expect(body.call_id).toBe("call-1");
  });

  it("GET vapi call events is org-scoped", async () => {
    const mockSql3 = (async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("SELECT 1 FROM voice_calls")) return [];
      if (q.includes("voice_call_events")) return [{ id: 1 }];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql3);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql3);

    const app = buildApp("org-a");
    const res = await app.request("/vapi/calls/x/events", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("GET tavus call detail is org-scoped", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp("org-a");
    const res = await app.request("/tavus/calls/conv-1", { method: "GET" }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("GET tavus call events includes platform and respects org", async () => {
    const mockSql4 = (async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("SELECT 1 FROM voice_calls")) return [{ "?": 1 }];
      if (q.includes("voice_call_events")) return [{ evt: 1 }];
      return [];
    }) as any;
    vi.mocked(getDb).mockResolvedValue(mockSql4);
    vi.mocked(getDbForOrg).mockResolvedValue(mockSql4);

    const app = buildApp("org-a");
    const res = await app.request("/tavus/calls/c1/events", { method: "GET" }, mockEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; platform: string };
    expect(body.platform).toBe("tavus");
    expect(body.events.length).toBe(1);
  });

  it("POST /vapi/webhook accepts when webhook secret unset", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp();
    const payload = { message: { type: "call.started", call: { id: "c1" } } };
    const res = await app.request("/vapi/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, mockEnv({ VAPI_WEBHOOK_SECRET: undefined }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed?: boolean; call_id?: string };
    expect(body.processed).toBe(true);
    expect(body.call_id).toBe("c1");
  });

  it("POST /vapi/webhook rejects bad signature when secret set", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp();
    const raw = JSON.stringify({ ok: true });
    const res = await app.request("/vapi/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vapi-signature": "deadbeef",
      },
      body: raw,
    }, mockEnv({ VAPI_WEBHOOK_SECRET: "sec" }));
    expect(res.status).toBe(401);
  });

  it("POST /vapi/webhook accepts valid signature", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp();
    const raw = JSON.stringify({ message: { type: "hang", call: { id: "c9" } } });
    const sig = await hmacHex("whsec", raw);
    const res = await app.request("/vapi/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vapi-signature": sig,
      },
      body: raw,
    }, mockEnv({ VAPI_WEBHOOK_SECRET: "whsec" }));
    expect(res.status).toBe(200);
  });

  it("POST /tavus/webhook returns 404 for unknown path platform", async () => {
    const app = buildApp();
    const res = await app.request("/unknown/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, mockEnv());
    expect(res.status).toBe(404);
  });

  it("POST /tavus/webhook accepts payload without secret", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp();
    const res = await app.request("/tavus/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "conversation.started", conversation_id: "t1" }),
    }, mockEnv());
    expect(res.status).toBe(200);
  });

  it("POST /vapi/calls returns 400 without API key", async () => {
    vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
    const app = buildApp();
    const res = await app.request("/vapi/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: "+1" }),
    }, mockEnv({ VAPI_API_KEY: undefined }));
    expect(res.status).toBe(400);
  });

  describe("outbound API proxy", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("POST /vapi/calls proxies to Vapi and persists", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ id: "vapi-new-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ) as any;

      vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
      const app = buildApp("org-x");
      const res = await app.request("/vapi/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number: "pn_1",
          assistant_id: "asst_1",
          agent_name: "agent-a",
        }),
      }, mockEnv({ VAPI_API_KEY: "vk_test" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { call_id: string; status: string };
      expect(body.call_id).toBe("vapi-new-1");
      expect(body.status).toBe("initiated");
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it("DELETE /vapi/calls/:id proxies end call", async () => {
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as any;
      vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
      const app = buildApp();
      const res = await app.request("/vapi/calls/abc", { method: "DELETE" }, mockEnv({ VAPI_API_KEY: "vk" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ended: boolean };
      expect(body.ended).toBe(true);
    });

    it("POST /tavus/calls creates conversation via Tavus API", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ conversation_id: "tv-99" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ) as any;
      vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
      const app = buildApp("org-z");
      const res = await app.request("/tavus/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona_id: "p1", context: "hi", agent_name: "a1" }),
      }, mockEnv({ TAVUS_API_KEY: "tk" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { conversation_id: string };
      expect(body.conversation_id).toBe("tv-99");
    });

    it("POST /tavus/calls returns 400 without Tavus key", async () => {
      vi.mocked(getDb).mockResolvedValue((async () => []) as any);
    vi.mocked(getDbForOrg).mockResolvedValue((async () => []) as any);
      const app = buildApp();
      const res = await app.request("/tavus/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona_id: "p1" }),
      }, mockEnv({ TAVUS_API_KEY: undefined }));
      expect(res.status).toBe(400);
    });
  });
});

describe("verifyWebhookHmac", () => {
  it("returns true when secret empty", async () => {
    const ok = await verifyWebhookHmac("", new ArrayBuffer(0), "");
    expect(ok).toBe(true);
  });
});
