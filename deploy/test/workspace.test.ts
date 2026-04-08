/**
 * Tests for deploy/src/runtime/workspace.ts
 * R2-backed workspace persistence: key construction, path safety, CRUD, manifest, isolation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  syncFileToR2,
  loadManifest,
  listWorkspaceFiles,
  readFileFromR2,
  deleteFileFromR2,
  validateWorkspacePath,
} from "../src/runtime/workspace";

// ── Mock R2Bucket ──────────────────────────────────────────────────

class MockR2Bucket {
  private store = new Map<string, { body: string; customMetadata?: Record<string, string> }>();

  async put(key: string, body: string | ReadableStream | ArrayBuffer | null, opts?: { customMetadata?: Record<string, string> }) {
    this.store.set(key, { body: typeof body === "string" ? body : "", customMetadata: opts?.customMetadata });
  }

  async get(key: string): Promise<{ text: () => Promise<string>; body: ReadableStream } | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      text: async () => entry.body,
      body: new ReadableStream(),
    };
  }

  async head(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return { uploaded: new Date() };
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(opts?: { prefix?: string; limit?: number; delimiter?: string }) {
    const prefix = opts?.prefix || "";
    const objects: Array<{ key: string; size: number }> = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) {
        objects.push({ key: k, size: v.body.length });
      }
    }
    return { objects, delimitedPrefixes: [] };
  }

  /** Expose internals for test assertions */
  _has(key: string): boolean {
    return this.store.has(key);
  }

  _getBody(key: string): string | undefined {
    return this.store.get(key)?.body;
  }

  _keys(): string[] {
    return [...this.store.keys()];
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Workspace R2 persistence", () => {
  let bucket: MockR2Bucket;

  beforeEach(() => {
    bucket = new MockR2Bucket();
  });

  // 1. R2 key construction
  it("constructs R2 keys following workspaces/{org}/{agent}/u/shared/files/{path} format", async () => {
    await syncFileToR2(bucket as any, "acme", "bot1", "readme.md", "# Hello", "sess1");
    const keys = bucket._keys();
    const fileKey = keys.find((k) => k.includes("files/readme.md"));
    expect(fileKey).toBe("workspaces/acme/bot1/u/shared/files/readme.md");
  });

  // 1b. User-scoped key construction
  it("scopes files per-user when userId is provided", async () => {
    await syncFileToR2(bucket as any, "acme", "bot1", "readme.md", "# Hello", "sess1", "user42");
    const keys = bucket._keys();
    const fileKey = keys.find((k) => k.includes("files/readme.md"));
    expect(fileKey).toBe("workspaces/acme/bot1/u/user42/files/readme.md");
  });

  // 2. Path traversal prevention via validateWorkspacePath
  it("rejects path traversal with '..'", () => {
    const result = validateWorkspacePath("../../../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/traversal/i);
  });

  it("rejects path traversal with embedded '..'", () => {
    const result = validateWorkspacePath("foo/../bar");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/traversal/i);
  });

  it("accepts a valid relative path", () => {
    const result = validateWorkspacePath("src/app.ts");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects double-slash paths", () => {
    const result = validateWorkspacePath("//etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid path/i);
  });

  it("rejects empty path", () => {
    const result = validateWorkspacePath("");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  // 3. Path sanitization — leading / stripped, double // collapsed
  it("strips leading /workspace/ prefix from file paths", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "/workspace/src/app.ts", "code", "s1");
    const keys = bucket._keys();
    const fileKey = keys.find((k) => k.includes("/files/"));
    expect(fileKey).toBe("workspaces/org1/agent1/u/shared/files/src/app.ts");
  });

  it("strips leading slashes from relative paths", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "///src/app.ts", "code", "s1");
    const keys = bucket._keys();
    const fileKey = keys.find((k) => k.includes("/files/"));
    expect(fileKey).toBe("workspaces/org1/agent1/u/shared/files/src/app.ts");
  });

  // 4. File write + read round-trip
  it("writes a file to R2 then reads back the same content", async () => {
    const content = "Hello, workspace!";
    await syncFileToR2(bucket as any, "org1", "agent1", "hello.txt", content, "sess1");
    const readBack = await readFileFromR2(bucket as any, "org1", "agent1", "hello.txt");
    expect(readBack).toBe(content);
  });

  // 5. File delete
  it("deletes a file from R2 and verifies it is gone", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "temp.txt", "temporary", "sess1");
    // Verify it exists
    const before = await readFileFromR2(bucket as any, "org1", "agent1", "temp.txt");
    expect(before).toBe("temporary");
    // Delete
    await deleteFileFromR2(bucket as any, "org1", "agent1", "temp.txt");
    // Verify gone
    const after = await readFileFromR2(bucket as any, "org1", "agent1", "temp.txt");
    expect(after).toBeNull();
  });

  // 6. Manifest update on write
  it("includes the file in the manifest after writing", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "data.json", '{"a":1}', "sess1");
    const manifest = await loadManifest(bucket as any, "org1", "agent1");
    expect(manifest).not.toBeNull();
    expect(manifest!.files.length).toBe(1);
    expect(manifest!.files[0].path).toBe("data.json");
    expect(manifest!.files[0].size).toBe('{"a":1}'.length);
  });

  // 7. Manifest update on delete
  it("removes the file from the manifest after deleting", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "gone.txt", "bye", "sess1");
    await syncFileToR2(bucket as any, "org1", "agent1", "keep.txt", "stay", "sess1");
    await deleteFileFromR2(bucket as any, "org1", "agent1", "gone.txt");
    const manifest = await loadManifest(bucket as any, "org1", "agent1");
    expect(manifest).not.toBeNull();
    expect(manifest!.files.length).toBe(1);
    expect(manifest!.files[0].path).toBe("keep.txt");
  });

  // 8. Field names in list response — verify `size` and `updated_at` exist
  it("returns files with size and updated_at fields", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "info.txt", "some info", "sess1");
    const files = await listWorkspaceFiles(bucket as any, "org1", "agent1");
    expect(files.length).toBe(1);
    expect(typeof files[0].size).toBe("number");
    expect(typeof files[0].updated_at).toBe("string");
    expect(files[0].size).toBe("some info".length);
    expect(files[0].updated_at).toBeTruthy();
  });

  // 9. Org isolation — files written under org_id=A cannot be read with org_id=B
  it("isolates files between different org_ids", async () => {
    await syncFileToR2(bucket as any, "orgA", "agent1", "secret.txt", "orgA data", "sess1");
    const readFromA = await readFileFromR2(bucket as any, "orgA", "agent1", "secret.txt");
    expect(readFromA).toBe("orgA data");
    const readFromB = await readFileFromR2(bucket as any, "orgB", "agent1", "secret.txt");
    expect(readFromB).toBeNull();
  });

  // 10. Agent isolation — files under agent_name=X cannot be read with agent_name=Y
  it("isolates files between different agent_names", async () => {
    await syncFileToR2(bucket as any, "org1", "agentX", "data.txt", "X data", "sess1");
    const readFromX = await readFileFromR2(bucket as any, "org1", "agentX", "data.txt");
    expect(readFromX).toBe("X data");
    const readFromY = await readFileFromR2(bucket as any, "org1", "agentY", "data.txt");
    expect(readFromY).toBeNull();
  });

  // Additional: Manifest contains correct org/agent metadata
  it("stores org_id and agent_name in the manifest", async () => {
    await syncFileToR2(bucket as any, "myorg", "mybot", "f.txt", "x", "s1");
    const manifest = await loadManifest(bucket as any, "myorg", "mybot");
    expect(manifest!.org_id).toBe("myorg");
    expect(manifest!.agent_name).toBe("mybot");
  });

  // Additional: Upsert updates existing file entry rather than duplicating
  it("upserts file entry on re-write (no duplicate entries)", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "app.ts", "v1", "sess1");
    await syncFileToR2(bucket as any, "org1", "agent1", "app.ts", "v2", "sess1");
    const manifest = await loadManifest(bucket as any, "org1", "agent1");
    expect(manifest!.files.length).toBe(1);
    expect(manifest!.files[0].size).toBe(2); // "v2".length
    const content = await readFileFromR2(bucket as any, "org1", "agent1", "app.ts");
    expect(content).toBe("v2");
  });

  // Additional: User isolation within same agent
  it("isolates files between different user_ids within the same agent", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "notes.txt", "user1 notes", "sess1", "user1");
    await syncFileToR2(bucket as any, "org1", "agent1", "notes.txt", "user2 notes", "sess1", "user2");
    const read1 = await readFileFromR2(bucket as any, "org1", "agent1", "notes.txt", "user1");
    const read2 = await readFileFromR2(bucket as any, "org1", "agent1", "notes.txt", "user2");
    expect(read1).toBe("user1 notes");
    expect(read2).toBe("user2 notes");
  });

  // Additional: deleteFileFromR2 on non-existent file does not throw
  it("does not throw when deleting a non-existent file", async () => {
    await expect(
      deleteFileFromR2(bucket as any, "org1", "agent1", "nonexistent.txt")
    ).resolves.not.toThrow();
  });
});
