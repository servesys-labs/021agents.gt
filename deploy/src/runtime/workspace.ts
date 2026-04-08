/**
 * Edge Runtime — Workspace Persistence (R2-backed).
 *
 * Per-file sync with manifest — not tar snapshots.
 *
 * Storage layout in R2:
 *   workspaces/{org}/{agent}/u/{userId}/manifest.json   — per-user file list
 *   workspaces/{org}/{agent}/u/{userId}/files/{path}    — per-user files
 *   workspaces/{org}/{agent}/projects/{name}/files/{..}  — named projects (shared)
 *
 * Each user gets their own workspace scope within the same agent.
 * When no userId is provided, falls back to "shared" (agent-level scope).
 *
 * Write flow:
 *   write-file → sandbox + R2 file + update manifest (non-blocking)
 *
 * Restore flow (cold start):
 *   load manifest → diff against sandbox → download missing files
 *
 * Benefits over tar:
 *   - No extract step on restore
 *   - Incremental sync (only changed files)
 *   - Random access reads from R2
 *   - Agent can work continuously without explicit save/load
 */

import type { RuntimeEnv } from "./types";

export interface FileEntry {
  path: string;
  size: number;
  hash: string;
  updated_at: string;
}

export interface WorkspaceManifest {
  org_id: string;
  agent_name: string;
  user_id: string;
  files: FileEntry[];
  last_sync: string;
  session_id: string;
}

function scopePrefix(org: string, agent: string, userId?: string): string {
  const userScope = userId || "shared";
  return `workspaces/${org}/${agent}/u/${userScope}`;
}

function manifestKey(org: string, agent: string, userId?: string): string {
  return `${scopePrefix(org, agent, userId)}/manifest.json`;
}

