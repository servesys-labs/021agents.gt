/**
 * Workspace Persistence — Hibernation-safe checkpointing for Durable Objects.
 *
 * Checkpoint workspace state to DO SQLite for fast hibernation recovery,
 * and to R2 for durable backup.
 *
 * DO SQLite is the primary store (survives hibernation).
 * R2 is the durable backup (survives DO eviction).
 */

import { parseJsonColumn } from "./parse-json-column";
import { log } from "./log";

// ── Types ─────────────────────────────────────────────────────

export interface WorkspaceFile {
  path: string;
  content: string;  // base64 for binary, utf-8 for text
  encoding: "utf-8" | "base64";
  size: number;
  hash: string;  // sha-256
  modified_at: string;
}

export interface WorkspaceCheckpoint {
  session_id: string;
  org_id: string;
  agent_name: string;
  files: WorkspaceFile[];
  working_memory: Record<string, unknown>;
  cumulative_cost_usd: number;
  turn_count: number;
  last_model: string;
  conversation_context: Array<{ role: string; content: string }>;
  created_at: string;
}

// ── SQLite Schema Init ────────────────────────────────────────

/**
 * Ensure workspace checkpoint and file tables exist in DO SQLite.
 * Safe to call multiple times (idempotent).
 */
export function ensureWorkspaceTables(sql: any): void {
  sql`CREATE TABLE IF NOT EXISTS workspace_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    created_at REAL NOT NULL DEFAULT (unixepoch('now'))
  )`;

  sql`CREATE TABLE IF NOT EXISTS workspace_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    encoding TEXT NOT NULL DEFAULT 'utf-8',
    size INTEGER NOT NULL DEFAULT 0,
    hash TEXT NOT NULL DEFAULT '',
    modified_at REAL NOT NULL DEFAULT (unixepoch('now')),
    UNIQUE(session_id, path)
  )`;
}

// ── Checkpoint: SQLite (primary, fast) ────────────────────────

/**
 * Save workspace checkpoint to DO SQLite.
 * Called: after every file write, every 30 seconds via alarm, and before hibernation.
 */
export function saveCheckpointToSQLite(
  sql: any,
  checkpoint: WorkspaceCheckpoint,
): void {
  ensureWorkspaceTables(sql);

  // Keep only the latest checkpoint per session (delete old ones)
  sql`DELETE FROM workspace_checkpoints WHERE session_id = ${checkpoint.session_id}`;

  sql`INSERT INTO workspace_checkpoints (session_id, checkpoint_json, created_at)
    VALUES (${checkpoint.session_id}, ${JSON.stringify(checkpoint)}, ${Date.now() / 1000})`;
}

/**
 * Restore workspace checkpoint from DO SQLite (fast, survives hibernation).
 * Returns null if no checkpoint exists (DO was evicted or first run).
 */
export function loadCheckpointFromSQLite(
  sql: any,
  sessionId: string,
): WorkspaceCheckpoint | null {
  ensureWorkspaceTables(sql);

  const rows = sql`SELECT checkpoint_json FROM workspace_checkpoints
    WHERE session_id = ${sessionId} ORDER BY created_at DESC LIMIT 1`;
  if (rows.length === 0) return null;
  return parseJsonColumn<WorkspaceCheckpoint | null>(rows[0].checkpoint_json, null);
}

// ── Checkpoint: R2 (durable backup) ──────────────────────────

/**
 * Save checkpoint to R2 (durable backup).
 * Called after SQLite save, non-blocking.
 */
export async function saveCheckpointToR2(
  storage: R2Bucket,
  orgId: string,
  agentName: string,
  sessionId: string,
  checkpoint: WorkspaceCheckpoint,
): Promise<void> {
  const key = `workspaces/${orgId}/${agentName}/sessions/${sessionId}/checkpoint.json`;
  await storage.put(key, JSON.stringify(checkpoint), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { session_id: sessionId, created_at: checkpoint.created_at },
  });
}

/**
 * Load checkpoint from R2 (fallback when DO SQLite is empty after eviction).
 */
