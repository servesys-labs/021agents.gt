/**
 * Workflows router — multi-agent DAG pipelines.
 * Ported from agentos/api/routers/workflows.py
 *
 * Topological sort + cycle detection in logic/workflow-validator.ts.
 * Run endpoint returns 410 (edge-only).
 */
import { Hono } from "hono";
import type { Env } from "../env";
import type { CurrentUser } from "../auth/types";
import { getDbForOrg } from "../db/client";
import { normalizeSteps, validateWorkflow, deriveRunMetadata } from "../logic/workflow-validator";
import { requireScope } from "../middleware/auth";

type R = { Bindings: Env; Variables: { user: CurrentUser } };
export const workflowRoutes = new Hono<R>();

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

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
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

async function ensureApprovalTable(sql: Awaited<ReturnType<typeof getDbForOrg>>): Promise<void> {
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
  try {
    item.steps = JSON.parse(item.steps_status_json || "{}");
  } catch {
    item.steps = {};
  }
  delete item.steps_status_json;
  try {
    item.dag = JSON.parse(item.dag_json || "{}");
  } catch {
    item.dag = {};
  }
  delete item.dag_json;
  try {
    item.reflection = JSON.parse(item.reflection_json || "{}");
  } catch {
    item.reflection = {};
  }
  delete item.reflection_json;
  item.run_metadata = deriveRunMetadata(item.dag || {}, item.reflection || {});
  return item;
}

function genId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

workflowRoutes.post("/approval/start", requireScope("workflows:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

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

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await ensureApprovalTable(sql);

  if (idempotencyKey) {
    const existingRows = await sql`
      SELECT * FROM workflow_approvals
      WHERE org_id = ${user.org_id} AND idempotency_key = ${idempotencyKey}
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
    SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} AND org_id = ${user.org_id} LIMIT 1
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

workflowRoutes.get("/approval/:approval_id", requireScope("workflows:read"), async (c) => {
  const user = c.get("user");
  const approvalId = c.req.param("approval_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await ensureApprovalTable(sql);
  const rows = await sql`
    SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} AND org_id = ${user.org_id} LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "Approval workflow not found" }, 404);
  return c.json(decodeApprovalRow(rows[0] as ApprovalRow));
});

workflowRoutes.post("/approval/:approval_id/decision", requireScope("workflows:write"), async (c) => {
  const user = c.get("user");
  const approvalId = c.req.param("approval_id");
  const body = await c.req.json();
  const decision = String(body.decision || "").trim().toLowerCase();
  const comment = String(body.comment || "").trim();
  const reviewerId = String(body.reviewer_id || user.user_id).trim();

  if (decision !== "approved" && decision !== "rejected") {
    return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  await ensureApprovalTable(sql);

  const rows = await sql`
    SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} AND org_id = ${user.org_id} LIMIT 1
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
  if (Number(existing.deadline_at || 0) > 0 && Number(existing.deadline_at) <= now) {
    await sql`
      UPDATE workflow_approvals
      SET status = ${"expired"}, updated_at = ${now}
      WHERE approval_id = ${approvalId} AND org_id = ${user.org_id}
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
    WHERE approval_id = ${approvalId} AND org_id = ${user.org_id}
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
    SELECT * FROM workflow_approvals WHERE approval_id = ${approvalId} AND org_id = ${user.org_id} LIMIT 1
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

workflowRoutes.get("/", requireScope("workflows:read"), async (c) => {
  const user = c.get("user");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const rows = await sql`
    SELECT * FROM workflows WHERE org_id = ${user.org_id} ORDER BY created_at DESC
  `;
  const result = rows.map((r: any) => {
    const d = { ...r };
    try {
      d.steps = JSON.parse(d.steps_json || "[]");
    } catch {
      d.steps = [];
    }
    delete d.steps_json;
    return d;
  });
  return c.json({ workflows: result });
});

workflowRoutes.post("/", requireScope("workflows:write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  const description = String(body.description || "");
  const steps = Array.isArray(body.steps) ? body.steps : [];

  if (!name) return c.json({ error: "name is required" }, 400);

  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);
  const workflowId = genId();
  const normalizedSteps = normalizeSteps(steps);
  const stepsJson = JSON.stringify(normalizedSteps);

  await sql`
    INSERT INTO workflows (workflow_id, org_id, name, description, steps_json)
    VALUES (${workflowId}, ${user.org_id}, ${name}, ${description}, ${stepsJson})
  `;

  return c.json({ workflow_id: workflowId, name, steps: normalizedSteps.length });
});

workflowRoutes.post("/:workflow_id/run", requireScope("workflows:write"), (c) =>
  c.json(
    {
      error: "Moved to edge runtime",
      detail: "Workflow runtime execution is edge-only. Dispatch workflow execution to worker runtime endpoints.",
    },
    410,
  ),
);

workflowRoutes.get("/:workflow_id/runs", requireScope("workflows:read"), async (c) => {
  const user = c.get("user");
  const workflowId = c.req.param("workflow_id");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 20));
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const wf = await sql`
    SELECT workflow_id FROM workflows WHERE workflow_id = ${workflowId} AND org_id = ${user.org_id}
  `;
  if (wf.length === 0) return c.json({ error: "Workflow not found" }, 404);

  const rows = await sql`
    SELECT * FROM workflow_runs WHERE workflow_id = ${workflowId}
    ORDER BY started_at DESC LIMIT ${limit}
  `;
  return c.json({ runs: rows.map(decodeRunRow) });
});

