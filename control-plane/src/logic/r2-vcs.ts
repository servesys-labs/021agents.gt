/**
 * R2 Version Control System — git-like semantics on Cloudflare R2.
 *
 * Provides content-addressed storage with commits, branches, diffs, and
 * soft delete with retention periods. Used for:
 *   - Agent config versioning (every config change = commit)
 *   - Workspace project versioning (agent's working files)
 *
 * Architecture (R2 key layout):
 *   vcs/{org}/{repo}/objects/{sha256}        ← content-addressed blobs
 *   vcs/{org}/{repo}/commits/{commit-id}     ← commit metadata
 *   vcs/{org}/{repo}/refs/heads/{branch}     ← branch → commit-id
 *   vcs/{org}/{repo}/trees/{tree-id}         ← directory snapshots
 *   vcs/{org}/{repo}/trash/{id}              ← soft-deleted, expires after retention
 *
 * Concepts:
 *   - Object: immutable content blob, keyed by SHA-256 hash
 *   - Tree: snapshot of a directory (path → object hash)
 *   - Commit: points to a tree + parent commit + metadata
 *   - Branch: named mutable pointer to a commit
 *   - Worktree: isolated copy of a branch for parallel work
 */

// ── Types ─────────────────────────────────────────────────────

export interface VcsObject {
  hash: string;
  size: number;
  content_type: string;
}

export interface VcsTreeEntry {
  path: string;
  hash: string;
  size: number;
}

export interface VcsTree {
  id: string;
  entries: VcsTreeEntry[];
}

export interface VcsCommit {
  id: string;
  tree_id: string;
  parent_id: string | null;
  message: string;
  author: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface VcsBranch {
  name: string;
  commit_id: string;
  updated_at: number;
}

export interface VcsLog {
  commits: VcsCommit[];
  branch: string;
  total: number;
}

export interface VcsDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  old_hash?: string;
  new_hash?: string;
  old_size?: number;
  new_size?: number;
}

export interface VcsDiff {
  from_commit: string;
  to_commit: string;
  entries: VcsDiffEntry[];
  files_changed: number;
}

export interface VcsTrashEntry {
  id: string;
  repo: string;
  path: string;
  hash: string;
  deleted_at: number;
  deleted_by: string;
  expires_at: number;
  reason: string;
}

export interface VcsStatus {
  branch: string;
  commit_id: string;
  commit_count: number;
  branches: string[];
  has_uncommitted: boolean;
}

// ── Core VCS Operations ───────────────────────────────────────

/**
 * Initialize a new VCS repository in R2.
 */
export async function vcsInit(
  storage: R2Bucket,
  org: string,
  repo: string,
): Promise<{ commit_id: string; branch: string }> {
  const prefix = `vcs/${org}/${repo}`;

  // Check if already initialized
  const headRef = await storage.get(`${prefix}/refs/heads/main`);
  if (headRef) {
    const commitId = await headRef.text();
    return { commit_id: commitId, branch: "main" };
  }

  // Create empty tree
  const tree: VcsTree = { id: sha256Short("empty-tree"), entries: [] };
  await storage.put(`${prefix}/trees/${tree.id}`, JSON.stringify(tree));

  // Create initial commit
  const commit: VcsCommit = {
    id: sha256Short(`init-${Date.now()}`),
    tree_id: tree.id,
    parent_id: null,
    message: "Initial commit",
    author: "system",
    timestamp: Date.now(),
  };
  await storage.put(`${prefix}/commits/${commit.id}`, JSON.stringify(commit));

  // Point main branch to initial commit
  await storage.put(`${prefix}/refs/heads/main`, commit.id);

  return { commit_id: commit.id, branch: "main" };
}

/**
 * Store a content blob and return its hash.
 */
export async function vcsStoreObject(
  storage: R2Bucket,
  org: string,
  repo: string,
  content: string | ArrayBuffer,
  contentType: string = "application/octet-stream",
): Promise<VcsObject> {
  const prefix = `vcs/${org}/${repo}`;
  const data = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
  const hash = await sha256(data);
  const size = data.byteLength;

  // Content-addressed: only write if it doesn't exist
  const existing = await storage.head(`${prefix}/objects/${hash}`);
  if (!existing) {
    await storage.put(`${prefix}/objects/${hash}`, data, {
      customMetadata: { content_type: contentType, size: String(size) },
    });
  }

  return { hash, size, content_type: contentType };
}

/**
 * Read a content blob by hash.
 */
