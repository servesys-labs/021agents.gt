/**
 * Route tests for /api/v1/admin/skills/revert.
 *
 * Covers the HTTP surface: auth gating, status-code mapping for every
 * RevertRuleErrorCode, and the happy-path JSON response shape. The
 * business-logic assertions (integrity check, overlay deletion, audit
 * row shape) are covered in skill-mutation.test.ts — this file only
 * proves the route wrapper is wired correctly.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { buildDbClientMock, mockEnv, type MockSqlFn } from "./helpers/test-env";
import { sha256Hex, OVERLAY_JOINER } from "../src/logic/skill-mutation";

// Mutable mock sql — each test replaces its implementation.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;
vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

// Import AFTER the mock so the route gets the mocked withOrgDb.
import { skillsAdminRoutes } from "../src/routes/skills-admin";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

function makeUser(role: CurrentUser["role"], orgId = "org-test"): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: orgId,
    project_id: "",
    env: "",
    role,
    scopes: [],
    auth_method: "api_key",
  };
}

function buildApp(role: CurrentUser["role"]): Hono<AppType> {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    c.set("user", makeUser(role));
    await next();
  });
  app.route("/", skillsAdminRoutes);
  return app;
}

/** Build a template-literal mock sql that returns queued row-sets in order. */
function queueResponses(responses: unknown[][]): MockSqlFn {
  let i = 0;
  return (async () => {
    const resp = responses[i++];
    return resp ?? [];
  }) as unknown as MockSqlFn;
}

describe("POST /admin/skills/revert — authorization", () => {
  it("returns 403 when role is member", async () => {
    const app = buildApp("member");
    const res = await app.request(
      "/revert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audit_id: "audit-1" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("allows role=owner", async () => {
    const priorContent = "rule A";
    const priorSha = await sha256Hex(priorContent);
    mockSql = queueResponses([
      [{
        audit_id: "audit-ok",
        skill_name: "debug",
        overlay_id: "ov-1",
        before_sha: priorSha,
        before_content: priorContent,
        after_content: priorContent + OVERLAY_JOINER + "new rule",
        source: "improve",
      }],
      [{ rule_text: priorContent }, { rule_text: "new rule" }],
      [{ overlay_id: "ov-1" }],
      [{ rule_text: priorContent }],
      [{ audit_id: "audit-revert" }],
    ]);

    const app = buildApp("owner");
    const res = await app.request(
      "/revert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audit_id: "audit-ok" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.reverted).toBe(true);
    expect(body.revert_audit_id).toBe("audit-revert");
    expect(body.reverted_audit_id).toBe("audit-ok");
  });
});

describe("POST /admin/skills/revert — status code mapping", () => {
  it("400 on missing audit_id", async () => {
    const app = buildApp("admin");
    const res = await app.request(
      "/revert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("404 on audit_not_found", async () => {
    mockSql = queueResponses([[]]); // empty SELECT
    const app = buildApp("admin");
    const res = await app.request(
      "/revert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audit_id: "missing" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("409 on already_reverted (overlay_id is null in the audit row)", async () => {
    const sha = await sha256Hex("");
    mockSql = queueResponses([
      [{
        audit_id: "audit-null",
        skill_name: "debug",
        overlay_id: null,
        before_sha: sha,
        before_content: "",
        after_content: "",
        source: "revert",
      }],
    ]);
    const app = buildApp("admin");
    const res = await app.request(
      "/revert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audit_id: "audit-null" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(409);
  });

  it("422 on tamper_detected (sha mismatch)", async () => {
    mockSql = queueResponses([
      [{
        audit_id: "audit-bad",
        skill_name: "debug",
        overlay_id: "ov-bad",
        before_sha: "0".repeat(64),
        before_content: "not the content that was hashed",
        after_content: "irrelevant",
        source: "improve",
      }],
    ]);
    const app = buildApp("admin");
    const res = await app.request(
      "/revert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audit_id: "audit-bad" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.code).toBe("tamper_detected");
  });

  it("409 on already_reverted when DELETE returns zero rows (concurrent race)", async () => {
    const content = "rule A";
    const sha = await sha256Hex(content);
    mockSql = queueResponses([
      [{
        audit_id: "audit-race",
        skill_name: "debug",
        overlay_id: "ov-race",
        before_sha: sha,
        before_content: content,
        after_content: content + OVERLAY_JOINER + "rule B",
        source: "improve",
      }],
      [{ rule_text: content }, { rule_text: "rule B" }],
      [],  // DELETE affects 0 rows
    ]);
    const app = buildApp("admin");
    const res = await app.request(
      "/revert",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audit_id: "audit-race" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(409);
  });
});
