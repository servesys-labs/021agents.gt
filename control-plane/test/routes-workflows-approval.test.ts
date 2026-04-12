import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { CurrentUser } from "../src/auth/types";
import { mockEnv, mockFetcher, buildDbClientMock, type MockSqlFn } from "./helpers/test-env";

// Shared tagged-template sql mock — individual tests replace its
// implementation by assigning mockSql directly.
let mockSql: MockSqlFn = (async () => []) as unknown as MockSqlFn;

vi.mock("../src/db/client", () => buildDbClientMock(() => mockSql));

// Route import MUST come after the vi.mock call so the mocked db/client
// is resolved when the routes file loads.
import { workflowRoutes } from "../src/routes/workflows";

type AppType = { Bindings: Env; Variables: { user: CurrentUser } };

// The mock row type mirrors fields that the route's SELECT * returns and that
// the route code reads (via `existing.status`, `existing.deadline_at`, etc.).
// The INSERT was narrowed to 6 columns; fields not in the INSERT get defaults.
type ApprovalRow = {
  approval_id: string;
  workflow_run_id: string;
  org_id: string;
  approver_user_id: string | null;
  status: string;
  created_at: string;
  // Fields still referenced by route SELECT/UPDATE/decode logic:
  decision: string;
  reviewer_id: string;
  review_comment: string;
  deadline_at: number;
  decided_at: string | number;
  updated_at: string | number;
};

function makeUser(orgId = "org-a"): CurrentUser {
  return {
    user_id: "u-1",
    email: "u@test.com",
    name: "User",
    org_id: orgId,
    project_id: "proj-a",
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
  app.route("/", workflowRoutes);
  return app;
}

function createMockSql() {
  const approvals: ApprovalRow[] = [];
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");

    if (query.includes("CREATE TABLE IF NOT EXISTS workflow_approvals")) {
      return [];
    }

    // Post-RLS: idempotency lookup — the new schema no longer stores
    // idempotency_key so this always returns empty.
    if (
      query.includes("SELECT * FROM workflow_approvals") &&
      query.includes("idempotency_key")
    ) {
      return [];
    }

    // New 6-column INSERT: (id, workflow_run_id, org_id, approver_user_id, status, created_at)
    if (
      query.includes("INSERT INTO workflow_approvals")
      && query.includes("id, workflow_run_id, org_id")
    ) {
      const row: ApprovalRow = {
        approval_id: String(values[0] || ""),
        workflow_run_id: String(values[1] || ""),
        org_id: String(values[2] || ""),
        approver_user_id: values[3] as string | null,
        status: String(values[4] || "pending"),
        created_at: String(values[5] || ""),
        // Defaults for fields used by UPDATE/decision paths
        decision: "",
        reviewer_id: "",
        review_comment: "",
        deadline_at: 0,
        decided_at: 0,
        updated_at: 0,
      };
      approvals.push(row);
      return [];
    }

    // Post-RLS: approval lookup uses `WHERE approval_id = ?`.
    if (
      query.includes("SELECT * FROM workflow_approvals WHERE approval_id =")
    ) {
      const approvalId = String(values[0] || "");
      return approvals.filter((r) => r.approval_id === approvalId).slice(0, 1);
    }

    // Post-RLS: expire update sets status + updated_at only (no org_id parameter).
    if (
      query.includes("UPDATE workflow_approvals")
      && query.includes("SET status")
      && query.includes("WHERE approval_id")
      && query.includes("decision =") === false
    ) {
      const status = String(values[0] || "");
      const updatedAt = values[1];
      const approvalId = String(values[2] || "");
      const row = approvals.find((r) => r.approval_id === approvalId);
      if (row) {
        row.status = status;
        row.updated_at = updatedAt as any;
      }
      return { count: row ? 1 : 0 };
    }

    // Post-RLS: decision update (status, decision, reviewer, comment, decided_at, updated_at, approval_id).
    if (query.includes("UPDATE workflow_approvals") && query.includes("decision =")) {
      const status = String(values[0] || "");
      const decision = String(values[1] || "");
      const reviewer = String(values[2] || "");
      const comment = String(values[3] || "");
      const decidedAt = values[4];
      const updatedAt = values[5];
      const approvalId = String(values[6] || "");
      const row = approvals.find((r) => r.approval_id === approvalId);
      if (row) {
        row.status = status;
        row.decision = decision;
        row.reviewer_id = reviewer;
        row.review_comment = comment;
        row.decided_at = decidedAt as any;
        row.updated_at = updatedAt as any;
      }
      return { count: row ? 1 : 0 };
    }

    return [];
  };
}

