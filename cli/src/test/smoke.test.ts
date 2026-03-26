/**
 * Smoke tests for CLI
 */
import { describe, it, expect } from "vitest";

// Test that all command modules can be imported
describe("CLI Module Imports", () => {
  it("should import all command modules", async () => {
    const commands = await Promise.all([
      import("../commands/init.js"),
      import("../commands/create.js"),
      import("../commands/run.js"),
      import("../commands/list.js"),
      import("../commands/deploy.js"),
      import("../commands/chat.js"),
      import("../commands/sandbox.js"),
      import("../commands/auth.js"),
      import("../commands/codemap.js"),
      import("../commands/eval.js"),
      import("../commands/evolve.js"),
      import("../commands/issues.js"),
      import("../commands/security.js"),
      import("../commands/sessions.js"),
      import("../commands/skills.js"),
      import("../commands/tools.js"),
      import("../commands/graph.js"),
      import("../commands/memory.js"),
      import("../commands/releases.js"),
      import("../commands/workflows.js"),
      import("../commands/schedules.js"),
      import("../commands/jobs.js"),
      import("../commands/research.js"),
      import("../commands/connectors.js"),
      import("../commands/billing.js"),
    ]);

    expect(commands.length).toBe(25);
    commands.forEach((mod) => {
      expect(mod).toBeDefined();
    });
  });

  it("should import lib modules", async () => {
    const api = await import("../lib/api.js");
    const config = await import("../lib/config.js");
    const version = await import("../lib/version.js");

    expect(api.apiGet).toBeDefined();
    expect(api.apiPost).toBeDefined();
    expect(api.apiPut).toBeDefined();
    expect(api.apiPatch).toBeDefined();
    expect(api.apiDelete).toBeDefined();
    expect(api.apiStream).toBeDefined();
    expect(api.APIError).toBeDefined();

    expect(config.getConfig).toBeDefined();
    expect(config.setConfig).toBeDefined();
    expect(config.getAuth).toBeDefined();
    expect(config.setAuth).toBeDefined();
    expect(config.isAuthenticated).toBeDefined();
    expect(config.requireAuth).toBeDefined();

    expect(version.getVersion).toBeDefined();
  });
});

describe("Version", () => {
  it("should return correct version", async () => {
    const { getVersion } = await import("../lib/version.js");
    expect(getVersion()).toBe("0.2.0");
  });
});