workflowRoutes.get("/:workflow_id/runs/:run_id", requireScope("workflows:read"), async (c) => {
  const user = c.get("user");
  const workflowId = c.req.param("workflow_id");
  const runId = c.req.param("run_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const wf = await sql`
    SELECT workflow_id FROM workflows WHERE workflow_id = ${workflowId} AND org_id = ${user.org_id}
  `;
  if (wf.length === 0) return c.json({ error: "Workflow not found" }, 404);

  const rows = await sql`
    SELECT * FROM workflow_runs WHERE run_id = ${runId} AND workflow_id = ${workflowId}
  `;
  if (rows.length === 0) return c.json({ error: "Workflow run not found" }, 404);
  return c.json(decodeRunRow(rows[0]));
});

workflowRoutes.post("/:workflow_id/runs/:run_id/cancel", requireScope("workflows:write"), async (c) => {
  const user = c.get("user");
  const workflowId = c.req.param("workflow_id");
  const runId = c.req.param("run_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const wf = await sql`
    SELECT workflow_id FROM workflows WHERE workflow_id = ${workflowId} AND org_id = ${user.org_id}
  `;
  if (wf.length === 0) return c.json({ error: "Workflow not found" }, 404);

  const rows = await sql`
    SELECT status FROM workflow_runs WHERE run_id = ${runId} AND workflow_id = ${workflowId}
  `;
  if (rows.length === 0) return c.json({ error: "Workflow run not found" }, 404);
  if (!["running", "pending"].includes(rows[0].status)) {
    return c.json({ error: `Cannot cancel run with status '${rows[0].status}'` }, 409);
  }

  const now = Date.now() / 1000;
  await sql`
    UPDATE workflow_runs SET status = 'cancelled', completed_at = ${now} WHERE run_id = ${runId}
  `;
  return c.json({ cancelled: runId });
});

workflowRoutes.post("/validate", requireScope("workflows:read"), async (c) => {
  const body = await c.req.json();
  const steps = Array.isArray(body.steps) ? body.steps : [];
  return c.json(validateWorkflow(steps));
});

workflowRoutes.delete("/:workflow_id", requireScope("workflows:write"), async (c) => {
  const user = c.get("user");
  const workflowId = c.req.param("workflow_id");
  const sql = await getDbForOrg(c.env.HYPERDRIVE, user.org_id);

  const result = await sql`
    DELETE FROM workflows WHERE workflow_id = ${workflowId} AND org_id = ${user.org_id}
  `;
  if (result.count === 0) return c.json({ error: "Workflow not found" }, 404);
  return c.json({ deleted: workflowId });
});
