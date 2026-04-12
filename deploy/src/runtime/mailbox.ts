/**
 * Phase 6.1: Agent-to-Agent Mailbox IPC
 *
 * Structured inter-agent messaging via DO SQLite. Workers can request
 * permission from the leader, send intermediate results, or signal shutdown.
 *
 * Correlation semantics: every permission_request / permission_response /
 * plan_approval carries a `correlation_id` so the sender can block on the
 * exact matching response. Text and shutdown remain fire-and-forget.
 */

export type MessageType = "text" | "permission_request" | "permission_response" | "shutdown" | "plan_approval";

export interface MailboxMessage {
  id: number;
  from_session: string;
  to_session: string;
  message_type: MessageType;
  payload: string;
  correlation_id: string | null;
  read_at: number | null;
  created_at: number;
}

/** Default timeout for permission responses: 5 minutes in ms. */
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Polling interval when waiting for a correlated response: 500ms. */
export const POLL_INTERVAL_MS = 500;

/**
 * Generate a short correlation ID (16 hex chars).
 */
export function generateCorrelationId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Initialize mailbox table in DO SQLite.
 * Call this during DO onStart() migration.
 */
export function createMailboxTable(sql: any): void {
  sql`CREATE TABLE IF NOT EXISTS mailbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_session TEXT NOT NULL,
    to_session TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK(message_type IN ('text','permission_request','permission_response','shutdown','plan_approval')),
    payload TEXT NOT NULL DEFAULT '',
    correlation_id TEXT,
    read_at REAL,
    created_at REAL NOT NULL DEFAULT (unixepoch('now'))
  )`;
  sql`CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(to_session, read_at)`;
  sql`CREATE INDEX IF NOT EXISTS idx_mailbox_correlation ON mailbox(to_session, correlation_id, read_at)`;
}

/**
 * Write a message to another agent's mailbox.
 * For backward compat, correlation_id is optional and defaults to null.
 */
export function writeToMailbox(
  sql: any,
  from: string,
  to: string,
  type: MessageType,
  payload: string | Record<string, unknown>,
  correlationId?: string,
): void {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const cid = correlationId || null;
  sql`INSERT INTO mailbox (from_session, to_session, message_type, payload, correlation_id) VALUES (${from}, ${to}, ${type}, ${payloadStr}, ${cid})`;
}

/**
 * Send a permission_request and return the correlation_id for later blocking wait.
 */
export function sendPermissionRequest(
  sql: any,
  from: string,
  to: string,
  payload: { action: string; reason?: string },
): string {
  const cid = generateCorrelationId();
  writeToMailbox(sql, from, to, "permission_request", { ...payload, child_session_id: from }, cid);
  return cid;
}

/**
 * Send a permission_response correlated to a specific request.
 */
export function sendPermissionResponse(
  sql: any,
  from: string,
  to: string,
  correlationId: string,
  payload: { approved: boolean; reason?: string },
): void {
  writeToMailbox(sql, from, to, "permission_response", payload, correlationId);
}

/**
 * Send a plan_approval correlated to a specific plan submission.
 */
export function sendPlanApproval(
  sql: any,
  from: string,
  to: string,
  correlationId: string,
  payload: { approved: boolean; feedback?: string },
): void {
  writeToMailbox(sql, from, to, "plan_approval", payload, correlationId);
}

/**
 * Read unread messages for a session. Marks them as read.
 */
export function readMailbox(
  sql: any,
  sessionId: string,
  since?: number,
): MailboxMessage[] {
  const sinceTs = since || 0;
  const rows = sql`
    SELECT id, from_session, to_session, message_type, payload, correlation_id, read_at, created_at
    FROM mailbox
    WHERE to_session = ${sessionId}
      AND read_at IS NULL
      AND created_at > ${sinceTs}
    ORDER BY id ASC
    LIMIT 50
  `;

  // Mark as read
  if (rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    const now = Date.now() / 1000;
    for (const id of ids) {
      sql`UPDATE mailbox SET read_at = ${now} WHERE id = ${id}`;
    }
  }

  return rows.map((r: any) => ({
    id: r.id,
    from_session: r.from_session,
    to_session: r.to_session,
    message_type: r.message_type as MessageType,
    payload: r.payload,
    correlation_id: r.correlation_id,
    read_at: r.read_at,
    created_at: r.created_at,
  }));
}

/**
 * Poll for a single unread message matching a correlation_id.
 * Returns the message and marks it read, or null if not found.
 */
export function pollForCorrelatedResponse(
  sql: any,
  sessionId: string,
  correlationId: string,
): MailboxMessage | null {
  const rows = sql`
    SELECT id, from_session, to_session, message_type, payload, correlation_id, read_at, created_at
    FROM mailbox
    WHERE to_session = ${sessionId}
      AND correlation_id = ${correlationId}
      AND read_at IS NULL
    ORDER BY id ASC
    LIMIT 1
  `;
  if (rows.length === 0) return null;

  const r = rows[0];
  const now = Date.now() / 1000;
  sql`UPDATE mailbox SET read_at = ${now} WHERE id = ${r.id}`;

  return {
    id: r.id,
    from_session: r.from_session,
    to_session: r.to_session,
    message_type: r.message_type as MessageType,
    payload: r.payload,
    correlation_id: r.correlation_id,
    read_at: r.read_at,
    created_at: r.created_at,
  };
}

/**
 * Block until a correlated response arrives or timeout expires.
 * Returns the response message, or null on timeout.
 *
 * Uses async polling with configurable interval. In Cloudflare Workers
 * Workflows this runs inside a step.do so the polling is non-blocking
 * to other workflow instances.
 */
export async function waitForCorrelatedResponse(
  sql: any,
  sessionId: string,
  correlationId: string,
  timeoutMs: number = PERMISSION_TIMEOUT_MS,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<MailboxMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = pollForCorrelatedResponse(sql, sessionId, correlationId);
    if (msg) return msg;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

/**
 * Check if there are pending permission requests for a session.
 */
export function hasPendingPermissionRequests(sql: any, sessionId: string): boolean {
  const rows = sql`
    SELECT COUNT(*) as cnt FROM mailbox
    WHERE to_session = ${sessionId} AND message_type = 'permission_request' AND read_at IS NULL
  `;
  return (rows[0]?.cnt || 0) > 0;
}