export async function loadCheckpointFromR2(
  storage: R2Bucket,
  orgId: string,
  agentName: string,
  sessionId: string,
): Promise<WorkspaceCheckpoint | null> {
  const key = `workspaces/${orgId}/${agentName}/sessions/${sessionId}/checkpoint.json`;
  const obj = await storage.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

// ── Per-File Persistence: SQLite ─────────────────────────────

/** Maximum SQLite DB size before we start evicting old files (100 MB). */
const SQLITE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Return the current SQLite database size in bytes.
 */
function getSQLiteDbSize(sql: any): number {
  const pages = sql`PRAGMA page_count`[0]?.page_count ?? 0;
  const pageSize = sql`PRAGMA page_size`[0]?.page_size ?? 4096;
  return pages * pageSize;
}

/**
 * Evict oldest workspace files until the database is under the size limit.
 * Deletes up to 50 files per call to avoid long blocking operations.
 */
function evictOldestFiles(sql: any, limit: number = 50): number {
  const rows = sql`SELECT id FROM workspace_files ORDER BY modified_at ASC LIMIT ${limit}`;
  if (rows.length === 0) return 0;
  const ids = rows.map((r: any) => r.id);
  // Delete in batches — tagged template doesn't support IN(...) with arrays,
  // so delete one-by-one (still fast for <= 50 rows).
  for (const id of ids) {
    sql`DELETE FROM workspace_files WHERE id = ${id}`;
  }
  return ids.length;
}

/**
 * Save individual file to DO SQLite.
 * Called on every file write/edit in the workspace.
 *
 * Guards against unbounded growth: if the DB exceeds 100 MB, evicts oldest
 * files first. If still over limit after eviction, skips the write.
 */
export function saveFileToSQLite(
  sql: any,
  sessionId: string,
  file: WorkspaceFile,
): void {
  ensureWorkspaceTables(sql);

  // Guard: check DB size before writing
  let dbSize = getSQLiteDbSize(sql);
  if (dbSize >= SQLITE_MAX_BYTES) {
    const evicted = evictOldestFiles(sql);
    log.warn(
      `[workspace] SQLite at ${(dbSize / 1024 / 1024).toFixed(1)}MB — evicted ${evicted} old files`,
    );
    dbSize = getSQLiteDbSize(sql);
    if (dbSize >= SQLITE_MAX_BYTES) {
      log.warn(
        `[workspace] SQLite still at ${(dbSize / 1024 / 1024).toFixed(1)}MB after eviction — skipping write for ${file.path}`,
      );
      return;
    }
  }

  sql`INSERT OR REPLACE INTO workspace_files (session_id, path, content, encoding, size, hash, modified_at)
    VALUES (${sessionId}, ${file.path}, ${file.content}, ${file.encoding}, ${file.size}, ${file.hash}, ${Date.now() / 1000})`;
}

/**
 * Load all workspace files from SQLite (fast restore after hibernation).
 */
export function loadFilesFromSQLite(
  sql: any,
  sessionId: string,
): WorkspaceFile[] {
  ensureWorkspaceTables(sql);

  const rows = sql`SELECT path, content, encoding, size, hash, modified_at
    FROM workspace_files WHERE session_id = ${sessionId} ORDER BY path`;
  return rows.map((r: any) => ({
    path: r.path,
    content: r.content,
    encoding: r.encoding || "utf-8",
    size: Number(r.size),
    hash: r.hash,
    modified_at: new Date(Number(r.modified_at) * 1000).toISOString(),
  }));
}

/**
 * Save all files from SQLite to R2 (bulk durable backup).
 * Used during checkpoint to ensure R2 has all workspace files.
 */
export async function syncFilesToR2(
  storage: R2Bucket,
  orgId: string,
  agentName: string,
  sessionId: string,
  files: WorkspaceFile[],
): Promise<void> {
  const prefix = `workspaces/${orgId}/${agentName}/sessions/${sessionId}/files`;
  for (const file of files) {
    const key = `${prefix}${file.path}`;
    await storage.put(key, file.content, {
      httpMetadata: { contentType: file.encoding === "base64" ? "application/octet-stream" : "text/plain" },
      customMetadata: { hash: file.hash, encoding: file.encoding },
    });
  }
}

// ── Utilities ─────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of content.
 */
export async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
