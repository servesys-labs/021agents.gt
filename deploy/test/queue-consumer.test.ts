import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const INDEX_PATH = path.resolve(__dirname, "../src/index.ts");

function loadSource(): string {
  return fs.readFileSync(INDEX_PATH, "utf-8");
}

describe("queue consumer mapping", () => {
  it("maps runtime_event duration_ms into runtime_events.latency_ms", () => {
    const source = loadSource();
    const runtimeEventBlock = source.match(/type === "runtime_event"[\s\S]*?INSERT INTO runtime_events[\s\S]*?ts\(p\.created_at\)/s);
    expect(runtimeEventBlock).not.toBeNull();
    const block = runtimeEventBlock![0];
    expect(block).toContain("latency_ms");
    expect(block).toContain("p.duration_ms || 0");
  });

  it("writes billing_flush updates through sessions summary columns", () => {
    const source = loadSource();
    const billingFlushBlock = source.match(/type === "billing_flush"[\s\S]*?UPDATE sessions SET[\s\S]*?WHERE session_id/s);
    expect(billingFlushBlock).not.toBeNull();
    const block = billingFlushBlock![0];
    expect(block).toContain("cost_total_usd");
    expect(block).toContain("step_count");
    expect(block).toContain("GREATEST");
  });

  it("classifies permanent vs transient queue failures", () => {
    const source = loadSource();
    expect(source).toContain("function isPermanent");
    expect(source).toContain("PERMANENT FAILURE");
    expect(source).toContain("TRANSIENT FAILURE");
    expect(source).toContain("retryWithBackoff");
  });
});
