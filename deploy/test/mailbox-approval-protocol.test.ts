import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createMailboxTable,
  writeToMailbox,
  readMailbox,
  sendPermissionRequest,
  sendPermissionResponse,
  sendPlanApproval,
  pollForCorrelatedResponse,
  waitForCorrelatedResponse,
  generateCorrelationId,
  PERMISSION_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  type MailboxMessage,
} from "../src/runtime/mailbox";

// ── In-memory SQLite mock ────────────────────────────────────────
// Simulates the DO_SQL tagged-template interface backed by a simple
// array-based store so we can test mailbox logic without a real DB.

interface MockRow {
  id: number;
  from_session: string;
  to_session: string;
  message_type: string;
  payload: string;
  correlation_id: string | null;
  read_at: number | null;
  created_at: number;
}

function createMockSql() {
  let rows: MockRow[] = [];
  let nextId = 1;

  function sql(strings: TemplateStringsArray, ...values: any[]): any {
    const query = strings.join("?");

    // CREATE TABLE / CREATE INDEX — no-op
    if (query.includes("CREATE TABLE") || query.includes("CREATE INDEX")) return [];

    // INSERT
    if (query.includes("INSERT INTO mailbox")) {
      const row: MockRow = {
        id: nextId++,
        from_session: values[0],
        to_session: values[1],
        message_type: values[2],
        payload: values[3],
        correlation_id: values[4] ?? null,
        read_at: null,
        created_at: Date.now() / 1000,
      };
      rows.push(row);
      return [];
    }

    // UPDATE read_at
    if (query.includes("UPDATE mailbox SET read_at")) {
      const now = values[0];
      const id = values[1];
      const row = rows.find((r) => r.id === id);
      if (row) row.read_at = now;
      return [];
    }

    // SELECT for readMailbox
    if (query.includes("SELECT") && query.includes("to_session") && query.includes("read_at IS NULL") && !query.includes("correlation_id =")) {
      const sessionId = values[0];
      const sinceTs = values[1] ?? 0;
      return rows
        .filter((r) => r.to_session === sessionId && r.read_at === null && r.created_at > sinceTs)
        .sort((a, b) => a.id - b.id)
        .slice(0, 50);
    }

    // SELECT for pollForCorrelatedResponse
    if (query.includes("SELECT") && query.includes("correlation_id =")) {
      const sessionId = values[0];
      const correlationId = values[1];
      return rows
        .filter((r) => r.to_session === sessionId && r.correlation_id === correlationId && r.read_at === null)
        .sort((a, b) => a.id - b.id)
        .slice(0, 1);
    }

    // SELECT COUNT for hasPendingPermissionRequests
    if (query.includes("COUNT(*)")) {
      const sessionId = values[0];
      const cnt = rows.filter((r) => r.to_session === sessionId && r.message_type === "permission_request" && r.read_at === null).length;
      return [{ cnt }];
    }

    return [];
  }

  return { sql, _rows: () => rows, _reset: () => { rows = []; nextId = 1; } };
}

// ── Source analysis helpers ───────────────────────────────────────

const WORKFLOW_PATH = path.resolve(__dirname, "../src/workflow.ts");
const TOOLS_PATH = path.resolve(__dirname, "../src/runtime/tools.ts");

