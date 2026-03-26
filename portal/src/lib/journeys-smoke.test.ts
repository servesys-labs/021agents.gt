import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

function expectRoutesPresent(routes: string[]) {
  for (const route of routes) {
    expect(appSource).toContain(`path="${route}"`);
  }
}

describe("portal journey route smoke coverage", () => {
  it("covers Builder zero-to-deploy route chain", () => {
    expectRoutesPresent([
      "/agents",
      "/agents/new",
      "/agents/:name",
      "/agents/:name/playground",
      "/agents/:name/deploy",
      "/agents/:name/success",
    ]);
  });

  it("covers Operator troubleshooting route chain", () => {
    expectRoutesPresent([
      "/agents/:name/sessions/:sessionId",
      "/agents/:name/issues/:issueId",
      "/agents/:name/verify",
      "/issues",
      "/intelligence",
    ]);
  });

  it("covers Admin governance and operations routes", () => {
    expectRoutesPresent([
      "/settings",
      "/security",
      "/compliance",
      "/workflows",
      "/jobs",
    ]);
  });
});