function fileKey(org: string, agent: string, filePath: string, userId?: string): string {
  // Normalize: strip leading /workspace/ to get relative path
  const relative = filePath.replace(/^\/workspace\//, "").replace(/^\/+/, "");
  return `${scopePrefix(org, agent, userId)}/files/${relative}`;
}

/**
 * Sync a single file to R2 and update the manifest.
 * Called after every write-file/edit-file in the tool layer.
 * Files are scoped per-user within the agent (userId from channel_user_id).
 */
export async function syncFileToR2(
  storage: R2Bucket,
  org: string,
  agent: string,
  filePath: string,
  content: string,
  sessionId: string,
  userId?: string,
): Promise<void> {
  const key = fileKey(org, agent, filePath, userId);
  const hash = await quickHash(content);
  const now = new Date().toISOString();

  // Write file to R2
  await storage.put(key, content, {
    customMetadata: {
      original_path: filePath,
      hash,
      session_id: sessionId,
      updated_at: now,
    },
  });

  // Update manifest (read-modify-write)
  const mKey = manifestKey(org, agent, userId);
  let manifest = await loadManifest(storage, org, agent, userId);
  if (!manifest) {
    manifest = { org_id: org, agent_name: agent, user_id: userId || "shared", files: [], last_sync: now, session_id: sessionId };
  }

  // Upsert file entry
  const relative = filePath.replace(/^\/workspace\//, "").replace(/^\/+/, "");
  const idx = manifest.files.findIndex((f) => f.path === relative);
  const entry: FileEntry = { path: relative, size: content.length, hash, updated_at: now };
  if (idx >= 0) {
    manifest.files[idx] = entry;
  } else {
    manifest.files.push(entry);
  }
  manifest.last_sync = now;
  manifest.session_id = sessionId;

  await storage.put(mKey, JSON.stringify(manifest, null, 2), {
    customMetadata: { updated_at: now },
  });
}

/**
 * Load the workspace manifest from R2.
 */
export async function loadManifest(
  storage: R2Bucket,
  org: string,
  agent: string,
  userId?: string,
): Promise<WorkspaceManifest | null> {
  const obj = await storage.get(manifestKey(org, agent, userId));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as WorkspaceManifest;
  } catch {
    return null;
  }
}

/**
 * Hydrate the sandbox workspace from R2 manifest.
 * Downloads only files that don't exist locally or have changed.
 * Called on cold start / session restore.
 */
export async function hydrateWorkspace(
  storage: R2Bucket,
  sandbox: {
    exec: (cmd: string, opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    writeFile: (path: string, content: string) => Promise<unknown>;
  },
  org: string,
  agent: string,
  userId?: string,
): Promise<{ restored: number; skipped: number }> {
  const manifest = await loadManifest(storage, org, agent, userId);
  if (!manifest || manifest.files.length === 0) return { restored: 0, skipped: 0 };

  await sandbox.exec("mkdir -p /workspace", { timeout: 5 }).catch(() => {});

  let restored = 0;
  let skipped = 0;

  for (const entry of manifest.files) {
    const localPath = `/workspace/${entry.path}`;

    // Always re-download — hash comparison is unreliable across sandbox restarts.
    // The sha256sum shell command had quoting issues and the hash encoding could
    // diverge from the JS quickHash. The overhead is acceptable: files are cached
    // in R2 and reads are fast.

    // Download from R2 and write to sandbox
    const key = fileKey(org, agent, localPath, userId);
    const obj = await storage.get(key);
    if (!obj) {
      console.warn(`[workspace] Manifest lists ${entry.path} but R2 object not found — skipping (possible partial delete)`);
      continue;
    }

    const content = await obj.text();
    const dir = localPath.substring(0, localPath.lastIndexOf("/"));
    if (dir) await sandbox.exec(`mkdir -p "${dir}"`, { timeout: 5 }).catch(() => {});
    await sandbox.writeFile(localPath, content);
    restored++;
  }

  return { restored, skipped };
}

/**
 * List all files in the workspace from the manifest (no sandbox access needed).
 */
export async function listWorkspaceFiles(
  storage: R2Bucket,
  org: string,
  agent: string,
  userId?: string,
): Promise<FileEntry[]> {
  const manifest = await loadManifest(storage, org, agent, userId);
  return manifest?.files || [];
}

/**
 * Read a file directly from R2 (no sandbox needed).
 */
export async function readFileFromR2(
  storage: R2Bucket,
  org: string,
  agent: string,
  filePath: string,
  userId?: string,
): Promise<string | null> {
  const key = fileKey(org, agent, filePath, userId);
  const obj = await storage.get(key);
  if (!obj) return null;
  return obj.text();
}

/**
 * Delete a file from R2 and remove it from the manifest.
 */
export async function deleteFileFromR2(
  storage: R2Bucket,
  org: string,
  agent: string,
  filePath: string,
  userId?: string,
): Promise<void> {
  const key = fileKey(org, agent, filePath, userId);
  await storage.delete(key);

  // Update manifest — remove the entry
  const mKey = manifestKey(org, agent, userId);
  const manifest = await loadManifest(storage, org, agent, userId);
  if (manifest) {
    const relative = filePath.replace(/^\/workspace\//, "").replace(/^\/+/, "");
    manifest.files = manifest.files.filter((f) => f.path !== relative);
    manifest.last_sync = new Date().toISOString();
    await storage.put(mKey, JSON.stringify(manifest, null, 2), {
      customMetadata: { updated_at: manifest.last_sync },
    });
  }
}

/**
 * Load an R2 folder (project or user workspace) into a text summary for agent context.
 * Returns file contents formatted for injection into the conversation.
 */
export async function loadFolderToContext(
  storage: R2Bucket,
  prefix: string,
  opts?: { maxFiles?: number; maxSizePerFile?: number },
): Promise<string> {
  const maxFiles = opts?.maxFiles || 20;
  const maxSize = opts?.maxSizePerFile || 50_000; // 50KB per file
  const listed = await storage.list({ prefix, limit: maxFiles + 5 });
  if (listed.objects.length === 0) return "No files found at this path.";

  const parts: string[] = [];
  let loaded = 0;

  for (const obj of listed.objects) {
    if (loaded >= maxFiles) break;
    // Skip manifest files and directories
    if (obj.key.endsWith("manifest.json") || obj.key.endsWith("/")) continue;
    if (obj.size > maxSize) {
      const relPath = obj.key.replace(prefix, "");
      parts.push(`--- ${relPath} (${obj.size} bytes, too large to include) ---`);
      loaded++;
      continue;
    }
    const file = await storage.get(obj.key);
    if (!file) continue;
    const content = await file.text();
    const relPath = obj.key.replace(prefix, "").replace(/^\//, "");
    parts.push(`--- ${relPath} ---\n${content}`);
    loaded++;
  }

  return parts.join("\n\n");
}

/**
 * Validate a workspace path for safety. Rejects path traversal attempts,
 * double slashes, and empty paths. Used by HTTP endpoints; exported for testing.
 */
export function validateWorkspacePath(path: string): { valid: boolean; error?: string } {
  if (!path) return { valid: false, error: "Path must not be empty" };
  if (path.includes("..")) return { valid: false, error: "Path traversal not allowed" };
  if (path.includes("//")) return { valid: false, error: "Invalid path" };
  return { valid: true };
}

// ── Helpers ───────────────────────────────────────────────────

async function quickHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