function loadSource(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

// ── Tests ───────────��────────────────────────────────────────────

describe("mailbox correlation semantics", () => {
  let mock: ReturnType<typeof createMockSql>;

  beforeEach(() => { mock = createMockSql(); });

  it("generateCorrelationId returns 16-char hex string", () => {
    const cid = generateCorrelationId();
    expect(cid).toMatch(/^[0-9a-f]{16}$/);
    // Uniqueness
    const cid2 = generateCorrelationId();
    expect(cid).not.toBe(cid2);
  });

  it("sendPermissionRequest writes with correlation_id and returns it", () => {
    const cid = sendPermissionRequest(mock.sql, "child-1", "parent-1", {
      action: "delete-file",
      reason: "cleanup old artifacts",
    });
    expect(cid).toMatch(/^[0-9a-f]{16}$/);

    const msgs = readMailbox(mock.sql, "parent-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message_type).toBe("permission_request");
    expect(msgs[0].correlation_id).toBe(cid);
    expect(msgs[0].from_session).toBe("child-1");

    const payload = JSON.parse(msgs[0].payload);
    expect(payload.action).toBe("delete-file");
    expect(payload.child_session_id).toBe("child-1");
  });

  it("sendPermissionResponse writes with matching correlation_id", () => {
    sendPermissionResponse(mock.sql, "parent-1", "child-1", "abc123", {
      approved: true,
      reason: "go ahead",
    });

    const msgs = readMailbox(mock.sql, "child-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message_type).toBe("permission_response");
    expect(msgs[0].correlation_id).toBe("abc123");

    const payload = JSON.parse(msgs[0].payload);
    expect(payload.approved).toBe(true);
    expect(payload.reason).toBe("go ahead");
  });

  it("sendPlanApproval writes with matching correlation_id", () => {
    sendPlanApproval(mock.sql, "parent-1", "child-1", "plan-cid", {
      approved: false,
      feedback: "too many files",
    });

    const msgs = readMailbox(mock.sql, "child-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message_type).toBe("plan_approval");
    expect(msgs[0].correlation_id).toBe("plan-cid");

    const payload = JSON.parse(msgs[0].payload);
    expect(payload.approved).toBe(false);
    expect(payload.feedback).toBe("too many files");
  });

  it("pollForCorrelatedResponse finds matching message and marks read", () => {
    sendPermissionResponse(mock.sql, "parent-1", "child-1", "cid-1", { approved: true });
    // Unrelated message
    writeToMailbox(mock.sql, "sibling-1", "child-1", "text", "hello");

    const result = pollForCorrelatedResponse(mock.sql, "child-1", "cid-1");
    expect(result).not.toBeNull();
    expect(result!.correlation_id).toBe("cid-1");
    expect(result!.message_type).toBe("permission_response");

    // Polling again should return null (already read)
    const again = pollForCorrelatedResponse(mock.sql, "child-1", "cid-1");
    expect(again).toBeNull();
  });

  it("pollForCorrelatedResponse returns null for correlation_id mismatch", () => {
    sendPermissionResponse(mock.sql, "parent-1", "child-1", "cid-A", { approved: true });

    const result = pollForCorrelatedResponse(mock.sql, "child-1", "cid-B");
    expect(result).toBeNull();
  });

  it("pollForCorrelatedResponse returns null for session mismatch", () => {
    sendPermissionResponse(mock.sql, "parent-1", "child-1", "cid-1", { approved: true });

    const result = pollForCorrelatedResponse(mock.sql, "child-2", "cid-1");
    expect(result).toBeNull();
  });
});

describe("waitForCorrelatedResponse — blocking wait", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns immediately when response already exists", async () => {
    const mock = createMockSql();
    sendPermissionResponse(mock.sql, "parent", "child", "cid-fast", { approved: true });

    const result = await waitForCorrelatedResponse(mock.sql, "child", "cid-fast", 5000, 50);
    expect(result).not.toBeNull();
    expect(result!.correlation_id).toBe("cid-fast");
  });

  it("returns null on timeout when no response arrives", async () => {
    const mock = createMockSql();
    // No response written — should timeout
    const result = await waitForCorrelatedResponse(mock.sql, "child", "cid-never", 200, 50);
    expect(result).toBeNull();
  });

  it("picks up response that arrives mid-wait", async () => {
    const mock = createMockSql();

    // Write response after 100ms
    setTimeout(() => {
      sendPermissionResponse(mock.sql, "parent", "child", "cid-delayed", { approved: false, reason: "nope" });
    }, 100);

    const result = await waitForCorrelatedResponse(mock.sql, "child", "cid-delayed", 2000, 50);
    expect(result).not.toBeNull();
    expect(result!.correlation_id).toBe("cid-delayed");
    const payload = JSON.parse(result!.payload);
    expect(payload.approved).toBe(false);
  });
});

describe("readMailbox — backward compat with correlation_id", () => {
  it("returns correlation_id field in messages", () => {
    const mock = createMockSql();
    // Legacy text message (no correlation_id)
    writeToMailbox(mock.sql, "parent", "child", "text", "hello");
    // Correlated message
    sendPermissionRequest(mock.sql, "child", "parent", { action: "deploy" });

    const childMsgs = readMailbox(mock.sql, "child");
    expect(childMsgs).toHaveLength(1);
    expect(childMsgs[0].correlation_id).toBeNull();

    const parentMsgs = readMailbox(mock.sql, "parent");
    expect(parentMsgs).toHaveLength(1);
    expect(parentMsgs[0].correlation_id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("workflow mailbox protocol — compile safety", () => {
  const source = loadSource(WORKFLOW_PATH);

  it("imports waitForCorrelatedResponse (not just pollForCorrelatedResponse)", () => {
    // This was the Phase 1 blocker: workflow called waitForCorrelatedResponse but
    // imported pollForCorrelatedResponse. Verify the USED function is imported.
    expect(source).toMatch(/import\s*\{[^}]*waitForCorrelatedResponse[^}]*\}\s*from\s*"\.\/runtime\/mailbox"/);
    // And it's actually called in the body
    expect(source).toContain("await waitForCorrelatedResponse(");
  });

  it("does not import pollForCorrelatedResponse (unused in workflow)", () => {
    expect(source).not.toMatch(/import\s*\{[^}]*pollForCorrelatedResponse[^}]*\}\s*from/);
  });

  it("passes DO_SQL into executeTools env", () => {
    // This was the Phase 1 blocker: send-message reads (env as any).DO_SQL
    // but the workflow env object didn't include it.
    const toolEnvBlock = source.slice(
      source.indexOf("results = await executeTools("),
      source.indexOf("} as any,", source.indexOf("results = await executeTools(")),
    );
    expect(toolEnvBlock).toContain("DO_SQL:");
  });
});

describe("workflow mailbox protocol — structural checks", () => {
  const source = loadSource(WORKFLOW_PATH);

  it("all agents poll mailbox, not just children", () => {
    const startIdx = source.indexOf("Phase 6.1: Mailbox IPC");
    const afterMailbox = source.indexOf("Phase 1.4: Loop detection", startIdx);
    const mailboxSection = source.slice(startIdx, afterMailbox);
    expect(mailboxSection.length).toBeGreaterThan(100);
    expect(mailboxSection).toContain("readMailbox");
    expect(mailboxSection).not.toMatch(/if\s*\(\s*p\.parent_session_id\s*\)\s*\{[\s\S]*?readMailbox/);
  });

  it("emits all six approval telemetry events with satisfies guard", () => {
    for (const evt of [
      "permission_requested", "permission_granted", "permission_denied",
      "permission_timeout", "plan_approved", "plan_rejected",
    ]) {
      expect(source).toContain(`"${evt}" satisfies RuntimeEventType`);
    }
  });

  it("terminates on permission_timeout and permission_denied", () => {
    expect(source).toContain('terminationReason = "permission_timeout"');
    expect(source).toContain('terminationReason = "permission_denied"');
  });

  it("planApprovedByParent bypasses premature-plan gate", () => {
    expect(source).toMatch(/planOnlyRequested\s*\|\|\s*planApprovedByParent/);
  });

  it("preserves existing shutdown and text behavior", () => {
    expect(source).toContain('terminationReason = "parent_shutdown"');
    expect(source).toContain("Received shutdown signal from parent agent");
    expect(source).toContain("[Message from parent agent]:");
  });
});

describe("send-message tool — typed mailbox sender", () => {
  const source = loadSource(TOOLS_PATH);

  it("imports typed mailbox senders", () => {
    expect(source).toMatch(/import\s*\{[^}]*sendPermissionRequest[^}]*\}\s*from\s*"\.\/mailbox"/);
    expect(source).toMatch(/import\s*\{[^}]*sendPermissionResponse[^}]*\}\s*from\s*"\.\/mailbox"/);
    expect(source).toMatch(/import\s*\{[^}]*sendPlanApproval[^}]*\}\s*from\s*"\.\/mailbox"/);
  });

  it("returns structured JSON with awaiting_approval for permission_request", () => {
    expect(source).toContain("awaiting_approval: true");
    // The result must include correlation_id so the workflow can block on it
    expect(source).toMatch(/message_type:\s*"permission_request"[\s\S]*?correlation_id:\s*cid/);
  });

  it("requires correlation_id for permission_response and plan_approval", () => {
    expect(source).toContain('permission_response requires \'correlation_id\'');
    expect(source).toContain('plan_approval requires \'correlation_id\'');
  });

  it("falls back to plain text writeToMailbox for default type", () => {
    expect(source).toContain('writeToMailbox(doSql, sessionId, to, "text", message)');
  });

  it("returns error string when DO_SQL unavailable", () => {
    expect(source).toContain("Mailbox not available (not running in a Durable Object context)");
  });
});

