/**
 * Workflows router — multi-agent DAG pipelines.
 *
 * Topological sort + cycle detection in logic/workflow-validator.ts.
 * Run endpoint returns 410 (edge-only).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { createOpenAPIRouter } from "../lib/openapi";
import { ErrorSchema, errorResponses, ApprovalRequest } from "../schemas/openapi";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { withOrgDb, type OrgSql } from "../db/client";
import { normalizeSteps, validateWorkflow, deriveRunMetadata } from "../logic/workflow-validator";
import { requireScope } from "../middleware/auth";
import { parseJsonColumn } from "../lib/parse-json-column";

export const workflowRoutes = createOpenAPIRouter();

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
type ApprovalDecision = "approved" | "rejected";

type ApprovalRow = {
  approval_id: string;
  org_id: string;
  project_id?: string;
  agent_name: string;
  run_id: string;
  gate_id: string;
  checkpoint_id?: string;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  reviewer_id?: string;
  review_comment?: string;
  context_json?: string;
  workflow_instance_id?: string;
  backend_mode?: string;
  idempotency_key?: string;
  deadline_at?: number;
  decided_at?: number;
  created_at?: number;
  updated_at?: number;
};

function nowSec(): string {
  return new Date().toISOString();
}

function parseEpochSeconds(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) return Math.floor(asNum);
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

async function ensureApprovalTable(sql: OrgSql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS workflow_approvals (
      approval_id text PRIMARY KEY,
      org_id text NOT NULL,
      project_id text DEFAULT '',
      agent_name text NOT NULL,
      run_id text NOT NULL,
      gate_id text NOT NULL,
      checkpoint_id text DEFAULT '',
      status text NOT NULL,
      decision text DEFAULT '',
      reviewer_id text DEFAULT '',
      review_comment text DEFAULT '',
      context_json text DEFAULT '{}',
      workflow_instance_id text DEFAULT '',
      backend_mode text DEFAULT 'checkpoint_fallback',
      idempotency_key text DEFAULT '',
      deadline_at bigint DEFAULT 0,
      decided_at bigint DEFAULT 0,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )
  `;
}

function decodeApprovalRow(row: ApprovalRow): Record<string, unknown> {
  const item: Record<string, unknown> = { ...row };
  const contextRaw = row.context_json;
  let context: Record<string, unknown> = {};
  if (typeof contextRaw === "string" && contextRaw.trim()) {
    try {
      const parsed = JSON.parse(contextRaw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        context = parsed as Record<string, unknown>;
      }
    } catch {
      context = {};
    }
  }
  item.context = context;
  delete item.context_json;
  return item;
}

async function dispatchApprovalWorkflow(
  env: Env,
  payload: Record<string, unknown>,
): Promise<{ backendMode: string; workflowInstanceId: string; dispatchError?: string }> {
  const enabled = String((env as Env & { APPROVAL_WORKFLOWS_ENABLED?: string }).APPROVAL_WORKFLOWS_ENABLED || "").toLowerCase() === "true";
  const workflowsBinding = (env as Env & { WORKFLOWS?: Fetcher }).WORKFLOWS;
  if (!enabled || !workflowsBinding) {
    return { backendMode: "checkpoint_fallback", workflowInstanceId: "" };
  }
  try {
    const resp = await workflowsBinding.fetch("https://workflow/approval/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      return {
        backendMode: "checkpoint_fallback",
        workflowInstanceId: "",
        dispatchError: `workflow dispatch failed (${resp.status})`,
      };
    }
    const body = await resp.json() as { instance_id?: string; workflow_instance_id?: string };
    const instanceId = String(body.instance_id || body.workflow_instance_id || "");
    return {
      backendMode: instanceId ? "cloudflare_workflows" : "checkpoint_fallback",
      workflowInstanceId: instanceId,
    };
  } catch (err) {
    return {
      backendMode: "checkpoint_fallback",
      workflowInstanceId: "",
      dispatchError: err instanceof Error ? err.message : "workflow dispatch failed",
    };
  }
}

function decodeRunRow(row: any): any {
  const item = { ...row };
  item.steps = parseJsonColumn(item.steps_status_json);
  delete item.steps_status_json;
  item.dag = parseJsonColumn(item.dag_json);
  delete item.dag_json;
  item.reflection = parseJsonColumn(item.reflection);
  delete item.reflection;
  item.run_metadata = deriveRunMetadata(item.dag || {}, item.reflection || {});
  return item;
}

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── POST /workflows/approval/start ──────────────────────────────────────

const approvalStartRoute = createRoute({
  method: "post",
  path: "/approval/start",
  tags: ["Workflows"],
  summary: "Start an approval workflow",
  middleware: [requireScope("workflows:write")],
  request: {
    body: {
      content: {
        "application/json": { schema: ApprovalRequest },
      },
    },
  },
  responses: {
    201: {
      description: "Approval workflow created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 409, 500),
  },
});
workflowRoutes.openapi(approvalStartRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const agentName = String(body.agent_name || "").trim();
  const runId = String(body.run_id || "").trim();
  const gateId = String(body.gate_id || "").trim();
  const checkpointId = String(body.checkpoint_id || "").trim();
  const idempotencyKey = String(body.idempotency_key || "").trim();
  const allowFallback = body.allow_fallback !== false;
  const context =
    typeof body.context === "object" && body.context !== null && !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : {};

  if (!agentName || !runId || !gateId) {
    return c.json({ error: "agent_name, run_id, and gate_id are required" }, 400);
  }

  const parsedDeadline = parseEpochSeconds(body.deadline_at);
  const deadlineAt = parsedDeadline ?? nowSec() + 86400;
  if (deadlineAt <= nowSec()) {
    return c.json({ error: "deadline_at must be in the future" }, 400);
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
  await ensureApprovalTable(sql);

  if (idempotencyKey) {
    const existingRows = await sql`
      SELECT * FROM workflow_approvals
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    if (existingRows.length > 0) {
      return c.json({ ...decodeApprovalRow(existingRows[0] as ApprovalRow), idempotent: true });
    }
  }

  const approvalId = genId();
  const createdAt = nowSec();

  const dispatch = await dispatchApprovalWorkflow(c.env, {
    approval_id: approvalId,
    org_id: user.org_id,
    project_id: user.project_id || "",
    agent_name: agentName,
    run_id: runId,
    gate_id: gateId,
    deadline_at: deadlineAt,
  });
  if (dispatch.dispatchError && !allowFallback) {
    return c.json(
      {
        error: "Approval workflow dispatch failed and fallback is disabled",
        detail: dispatch.dispatchError,
      },
      503,
    );
  }

  await sql`
    INSERT INTO workflow_approvals (
      approval_id, org_id, project_id, agent_name, run_id, gate_id, checkpoint_id,
      status, decision, reviewer_id, review_comment, context_json,
      workflow_instance_id, backend_mode, idempotency_key,
      deadline_at, decided_at, created_at, updated_at
    )
    VALUES (
      ${approvalId}, ${user.org_id}, ${user.project_id || ""}, ${agentName}, ${runId}, ${gateId}, ${checkpointId},
      ${"pending"}, ${""}, ${""}, ${""}, ${JSON.stringify(context)},
      ${dispatch.workflowInstanceId}, ${dispatch.backendMode}, ${idempotencyKey},
      ${deadlineAt}, ${0}, ${createdAt}, ${createdAt}
    )
  `;

  const rows = await sql`
    SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} LIMIT 1
  `;
  return c.json(
    {
      ...(rows.length > 0 ? decodeApprovalRow(rows[0] as ApprovalRow) : {
        approval_id: approvalId,
        org_id: user.org_id,
        project_id: user.project_id || "",
        agent_name: agentName,
        run_id: runId,
        gate_id: gateId,
        checkpoint_id: checkpointId,
        status: "pending",
        workflow_instance_id: dispatch.workflowInstanceId,
        backend_mode: dispatch.backendMode,
        idempotency_key: idempotencyKey,
        deadline_at: deadlineAt,
        created_at: createdAt,
        updated_at: createdAt,
        context,
      }),
      dispatch_warning: dispatch.dispatchError || "",
    },
    201,
  );
  });
});

// ── GET /workflows/approval/:approval_id ────────────────────────────────

const getApprovalRoute = createRoute({
  method: "get",
  path: "/approval/{approval_id}",
  tags: ["Workflows"],
  summary: "Get approval workflow status",
  middleware: [requireScope("workflows:read")],
  request: {
    params: z.object({ approval_id: z.string() }),
  },
  responses: {
    200: {
      description: "Approval details",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
workflowRoutes.openapi(getApprovalRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { approval_id: approvalId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await ensureApprovalTable(sql);
    const rows = await sql`
      SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} LIMIT 1
    `;
    if (rows.length === 0) return c.json({ error: "Approval workflow not found" }, 404);
    return c.json(decodeApprovalRow(rows[0] as ApprovalRow));
  });
});

// ── POST /workflows/approval/:approval_id/decision ──────────────────────

const approvalDecisionRoute = createRoute({
  method: "post",
  path: "/approval/{approval_id}/decision",
  tags: ["Workflows"],
  summary: "Submit approval decision",
  middleware: [requireScope("workflows:write")],
  request: {
    params: z.object({ approval_id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            decision: z.string().min(1),
            comment: z.string().optional(),
            reviewer_id: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Decision recorded",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400, 404, 409),
  },
});
workflowRoutes.openapi(approvalDecisionRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { approval_id: approvalId } = c.req.valid("param");
  const body = c.req.valid("json");
  const decision = String(body.decision || "").trim().toLowerCase();
  const comment = String(body.comment || "").trim();
  const reviewerId = String(body.reviewer_id || user.user_id).trim();

  if (decision !== "approved" && decision !== "rejected") {
    return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }

  return await withOrgDb(c.env, user.org_id, async (sql) => {
  await ensureApprovalTable(sql);

  const rows = await sql`
    SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Approval workflow not found" }, 404);

  const existing = rows[0] as ApprovalRow;
  if (existing.status !== "pending") {
    if (existing.status === decision && existing.decision === decision) {
      return c.json({ ...decodeApprovalRow(existing), idempotent: true });
    }
    return c.json({ error: `Approval is already ${existing.status}` }, 409);
  }

  const now = nowSec();
  if (existing.deadline_at && new Date(existing.deadline_at).getTime() <= Date.now()) {
    await sql`
      UPDATE workflow_approvals
      SET status = ${"expired"}, updated_at = ${now}
      WHERE approval_id = ${approvalId}
    `;
    return c.json({ error: "Approval deadline has expired", status: "expired" }, 409);
  }

  await sql`
    UPDATE workflow_approvals
    SET status = ${decision},
        decision = ${decision},
        reviewer_id = ${reviewerId},
        review_comment = ${comment},
        decided_at = ${now},
        updated_at = ${now}
    WHERE approval_id = ${approvalId}
  `;

  // Best-effort notification to runtime edge; do not block client success.
  try {
    await c.env.RUNTIME.fetch("https://runtime/api/v1/internal/approvals/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.env.SERVICE_TOKEN ? { Authorization: `Bearer ${c.env.SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        approval_id: approvalId,
        org_id: user.org_id,
        agent_name: existing.agent_name,
        run_id: existing.run_id,
        gate_id: existing.gate_id,
        checkpoint_id: existing.checkpoint_id || "",
        decision,
        reviewer_id: reviewerId,
        comment,
      }),
    });
  } catch {
    // Runtime callback is non-critical for control-plane decision durability.
  }

  const updatedRows = await sql`
    SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} LIMIT 1
  `;
  return c.json(
    updatedRows.length > 0
      ? decodeApprovalRow(updatedRows[0] as ApprovalRow)
      : {
        approval_id: approvalId,
        org_id: user.org_id,
        status: decision,
        decision,
        reviewer_id: reviewerId,
        review_comment: comment,
        decided_at: now,
        updated_at: now,
      },
  );
  });
});

// ── GET /workflows ──────────────────────────────────────────────────────

const listWorkflowsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Workflows"],
  summary: "List all workflows",
  middleware: [requireScope("workflows:read")],
  responses: {
    200: {
      description: "List of workflows",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
workflowRoutes.openapi(listWorkflowsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const rows = await sql`
      SELECT * FROM workflows ORDER BY created_at DESC
    `;
    const result = rows.map((r: any) => {
      const d = { ...r };
      d.steps = parseJsonColumn(d.steps, []);
      delete d.steps;
      return d;
    });
    return c.json({ workflows: result });
  });
});

// ── POST /workflows ─────────────────────────────────────────────────────

const createWorkflowRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Workflows"],
  summary: "Create a workflow",
  middleware: [requireScope("workflows:write")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            steps: z.array(z.record(z.unknown())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Workflow created",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(400),
  },
});
workflowRoutes.openapi(createWorkflowRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const name = String(body.name || "").trim();
  const description = String(body.description || "");
  const steps = Array.isArray(body.steps) ? body.steps : [];

  if (!name) return c.json({ error: "name is required" }, 400);

  const workflowId = genId();
  const normalizedSteps = normalizeSteps(steps as any);
  const stepsJson = JSON.stringify(normalizedSteps);

  return await withOrgDb(c.env, user.org_id, async (sql) => {
    await sql`
      INSERT INTO workflows (workflow_id, org_id, name, description, steps)
      VALUES (${workflowId}, ${user.org_id}, ${name}, ${description}, ${stepsJson})
    `;

    return c.json({ workflow_id: workflowId, name, steps: normalizedSteps.length });
  });
});

// ── POST /workflows/:workflow_id/run ────────────────────────────────────

const runWorkflowRoute = createRoute({
  method: "post",
  path: "/{workflow_id}/run",
  tags: ["Workflows"],
  summary: "Run a workflow (edge-only, returns 410)",
  middleware: [requireScope("workflows:write")],
  request: {
    params: z.object({ workflow_id: z.string() }),
  },
  responses: {
    410: {
      description: "Moved to edge runtime",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
workflowRoutes.openapi(runWorkflowRoute, (c): any =>
  c.json(
    {
      error: "Moved to edge runtime",
      detail: "Workflow runtime execution is edge-only. Dispatch workflow execution to worker runtime endpoints.",
    },
    410,
  ),
);

// ── GET /workflows/:workflow_id/runs ────────────────────────────────────

const listRunsRoute = createRoute({
  method: "get",
  path: "/{workflow_id}/runs",
  tags: ["Workflows"],
  summary: "List runs for a workflow",
  middleware: [requireScope("workflows:read")],
  request: {
    params: z.object({ workflow_id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(20).optional(),
    }),
  },
  responses: {
    200: {
      description: "Workflow runs",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
workflowRoutes.openapi(listRunsRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { workflow_id: workflowId } = c.req.valid("param");
  const query = c.req.valid("query");
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const wf = await sql`
      SELECT workflow_id FROM workflows WHERE workflow_id = ${workflowId}
    `;
    if (wf.length === 0) return c.json({ error: "Workflow not found" }, 404);

    const rows = await sql`
      SELECT * FROM workflow_runs WHERE workflow_id = ${workflowId}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
    return c.json({ runs: rows.map(decodeRunRow) });
  });
});

// ── GET /workflows/:workflow_id/runs/:run_id ────────────────────────────

const getRunRoute = createRoute({
  method: "get",
  path: "/{workflow_id}/runs/{run_id}",
  tags: ["Workflows"],
  summary: "Get a specific workflow run",
  middleware: [requireScope("workflows:read")],
  request: {
    params: z.object({
      workflow_id: z.string(),
      run_id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Workflow run details",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
workflowRoutes.openapi(getRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { workflow_id: workflowId, run_id: runId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const wf = await sql`
      SELECT workflow_id FROM workflows WHERE workflow_id = ${workflowId}
    `;
    if (wf.length === 0) return c.json({ error: "Workflow not found" }, 404);

    const rows = await sql`
      SELECT * FROM workflow_runs WHERE run_id = ${runId} AND workflow_id = ${workflowId}
    `;
    if (rows.length === 0) return c.json({ error: "Workflow run not found" }, 404);
    return c.json(decodeRunRow(rows[0]));
  });
});

// ── POST /workflows/:workflow_id/runs/:run_id/cancel ────────────────────

const cancelRunRoute = createRoute({
  method: "post",
  path: "/{workflow_id}/runs/{run_id}/cancel",
  tags: ["Workflows"],
  summary: "Cancel a workflow run",
  middleware: [requireScope("workflows:write")],
  request: {
    params: z.object({
      workflow_id: z.string(),
      run_id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Run cancelled",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404, 409),
  },
});
workflowRoutes.openapi(cancelRunRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { workflow_id: workflowId, run_id: runId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const wf = await sql`
      SELECT workflow_id FROM workflows WHERE workflow_id = ${workflowId}
    `;
    if (wf.length === 0) return c.json({ error: "Workflow not found" }, 404);

    const rows = await sql`
      SELECT status FROM workflow_runs WHERE run_id = ${runId} AND workflow_id = ${workflowId}
    `;
    if (rows.length === 0) return c.json({ error: "Workflow run not found" }, 404);
    if (!["running", "pending"].includes(rows[0].status)) {
      return c.json({ error: `Cannot cancel run with status '${rows[0].status}'` }, 409);
    }

    const now = new Date().toISOString();
    await sql`
      UPDATE workflow_runs SET status = 'cancelled', completed_at = ${now} WHERE run_id = ${runId}
    `;
    return c.json({ cancelled: runId });
  });
});

// ── POST /workflows/validate ────────────────────────────────────────────

const validateWorkflowRoute = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Workflows"],
  summary: "Validate workflow steps",
  middleware: [requireScope("workflows:read")],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            steps: z.array(z.record(z.unknown())).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Validation result",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
  },
});
workflowRoutes.openapi(validateWorkflowRoute, async (c): Promise<any> => {
  const body = c.req.valid("json");
  const steps = Array.isArray(body.steps) ? body.steps : [];
  return c.json(validateWorkflow(steps as any));
});

// ── DELETE /workflows/:workflow_id ──────────────────────────────────────

const deleteWorkflowRoute = createRoute({
  method: "delete",
  path: "/{workflow_id}",
  tags: ["Workflows"],
  summary: "Delete a workflow",
  middleware: [requireScope("workflows:write")],
  request: {
    params: z.object({ workflow_id: z.string() }),
  },
  responses: {
    200: {
      description: "Workflow deleted",
      content: { "application/json": { schema: z.record(z.unknown()) } },
    },
    ...errorResponses(404),
  },
});
workflowRoutes.openapi(deleteWorkflowRoute, async (c): Promise<any> => {
  const user = c.get("user");
  const { workflow_id: workflowId } = c.req.valid("param");
  return await withOrgDb(c.env, user.org_id, async (sql) => {
    const result = await sql`
      DELETE FROM workflows WHERE workflow_id = ${workflowId}
    `;
    if (result.count === 0) return c.json({ error: "Workflow not found" }, 404);
    return c.json({ deleted: workflowId });
  });
});
