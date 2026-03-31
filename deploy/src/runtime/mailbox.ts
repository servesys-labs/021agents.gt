/**
 * Phase 6.1: Agent-to-Agent Mailbox IPC
 *
 * Structured inter-agent messaging via DO SQLite. Workers can request
 * permission from the leader, send intermediate results, or signal shutdown.
 *
 * Inspired by Claude Code's coordinator mailbox system for teammate IPC.
 */

export type MessageType = "text" | "permission_request" | "permission_response" | "shutdown" | "plan_approval";

export interface MailboxMessage {
  id: number;
  from_session: string;
  to_session: string;
  message_type: MessageType;
  payload: string;
  read_at: number | null;
  created_at: number;
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
    read_at REAL,
    created_at REAL NOT NULL DEFAULT (unixepoch('now'))
  )`;
  sql`CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(to_session, read_at)`;
}

/**
 * Write a message to another agent's mailbox.
 */
export function writeToMailbox(
  sql: any,
  from: string,
  to: string,
  type: MessageType,
  payload: string | Record<string, unknown>,
): void {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  sql`INSERT INTO mailbox (from_session, to_session, message_type, payload) VALUES (${from}, ${to}, ${type}, ${payloadStr})`;
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
    SELECT id, from_session, to_session, message_type, payload, read_at, created_at
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
    read_at: r.read_at,
    created_at: r.created_at,
  }));
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