describe("DO_SQL wiring — negative test", () => {
  it("send-message without DO_SQL returns error, not silent failure", () => {
    // Simulate what happens when DO_SQL is undefined by checking the tool code path.
    // The tool checks `const doSql = (env as any).DO_SQL; if (!doSql) return "Mailbox not available..."`.
    // This test verifies that guard exists in the source, because without it
    // the tool would throw on undefined.DO_SQL.
    const source = loadSource(TOOLS_PATH);
    // Find the send-message case and verify the guard is present
    const caseStart = source.indexOf('case "send-message"');
    const caseEnd = source.indexOf("case ", caseStart + 1);
    const caseBlock = source.slice(caseStart, caseEnd);
    expect(caseBlock).toContain("if (!doSql)");
    expect(caseBlock).toContain("Mailbox not available");
  });
});

describe("DO schema migration v6 — correlation_id column", () => {
  const source = loadSource(path.resolve(__dirname, "../src/index.ts"));

  it("migration v6 exists and ALTERs mailbox table", () => {
    expect(source).toContain("schemaVersion < 6");
    expect(source).toMatch(/ALTER TABLE mailbox ADD COLUMN correlation_id/);
  });

  it("migration v6 creates the correlation index", () => {
    expect(source).toContain("idx_mailbox_correlation");
    // Verify it's in the v6 block, not just anywhere
    const v6Start = source.indexOf("schemaVersion < 6");
    const v6End = source.indexOf("INSERT INTO _sql_schema_migrations (id) VALUES (6)", v6Start);
    const v6Block = source.slice(v6Start, v6End);
    expect(v6Block).toContain("idx_mailbox_correlation");
    expect(v6Block).toContain("correlation_id");
  });

  it("migration v6 records itself in schema_migrations", () => {
    expect(source).toContain("INSERT INTO _sql_schema_migrations (id) VALUES (6)");
  });

  it("migration v6 is idempotent — checks column existence before ALTER (regression)", () => {
    // Regression: createMailboxTable() (v4) now includes correlation_id in
    // CREATE TABLE, so new DOs already have the column. v6 must NOT blindly
    // ALTER TABLE ADD COLUMN — SQLite throws on duplicate columns.
    const v6Start = source.indexOf("schemaVersion < 6");
    const v6End = source.indexOf("INSERT INTO _sql_schema_migrations (id) VALUES (6)", v6Start);
    const v6Block = source.slice(v6Start, v6End);
    // Must use PRAGMA table_info to check column existence
    expect(v6Block).toContain("PRAGMA table_info");
    expect(v6Block).toContain("hasCorrelationId");
    // ALTER is conditional, not unconditional
    expect(v6Block).toContain("if (!hasCorrelationId)");
  });
});