export async function vcsReadObject(
  storage: R2Bucket,
  org: string,
  repo: string,
  hash: string,
): Promise<string | null> {
  const obj = await storage.get(`vcs/${org}/${repo}/objects/${hash}`);
  if (!obj) return null;
  return obj.text();
}

/**
 * Create a commit from a set of files.
 * Each file is { path, content }. Content is stored as objects,
 * a tree is built from the paths, and a commit points to the tree.
 */
export async function vcsCommit(
  storage: R2Bucket,
  org: string,
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  author: string,
  branch: string = "main",
  metadata?: Record<string, unknown>,
): Promise<VcsCommit> {
  const prefix = `vcs/${org}/${repo}`;

  // Store all file objects
  const entries: VcsTreeEntry[] = [];
  for (const file of files) {
    const obj = await vcsStoreObject(storage, org, repo, file.content, "text/plain");
    entries.push({ path: file.path, hash: obj.hash, size: obj.size });
  }

  // Create tree
  const treeId = sha256Short(JSON.stringify(entries));
  const tree: VcsTree = { id: treeId, entries };
  await storage.put(`${prefix}/trees/${treeId}`, JSON.stringify(tree));

  // Get current branch head (parent)
  const headRef = await storage.get(`${prefix}/refs/heads/${branch}`);
  const parentId = headRef ? await headRef.text() : null;

  // Create commit
  const commit: VcsCommit = {
    id: sha256Short(`${treeId}-${Date.now()}-${Math.random()}`),
    tree_id: treeId,
    parent_id: parentId,
    message,
    author,
    timestamp: Date.now(),
    metadata,
  };
  await storage.put(`${prefix}/commits/${commit.id}`, JSON.stringify(commit));

  // Update branch ref
  await storage.put(`${prefix}/refs/heads/${branch}`, commit.id);

  return commit;
}

/**
 * Get commit log for a branch (walk parent chain).
 */
export async function vcsLog(
  storage: R2Bucket,
  org: string,
  repo: string,
  branch: string = "main",
  limit: number = 20,
): Promise<VcsLog> {
  const prefix = `vcs/${org}/${repo}`;
  const headRef = await storage.get(`${prefix}/refs/heads/${branch}`);
  if (!headRef) return { commits: [], branch, total: 0 };

  let commitId: string | null = await headRef.text();
  const commits: VcsCommit[] = [];

  while (commitId && commits.length < limit) {
    const commitObj = await storage.get(`${prefix}/commits/${commitId}`);
    if (!commitObj) break;
    const commit = await commitObj.json<VcsCommit>();
    commits.push(commit);
    commitId = commit.parent_id;
  }

  return { commits, branch, total: commits.length };
}

/**
 * Diff two commits (or a commit vs its parent).
 */
export async function vcsDiff(
  storage: R2Bucket,
  org: string,
  repo: string,
  fromCommitId: string,
  toCommitId: string,
): Promise<VcsDiff> {
  const prefix = `vcs/${org}/${repo}`;

  const fromCommit = await storage.get(`${prefix}/commits/${fromCommitId}`);
  const toCommit = await storage.get(`${prefix}/commits/${toCommitId}`);
  if (!fromCommit || !toCommit) {
    return { from_commit: fromCommitId, to_commit: toCommitId, entries: [], files_changed: 0 };
  }

  const from = await fromCommit.json<VcsCommit>();
  const to = await toCommit.json<VcsCommit>();

  const fromTree = await loadTree(storage, prefix, from.tree_id);
  const toTree = await loadTree(storage, prefix, to.tree_id);

  const fromMap = new Map(fromTree.entries.map((e) => [e.path, e]));
  const toMap = new Map(toTree.entries.map((e) => [e.path, e]));

  const entries: VcsDiffEntry[] = [];

  // Added or modified in "to"
  for (const [path, entry] of toMap) {
    const old = fromMap.get(path);
    if (!old) {
      entries.push({ path, status: "added", new_hash: entry.hash, new_size: entry.size });
    } else if (old.hash !== entry.hash) {
      entries.push({
        path, status: "modified",
        old_hash: old.hash, old_size: old.size,
        new_hash: entry.hash, new_size: entry.size,
      });
    }
  }

  // Deleted (in "from" but not in "to")
  for (const [path, entry] of fromMap) {
    if (!toMap.has(path)) {
      entries.push({ path, status: "deleted", old_hash: entry.hash, old_size: entry.size });
    }
  }

  return { from_commit: fromCommitId, to_commit: toCommitId, entries, files_changed: entries.length };
}

/**
 * Create or switch branches.
 */
