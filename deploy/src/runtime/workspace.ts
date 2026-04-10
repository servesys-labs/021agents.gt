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
/**
 * List workspace files for an agent, merging the user-scoped manifest
 * with the shared-scoped manifest.
 *
 * Why merge: agent-generated files from web/canvas/SSE runs (where the
 * channel has no user_id) land under the "shared" scope. Manual uploads
 * from the portal land under the portal user's scope. The portal user
 * browsing the Files tab needs to see BOTH so they can find what their
 * canvas test runs produced.
 *
 * Precedence: when the same path exists in both scopes, the user-scoped
 * entry wins (it's more recent / more specifically owned). Each entry
 * carries a `scope` field so the UI can show which side it came from.
 */
export async function listWorkspaceFiles(
  storage: R2Bucket,
  org: string,
  agent: string,
  userId?: string,
): Promise<Array<FileEntry & { scope: "user" | "shared" }>> {
  // Load both manifests in parallel — both lookups go to R2 cold storage
  // and there's no point waiting on one before the other.
  const userManifestP = userId && userId !== "shared"
    ? loadManifest(storage, org, agent, userId)
    : Promise.resolve(null);
  const sharedManifestP = loadManifest(storage, org, agent, undefined);

  const [userManifest, sharedManifest] = await Promise.all([
    userManifestP,
    sharedManifestP,
  ]);

  // Build a path-keyed map. Insert shared first so user-scoped entries
  // overwrite when the same relative path exists in both. This matches
  // the precedence rule: portal uploads beat agent-generated files at
  // the same path because the user explicitly chose to put a file there.
  const merged = new Map<string, FileEntry & { scope: "user" | "shared" }>();
  for (const f of sharedManifest?.files ?? []) {
    merged.set(f.path, { ...f, scope: "shared" });
  }
  for (const f of userManifest?.files ?? []) {
    merged.set(f.path, { ...f, scope: "user" });
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

/**
 * Read a file directly from R2 (no sandbox needed).
 *
 * Tries the user-scoped key first, then falls back to the shared scope
 * so portal users can read files generated by agent runs that landed
 * in workspaces/{org}/{agent}/u/shared/ instead of their own scope.
 */
export async function readFileFromR2(
  storage: R2Bucket,
  org: string,
  agent: string,
  filePath: string,
  userId?: string,
): Promise<string | null> {
  // Try user scope first if a userId was provided
  if (userId && userId !== "shared") {
    const userKey = fileKey(org, agent, filePath, userId);
    const obj = await storage.get(userKey);
    if (obj) return obj.text();
  }
  // Fall back to shared scope (where canvas/SSE-channel agent runs land)
  const sharedKey = fileKey(org, agent, filePath, undefined);
  const sharedObj = await storage.get(sharedKey);
  if (!sharedObj) return null;
  return sharedObj.text();
}

/**
 * Delete a file from R2 and remove it from the manifest.
 *
 * The portal can show files from BOTH the user-scoped and shared-scoped
 * manifests (see listWorkspaceFiles). To avoid the user clicking delete
 * on a "shared" file and silently leaving it in R2, this attempts the
 * delete in the user scope first and then in the shared scope. Whichever
 * one had the file gets cleaned up.
 */
export async function deleteFileFromR2(
  storage: R2Bucket,
  org: string,
  agent: string,
  filePath: string,
  userId?: string,
): Promise<void> {
  const relative = filePath.replace(/^\/workspace\//, "").replace(/^\/+/, "");
  const now = new Date().toISOString();

  // Try the user scope first
  if (userId && userId !== "shared") {
    const userKey = fileKey(org, agent, filePath, userId);
    const userObj = await storage.head(userKey).catch(() => null);
    if (userObj) {
      await storage.delete(userKey);
      const userManifest = await loadManifest(storage, org, agent, userId);
      if (userManifest) {
        userManifest.files = userManifest.files.filter((f) => f.path !== relative);
        userManifest.last_sync = now;
        await storage.put(manifestKey(org, agent, userId), JSON.stringify(userManifest, null, 2), {
          customMetadata: { updated_at: now },
        });
      }
      return;
    }
  }

  // Fall back to the shared scope
  const sharedKey = fileKey(org, agent, filePath, undefined);
  await storage.delete(sharedKey);
  const sharedManifest = await loadManifest(storage, org, agent, undefined);
  if (sharedManifest) {
    sharedManifest.files = sharedManifest.files.filter((f) => f.path !== relative);
    sharedManifest.last_sync = now;
    await storage.put(manifestKey(org, agent, undefined), JSON.stringify(sharedManifest, null, 2), {
      customMetadata: { updated_at: now },
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
