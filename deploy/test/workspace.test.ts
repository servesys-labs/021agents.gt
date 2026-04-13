/**
 * Tests for deploy/src/runtime/workspace.ts
 * R2-backed workspace persistence: key construction, path safety, CRUD, manifest, isolation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  syncFileToR2,
  syncBinaryFileToR2,
  loadManifest,
  listWorkspaceFiles,
  readFileFromR2,
  deleteFileFromR2,
  validateWorkspacePath,
} from "../src/runtime/workspace";

// ── Mock R2Bucket ──────────────────────────────────────────────────

class MockR2Bucket {
  private store = new Map<string, { body: string | ArrayBuffer | Uint8Array; customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> }>();

  async put(key: string, body: string | ReadableStream | ArrayBuffer | Uint8Array | null, opts?: { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> }) {
    this.store.set(key, {
      body: body instanceof Uint8Array ? body : (body instanceof ArrayBuffer ? body : (typeof body === "string" ? body : "")),
      customMetadata: opts?.customMetadata,
      httpMetadata: opts?.httpMetadata,
    });
  }

  async get(key: string): Promise<{ text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer>; body: ReadableStream; customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> } | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      text: async () => typeof entry.body === "string" ? entry.body : new TextDecoder().decode(entry.body),
      arrayBuffer: async () => entry.body instanceof ArrayBuffer ? entry.body : (entry.body instanceof Uint8Array ? entry.body.buffer.slice(entry.body.byteOffset, entry.body.byteOffset + entry.body.byteLength) : new TextEncoder().encode(entry.body as string).buffer),
      body: new ReadableStream(),
      customMetadata: entry.customMetadata,
      httpMetadata: entry.httpMetadata,
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
        const size = typeof v.body === "string" ? v.body.length : (v.body instanceof Uint8Array ? v.body.byteLength : (v.body as ArrayBuffer).byteLength);
        objects.push({ key: k, size });
      }
    }
    return { objects, delimitedPrefixes: [] };
  }

  /** Expose internals for test assertions */
  _has(key: string): boolean {
    return this.store.has(key);
  }

  _getBody(key: string): string | ArrayBuffer | Uint8Array | undefined {
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

  // Additional: read fallback to shared scope for agent-generated artifacts
  it("falls back to shared scope when user-scoped file is missing", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "daily_digest.md", "shared artifact", "sess1");
    const readAsUser = await readFileFromR2(bucket as any, "org1", "agent1", "daily_digest.md", "portal-user");
    expect(readAsUser).toBe("shared artifact");
  });

  // Additional: deleteFileFromR2 on non-existent file does not throw
  it("does not throw when deleting a non-existent file", async () => {
    await expect(
      deleteFileFromR2(bucket as any, "org1", "agent1", "nonexistent.txt")
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Binary file support — PDFs, images, archives stored as raw bytes
// ═══════════════════════════════════════════════════════════════════

describe("Workspace R2 binary file support", () => {
  let bucket: MockR2Bucket;

  beforeEach(() => {
    bucket = new MockR2Bucket();
  });

  it("syncBinaryFileToR2 stores binary content from base64", async () => {
    // A minimal PDF-like binary: "%PDF-1.4" in base64
    const pdfContent = "JVBERi0xLjQ="; // btoa("%PDF-1.4")
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/report.pdf", pdfContent, "sess1");
    expect(bucket._has("workspaces/org1/agent1/u/shared/files/report.pdf")).toBe(true);
  });

  it("syncBinaryFileToR2 stores raw bytes, not base64 text", async () => {
    const original = "Hello PDF";
    const b64 = btoa(original);
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/test.pdf", b64, "sess1");

    const raw = bucket._getBody("workspaces/org1/agent1/u/shared/files/test.pdf");
    // Must be a Uint8Array, not a string
    expect(raw).toBeInstanceOf(Uint8Array);
    // Decoded bytes must match the original
    const decoded = new TextDecoder().decode(raw as Uint8Array);
    expect(decoded).toBe(original);
  });

  it("syncBinaryFileToR2 sets correct MIME type for PDFs", async () => {
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/doc.pdf", btoa("fake-pdf"), "sess1");
    const obj = await bucket.get("workspaces/org1/agent1/u/shared/files/doc.pdf");
    expect(obj?.httpMetadata?.contentType).toBe("application/pdf");
  });

  it("syncBinaryFileToR2 sets correct MIME type for images", async () => {
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/photo.png", btoa("fake-png"), "sess1");
    const obj = await bucket.get("workspaces/org1/agent1/u/shared/files/photo.png");
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
  });

  it("syncBinaryFileToR2 marks encoding=binary in metadata", async () => {
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/data.xlsx", btoa("fake-xlsx"), "sess1");
    const obj = await bucket.get("workspaces/org1/agent1/u/shared/files/data.xlsx");
    expect(obj?.customMetadata?.encoding).toBe("binary");
  });

  it("syncBinaryFileToR2 updates the manifest with correct byte size", async () => {
    const content = "0123456789"; // 10 bytes
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/file.zip", btoa(content), "sess1");
    const manifest = await loadManifest(bucket as any, "org1", "agent1");
    expect(manifest).not.toBeNull();
    expect(manifest!.files.length).toBe(1);
    expect(manifest!.files[0].path).toBe("file.zip");
    expect(manifest!.files[0].size).toBe(10); // byte count, not base64 length
  });

  it("readFileFromR2 returns data URI for binary files", async () => {
    const original = "PDF binary content here";
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/report.pdf", btoa(original), "sess1");
    const result = await readFileFromR2(bucket as any, "org1", "agent1", "report.pdf");
    expect(result).not.toBeNull();
    expect(result).toMatch(/^data:application\/pdf;base64,/);
    // Extract and decode the base64 payload
    const b64 = result!.split(",")[1];
    expect(atob(b64)).toBe(original);
  });

  it("readFileFromR2 returns plain text for text files (no data URI)", async () => {
    await syncFileToR2(bucket as any, "org1", "agent1", "readme.md", "# Hello", "sess1");
    const result = await readFileFromR2(bucket as any, "org1", "agent1", "readme.md");
    expect(result).toBe("# Hello");
    expect(result).not.toMatch(/^data:/);
  });

  it("binary files respect org isolation", async () => {
    await syncBinaryFileToR2(bucket as any, "orgA", "agent1", "/workspace/secret.pdf", btoa("secret"), "sess1");
    const fromA = await readFileFromR2(bucket as any, "orgA", "agent1", "secret.pdf");
    expect(fromA).not.toBeNull();
    const fromB = await readFileFromR2(bucket as any, "orgB", "agent1", "secret.pdf");
    expect(fromB).toBeNull();
  });

  it("binary files respect user isolation with shared fallback", async () => {
    await syncBinaryFileToR2(bucket as any, "org1", "agent1", "/workspace/chart.png", btoa("shared-chart"), "sess1");
    // User-scoped read falls back to shared
    const result = await readFileFromR2(bucket as any, "org1", "agent1", "chart.png", "portal-user");
    expect(result).not.toBeNull();
    expect(result).toMatch(/^data:image\/png;base64,/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Source-inspection: binary sync pipeline wiring
// ═══════════════════════════════════════════════════════════════════

describe("Workspace binary sync pipeline invariants", () => {
  const fs = require("fs");
  const path = require("path");
  const toolsSource = fs.readFileSync(path.resolve(__dirname, "../src/runtime/tools.ts"), "utf-8");

  it("syncRecentWorkspaceFilesToR2 uses base64 for binary extensions", () => {
    const syncBlock = toolsSource.match(
      /syncRecentWorkspaceFilesToR2[\s\S]*?^}/m,
    );
    expect(syncBlock).not.toBeNull();
    const block = syncBlock![0];
    expect(block).toContain("BINARY_EXTS");
    expect(block).toContain(".pdf");
    expect(block).toContain(".png");
    expect(block).toContain("base64");
    expect(block).toContain("syncBinaryFileToR2");
  });

  it("binary size cap is at least 5MB", () => {
    const capMatch = toolsSource.match(/if \(size > ([\d_]+)\) continue;.*cap/);
    expect(capMatch).not.toBeNull();
    const cap = Number(capMatch![1].replace(/_/g, ""));
    expect(cap).toBeGreaterThanOrEqual(5_000_000);
  });
});