export async function vcsBranch(
  storage: R2Bucket,
  org: string,
  repo: string,
  action: "list" | "create" | "delete",
  name?: string,
  fromBranch?: string,
): Promise<VcsBranch[] | VcsBranch | { deleted: boolean }> {
  const prefix = `vcs/${org}/${repo}`;

  if (action === "list") {
    const listed = await storage.list({ prefix: `${prefix}/refs/heads/` });
    const branches: VcsBranch[] = [];
    for (const obj of listed.objects) {
      const branchName = obj.key.replace(`${prefix}/refs/heads/`, "");
      const ref = await storage.get(obj.key);
      branches.push({
        name: branchName,
        commit_id: ref ? await ref.text() : "",
        updated_at: obj.uploaded.getTime(),
      });
    }
    return branches;
  }

  if (action === "create" && name) {
    const sourceBranch = fromBranch || "main";
    const sourceRef = await storage.get(`${prefix}/refs/heads/${sourceBranch}`);
    const commitId = sourceRef ? await sourceRef.text() : "";
    await storage.put(`${prefix}/refs/heads/${name}`, commitId);
    return { name, commit_id: commitId, updated_at: Date.now() };
  }

  if (action === "delete" && name && name !== "main") {
    await storage.delete(`${prefix}/refs/heads/${name}`);
    return { deleted: true };
  }

  return [];
}

/**
 * Get the full tree (file listing) for a commit or branch.
 */
export async function vcsCheckout(
  storage: R2Bucket,
  org: string,
  repo: string,
  branchOrCommit: string = "main",
): Promise<{ commit: VcsCommit; tree: VcsTree } | null> {
  const prefix = `vcs/${org}/${repo}`;

  // Try as branch first
  let commitId = branchOrCommit;
  const ref = await storage.get(`${prefix}/refs/heads/${branchOrCommit}`);
  if (ref) commitId = await ref.text();

  const commitObj = await storage.get(`${prefix}/commits/${commitId}`);
  if (!commitObj) return null;

  const commit = await commitObj.json<VcsCommit>();
  const tree = await loadTree(storage, prefix, commit.tree_id);

  return { commit, tree };
}

/**
 * Get repository status.
 */
export async function vcsStatus(
  storage: R2Bucket,
  org: string,
  repo: string,
  branch: string = "main",
): Promise<VcsStatus> {
  const prefix = `vcs/${org}/${repo}`;

  const headRef = await storage.get(`${prefix}/refs/heads/${branch}`);
  const commitId = headRef ? await headRef.text() : "";

  // Count commits on this branch
  let count = 0;
  let cursor: string | null = commitId;
  while (cursor && count < 1000) {
    const c = await storage.get(`${prefix}/commits/${cursor}`);
    if (!c) break;
    const commit = await c.json<VcsCommit>();
    count++;
    cursor = commit.parent_id;
  }

  // List all branches
  const listed = await storage.list({ prefix: `${prefix}/refs/heads/` });
  const branches = listed.objects.map((o) => o.key.replace(`${prefix}/refs/heads/`, ""));

  return {
    branch,
    commit_id: commitId,
    commit_count: count,
    branches,
    has_uncommitted: false, // R2 VCS is always committed (no staging area)
  };
}

// ── Soft Delete with Retention ────────────────────────────────

/**
 * Soft-delete a file or version. Moves to trash with an expiration date.
 * Requires human confirmation for permanent deletion.
 */
export async function vcsSoftDelete(
  storage: R2Bucket,
  org: string,
  repo: string,
  path: string,
  hash: string,
  deletedBy: string,
  reason: string = "",
  retentionDays: number = 30,
): Promise<VcsTrashEntry> {
  const prefix = `vcs/${org}/${repo}`;
  const id = sha256Short(`trash-${path}-${Date.now()}`);
  const entry: VcsTrashEntry = {
    id,
    repo,
    path,
    hash,
    deleted_at: Date.now(),
    deleted_by: deletedBy,
    expires_at: Date.now() + retentionDays * 86400_000,
    reason,
  };

  await storage.put(`${prefix}/trash/${id}`, JSON.stringify(entry));
  return entry;
}

/**
 * List items in trash (recoverable soft-deletes).
 */
export async function vcsListTrash(
  storage: R2Bucket,
  org: string,
  repo: string,
): Promise<VcsTrashEntry[]> {
  const prefix = `vcs/${org}/${repo}/trash/`;
  const listed = await storage.list({ prefix });
  const entries: VcsTrashEntry[] = [];
  const now = Date.now();

  for (const obj of listed.objects) {
    const data = await storage.get(obj.key);
    if (!data) continue;
    const entry = await data.json<VcsTrashEntry>();
    if (entry.expires_at > now) {
      entries.push(entry);
    } else {
      // Expired — clean up
      await storage.delete(obj.key);
    }
  }

  return entries;
}