describe("event registry — approval events registered", () => {
  const eventsSource = loadSource(path.resolve(__dirname, "../src/runtime/events.ts"));

  it("has all six approval event types", () => {
    for (const evt of [
      "permission_requested",
      "permission_granted",
      "permission_denied",
      "permission_timeout",
      "plan_approved",
      "plan_rejected",
    ]) {
      expect(eventsSource).toContain(`"${evt}"`);
    }
  });
});

describe("end-to-end protocol — executable flow", () => {
  it("child sends permission_request, blocks, parent approves, child unblocks", async () => {
    const mock = createMockSql();

    // Step 1: Child sends permission_request to parent
    const cid = sendPermissionRequest(mock.sql, "child-1", "parent-1", {
      action: "delete /workspace/old-data",
      reason: "cleanup stale artifacts",
    });

    // Step 2: Parent sees the request
    const parentMsgs = readMailbox(mock.sql, "parent-1");
    expect(parentMsgs).toHaveLength(1);
    expect(parentMsgs[0].message_type).toBe("permission_request");
    expect(parentMsgs[0].correlation_id).toBe(cid);
    const request = JSON.parse(parentMsgs[0].payload);
    expect(request.action).toBe("delete /workspace/old-data");
    expect(request.child_session_id).toBe("child-1");

    // Step 3: Child starts blocking wait (with short timeout for test)
    // Simulate parent responding after 80ms
    const parentReplyTimer = setTimeout(() => {
      sendPermissionResponse(mock.sql, "parent-1", "child-1", cid, {
        approved: true,
        reason: "cleanup approved",
      });
    }, 80);

    const response = await waitForCorrelatedResponse(
      mock.sql, "child-1", cid, 2000, 30,
    );

    clearTimeout(parentReplyTimer);

    // Step 4: Child receives the correlated response
    expect(response).not.toBeNull();
    expect(response!.message_type).toBe("permission_response");
    expect(response!.correlation_id).toBe(cid);
    const decision = JSON.parse(response!.payload);
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("cleanup approved");
  });

  it("child sends permission_request, parent denies, child gets denial", async () => {
    const mock = createMockSql();

    const cid = sendPermissionRequest(mock.sql, "child-1", "parent-1", {
      action: "deploy to production",
    });

    // Parent denies immediately
    sendPermissionResponse(mock.sql, "parent-1", "child-1", cid, {
      approved: false,
      reason: "not during freeze window",
    });

    const response = await waitForCorrelatedResponse(
      mock.sql, "child-1", cid, 1000, 30,
    );

    expect(response).not.toBeNull();
    const decision = JSON.parse(response!.payload);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("not during freeze window");
  });

  it("child times out when parent never responds", async () => {
    const mock = createMockSql();

    const cid = sendPermissionRequest(mock.sql, "child-1", "parent-1", {
      action: "risky operation",
    });

    // Parent never responds — child should timeout
    const response = await waitForCorrelatedResponse(
      mock.sql, "child-1", cid, 150, 30,
    );

    expect(response).toBeNull();
  });

  it("correlation_id mismatch does not unblock the child", async () => {
    const mock = createMockSql();

    const cid = sendPermissionRequest(mock.sql, "child-1", "parent-1", {
      action: "test action",
    });

    // Parent responds with WRONG correlation_id
    sendPermissionResponse(mock.sql, "parent-1", "child-1", "wrong-cid", {
      approved: true,
    });

    const response = await waitForCorrelatedResponse(
      mock.sql, "child-1", cid, 150, 30,
    );

    // Should timeout — wrong correlation doesn't match
    expect(response).toBeNull();
  });

  it("multiple concurrent permission requests are independently correlated", async () => {
    const mock = createMockSql();

    // Two children request permission from the same parent
    const cid1 = sendPermissionRequest(mock.sql, "child-1", "parent-1", { action: "action-A" });
    const cid2 = sendPermissionRequest(mock.sql, "child-2", "parent-1", { action: "action-B" });

    expect(cid1).not.toBe(cid2);

    // Parent approves child-2 but denies child-1
    sendPermissionResponse(mock.sql, "parent-1", "child-2", cid2, { approved: true });
    sendPermissionResponse(mock.sql, "parent-1", "child-1", cid1, { approved: false, reason: "denied" });

    // Each child gets their own correlated response
    const resp1 = await waitForCorrelatedResponse(mock.sql, "child-1", cid1, 500, 30);
    const resp2 = await waitForCorrelatedResponse(mock.sql, "child-2", cid2, 500, 30);

    expect(resp1).not.toBeNull();
    expect(JSON.parse(resp1!.payload).approved).toBe(false);

    expect(resp2).not.toBeNull();
    expect(JSON.parse(resp2!.payload).approved).toBe(true);
  });
});

describe("constants", () => {
  it("PERMISSION_TIMEOUT_MS is 5 minutes", () => {
    expect(PERMISSION_TIMEOUT_MS).toBe(300_000);
  });

  it("POLL_INTERVAL_MS is 500ms", () => {
    expect(POLL_INTERVAL_MS).toBe(500);
  });
});