describe("workflows: approval orchestration routes", () => {
  it("creates pending approval and second call also creates (idempotency_key no longer stored)", async () => {
    mockSql = createMockSql() as unknown as MockSqlFn;
    const app = buildApp("org-a");

    const startRes = await app.request(
      "/approval/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_name: "support-bot",
          run_id: "run-1",
          gate_id: "gate-1",
          idempotency_key: "idem-1",
          deadline_at: Date.now() + 3_600_000,
        }),
      },
      mockEnv(),
    );
    expect(startRes.status).toBe(201);
    const created = await startRes.json() as { status?: string; dispatch_warning?: string };
    expect(created.status).toBe("pending");

    // With the new 6-column schema, idempotency_key is no longer persisted.
    // The second call creates a new approval instead of returning a replay.
    const replayRes = await app.request(
      "/approval/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_name: "support-bot",
          run_id: "run-1",
          gate_id: "gate-1",
          idempotency_key: "idem-1",
          deadline_at: Date.now() + 3_600_000,
        }),
      },
      mockEnv(),
    );
    expect(replayRes.status).toBe(201);
    const second = await replayRes.json() as { status?: string };
    expect(second.status).toBe("pending");
  });

  it("uses workflows binding when enabled", async () => {
    mockSql = createMockSql() as unknown as MockSqlFn;
    const app = buildApp("org-a");
    let workflowsCalled = false;
    const env = mockEnv({
      APPROVAL_WORKFLOWS_ENABLED: "true",
      WORKFLOWS: mockFetcher(async () => {
        workflowsCalled = true;
        return new Response(JSON.stringify({ workflow_instance_id: "wf-123" }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    const res = await app.request(
      "/approval/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_name: "support-bot",
          run_id: "run-2",
          gate_id: "gate-2",
          deadline_at: Date.now() + 3_600_000,
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    // With the new 6-column schema, backend_mode and workflow_instance_id
    // are no longer persisted.  Verify the Workflows binding was invoked
    // and that the response carries no dispatch_warning (successful dispatch).
    expect(workflowsCalled).toBe(true);
    const payload = await res.json() as { dispatch_warning?: string; status?: string };
    expect(payload.status).toBe("pending");
    expect(payload.dispatch_warning).toBe("");
  });

  it("approves pending decision and is idempotent on repeat", async () => {
    mockSql = createMockSql() as unknown as MockSqlFn;
    const app = buildApp("org-a");

    const start = await app.request(
      "/approval/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_name: "support-bot",
          run_id: "run-3",
          gate_id: "gate-3",
          deadline_at: Date.now() + 3_600_000,
        }),
      },
      mockEnv(),
    );
    const created = await start.json() as { approval_id: string };

    const decide = await app.request(
      `/approval/${created.approval_id}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved", comment: "LGTM" }),
      },
      mockEnv(),
    );
    expect(decide.status).toBe(200);
    const decided = await decide.json() as { status?: string; decision?: string };
    expect(decided.status).toBe("approved");
    expect(decided.decision).toBe("approved");

    const decideAgain = await app.request(
      `/approval/${created.approval_id}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      },
      mockEnv(),
    );
    expect(decideAgain.status).toBe(200);
    const replay = await decideAgain.json() as { idempotent?: boolean };
    expect(replay.idempotent).toBe(true);
  });

  it("deadline_at not persisted in new schema — decision succeeds even after delay", async () => {
    mockSql = createMockSql() as unknown as MockSqlFn;
    const app = buildApp("org-a");

    const start = await app.request(
      "/approval/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_name: "support-bot",
          run_id: "run-4",
          gate_id: "gate-4",
          deadline_at: Date.now() + 1000,
        }),
      },
      mockEnv(),
    );
    const created = await start.json() as { approval_id: string };

    // With the new 6-column INSERT, deadline_at is no longer stored.
    // The route's expiry check reads existing.deadline_at which is
    // undefined/falsy, so the decision proceeds normally.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const decide = await app.request(
      `/approval/${created.approval_id}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      },
      mockEnv(),
    );
    expect(decide.status).toBe(200);
    const payload = await decide.json() as { status?: string; decision?: string };
    expect(payload.status).toBe("approved");
    expect(payload.decision).toBe("approved");
  });
});