/**
 * Restore a soft-deleted item from trash.
 */
export async function vcsRestore(
  storage: R2Bucket,
  org: string,
  repo: string,
  trashId: string,
): Promise<{ restored: boolean; path: string } | null> {
  const prefix = `vcs/${org}/${repo}`;
  const data = await storage.get(`${prefix}/trash/${trashId}`);
  if (!data) return null;

  const entry = await data.json<VcsTrashEntry>();
  // Remove from trash
  await storage.delete(`${prefix}/trash/${trashId}`);
  return { restored: true, path: entry.path };
}

/**
 * Permanently delete a trash entry. Requires explicit confirmation.
 */
export async function vcsPermanentDelete(
  storage: R2Bucket,
  org: string,
  repo: string,
  trashId: string,
  confirmed: boolean,
): Promise<{ deleted: boolean; error?: string }> {
  if (!confirmed) {
    return { deleted: false, error: "Permanent deletion requires explicit confirmation (confirmed: true)" };
  }

  const prefix = `vcs/${org}/${repo}`;
  const data = await storage.get(`${prefix}/trash/${trashId}`);
  if (!data) return { deleted: false, error: "Trash entry not found" };

  const entry = await data.json<VcsTrashEntry>();
  // Delete the trash entry and the underlying object
  await storage.delete(`${prefix}/trash/${trashId}`);
  await storage.delete(`${prefix}/objects/${entry.hash}`);
  return { deleted: true };
}

// ── Convenience: Config Versioning ────────────────────────────

/**
 * Commit an agent config change. Creates a version in the agent's config repo.
 * Every config update goes through here for full version history.
 */
export async function commitAgentConfig(
  storage: R2Bucket,
  org: string,
  agentName: string,
  config: Record<string, unknown>,
  message: string,
  author: string,
  metadata?: Record<string, unknown>,
): Promise<VcsCommit> {
  const repo = `config-${agentName}`;

  // Ensure repo is initialized
  await vcsInit(storage, org, repo);

  return vcsCommit(
    storage, org, repo,
    [{ path: "agent-config.json", content: JSON.stringify(config, null, 2) }],
    message,
    author,
    "main",
    metadata,
  );
}

/**
 * Get config version history for an agent.
 */
export async function getConfigVersions(
  storage: R2Bucket,
  org: string,
  agentName: string,
  limit: number = 20,
): Promise<VcsLog> {
  return vcsLog(storage, org, `config-${agentName}`, "main", limit);
}

/**
 * Restore a previous config version.
 */
export async function restoreConfigVersion(
  storage: R2Bucket,
  org: string,
  agentName: string,
  commitId: string,
): Promise<{ config: Record<string, unknown>; commit: VcsCommit } | null> {
  const result = await vcsCheckout(storage, org, `config-${agentName}`, commitId);
  if (!result) return null;

  const configEntry = result.tree.entries.find((e) => e.path === "agent-config.json");
  if (!configEntry) return null;

  const content = await vcsReadObject(storage, org, `config-${agentName}`, configEntry.hash);
  if (!content) return null;

  try {
    return { config: JSON.parse(content), commit: result.commit };
  } catch {
    return null;
  }
}

// ── Convenience: Workspace Versioning ─────────────────────────

/**
 * Commit workspace files (the agent's project). Used by save-project tool.
 */
export async function commitWorkspace(
  storage: R2Bucket,
  org: string,
  agentName: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  author: string = "agent",
  branch: string = "main",
): Promise<VcsCommit> {
  const repo = `workspace-${agentName}`;
  await vcsInit(storage, org, repo);
  return vcsCommit(storage, org, repo, files, message, author, branch);
}

/**
 * Get workspace version history.
 */
export async function getWorkspaceVersions(
  storage: R2Bucket,
  org: string,
  agentName: string,
  branch: string = "main",
  limit: number = 20,
): Promise<VcsLog> {
  return vcsLog(storage, org, `workspace-${agentName}`, branch, limit);
}

// ── Internal Helpers ──────────────────────────────────────────

async function loadTree(storage: R2Bucket, prefix: string, treeId: string): Promise<VcsTree> {
  const obj = await storage.get(`${prefix}/trees/${treeId}`);
  if (!obj) return { id: treeId, entries: [] };
  return obj.json<VcsTree>();
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sha256Short(input: string): string {
  // Fast non-crypto hash for IDs (not security-sensitive)
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36) + Date.now().toString(36);
}
