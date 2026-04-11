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

type ApprovalRow = {
  approval_id: string;
  org_id: string;
  project_id: string;
  agent_name: string;
  run_id: string;
  gate_id: string;
  checkpoint_id: string;
  status: string;
  decision: string;
  reviewer_id: string;
  review_comment: string;
  context_json: string;
  workflow_instance_id: string;
  backend_mode: string;
  idempotency_key: string;
  deadline_at: number;
  decided_at: number;
  created_at: number;
  updated_at: number;
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

    // Post-RLS: idempotency lookup uses only `WHERE idempotency_key = ?` —
    // org scoping is enforced by the RLS session context, not a parameter.
    if (
      query.includes("SELECT * FROM workflow_approvals") &&
      query.includes("idempotency_key")
    ) {
      const key = String(values[0] || "");
      return approvals.filter((r) => r.idempotency_key === key).slice(0, 1);
    }

    if (
      query.includes("INSERT INTO workflow_approvals")
      && query.includes("approval_id, org_id, project_id")
    ) {
      const row: ApprovalRow = {
        approval_id: String(values[0] || ""),
        org_id: String(values[1] || ""),
        project_id: String(values[2] || ""),
        agent_name: String(values[3] || ""),
        run_id: String(values[4] || ""),
        gate_id: String(values[5] || ""),
        checkpoint_id: String(values[6] || ""),
        status: String(values[7] || "pending"),
        decision: String(values[8] || ""),
        reviewer_id: String(values[9] || ""),
        review_comment: String(values[10] || ""),
        context_json: String(values[11] || "{}"),
        workflow_instance_id: String(values[12] || ""),
        backend_mode: String(values[13] || "checkpoint_fallback"),
        idempotency_key: String(values[14] || ""),
        deadline_at: Number(values[15] || 0),
        decided_at: Number(values[16] || 0),
        created_at: Number(values[17] || 0),
        updated_at: Number(values[18] || 0),
      };
      approvals.push(row);
      return [];
    }

    // Post-RLS: approval lookup uses only `WHERE approval_id = ?`.
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
      const updatedAt = Number(values[1] || 0);
      const approvalId = String(values[2] || "");
      const row = approvals.find((r) => r.approval_id === approvalId);
      if (row) {
        row.status = status;
        row.updated_at = updatedAt;
      }
      return { count: row ? 1 : 0 };
    }

    // Post-RLS: decision update (status, decision, reviewer, comment, decided_at, updated_at, approval_id).
    if (query.includes("UPDATE workflow_approvals") && query.includes("decision =")) {
      const status = String(values[0] || "");
      const decision = String(values[1] || "");
      const reviewer = String(values[2] || "");
      const comment = String(values[3] || "");
      const decidedAt = Number(values[4] || 0);
      const updatedAt = Number(values[5] || 0);
      const approvalId = String(values[6] || "");
      const row = approvals.find((r) => r.approval_id === approvalId);
      if (row) {
        row.status = status;
        row.decision = decision;
        row.reviewer_id = reviewer;
        row.review_comment = comment;
        row.decided_at = decidedAt;
        row.updated_at = updatedAt;
      }
      return { count: row ? 1 : 0 };
    }

    return [];
  };
}

describe("workflows: approval orchestration routes", () => {
  it("creates pending approval and returns idempotent replay", async () => {
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
    const created = await startRes.json() as { status?: string; backend_mode?: string; approval_id?: string };
    expect(created.status).toBe("pending");
    expect(created.backend_mode).toBe("checkpoint_fallback");
    expect(typeof created.approval_id).toBe("string");

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
    expect(replayRes.status).toBe(200);
    const replay = await replayRes.json() as { idempotent?: boolean; approval_id?: string };
    expect(replay.idempotent).toBe(true);
    expect(replay.approval_id).toBe(created.approval_id);
  });

  it("uses workflows binding when enabled", async () => {
    mockSql = createMockSql() as unknown as MockSqlFn;
    const app = buildApp("org-a");
    const env = mockEnv({
      APPROVAL_WORKFLOWS_ENABLED: "true",
      WORKFLOWS: mockFetcher(async () => {
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
    const payload = await res.json() as { backend_mode?: string; workflow_instance_id?: string };
    expect(payload.backend_mode).toBe("cloudflare_workflows");
    expect(payload.workflow_instance_id).toBe("wf-123");
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

  it("expires stale approvals on decision attempt", async () => {
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

    // Set table row deadline to stale via immediate follow-up and small wait.
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
    expect(decide.status).toBe(409);
    const payload = await decide.json() as { status?: string };
    expect(payload.status).toBe("expired");
  });
});
