/**
 * Cron expression parser tests.
 */
import { describe, it, expect } from "vitest";
import { parseCron } from "../src/logic/cron-parser";

describe("parseCron", () => {
  it("parses standard 5-field expression", () => {
    const result = parseCron("0 * * * *");
    expect(result.fields).toHaveLength(5);
    expect(result.expression).toBe("0 * * * *");
  });

  it("throws on too few fields", () => {
    expect(() => parseCron("0 *")).toThrow();
  });

  it("throws on too many fields", () => {
    expect(() => parseCron("0 * * * * * *")).toThrow();
  });

  it("handles @daily shortcut", () => {
    const result = parseCron("@daily");
    expect(result.fields).toHaveLength(5);
    expect(result.original).toBe("@daily");
  });

  it("handles @hourly shortcut", () => {
    const result = parseCron("@hourly");
    expect(result.fields).toHaveLength(5);
  });

  it("handles @every_5m shortcut", () => {
    const result = parseCron("@every_5m");
    expect(result.fields).toHaveLength(5);
    expect(result.fields[0]).toBe("*/5");
  });

  it("parses step expressions", () => {
    const result = parseCron("*/5 * * * *");
    expect(result.fields[0]).toBe("*/5");
  });

  it("parses range expressions", () => {
    const result = parseCron("0 9-17 * * *");
    expect(result.fields[1]).toBe("9-17");
  });

  it("parses list expressions", () => {
    const result = parseCron("0 0 1,15 * *");
    expect(result.fields[2]).toBe("1,15");
  });

  it("throws on invalid field values", () => {
    expect(() => parseCron("60 * * * *")).toThrow(); // minute > 59
  });

  it("throws on empty expression", () => {
    expect(() => parseCron("")).toThrow();
  });
});
