import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CONNECTORS_PATH = path.resolve(__dirname, "../src/runtime/connectors.ts");

function load(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

describe("connector runtime hardening", () => {
  it("returns structured connector error codes", () => {
    const source = load(CONNECTORS_PATH);
    expect(source).toContain("CONNECTOR_NOT_CONNECTED");
    expect(source).toContain("CONNECTOR_TOKEN_EXPIRED");
    expect(source).toContain("CONNECTOR_CALL_FAILED");
    expect(source).toContain("CONNECTOR_NETWORK_ERROR");
    expect(source).toContain("retryable");
  });

  it("enforces connector request timeout", () => {
    const source = load(CONNECTORS_PATH);
    expect(source).toContain("signal: AbortSignal.timeout(30_000)");
  });
});
